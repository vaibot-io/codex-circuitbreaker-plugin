#!/usr/bin/env node
/**
 * VAIBot Codex PermissionRequest hook (E-145).
 *
 * Codex fires PermissionRequest when it is about to ask the human to approve an
 * action (shell escalation, managed-network access, an MCP call, …). By then
 * PreToolUse has already decided the same call through the guard, so this hook
 * answers from that decision instead of deciding again:
 *   allowed (or approved while held) → auto-approve (behavior: "allow"; no human prompt)
 *   denied                           → auto-deny    (behavior: "deny")
 *   anything else                    → decline      (empty output → Codex's NATIVE prompt)
 *
 * Deciding again opened a second guard run for a call that already had one, and
 * nothing ever closed it: every escalated command left one behind. It also read
 * the local VAIBOT_MODE instead of the mode the guard reported.
 *
 * The run is found by session + tool + the call itself (lib/call-key.mjs):
 * Codex's PermissionRequest has no tool_use_id, and for a shell command its
 * tool_input adds a `description`. No run found → decline, so the human is
 * asked; PreToolUse remains the enforcement floor.
 *
 * Contract (developers.openai.com/codex/hooks — verified 2026-06-01):
 *   allow:   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
 *   deny:    {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"…"}}}
 *   decline: exit 0 with empty stdout (no decision) → normal approval flow.
 *   Reserved / fail-closed — never return: updatedInput, updatedPermissions, interrupt.
 *
 * Input on stdin (PermissionRequest): session_id, cwd, hook_event_name, model,
 *   permission_mode, turn_id, tool_name, tool_input.
 *
 * Env: VAIBOT_MODE (observe|enforce) — used only when the run has no mode recorded.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callKey, commandKey } from './lib/call-key.mjs'

const MODE = process.env.VAIBOT_MODE ?? 'enforce'
const STATE_DIR = join(tmpdir(), 'vaibot-codex')
// A PreToolUse run older than this is not the call being asked about.
const MAX_RUN_AGE_MS = 10 * 60 * 1000

// Decline = exit 0 with empty stdout → Codex runs its normal approval flow (the
// human is prompted). The safe default whenever we can't / shouldn't auto-decide.
function decline(note) {
  if (note) process.stderr.write(`VAIBot: ${note}\n`)
  process.exit(0)
}

function emit(behavior, message) {
  const decision =
    behavior === 'deny'
      ? { behavior: 'deny', message: message || 'Denied by VAIBot policy' }
      : { behavior: 'allow' }
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }),
  )
  process.exit(0)
}

/** The run PreToolUse decided for this call, or null. Read-only: PostToolUse still owns it. */
function findRun(stateDir, { sessionId, turnId, toolName, toolInput, cwd, now = Date.now() }) {
  const exact = callKey(toolName, toolInput, cwd)
  const byCommand = commandKey(toolName, toolInput)
  let best = null
  let files = []
  try { files = readdirSync(stateDir).filter((f) => f.endsWith('.json')) } catch { return null }
  for (const file of files) {
    let entry
    try { entry = JSON.parse(readFileSync(join(stateDir, file), 'utf-8')) } catch { continue }
    if (!entry?.run_id || entry.session_id !== sessionId || entry.tool_name !== toolName) continue
    if (typeof entry.ts !== 'number' || now - entry.ts > MAX_RUN_AGE_MS) continue
    if (turnId && entry.turn_id && entry.turn_id !== turnId) continue
    const matches = entry.intent_key === exact || (byCommand !== null && entry.command_key === byCommand)
    if (!matches) continue
    if (!best || entry.ts > best.ts) best = entry
  }
  return best
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let hookInput
  try {
    hookInput = JSON.parse(raw)
  } catch {
    decline('PermissionRequest input unparseable — deferring to native approval')
  }

  const toolName = hookInput.tool_name ?? 'unknown'
  const toolInput = hookInput.tool_input ?? {}
  const sessionId = hookInput.session_id ?? null
  const turnId = hookInput.turn_id ?? null
  const cwd = toolInput.cwd ?? hookInput.cwd ?? process.cwd()

  // vaibot's own governance tools are never gated (mirrors the PreToolUse skip).
  // Governance tools are exempt so a governance call cannot recurse into governing
  // itself, and so an operator can still lift containment from inside the agent.
  //
  // Matched at the namespace boundary, NOT as a bare prefix. Codex names MCP
  // tools `mcp__<server>__<tool>`, so an exemption that any name merely BEGINNING
  // with `mcp__vaibot` satisfied would hand a server called `vaibotage` a whole
  // tool namespace that is never governed at all -- no containment, no floor,
  // nothing. This check runs before the containment check below, so that gap was a
  // way around the account-wide stop.
  if (toolName === 'mcp__vaibot' || toolName.startsWith('mcp__vaibot__')) process.exit(0)

  if (!sessionId) decline(`no session for PermissionRequest — deferring ${toolName} to native approval`)

  const run = findRun(STATE_DIR, { sessionId, turnId, toolName, toolInput, cwd })
  if (!run) decline(`no VAIBot decision found for ${toolName} — deferring to native approval`)

  // Observe mode never auto-decides — log-only; let the native flow proceed.
  const mode = run.effective_mode === 'observe' || run.effective_mode === 'enforce' ? run.effective_mode : MODE
  if (mode === 'observe') {
    decline(`[observe]: PermissionRequest for ${toolName} — deferring to native approval`)
  }

  if (run.approval === 'approved' || run.decision === 'allow') {
    process.stderr.write(`VAIBot: auto-approved ${toolName} (${run.approval === 'approved' ? 'approved in VAIBot' : 'allowed by policy'})\n`)
    emit('allow')
  }
  if (run.decision === 'deny') {
    emit('deny', `VAIBot denied ${toolName}: policy`)
  }

  // Needs a person's answer → decline → Codex surfaces its native approval prompt.
  decline(`${toolName} needs approval — escalating to native prompt`)
}

main().catch(() => {
  // Never break Codex's flow on an unexpected error — defer to the human.
  process.exit(0)
})
