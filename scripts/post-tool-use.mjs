#!/usr/bin/env node
/**
 * VAIBot Codex CLI PostToolUse hook.
 *
 * Reads tool result from stdin (JSON), finds the matching run state from
 * pre-tool-use, and calls the VAIBot finalize endpoint to close the receipt.
 *
 * In the v0.1 enforce flow, approval_required intents are DENIED by
 * pre-tool-use, so the tool doesn't execute and PostToolUse doesn't fire
 * for the blocked attempt. On retry after out-of-band approval, the
 * server returns previously_approved=true and pre-tool-use saves runState
 * with `approval_required: false` — so the opportunistic PATCH /approve
 * branch below is mostly defensive (it would fire only if some other
 * code path saved an approval_required runState that subsequently ran).
 *
 * Environment variables:
 *   VAIBOT_API_URL    — base URL of the VAIBot v2 API (default: https://api.vaibot.io)
 *   VAIBOT_API_KEY    — Bearer token for the governance API
 *   VAIBOT_TIMEOUT_MS — request timeout in ms (default: 10000)
 */

import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCredentials, credsPath } from './lib/creds.mjs'

const CREDS_FILE = credsPath()
const resolved = resolveCredentials()
const API_URL = resolved.apiBaseUrl
const API_KEY = resolved.apiKey ?? ''
const TIMEOUT_MS = Number(process.env.VAIBOT_TIMEOUT_MS) || 10000

const STATE_DIR = join(tmpdir(), 'vaibot-codex')
const MAX_STATE_AGE_MS = 5 * 60 * 1000 // 5 minutes

function findRunState(toolName, toolUseId) {
  try {
    const files = readdirSync(STATE_DIR).filter(f => f.endsWith('.json'))
    const now = Date.now()
    let bestMatch = null
    let bestTs = 0

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(STATE_DIR, file), 'utf-8'))

        // Expire ordinary entries after 5min. Approval-required entries live
        // until a hook sweeps them — human decisions can outlast the normal
        // expiry window.
        if (!data.approval_required && now - data.ts > MAX_STATE_AGE_MS) {
          try { unlinkSync(join(STATE_DIR, file)) } catch { /* ignore */ }
          continue
        }

        // Prefer exact tool_use_id match; fall back to most-recent tool_name.
        if (toolUseId && data.tool_use_id === toolUseId) {
          bestMatch = { ...data, file }
          break
        }
        if (data.tool_name === toolName && data.ts > bestTs) {
          bestMatch = { ...data, file }
          bestTs = data.ts
        }
      } catch { /* ignore corrupt files */ }
    }

    // Claim the matched state file before any network call. Race protection.
    if (bestMatch) {
      try { unlinkSync(join(STATE_DIR, bestMatch.file)) }
      catch { return null }
    }

    return bestMatch
  } catch {
    return null
  }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let hookInput
  try {
    hookInput = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  // Codex stdin field names for PostToolUse (verified 2026-05-08):
  //   tool_name, tool_use_id, tool_input, tool_response
  const toolName = hookInput.tool_name ?? 'unknown'
  const toolUseId = hookInput.tool_use_id ?? null
  const toolResponse = hookInput.tool_response ?? null

  // Detect failure from tool_response. Codex's response shape isn't fully
  // standardised across tool kinds — be defensive.
  const error = toolResponse?.error ?? toolResponse?.is_error ?? null
  const durationMs = hookInput.duration_ms ?? null

  // Skip governance tools
  if (toolName.startsWith('mcp__vaibot__') || toolName.startsWith('mcp__vaibot')) process.exit(0)

  const runState = findRunState(toolName, toolUseId)
  if (!runState?.run_id) process.exit(0)

  if (!API_KEY) {
    process.stderr.write(
      `VAIBot [finalize]: no API key — receipt ${runState.run_id} left unfinalized. ` +
      `Set VAIBOT_API_KEY or ensure ${CREDS_FILE} is readable.\n`
    )
    process.exit(0)
  }

  // Defensive: if a runState somehow reaches PostToolUse with
  // approval_required still true (e.g. legacy entries from a prior plugin
  // version, or a future code path that saves the flag), PATCH /approve
  // so the receipt's approval_status doesn't stay pending forever. In the
  // current enforce flow this branch is effectively unreachable — pre-tool-
  // use denies approval_required intents, so the tool doesn't execute and
  // PostToolUse doesn't fire. Retries with previously_approved=true save
  // runState with approval_required=false.
  if (runState.approval_required && runState.content_hash) {
    try {
      await fetch(`${API_URL}/v2/receipts/${encodeURIComponent(runState.content_hash)}/approve`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch { /* best-effort — don't block finalize */ }
  }

  const outcome = error ? 'blocked' : 'allowed'

  const result = {}
  if (typeof durationMs === 'number') result.duration_ms = durationMs
  if (error) result.error = String(error).slice(0, 2000)
  const body = { outcome, ...(Object.keys(result).length > 0 ? { result } : {}) }

  try {
    await fetch(`${API_URL}/v2/governance/finalize/${encodeURIComponent(runState.run_id)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Best-effort finalization — don't block the session
  }

  process.exit(0)
}

main().catch(() => process.exit(0))
