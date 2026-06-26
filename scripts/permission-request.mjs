#!/usr/bin/env node
/**
 * VAIBot Codex PermissionRequest hook (E-145).
 *
 * Codex fires PermissionRequest when it is about to ask the human to approve an
 * action (shell escalation, managed-network access, an MCP call, …). This hook
 * routes that decision through the local VAIBot guard so the governance verdict
 * drives the prompt:
 *   guard allow   → auto-approve   (behavior: "allow"; no human prompt)
 *   guard deny    → auto-deny      (behavior: "deny"; blocked)
 *   guard approve → decline        (empty output → Codex's NATIVE approval prompt)
 * Anything we can't decide (guard unreachable, parse error, observe mode) also
 * declines, so the human is still asked. PreToolUse remains the mandatory
 * deny-only enforcement floor; this hook is the inline allow/deny/escalate UX.
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
 * Env: VAIBOT_GUARD_BASE_URL, VAIBOT_GUARD_TOKEN, VAIBOT_API_URL, VAIBOT_API_KEY,
 *      VAIBOT_MODE (observe|enforce), VAIBOT_TIMEOUT_MS.
 */

import { createRequire } from 'node:module'
import { resolveCredentials, migrateFileIfNeeded } from '../vendor/vaibot-guard/scripts/lib/creds.mjs'
import { ensureGuardDefault } from '../vendor/vaibot-guard/scripts/lib/guard-launch.mjs'
import { decideViaGuard, guardDecisionToVerdict } from '../vendor/vaibot-guard/scripts/lib/guard-client.mjs'

const nodeRequire = createRequire(import.meta.url)

const TIMEOUT_MS = Number(process.env.VAIBOT_TIMEOUT_MS) || 10000
const MODE = process.env.VAIBOT_MODE ?? 'observe'

// Credentials are resolved (not bootstrapped) here — PreToolUse runs first and
// owns auto-bootstrap. We just hand whatever key exists to the guard so it can
// prove the receipt; an empty key still yields a valid decision.
migrateFileIfNeeded()
const resolved = resolveCredentials()
const API_URL = resolved.apiBaseUrl
const API_KEY = resolved.apiKey ?? ''

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

async function resolveGuardTarget(cwd) {
  const baseUrl = process.env.VAIBOT_GUARD_BASE_URL
  if (baseUrl) {
    try {
      const u = new URL(baseUrl)
      return { host: u.hostname, port: Number(u.port) || 39111, token: process.env.VAIBOT_GUARD_TOKEN || '' }
    } catch {
      /* fall through to launch */
    }
  }
  let guardScript
  try {
    guardScript = nodeRequire.resolve('../vendor/vaibot-guard/scripts/vaibot-guard-service.mjs')
  } catch {
    return null
  }
  const r = await ensureGuardDefault({
    guardScript,
    guardEnv: { VAIBOT_API_URL: API_URL, VAIBOT_API_KEY: API_KEY, VAIBOT_WORKSPACE: cwd || process.cwd() },
  })
  return r && r.ok ? { host: r.host, port: r.port, token: r.token } : null
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
  const sessionId = hookInput.session_id ?? `cdx-${Date.now()}`
  const cwd = hookInput.cwd ?? process.cwd()

  // vaibot's own governance tools are never gated (mirrors the PreToolUse skip).
  if (toolName.startsWith('mcp__vaibot')) process.exit(0)

  // Observe mode never auto-decides — log-only; let the native flow proceed.
  if (MODE === 'observe') {
    decline(`[observe]: PermissionRequest for ${toolName} — deferring to native approval`)
  }

  let guard = null
  try {
    guard = await resolveGuardTarget(cwd)
  } catch {
    guard = null
  }
  if (!guard) {
    decline(`guard unavailable for PermissionRequest — deferring ${toolName} to native approval`)
  }

  let result
  try {
    result = await decideViaGuard(
      guard,
      { sessionId, toolName, params: toolInput, workspaceDir: cwd },
      { timeoutMs: TIMEOUT_MS },
    )
  } catch {
    decline(`guard decide errored for ${toolName} — deferring to native approval`)
  }

  // null verdict = guard unreachable / non-2xx → human decides (PreToolUse is
  // still the hard enforcement floor for this same call).
  const verdict = guardDecisionToVerdict(result)
  if (!verdict) {
    decline(`guard returned no verdict for ${toolName} — deferring to native approval`)
  }

  if (verdict.permission === 'allow') {
    process.stderr.write(`VAIBot: auto-approved ${toolName} (${verdict.reason || 'allowed by policy'})\n`)
    emit('allow')
  }
  if (verdict.permission === 'deny') {
    emit('deny', `VAIBot denied ${toolName}: ${verdict.reason || 'policy'}`)
  }

  // permission === 'ask' → decline → Codex surfaces its native approval prompt.
  decline(`${toolName} needs approval (${verdict.reason || 'ask'}) — escalating to native prompt`)
}

main().catch(() => {
  // Never break Codex's flow on an unexpected error — defer to the human.
  process.exit(0)
})
