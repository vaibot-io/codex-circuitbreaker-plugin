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
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, unlinkSync, chmodSync, renameSync } from 'node:fs'
import { tmpdir, hostname, homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { resolveCredentials, saveCredsForEnv, migrateFileIfNeeded, credsPath } from '../vendor/vaibot-guard/scripts/lib/creds.mjs'
import {
  CircuitBreaker,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_WINDOW_MS,
  DEFAULT_COOLDOWN_MS,
} from '../vendor/vaibot-guard/scripts/lib/circuit-breaker.mjs'
import { classify, VERDICT } from '../vendor/vaibot-guard/scripts/classifier.mjs'
import { ensureGuardDefault } from '../vendor/vaibot-guard/scripts/lib/guard-launch.mjs'
import { decideViaGuard } from '../vendor/vaibot-guard/scripts/lib/guard-client.mjs'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

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
// Default posture is ENFORCE. When the guard is reachable it publishes the
// account's effective_mode (which wins); this default only governs the guard-DOWN
// fallback, where enforce degrades *conditionally* (see applyGuardDownDecision)
// instead of blanket-denying a fresh install.
const MODE = process.env.VAIBOT_MODE ?? 'enforce'

// ── Circuit breaker ────────────────────────────────────────────────────────
// Local fallback. Sliding-window failure counter: N transient API errors
// (5xx / network) inside windowMs trip the breaker for cooldownMs. While
// tripped, tools are decided LOCALLY by the risk classifier — classifier-safe
// tools pass, the denylist blocks, and anything the classifier would ask/deny
// gets a deny-with-reason (we can't prompt for approval while offline). 401/403
// (auth) and other 4xx (real verdicts) do NOT count as transient failures.
// State lives in ~/.vaibot/breaker-state/codex.json so trip state survives
// Codex restarts.
//
// There is NO allowlist: "safe to pass" is computed by the classifier on every
// call, never granted and remembered. To functionally disable the breaker, set
// VAIBOT_BREAKER_FAILURE_THRESHOLD to a number you'll never reach.

function parseList(envVal, fallback) {
  if (!envVal || envVal.trim() === '') return fallback
  return envVal.split(',').map((s) => s.trim()).filter(Boolean)
}

const BREAKER_CFG = {
  failureThreshold:
    Number(process.env.VAIBOT_BREAKER_FAILURE_THRESHOLD) || DEFAULT_FAILURE_THRESHOLD,
  windowMs: Number(process.env.VAIBOT_BREAKER_WINDOW_MS) || DEFAULT_WINDOW_MS,
  cooldownMs: Number(process.env.VAIBOT_BREAKER_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS,
  denylist: parseList(process.env.VAIBOT_BREAKER_DENYLIST, []),
}

const BREAKER_STATE_DIR = join(homedir(), '.vaibot', 'breaker-state')
const BREAKER_STATE_FILE = join(BREAKER_STATE_DIR, 'codex.json')

function loadBreakerSnapshot() {
  try {
    const raw = JSON.parse(readFileSync(BREAKER_STATE_FILE, 'utf-8'))
    return raw?.breaker ?? null
  } catch {
    return null
  }
}

function saveBreakerSnapshot(snap) {
  try {
    mkdirSync(BREAKER_STATE_DIR, { recursive: true, mode: 0o700 })
    chmodSync(BREAKER_STATE_DIR, 0o700)
    const tmp = `${BREAKER_STATE_FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, breaker: snap, updated_at: Date.now() }) + '\n',
      { mode: 0o600 },
    )
    renameSync(tmp, BREAKER_STATE_FILE)
  } catch {
    /* best-effort — state is an optimization, not correctness-critical */
  }
}

// Emits a deny / allow when the breaker is tripped. Returns nothing; caller
// is expected to exit(0) and persist the breaker snapshot after this fires.
// In observe mode the breadcrumb-and-allow path is preserved (observe never
// blocks). In enforce, the decision is made LOCALLY by the risk classifier:
//   denylist            → deny (un-overridable safety floor)
//   classifier "allow"  → allow with breadcrumb (classifier-safe)
//   classifier ask/deny → deny with reason (can't prompt for approval offline)
function applyBreakerTrippedDecision(breaker, toolName, toolInput) {
  if (MODE === 'observe') {
    process.stderr.write(
      `VAIBot [breaker observe]: tripped — would re-decide ${toolName} ` +
      `locally [observe mode allows]\n`,
    )
    return
  }

  if (breaker.isDenied(toolName)) {
    emitBreakerDeny(`VAIBot circuit breaker tripped — ${toolName} is in the breaker denylist.`)
    return
  }

  const verdict = classify({ tool: toolName, input: toolInput })
  if (verdict.verdictHint === VERDICT.ALLOW) {
    process.stderr.write(
      `VAIBot [breaker]: tripped — classifier pass-through (${verdict.risk}) for ${toolName}\n`,
    )
    return
  }

  const cooldownSec = Math.round(BREAKER_CFG.cooldownMs / 1000)
  emitBreakerDeny(
    `VAIBot circuit breaker tripped — V2 governance API failed ${BREAKER_CFG.failureThreshold}+ times recently.\n` +
    `${toolName} classified ${verdict.risk} (${verdict.reasons[0] ?? 'n/a'}); the classifier can't pass it ` +
    `automatically and approval can't be requested while offline. Blocked until cooldown (${cooldownSec}s) or API recovery.`,
  )
}

function emitBreakerDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.stderr.write(`VAIBot: ${reason}\n`)
}

// Cold start = a machine where the guard has never written a rendezvous lock.
// Conditions the guard-unreachable degrade: a fresh install (no lock) may still be
// bringing the daemon up, so it degrades to the local floor instead of bricking;
// an established install whose lock is present but now unreachable is treated as
// possible tampering and stays fail-closed. Same-user best-effort — a deleted lock
// can spoof cold-start, which is why guard-down still audits + alerts either way.
function isColdStart() {
  try {
    return !existsSync(join(homedir(), '.vaibot', 'guard', 'guard.json'))
  } catch {
    return false // unreadable → do NOT assume fresh; fail toward fail-closed
  }
}

// Guard unreachable under enforce → conditioned degrade (NOT a blanket allow):
//  * the catastrophic floor is enforced LOCALLY in every case (classifier
//    DANGEROUS → deny), so rm -rf /, guard self-protection, fork bombs, etc. are
//    blocked even with no daemon running;
//  * cold start (fresh install, no rendezvous lock) → allow-with-audit so the box
//    can bootstrap the daemon;
//  * established install (lock present) but daemon gone and un-relaunchable →
//    possible tampering → stay fail-closed (deny) + alert.
function applyGuardDownDecision(toolName, toolInput) {
  const verdict = classify({ tool: toolName, input: toolInput })
  const dangerous = verdict.verdictHint === VERDICT.DENY
  // Cold start (fresh install, no rendezvous lock) + non-catastrophic → degrade to
  // allow-with-audit so the box can bring the daemon up. Dangerous still denies.
  if (isColdStart() && !dangerous) {
    process.stderr.write(
      `VAIBot [degraded]: guard not up yet (fresh install) — ${toolName} allowed with audit; ` +
      `catastrophic floor still enforced. If the guard never comes up, see ~/.vaibot/guard/launch.log.\n`,
    )
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    }))
    process.exit(0)
  }
  // Catastrophic floor (any install) OR an established install whose guard is gone
  // and un-relaunchable (possible tampering) → fail-closed hard deny (exit 2).
  process.stderr.write(
    dangerous
      ? `VAIBot: denying ${toolName} — catastrophic floor (${verdict.reasons?.[0] ?? 'dangerous action'}), enforced with no daemon.\n`
      : `VAIBot: denying ${toolName} — guard ran here but is now unreachable and un-relaunchable (possible tampering). See ~/.vaibot/guard/launch.log.\n`,
  )
  process.exit(2)
}

