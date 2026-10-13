#!/usr/bin/env node
/**
 * VAIBot Codex CLI Stop hook.
 *
 * At the end of a turn:
 *
 *  1. Closes this session's ordinary runs that no PostToolUse closed. Codex runs
 *     PostToolUse only for a call it counts as succeeded and has no failure hook,
 *     so a failed MCP call or apply_patch leaves its run open. Each is finalized
 *     ok:false, with the failure the transcript reports when it has one — see
 *     lib/finalize.mjs.
 *
 *  2. Clears this session's approval_required run-state that its PostToolUse
 *     never consumed (plus abandoned entries from any session) — see
 *     lib/sweep.mjs. Nothing is recorded for these. It used to PATCH the cloud
 *     `/v2/receipts/:hash/deny` for every such entry, which was wrong twice over:
 *     the only id a hook holds is the guard's LOCAL approval id, which the API
 *     does not key receipts by (so the call could only 404), and a codex
 *     escalation is never a human "No" — in enforce it is denied by the plugin
 *     and answered out-of-band, and Codex reports no answer to its own approval
 *     prompt.
 *
 * Per Codex hooks docs: Stop expects JSON only (plain text invalid). We don't
 * intervene in the stop flow; we exit with nothing on stdout.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearFinishedAsks, takeUnfinishedRuns } from './lib/sweep.mjs'
import { resolveGuard, finalizeRun, transcriptOutcome, transcriptFailure } from './lib/finalize.mjs'

const STATE_DIR = join(tmpdir(), 'vaibot-codex')

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input = {}
  try { input = JSON.parse(raw || '{}') } catch { /* sweep abandoned entries only */ }

  const sessionId = input.session_id ?? null
  const unfinished = takeUnfinishedRuns(STATE_DIR, { sessionId })
  if (unfinished.length) {
    const guard = resolveGuard()
    if (!guard) {
      process.stderr.write(`VAIBot [finalize]: no local guard reachable — ${unfinished.length} run(s) left unfinalized.\n`)
    } else {
      await Promise.all(unfinished.map((entry) => {
        const reported = transcriptFailure(transcriptOutcome(input.transcript_path, entry.tool_use_id))
        return finalizeRun(guard, entry.run_id, {
          ok: false,
          outcome: 'blocked',
          error: reported ?? 'tool call did not complete successfully',
          ...(entry.approval === 'approved' ? { approval: 'approved' } : {}),
        })
      }))
    }
  }

  clearFinishedAsks(STATE_DIR, { sessionId, turnEnded: true })
  process.exit(0)
}

main().catch(() => process.exit(0))
