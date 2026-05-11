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
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'

const CREDS_DIR = join(homedir(), '.vaibot')
const CREDS_FILE = join(CREDS_DIR, 'credentials.json')

function loadSavedCredentials() {
  try {
    if (existsSync(CREDS_FILE)) return JSON.parse(readFileSync(CREDS_FILE, 'utf-8'))
  } catch { /* ignore corrupt file */ }
  return null
}

function saveCredentials(creds) {
  try {
    mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 })
  } catch { /* best-effort */ }
}

const API_URL = (process.env.VAIBOT_API_URL ?? 'https://api.vaibot.io').replace(/\/+$/, '')
const DASHBOARD_URL = (process.env.VAIBOT_DASHBOARD_URL ?? 'https://www.vaibot.io').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.VAIBOT_TIMEOUT_MS) || 10000
const MODE = process.env.VAIBOT_MODE ?? 'observe'

const savedCreds = loadSavedCredentials()
const API_KEY = process.env.VAIBOT_API_KEY ?? savedCreds?.api_key ?? ''

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
    saveCredentials({
      api_key: data.api_key,
      account_id: data.account_id,
      user_id: data.user_id,
      wallet_address: data.wallet_address,
      wallet_network: data.wallet_network,
      api_url: API_URL,
      bootstrapped_at: new Date().toISOString(),
    })
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
  process.stderr.write(`VAIBot: governance active (mode=${MODE}). https://www.vaibot.io\n`)

  process.exit(0)
}

main().catch(() => process.exit(0))