// No usable API key (bootstrap can't provision one — the account already exists but the
// local key was lost, or the endpoint is unreachable) → do NOT brick. Govern LOCALLY via
// the classifier so safe work + `vaibot login` recovery proceed while the catastrophic
// floor still holds. Codex can't escalate-to-human like Claude Code, so a risky verdict
// is held (deny + login hint) rather than prompted — safe tools still run, which is
// enough for the user to recover the key.
function applyNoKeyDecision(toolName, toolInput) {
  if (MODE === 'observe' || FAIL_OPEN) return // codex: no output = allow
  const verdict = classify({ tool: toolName, input: toolInput })
  if (verdict.verdictHint === VERDICT.ALLOW) return // allow
  const floor = verdict.verdictHint === VERDICT.DENY
  const reason = floor
    ? `VAIBot floor — ${toolName} blocked (${verdict.reasons?.[0] ?? 'catastrophic action'}), enforced even without an API key.`
    : `VAIBot held ${toolName} (${verdict.risk} risk) — no API key, so it can't be sent for approval. Run \`vaibot login\` to restore governance + approvals. Safe tools still run.`
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }))
  process.stderr.write(`VAIBot: ${reason}\n`)
}

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

// State files contain run IDs, content hashes, intent hashes, and tool names —
// not credentials, but enumerable metadata about agent activity. Keep STATE_DIR
// 0o700 and state files 0o600 so other local users on a shared host can't read
// them. mkdirSync only applies `mode` to dirs it creates, so chmod legacy dirs
// from older plugin versions (which used default umask) on every touch.
function ensureStateDir() {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    chmodSync(STATE_DIR, 0o700)
  } catch { /* best-effort */ }
}

