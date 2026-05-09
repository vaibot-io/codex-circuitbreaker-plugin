import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'scripts', 'postinstall.mjs')

function runPostinstall(home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, HOME: home, VAIBOT_SKIP_POSTINSTALL: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

test('writes managed [features] and [mcp_servers.vaibot] blocks to ~/.codex/config.toml', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-postinstall-'))
  try {
    const { code } = await runPostinstall(fakeHome)
    assert.equal(code, 0)

    const cfgPath = join(fakeHome, '.codex', 'config.toml')
    assert.ok(existsSync(cfgPath), 'config.toml created')
    const cfg = readFileSync(cfgPath, 'utf-8')

    assert.match(cfg, /# >>> vaibot-codex-circuitbreaker: features \(managed\) >>>/)
    assert.match(cfg, /\[features\]\s*\ncodex_hooks = true/)
    assert.match(cfg, /# >>> vaibot-codex-circuitbreaker: mcp \(managed\) >>>/)
    assert.match(cfg, /\[mcp_servers\.vaibot\]/)
    assert.match(cfg, /url = "https:\/\/api\.vaibot\.io\/v2\/mcp"/)
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('idempotent — running twice produces the same config', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-postinstall-'))
  try {
    await runPostinstall(fakeHome)
    const after1 = readFileSync(join(fakeHome, '.codex', 'config.toml'), 'utf-8')
    await runPostinstall(fakeHome)
    const after2 = readFileSync(join(fakeHome, '.codex', 'config.toml'), 'utf-8')
    assert.equal(after1, after2, 'second run must not change the file')
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('preserves user content outside managed blocks', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-postinstall-'))
  try {
    const cfgDir = join(fakeHome, '.codex')
    mkdirSync(cfgDir, { recursive: true })
    const userContent = '# user comment\napproval_policy = "on-request"\n\n[mcp_servers.other]\nurl = "https://other.example.com"\n'
    writeFileSync(join(cfgDir, 'config.toml'), userContent)

    await runPostinstall(fakeHome)
    const cfg = readFileSync(join(cfgDir, 'config.toml'), 'utf-8')

    assert.match(cfg, /# user comment/, 'user comment preserved')
    assert.match(cfg, /approval_policy = "on-request"/, 'user setting preserved')
    assert.match(cfg, /\[mcp_servers\.other\]/, 'unrelated MCP server preserved')
    assert.match(cfg, /\[features\]\s*\ncodex_hooks = true/, 'managed block added')
    assert.match(cfg, /\[mcp_servers\.vaibot\]/, 'vaibot MCP added')
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('user edits between markers are overwritten on re-run (managed semantics)', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-postinstall-'))
  try {
    await runPostinstall(fakeHome)
    const cfgPath = join(fakeHome, '.codex', 'config.toml')
    const tampered = readFileSync(cfgPath, 'utf-8').replace(
      'url = "https://api.vaibot.io/v2/mcp"',
      'url = "https://attacker.example.com/evil"',
    )
    writeFileSync(cfgPath, tampered)

    await runPostinstall(fakeHome)
    const cfg = readFileSync(cfgPath, 'utf-8')
    assert.match(cfg, /url = "https:\/\/api\.vaibot\.io\/v2\/mcp"/, 'managed block re-asserts the original URL')
    assert.doesNotMatch(cfg, /attacker/, 'tampered URL removed')
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('VAIBOT_SKIP_POSTINSTALL=true skips writes', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-postinstall-'))
  try {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, HOME: fakeHome, VAIBOT_SKIP_POSTINSTALL: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    await new Promise((resolve) => child.on('exit', resolve))
    assert.equal(existsSync(join(fakeHome, '.codex', 'config.toml')), false)
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})
