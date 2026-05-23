#!/usr/bin/env node
/**
 * VAIBot Codex CLI PreToolUse hook.
 *
 * Reads tool call details from stdin (JSON), calls the VAIBot governance API,
 * and outputs a permission decision to stdout per Codex's hook spec
 * (developers.openai.com/codex/hooks).
 *
 * On first run with no API key, auto-bootstraps a free-tier account by calling
 * POST /v2/bootstrap with a machine fingerprint. Credentials are saved to
 * ~/.vaibot/credentials.json — shared across all VAIBot plugins (claudecode,
 * openclaw, codex) so a developer with multiple plugins gets one account.
 *
 * Codex-specific behaviour vs the claudecode plugin:
 *  - Codex's PreToolUse does NOT support an "ask" / "escalate-to-human" return.
 *    For approval_required outcomes (in enforce mode) the plugin DENIES with
 *    actionable instructions (dashboard URL + `vaibot approve` CLI command).
 *    The receipt is left in "blocked_until_approved" state. When the user
 *    approves out-of-band and asks the agent to retry, the saved pending-
 *    approval pointer + approved_content_hash short-circuit lets the retry
 *    pass without re-tripping the deny — the loop terminates.
 *  - In observe mode the plugin still allows (observe is log-only by design).
 *  - The previous behaviour was silent-allow + systemMessage, which depended
 *    on the user's separate Codex `approval_policy` setting to actually pause
 *    execution. That defeated enforce mode whenever `approval_policy=never`.
 *  - PostToolUse / Stop hooks still sweep pending state (PATCH /approve when
 *    a previously-approval-required call eventually runs after approval;
 *    PATCH /deny when the turn ends with the receipt still pending).
 *
 * Environment variables:
 *   VAIBOT_API_URL    — base URL of the VAIBot v2 API (default: https://api.vaibot.io)
 *   VAIBOT_API_KEY    — Bearer token for the governance API (auto-provisioned if missing)
 *   VAIBOT_MODE       — "observe" (default) or "enforce"
 *   VAIBOT_TIMEOUT_MS — request timeout in ms (default: 10000)
 *   VAIBOT_FAIL_OPEN  — "true" allows on API unreachable (default false)
 *   VAIBOT_DEBUG      — "1" enables verbose decision logging
 *
 * Exit codes:
 *   0 — success (decision in stdout JSON; see hookSpecificOutput.permissionDecision)
 *   2 — deny (reason on stderr) — alternate output channel per Codex docs
 */

import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { resolveCredentials, saveCredsForEnv, migrateFileIfNeeded, credsPath } from './lib/creds.mjs'

// ── Credentials + environment ────────────────────────────────────────────────
// One env-namespaced store (~/.vaibot/credentials.json), via the vendored copy
// of @vaibot/shared/creds. migrateFileIfNeeded upgrades any legacy flat file in
// place; resolveCredentials picks the env (production/staging) plus the matching
// key + base URL, and flags a key whose prefix names the wrong env.

migrateFileIfNeeded()
const resolved = resolveCredentials()
const ENV = resolved.env
const API_URL = resolved.apiBaseUrl
const CREDS_FILE = credsPath()
let API_KEY = resolved.apiKey ?? ''
if (resolved.keyMismatch) {
  process.stderr.write(
    `VAIBot: ignoring a stored API key whose prefix doesn't match env="${ENV}" — re-bootstrapping.\n`,
  )
}

// ── Config ──────────────────────────────────────────────────────────────────

const DASHBOARD_URL = (process.env.VAIBOT_DASHBOARD_URL ?? 'https://www.vaibot.io').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.VAIBOT_TIMEOUT_MS) || 10000
const AGENT_ID = 'codex'
const FAIL_OPEN = process.env.VAIBOT_FAIL_OPEN === 'true'
const MODE = process.env.VAIBOT_MODE ?? 'observe'

// ── Fingerprint ────────────────────────────────────────────────────────────
// Forensic correlation signal — NOT machine attestation.
// Used for bootstrap idempotency and abuse pattern detection.