function saveRunState(toolCallId, state) {
  try {
    ensureStateDir()
    writeFileSync(join(STATE_DIR, `${toolCallId}.json`), JSON.stringify(state), { mode: 0o600 })
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

    // Guard approvals self-expire server-side; the sweep only cleans stale
    // local run-state (no network call).
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
    ensureStateDir()
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
    ensureStateDir()
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

function extractCwd(toolName, input) {
  if (!input) return undefined
  if (input.cwd) return input.cwd
  return process.cwd()
}

function stableHash(obj) {
  const json = JSON.stringify(obj, Object.keys(obj).sort())
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}

// ── Guard resolution (Direction A) ───────────────────────────────────────────
// Resolve the local guard to route the decision through. If VAIBOT_GUARD_BASE_URL
// is set, use it directly (external guard / test seam); otherwise discover-or-
// launch @vaibot/guard via ensureGuardDefault, handing it the resolved creds so
// it can prove receipts. Returns null when no guard can be reached/launched —
// the caller treats that as a transient outage (breaker + classifier fallback).
async function resolveGuardTarget(cwd) {
  const baseUrl = process.env.VAIBOT_GUARD_BASE_URL
  if (baseUrl) {
    try {
      const u = new URL(baseUrl)
      return { host: u.hostname, port: Number(u.port) || 39111, token: process.env.VAIBOT_GUARD_TOKEN || '' }
    } catch { /* fall through to launch */ }
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Read hook input from stdin (Codex sends JSON per /codex/hooks spec)
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let hookInput
  try {
    hookInput = JSON.parse(raw)
  } catch {
    // Fail-closed: an unparseable tool call can't be governed → deny in enforce.
    // Observe / FAIL_OPEN keep the old non-blocking behavior.
    if (FAIL_OPEN || MODE === 'observe') process.exit(0)
    process.stderr.write('VAIBot: could not parse hook input — denying (fail-closed)\n')
    process.exit(2)
  }

  // Codex stdin field names (verified 2026-05-08):
  //   tool_name, tool_use_id, tool_input, session_id, cwd, hook_event_name, model
  const toolName = hookInput.tool_name ?? 'unknown'
  const toolInput = hookInput.tool_input ?? {}
  const sessionId = hookInput.session_id ?? `cdx-${Date.now()}`
  const toolUseId = hookInput.tool_use_id ?? null

  // Skip governance for the governance tools themselves (avoid recursion).
  // Codex MCP naming: mcp__<server>__<tool>. The hooks.json matcher *should*
  // already filter these via negative-lookahead, but defence-in-depth here.
  if (toolName.startsWith('mcp__vaibot__') || toolName.startsWith('mcp__vaibot')) {
    process.exit(0)
  }

  // No API key — try auto-bootstrap. If it can't yield a key (account already exists
  // and the local key was lost, or the endpoint is unreachable), do NOT fail-closed
  // and brick — govern LOCALLY via the classifier so safe work + `vaibot login`
  // recovery proceed while the catastrophic floor still holds.
  if (!API_KEY) {
    try {
      const bootstrapKey = await bootstrap()
      if (bootstrapKey) {
        API_KEY = bootstrapKey
      } else {
        process.stderr.write('VAIBot: no API key — governing locally (safe tools run, risky held, floor enforced). Run `vaibot login` to restore server-backed governance + approvals.\n')
        applyNoKeyDecision(toolName, toolInput)
        process.exit(0)
      }
    } catch (err) {
      process.stderr.write(`VAIBot [bootstrap]: ${err.message} — governing locally until a key is available.\n`)
      applyNoKeyDecision(toolName, toolInput)
      process.exit(0)
    }
  }

  // Resolve still-pending ask-in-flight from a prior tool call.
  await sweepPendingApprovals({ excludeToolUseId: toolUseId })

  // ── Breaker check (before any API call) ──
  // Load persisted state from disk and check trip. Tripped → decide locally and
  // exit before incurring another API attempt. isTripped() auto-resets state if
  // the cooldown has elapsed; save the snapshot either way so the reset persists.
  const breaker = new CircuitBreaker(BREAKER_CFG)
  breaker.load(loadBreakerSnapshot())
  if (breaker.isTripped()) {
    applyBreakerTrippedDecision(breaker, toolName, toolInput)
    saveBreakerSnapshot(breaker.snapshot())
    process.exit(0)
  }

  const command = extractCommand(toolName, toolInput)
  const cwd = extractCwd(toolName, toolInput)
  const toolCallId = toolUseId ?? stableHash({ toolName, ...toolInput, ts: Date.now() })

  // Retry awareness: if we previously got approval_required for this exact
  // intent and saved a pointer, present it to the guard for redemption.
  const pending = readPendingApproval(toolName, command, cwd)

  if (process.env.VAIBOT_DEBUG === '1') {
    const ih = intentHash(toolName, command, cwd)
    const pp = pendingPath(toolName, command, cwd)
    process.stderr.write(
      `VAIBot [debug] pre: tool=${toolName} cwd=${cwd} cmd=${(command ?? '').slice(0, 80)}\n` +
      `VAIBot [debug] pre: intentHash=${ih} pendingFile=${pp} pendingExists=${existsSync(pp)} sentApproved=${pending?.content_hash ?? 'none'}\n`
    )
  }

  try {
    // Direction A: route the decision through the local guard — it decides AND
    // proves the receipt. On guard-unreachable, fall back to the breaker +
    // classifier; a 4xx (e.g. 401) is a real response, not a transient outage.
    const guard = await resolveGuardTarget(cwd)
    if (!guard) {
      breaker.recordFailure('guard unavailable')
      saveBreakerSnapshot(breaker.snapshot())
      if (breaker.isTripped()) { applyBreakerTrippedDecision(breaker, toolName, toolInput); process.exit(0) }
      if (FAIL_OPEN || MODE === 'observe') process.exit(0)
      applyGuardDownDecision(toolName, toolInput)
      process.exit(0)
    }

    const result = await decideViaGuard(
      guard,
      { sessionId, toolName, params: toolInput, workspaceDir: cwd, approvalId: pending?.content_hash },
      { timeoutMs: TIMEOUT_MS },
    )

    if (!result.ok) {
      if (result.unreachable) {
        breaker.recordFailure(`guard ${result.status ?? 'unreachable'}`)
        saveBreakerSnapshot(breaker.snapshot())
        if (breaker.isTripped()) { applyBreakerTrippedDecision(breaker, toolName, toolInput); process.exit(0) }
        if (FAIL_OPEN || MODE === 'observe') process.exit(0)
        process.stderr.write(`VAIBot: guard decide failed (${result.status ?? 'network'}) — denying ${toolName}\n`)
        process.exit(2)
      }
      if (FAIL_OPEN || MODE === 'observe') process.exit(0)
      process.stderr.write(`VAIBot: guard returned ${result.status} — denying ${toolName}\n`)
      process.exit(2)
    }

    // Guard reachable → reset the breaker's failure window.
    breaker.recordSuccess()
    saveBreakerSnapshot(breaker.snapshot())

    // The guard publishes the server-resolved account mode; it is authoritative on
    // this ONLINE path (the guard answered). VAIBOT_MODE stays the fallback only
    // when the guard is older/silent (field absent) — and on the offline/breaker
    // paths above, where there is no guard answer at all.
    const effectiveMode =
      result.effective_mode === 'observe' || result.effective_mode === 'enforce'
        ? result.effective_mode
        : MODE

    // Adapt the guard's decision into the shape the downstream consumes
    // (approve → approval_required; the approvalId rides as content_hash).
    const guardDecision = result.decision === 'approve' ? 'approval_required' : result.decision
    const data = {
      run_id: result.runId,
      content_hash: result.approvalId ?? '',
      receipt_id: null,
      risk: result.risk && typeof result.risk === 'object' ? result.risk : { risk: result.risk ?? null },
      decision: { decision: guardDecision, reason: result.reason },
      shadow_decision: { decision: guardDecision, reason: result.reason },
      previously_approved: !!pending?.content_hash && result.decision === 'allow',
    }

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

    // ── Observe mode: log raw verdict and allow — EXCEPT the un-overridable
    // catastrophic floor (Tier-0), which blocks even in observe. Uses the
    // guard-resolved effectiveMode (not the local VAIBOT_MODE) on this path. ──
    if (effectiveMode === 'observe') {
      if (rawDecision && rawDecision !== 'allow') {
        process.stderr.write(
          `VAIBot [observe]: ${toolName} would be ${rawDecision} — ${rawReason}\n`
        )
      }
      if (rawDecision === 'deny' && result.floor === true) {
        const output = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `VAIBot blocked (catastrophic floor, enforced even in observe) — ${rawReason}`,
          },
        }
        process.stdout.write(JSON.stringify(output))
        process.exit(0)
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

    // Unknown decision — fail-closed: deny an unrecognized verdict (past the
    // observe gate, so only an explicit FAIL_OPEN keeps it non-blocking).
    if (FAIL_OPEN) process.exit(0)
    process.stderr.write('VAIBot: unrecognized guard decision — denying (fail-closed)\n')
    process.exit(2)

  } catch (err) {
    // Breaker accounting: network errors / timeouts are transient.
    breaker.recordFailure(`network: ${err.message}`)
    saveBreakerSnapshot(breaker.snapshot())
    if (breaker.isTripped()) {
      applyBreakerTrippedDecision(breaker, toolName, toolInput)
      process.exit(0)
    }

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
