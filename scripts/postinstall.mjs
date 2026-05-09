#!/usr/bin/env node
/**
 * Postinstall script for @vaibot/codex-circuitbreaker-plugin.
 *
 * Idempotent. Adds two managed blocks to ~/.codex/config.toml so Codex picks
 * up the plugin's hooks and the VAIBot MCP server on next session. Both blocks
 * are wrapped with comment markers so user edits between markers never get
 * overwritten.
 *
 *   1. [features] codex_hooks = true
 *      → enables Codex's hook system (verified required per
 *        developers.openai.com/codex/hooks).
 *
 *   2. [mcp_servers.vaibot]
 *      → registers VAIBot's MCP endpoint so the agent can call
 *        mcp__vaibot__status, mcp__vaibot__pending, etc.
 *
 * Note: when installed via `codex plugin marketplace add`, Codex itself loads
 * the plugin's hooks/hooks.json + .mcp.json automatically — this postinstall
 * is mainly a safety net for direct/local installs and for users who want to
 * confirm by reading their config.toml. Re-running is safe.
 *
 * Skipped when CODEX_PLUGIN_INSTALL=true (Codex's own install flow handles it),
 * or when VAIBOT_SKIP_POSTINSTALL=true.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.codex')
const CONFIG_FILE = join(CONFIG_DIR, 'config.toml')

const FEATURES_MARKER_BEGIN = '# >>> vaibot-codex-circuitbreaker: features (managed) >>>'
const FEATURES_MARKER_END = '# <<< vaibot-codex-circuitbreaker: features (managed) <<<'
const MCP_MARKER_BEGIN = '# >>> vaibot-codex-circuitbreaker: mcp (managed) >>>'
const MCP_MARKER_END = '# <<< vaibot-codex-circuitbreaker: mcp (managed) <<<'

const FEATURES_BLOCK = [
  FEATURES_MARKER_BEGIN,
  '[features]',
  'codex_hooks = true',
  FEATURES_MARKER_END,
].join('\n')

const MCP_BLOCK = [
  MCP_MARKER_BEGIN,
  '[mcp_servers.vaibot]',
  'type = "http"',
  'url = "https://api.vaibot.io/v2/mcp"',
  MCP_MARKER_END,
].join('\n')

function shouldSkip() {
  if (process.env.CODEX_PLUGIN_INSTALL === 'true') return true
  if (process.env.VAIBOT_SKIP_POSTINSTALL === 'true') return true
  return false
}

function ensureConfigDir() {
  try { mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }) } catch { /* best-effort */ }
}

function readConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return readFileSync(CONFIG_FILE, 'utf-8')
  } catch { /* best-effort */ }
  return ''
}

// Replace any existing managed block (between markers) with the new one.
// If markers aren't present, append the block.
function upsertBlock(config, beginMarker, endMarker, newBlock) {
  const beginIdx = config.indexOf(beginMarker)
  const endIdx = config.indexOf(endMarker)
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = config.slice(0, beginIdx)
    const after = config.slice(endIdx + endMarker.length)
    return before.trimEnd() + '\n\n' + newBlock + '\n' + after.trimStart()
  }
  // Marker absent — append at end of file
  const sep = config.endsWith('\n') ? '\n' : '\n\n'
  return config + sep + newBlock + '\n'
}

function main() {
  if (shouldSkip()) {
    process.stderr.write('VAIBot postinstall: skipped (CODEX_PLUGIN_INSTALL or VAIBOT_SKIP_POSTINSTALL set).\n')
    return
  }

  ensureConfigDir()
  let config = readConfig()
  config = upsertBlock(config, FEATURES_MARKER_BEGIN, FEATURES_MARKER_END, FEATURES_BLOCK)
  config = upsertBlock(config, MCP_MARKER_BEGIN, MCP_MARKER_END, MCP_BLOCK)

  try {
    writeFileSync(CONFIG_FILE, config, { mode: 0o600 })
    process.stderr.write(
      `VAIBot: wrote managed [features] and [mcp_servers.vaibot] blocks to ${CONFIG_FILE}.\n` +
      `        Restart Codex to pick up the changes.\n`
    )
  } catch (err) {
    process.stderr.write(
      `VAIBot postinstall: could not write ${CONFIG_FILE} — ${err.message}\n` +
      `        Add manually:\n\n${FEATURES_BLOCK}\n\n${MCP_BLOCK}\n`
    )
  }
}

main()
