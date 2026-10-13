/**
 * Closing a guard run — shared by PostToolUse, Stop and PreToolUse's deny path.
 *
 * Codex runs PostToolUse only for a call it counts as succeeded
 * (codex-rs/core/src/tools/registry.rs, `success_for_logging`), and it has no
 * failure hook. A shell command that exits non-zero still gets PostToolUse, but
 * its `tool_response` is the output text alone, with no exit code. Every other
 * failed call (an MCP error result or JSON-RPC error, a failed apply_patch) gets
 * no PostToolUse at all. So:
 *   - PostToolUse reads the exit status from the session transcript;
 *   - Stop closes, as failed, this session's runs that no PostToolUse closed;
 *   - PreToolUse closes a run it denies, since that call never runs.
 */
import { closeSync, openSync, readSync, fstatSync } from 'node:fs'
import { readLock } from '../../vendor/vaibot-guard/scripts/lib/guard-bootstrap.mjs'

const TIMEOUT_MS = Number(process.env.VAIBOT_TIMEOUT_MS) || 10000

// Resolve the running guard to finalize against. pre-tool-use already launched
// it (lock written) by the time PostToolUse fires; honour the env override if set.
export function resolveGuard() {
  const baseUrl = process.env.VAIBOT_GUARD_BASE_URL
  if (baseUrl) {
    try {
      const u = new URL(baseUrl)
      return { host: u.hostname, port: Number(u.port) || 39111, token: process.env.VAIBOT_GUARD_TOKEN || '' }
    } catch { /* fall through */ }
  }
  const lock = readLock()
  return lock && lock.port ? { host: lock.host, port: lock.port, token: lock.token } : null
}

// Best-effort: a failed finalize never blocks the session.
export async function finalizeRun(guard, runId, result) {
  if (!guard || !runId) return
  try {
    await fetch(`http://${guard.host}:${guard.port}/v1/finalize/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${guard.token}` },
      body: JSON.stringify({ sessionId: 'codex', runId, result }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch { /* best-effort */ }
}

// The transcript record Codex writes when a call completes:
//   {"type":"event_msg","payload":{"type":"item_completed","item":{"id":<tool_use_id>,
//     "status":"completed"|"failed", "exit_code":N, ...}}}
// It is written before PostToolUse runs. The format is Codex's own, not a hook
// contract, so anything unexpected returns null and the caller keeps what the
// hook payload says. Only the tail is read: the record is among the newest.
const TAIL_BYTES = 1024 * 1024

export function transcriptOutcome(transcriptPath, toolUseId) {
  if (typeof transcriptPath !== 'string' || !transcriptPath || typeof toolUseId !== 'string' || !toolUseId) return null
  let fd
  try {
    fd = openSync(transcriptPath, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes(toolUseId) || !line.includes('item_completed')) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      const item = rec?.payload?.type === 'item_completed' ? rec.payload.item : null
      if (!item || item.id !== toolUseId) continue
      return {
        status: typeof item.status === 'string' ? item.status : null,
        exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
      }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

// The error text for a failure the transcript reports, or null when it reports none.
export function transcriptFailure(outcome) {
  if (!outcome) return null
  if (outcome.exitCode !== null && outcome.exitCode !== 0) return `exit code ${outcome.exitCode}`
  if (outcome.status === 'failed') return 'tool call failed'
  return null
}