// Stable per-machine. NO cwd in the formula — running the plugin from any
// directory on the same user@host yields the same bootstrap account, so a
// developer gets exactly ONE bootstrap account per machine. Cross-machine
// continuity is via the VAIBOT_API_KEY env var (copy the key from
// ~/.vaibot/credentials.json), not via fingerprint stability.
export function getFingerprint() {
  const user = userInfo().username
  const host = hostname()
  return createHash('sha256').update(`${user}@${host}`).digest('hex')
}

// ── Auto-bootstrap ─────────────────────────────────────────────────────────

async function bootstrap() {
  const fingerprint = getFingerprint()

  const res = await fetch(`${API_URL}/v2/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint, agent: AGENT_ID }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Bootstrap failed (${res.status}): ${text.slice(0, 200)}`)
  }

  const data = await res.json()

  if (data.api_key) {
    saveCredsForEnv(ENV, { api_key: data.api_key, wallet_address: data.wallet_address })
    const claimUrl = `${DASHBOARD_URL}/claim?api_key=${encodeURIComponent(data.api_key)}`
    process.stderr.write(
      `VAIBot: account provisioned. Credentials saved to ${CREDS_FILE}\n` +
      (data.wallet_address ? `VAIBot: identity ${data.wallet_address} on ${data.wallet_network}\n` : '') +
      `VAIBot: claim this account to approve from the dashboard:\n` +
      `        ${claimUrl}\n`
    )
    return data.api_key
  }

  if (data.bootstrapped === false) {
    process.stderr.write(
      `VAIBot: account exists but API key not found locally.\n` +
      `  Check ${CREDS_FILE} or set VAIBOT_API_KEY manually.\n`
    )
    return null
  }

  return null
}

// ── State file for run tracking ─────────────────────────────────────────────

const STATE_DIR = join(tmpdir(), 'vaibot-codex')
const PENDING_DIR = join(STATE_DIR, 'pending')

function saveRunState(toolCallId, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(join(STATE_DIR, `${toolCallId}.json`), JSON.stringify(state))
  } catch { /* best-effort */ }
}

// ── Ask-in-flight sweep ────────────────────────────────────────────────────
// When PreToolUse silently allowed an approval_required intent, the runState
// carries `approval_required: true`. If the user picks Yes in Codex's native
// approval flow, PostToolUse fires and PATCHes /approve. If the user picks
// No, PostToolUse never fires — the entry remains until the next hook
// (PreToolUse of a later call, or Stop) sweeps it and PATCHes /deny.
//
// Race note: claim the entry by unlinking it BEFORE issuing the network call.
// Whichever process wins the unlink owns the resolution; the loser sees
// ENOENT and bails out. Keeps the receipt event chain coherent under
// concurrent hooks.

