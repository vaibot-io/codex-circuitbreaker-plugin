/**
 * Clearing approval_required run-state that is over — shared by the PreToolUse
 * sweep and the Stop hook so the two cannot drift apart.
 *
 * In enforce mode a gated call is denied and drops its own run-state (it never
 * runs). What reaches a sweep is an OBSERVE-mode escalation: the call was
 * allowed, and its PostToolUse consumes the entry when it finishes. The state
 * dir is shared by every Codex session on the machine, and the sweeps used to
 * clear any such entry — including another session's call still running, whose
 * PostToolUse then found nothing to finalize. Now an entry is cleared only when
 * it is known to be over:
 *   - it is THIS session's and from an EARLIER turn (or the turn has ended:
 *     Stop) — every call of a finished turn has had its PostToolUse; or
 *   - it is abandoned: older than a day, whatever the session (this also covers
 *     legacy entries with no session id, which cannot be attributed until then).
 *
 * Nothing is recorded for a cleared entry. Codex reports no answer to its own
 * approval prompt, so nobody is known to have said no.
 */
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const ASK_ABANDON_MS = 24 * 60 * 60 * 1000

export function askIsOver(entry, { sessionId, turnId, turnEnded = false, now = Date.now() }) {
  if (typeof entry?.ts === 'number' && now - entry.ts > ASK_ABANDON_MS) return true
  if (!entry?.session_id || entry.session_id !== sessionId) return false
  if (turnEnded) return true
  return Boolean(turnId) && Boolean(entry.turn_id) && entry.turn_id !== turnId
}

export function clearFinishedAsks(stateDir, { sessionId, turnId, turnEnded = false } = {}) {
  let files
  try { files = readdirSync(stateDir).filter((f) => f.endsWith('.json')) } catch { return }
  for (const file of files) {
    const path = join(stateDir, file)
    let entry
    try { entry = JSON.parse(readFileSync(path, 'utf-8')) } catch { continue }
    if (!entry?.approval_required) continue
    if (!askIsOver(entry, { sessionId, turnId, turnEnded })) continue
    try { unlinkSync(path) } catch { continue } // lost the race — another hook has it
    if (entry.intent_key) {
      try { unlinkSync(join(stateDir, 'pending', `${entry.intent_key}.json`)) } catch {}
    }
  }
}

/**
 * Claim this session's ordinary (not approval_required) run-state once its turn
 * has ended, for Stop to close. Every call of an ended turn has finished, and a
 * call that succeeded had its entry consumed by PostToolUse, so what is left is a
 * call Codex reported no success for: it failed, or never completed. Another
 * session's entries are never taken. Claiming is the unlink, so a run is closed once.
 */
export function takeUnfinishedRuns(stateDir, { sessionId } = {}) {
  if (!sessionId) return []
  let files
  try { files = readdirSync(stateDir).filter((f) => f.endsWith('.json')) } catch { return [] }
  const taken = []
  for (const file of files) {
    const path = join(stateDir, file)
    let entry
    try { entry = JSON.parse(readFileSync(path, 'utf-8')) } catch { continue }
    if (!entry || entry.approval_required || !entry.run_id) continue
    if (entry.session_id !== sessionId) continue
    try { unlinkSync(path) } catch { continue } // lost the race — another hook has it
    taken.push(entry)
  }
  return taken
}
