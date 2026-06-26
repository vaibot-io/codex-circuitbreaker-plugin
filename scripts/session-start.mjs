#!/usr/bin/env node
/**
 * VAIBot Codex CLI SessionStart hook.
 *
 * Per developers.openai.com/codex/hooks: fires with `source` ∈
 * { "startup", "resume", "clear" }. We use it for two things:
 *
 *  1. Proactive bootstrap: if no API key is cached, call POST /v2/bootstrap
 *     once at session start so the very first tool call doesn't pay the
 *     bootstrap latency. Best-effort; failure leaves the cache empty and
 *     pre-tool-use will re-attempt.
 *  2. Mode banner: write a one-line stderr note announcing observe / enforce
 *     mode so the user sees VAIBot is active in their session.
 *
 * Plain text on stdout is added as developer context per Codex docs. We
 * keep stdout empty — banner goes to stderr, additional context (if any)
 * comes from the agent's tool calls themselves.
 *
 * Environment variables: same as pre-tool-use.mjs.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { resolveCredentials, saveCredsForEnv, migrateFileIfNeeded, credsPath } from '../vendor/vaibot-guard/scripts/lib/creds.mjs'

const DASHBOARD_URL = (process.env.VAIBOT_DASHBOARD_URL ?? 'https://www.vaibot.io').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.VAIBOT_TIMEOUT_MS) || 10000
const MODE = process.env.VAIBOT_MODE ?? 'observe'

// Env-namespaced credential store (see pre-tool-use.mjs). Migrate any legacy
// flat file, then resolve env + key + base URL for this session.
migrateFileIfNeeded()
const resolved = resolveCredentials()
const ENV = resolved.env
const API_URL = resolved.apiBaseUrl
const CREDS_FILE = credsPath()
const API_KEY = resolved.apiKey ?? ''

// Read the user's Codex approval_policy (informational only — we never write
// it). A regex read avoids pulling in a TOML parser, consistent with how
// postinstall.mjs manipulates config.toml. Returns the policy string or null
// if unset / unreadable.
function readApprovalPolicy() {
  try {
    const cfg = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf-8')
    const m = /^\s*approval_policy\s*=\s*["']?([a-z_-]+)["']?/m.exec(cfg)
    return m ? m[1] : null
  } catch { return null }
}

// Stable per-machine. NO cwd in the formula — matches pre-tool-use.mjs.
function getFingerprint() {
  const user = userInfo().username
  const host = hostname()
  return createHash('sha256').update(`${user}@${host}`).digest('hex')
}

async function bootstrap() {
  const fingerprint = getFingerprint()
  const res = await fetch(`${API_URL}/v2/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint, agent: 'codex' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return null
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
  return null
}

async function main() {
  // Drain stdin per Codex hook spec (JSON payload with session_id, source, etc.)
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let hookInput = {}
  try { hookInput = JSON.parse(raw) } catch { /* harmless */ }

  const source = hookInput.source ?? 'startup'

  // Proactive bootstrap on startup only — resume / clear don't need re-bootstrap.
  if (source === 'startup' && !API_KEY) {
    try { await bootstrap() } catch { /* pre-tool-use will retry */ }
  }

  // Mode banner — stderr so it doesn't pollute stdout (which Codex treats
  // as developer context).
  process.stderr.write(`VAIBot: governance active (mode=${MODE}, env=${ENV}). https://www.vaibot.io\n`)

  // Heads-up for enforce-mode users who have approval_policy = "never": they
  // might assume nothing gates their tool calls. VAIBot enforces independently
  // of Codex's approval_policy (we deny in PreToolUse before Codex's native
  // flow ever runs), so reassure them — without touching their config.
  if (MODE === 'enforce' && readApprovalPolicy() === 'never') {
    process.stderr.write(
      `VAIBot: your Codex approval_policy is "never", but VAIBot enforce gates ` +
      `independently — flagged actions are blocked regardless of that setting. ` +
      `Approve blocked actions at ${DASHBOARD_URL}/dashboard or with 'vaibot approve <hash>'.\n`,
    )
  }

  process.exit(0)
}

main().catch(() => process.exit(0))