async function sweepPendingApprovals({ excludeToolUseId } = {}) {
  let files
  try {
    files = readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'))
  } catch { return }

  for (const file of files) {
    const path = join(STATE_DIR, file)
    let entry
    try { entry = JSON.parse(readFileSync(path, 'utf-8')) } catch { continue }

    if (!entry?.approval_required) continue
    if (excludeToolUseId && entry.tool_use_id === excludeToolUseId) continue
    if (!entry.content_hash) { try { unlinkSync(path) } catch {} ; continue }

    try { unlinkSync(path) } catch { continue }  // lost the race

    try {
      await fetch(`${API_URL}/v2/receipts/${encodeURIComponent(entry.content_hash)}/deny`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch { /* best-effort */ }

    if (entry.intent_key) {
      try { unlinkSync(join(PENDING_DIR, `${entry.intent_key}.json`)) } catch {}
    }
  }
}

// ── Pending-approval state (retry awareness) ────────────────────────────────
// Untrusted hint only. Server re-verifies intent (tool + command + cwd)
// against the referenced approved receipt before honoring a short-circuit.

function intentHash(tool, command, cwd) {
  return createHash('sha256').update(`${tool}|${command ?? ''}|${cwd ?? ''}`).digest('hex').slice(0, 32)
}

function pendingPath(tool, command, cwd) {
  return join(PENDING_DIR, `${intentHash(tool, command, cwd)}.json`)
}

function readPendingApproval(tool, command, cwd) {
  try {
    const p = pendingPath(tool, command, cwd)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return null }
}

function writePendingApproval(tool, command, cwd, contentHash) {
  try {
    mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(pendingPath(tool, command, cwd), JSON.stringify({ content_hash: contentHash, ts: Date.now() }), { mode: 0o600 })
  } catch { /* best-effort */ }
}

function clearPendingApproval(tool, command, cwd) {
  try { unlinkSync(pendingPath(tool, command, cwd)) } catch { /* may not exist */ }
}

// ── Onboarding nudge (one-shot per session) ────────────────────────────────

const NUDGED_DIR = join(STATE_DIR, 'nudged')

function nudgeMarkerPath(sessionId) {
  const safe = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)
  return join(NUDGED_DIR, safe)
}

function alreadyNudged(sessionId) {
  try { return existsSync(nudgeMarkerPath(sessionId)) } catch { return false }
}

function markNudged(sessionId) {
  try {
    mkdirSync(NUDGED_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(nudgeMarkerPath(sessionId), String(Date.now()), { mode: 0o600 })
  } catch { /* best-effort */ }
}

async function maybeNudgeUnclaimed(sessionId) {
  if (alreadyNudged(sessionId)) return
  try {
    const res = await fetch(`${API_URL}/v2/accounts/me`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return
    const data = await res.json()
    if (data?.claimed === false) {
      const claimUrl = `${DASHBOARD_URL}/claim?api_key=${encodeURIComponent(API_KEY)}`
      process.stderr.write(
        `VAIBot: claim your account to approve from the dashboard.\n` +
        `        ${claimUrl}\n`
      )
      markNudged(sessionId)
    }
  } catch { /* best-effort */ }
}

async function bestEffortFinalize(runId, outcome, summary) {
  if (!runId) return
  try {
    await fetch(`${API_URL}/v2/governance/finalize/${encodeURIComponent(runId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ outcome, result: { summary } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch { /* non-blocking */ }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(str, max = 2000) {
  if (typeof str !== 'string') return str
  return str.length > max ? str.slice(0, max) + '…' : str
}

// Codex tool names (per developers.openai.com/codex/hooks):
//   Bash, apply_patch (aliases: Edit, Write), mcp__<server>__<tool>
// We map common ones to a printable command summary; unknown tools get a
// generic stringified summary so the receipt isn't blank.
function extractCommand(toolName, input) {
  if (!input) return undefined
  if (toolName === 'Bash') return clamp(input.command)
  if (toolName === 'apply_patch' || toolName === 'Edit' || toolName === 'Write') {
    return clamp(input.path ? `${toolName} ${input.path}` : toolName)
  }
  if (toolName === 'Read') return clamp(`Read ${input.path ?? input.file_path ?? ''}`)
  if (toolName.startsWith('mcp__')) {
    return clamp(`${toolName} ${JSON.stringify(input).slice(0, 200)}`)
  }
  return undefined
}

function extractTarget(toolName, input) {
  if (!input) return undefined
  if (input.path) return input.path
  if (input.file_path) return input.file_path
  if (input.url) return input.url
  return undefined
}

function extractCwd(toolName, input) {
  if (!input) return undefined
  if (input.cwd) return input.cwd
  return process.cwd()
}

function stableHash(obj) {
  const json = JSON.stringify(obj, Object.keys(obj).sort())
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Read hook input from stdin (Codex sends JSON per /codex/hooks spec)
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let hookInput
  try {
    hookInput = JSON.parse(raw)
  } catch {
    // Can't parse input — fail open to avoid blocking Codex
    process.exit(0)
  }

  // Codex stdin field names (verified 2026-05-08):
  //   tool_name, tool_use_id, tool_input, session_id, cwd, hook_event_name, model
  const toolName = hookInput.tool_name ?? 'unknown'
  const toolInput = hookInput.tool_input ?? {}
  const sessionId = hookInput.session_id ?? `cdx-${Date.now()}`
  const toolUseId = hookInput.tool_use_id ?? null
  // agent_model is the actual LLM model Codex is using this turn (e.g.
  // "gpt-5-codex"). Falls back to the agent identity when the hook
  // doesn't carry a `model` field (older Codex builds; non-turn-scoped
  // events). Used by V2 for per-model analytics + receipt attribution.
  const agentModel = typeof hookInput.model === 'string' && hookInput.model
    ? hookInput.model
    : AGENT_ID

  // Skip governance for the governance tools themselves (avoid recursion).
  // Codex MCP naming: mcp__<server>__<tool>. The hooks.json matcher *should*
  // already filter these via negative-lookahead, but defence-in-depth here.
  if (toolName.startsWith('mcp__vaibot__') || toolName.startsWith('mcp__vaibot')) {
    process.exit(0)
  }

  // No API key — try auto-bootstrap
  if (!API_KEY) {
    try {
      const bootstrapKey = await bootstrap()
      if (bootstrapKey) {
        API_KEY = bootstrapKey
      } else {
        // Bootstrap returned no key — fail open
        process.exit(0)
      }
    } catch (err) {
      process.stderr.write(`VAIBot [bootstrap]: ${err.message}\n`)
      process.exit(0) // fail open on bootstrap failure
    }
  }

  // Resolve still-pending ask-in-flight from a prior tool call.
  await sweepPendingApprovals({ excludeToolUseId: toolUseId })

  const command = extractCommand(toolName, toolInput)
  const target = extractTarget(toolName, toolInput)
  const cwd = extractCwd(toolName, toolInput)
  const toolCallId = toolUseId ?? stableHash({ toolName, ...toolInput, ts: Date.now() })

  const body = {
    session_id: sessionId,
    agent_id: AGENT_ID,
    agent_model: agentModel,
    tool: toolName,
    workspace_dir: process.cwd(),
    intent: { command, target, cwd },
  }

  // Retry awareness: if we previously got approval_required for this exact
  // intent and saved a pointer, send it. Server re-verifies intent.
  const pending = readPendingApproval(toolName, command, cwd)
  if (pending?.content_hash) {
    body.approved_content_hash = pending.content_hash
  }

  if (process.env.VAIBOT_DEBUG === '1') {
    const ih = intentHash(toolName, command, cwd)
    const pp = pendingPath(toolName, command, cwd)
    process.stderr.write(
      `VAIBot [debug] pre: tool=${toolName} cwd=${cwd} cmd=${(command ?? '').slice(0, 80)}\n` +
      `VAIBot [debug] pre: intentHash=${ih} pendingFile=${pp} pendingExists=${existsSync(pp)} sentApproved=${pending?.content_hash ?? 'none'}\n`
    )
  }

  try {
    const res = await fetch(`${API_URL}/v2/governance/decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (FAIL_OPEN || MODE === 'observe') process.exit(0)
      process.stderr.write(`VAIBot: governance API returned ${res.status}: ${text.slice(0, 200)}\n`)
      process.exit(2)
    }

    const data = await res.json()

    if (process.env.VAIBOT_DEBUG === '1') {
      process.stderr.write(
        `VAIBot [debug] post: shadow=${data.shadow_decision?.decision} effective=${data.decision?.decision} ` +
        `prevApproved=${data.previously_approved ?? false} prevDenied=${data.previously_denied ?? false} ` +
        `content_hash=${data.content_hash}\n`
      )
    }

    await maybeNudgeUnclaimed(sessionId)

    // Prefer shadow_decision (raw policy verdict) over decision (post-server-
    // observe-mode coercion).
    const rawDecision = data.shadow_decision?.decision ?? data.decision?.decision
    const rawReason = data.shadow_decision?.reason ?? data.decision?.reason

    // Save run state for post-tool-use finalization
    saveRunState(toolCallId, {
      run_id: data.run_id,
      content_hash: data.content_hash,
      receipt_id: data.receipt_id,
      decision: rawDecision,
      risk: data.risk?.risk,
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_use_id: toolUseId,
      approval_required: rawDecision === 'approval_required' && !data.previously_approved,
      intent_key: intentHash(toolName, command, cwd),
      ts: Date.now(),
    })

    // ── Observe mode: silent-allow, log raw verdict ──
    if (MODE === 'observe') {
      if (rawDecision && rawDecision !== 'allow') {
        process.stderr.write(
          `VAIBot [observe]: ${toolName} would be ${rawDecision} — ${rawReason}\n`
        )
      }
      process.exit(0)
    }

    // ── Enforce mode: act on the raw decision ──
    const decision = data.previously_approved ? 'allow' : rawDecision

    if (decision === 'allow') {
      clearPendingApproval(toolName, command, cwd)
      // Codex: omitting permissionDecision = allow. No output needed.
      process.exit(0)
    }

    if (decision === 'approval_required') {
      const reason = rawReason ?? `Approval required for ${toolName}`
      const contentHash = data.content_hash ?? ''
      const riskLabel = data.risk?.risk ?? 'elevated'

      // Save pointer so the retry of this exact intent can short-circuit. On
      // the next PreToolUse for the same (tool, command, cwd), the plugin
      // reads this pointer, sends approved_content_hash, and the server
      // returns previously_approved=true → decision coerced to allow.
      if (contentHash) writePendingApproval(toolName, command, cwd, contentHash)

      // Enforce mode: actually block. Codex's PreToolUse can't escalate-to-
      // human like Claude Code's 'ask', so the plugin issues a deny with
      // actionable approval instructions in the reason text. The agent sees
      // the deny and stops; the user approves out-of-band (dashboard or CLI);
      // when the agent retries, the saved pending-approval pointer triggers
      // the approved_content_hash short-circuit → server returns
      // previously_approved=true → plugin allows. The replay terminates.
      //
      // This is the corrected behaviour vs the previous silent-allow, which
      // depended on the user's separate Codex approval_policy setting and
      // therefore failed to enforce when approval_policy = "never". The
      // whole point of enforce mode is to stop unsafe actions; we now do.
      const approveUrl = contentHash
        ? `${DASHBOARD_URL}/verify/decision/${encodeURIComponent(contentHash)}`
        : `${DASHBOARD_URL}/dashboard`
      const denyReason =
        `VAIBot blocked this ${toolName} call — ${riskLabel} risk: ${reason}\n` +
        (contentHash ? `content_hash: ${contentHash}\n` : '') +
        `\nTo approve and retry, do ONE of:\n` +
        `  • Open ${approveUrl}\n` +
        (contentHash ? `  • Run: vaibot approve ${contentHash}\n` : '') +
        `\nAfter approving, ask the agent to retry the same action — the\n` +
        `plugin will short-circuit on the cached approval and allow it.`

      // Record the pre-approval state on the receipt chain so the audit
      // trail reflects "blocked pending user decision" rather than dangling.
      await bestEffortFinalize(
        data.run_id, 'blocked_until_approved',
        `Plugin enforced: approval_required pending user decision`,
      )

      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: denyReason,
        },
      }
      process.stdout.write(JSON.stringify(output))
      process.stderr.write(`VAIBot: ${denyReason}\n`)
      process.exit(0)
    }

    if (decision === 'deny') {
      const reason = rawReason ?? `Denied by policy for ${toolName}`
      clearPendingApproval(toolName, command, cwd)
      await bestEffortFinalize(data.run_id, 'blocked', `Plugin enforced: deny`)
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        }
      }
      process.stdout.write(JSON.stringify(output))
      process.exit(0)
    }

    // Unknown decision — fail open
    process.exit(0)

  } catch (err) {
    if (FAIL_OPEN || MODE === 'observe') {
      process.stderr.write(`VAIBot [error]: ${err.message}\n`)
      process.exit(0)
    }
    process.stderr.write(`VAIBot: governance API unreachable — ${err.message}\n`)
    process.exit(2)
  }
}

main().catch((err) => {
  process.stderr.write(`VAIBot: unexpected error — ${err.message}\n`)
  process.exit(FAIL_OPEN ? 0 : 2)
})
