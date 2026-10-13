/**
 * Holding a call for an answer away from the terminal.
 *
 * When the guard escalates a call in enforce mode, PreToolUse asks the guard to
 * hold it (`POST /v1/hold`). The guard posts it to VAIBot as pending, where it
 * can be answered on the VAIBot Authenticator, in the dashboard or from the
 * alert email, and hears the answer back signed. The hook waits for it by
 * polling `POST /v1/approvals/status`.
 *
 * Codex runs PreToolUse hooks before anything else and has no prompt of its own
 * for a PreToolUse escalation, so the wait happens here. A hook that outlives
 * its `timeout` in hooks.json counts as no decision, which Codex treats as
 * allow, so the wait is capped well inside that timeout.
 *
 * Anything that isn't a clear answer (an older guard without /v1/hold, a call
 * that can't be held, nowhere to answer it, an error, no answer in time) returns
 * a non-answer and the caller keeps its existing deny-with-retry path.
 */

const TIMEOUT_MS = Number(process.env.VAIBOT_TIMEOUT_MS) || 10000
// hooks.json gives PreToolUse 180 s. Stay well inside it, whatever the env says.
export const MAX_HOLD_WAIT_MS = 150_000
export const HOLD_WAIT_MS = Math.min(
  MAX_HOLD_WAIT_MS,
  Math.max(0, Number(process.env.VAIBOT_HOLD_WAIT_MS) || 120_000),
)
const POLL_MS = Math.max(50, Number(process.env.VAIBOT_HOLD_POLL_MS) || 1000)

/** Where a held call was answered, for the message back to the agent. */
export const ANSWER_PLACE = {
  authenticator: 'on your phone',
  dashboard: 'in the VAIBot dashboard',
  email: 'from the email link',
}

async function guardPost(guard, route, body) {
  const res = await fetch(`http://${guard.host}:${guard.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${guard.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/**
 * Hold the run and wait for the answer.
 *
 * @returns {Promise<{ held: false } | { held: true, answer: 'approved'|'denied'|null, source: string|null, channels: object }>}
 *   `answer: null` means it was held but nobody answered in time (or the
 *   approval lapsed): the call is still answerable in VAIBot.
 */
export async function holdAndWait(guard, { runId, sessionId }, { waitMs = HOLD_WAIT_MS, now = Date.now } = {}) {
  if (!guard || !runId) return { held: false }
  let hold
  try {
    hold = await guardPost(guard, '/v1/hold', { runId, sessionId })
  } catch {
    return { held: false }
  }
  if (hold.status !== 200 || hold.body?.held !== true || !hold.body.approvalId) return { held: false }
  const channels = hold.body.channels ?? {}
  // Only the dashboard: nobody is told it's waiting, so don't make the agent wait.
  if (!channels.authenticator && !channels.email) return { held: true, answer: null, source: null, channels }

  const approvalId = hold.body.approvalId
  const deadline = now() + waitMs
  while (now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    let st
    try {
      st = (await guardPost(guard, '/v1/approvals/status', { approvalIds: [approvalId] })).body?.approvals?.[0]
    } catch {
      continue // a slow guard is not an answer
    }
    if (!st) continue
    if (st.status === 'approved' || st.status === 'denied') {
      return { held: true, answer: st.status, source: st.resolutionSource ?? null, channels }
    }
    if (st.status === 'expired' || st.status === 'used' || st.status === 'unknown') break
  }
  return { held: true, answer: null, source: null, channels }
}
