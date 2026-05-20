import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'scripts', 'session-start.mjs')

// Spawn session-start.mjs with HOME pointed at a temp dir so it reads our
// fixture ~/.codex/config.toml and writes creds nowhere real. API key is
// set + source=resume so no bootstrap network call fires.
function runSessionStart({ home, mode = 'enforce', source = 'resume' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        HOME: home,
        VAIBOT_MODE: mode,
        VAIBOT_API_KEY: 'test-key',
        VAIBOT_API_URL: 'http://127.0.0.1:1',
        VAIBOT_TIMEOUT_MS: '1000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stderr }))
    child.stdin.write(JSON.stringify({ source }))
    child.stdin.end()
  })
}

function makeHome(policyLine) {
  const home = mkdtempSync(join(tmpdir(), 'vaibot-ss-'))
  mkdirSync(join(home, '.codex'), { recursive: true })
  if (policyLine !== null) {
    writeFileSync(join(home, '.codex', 'config.toml'), policyLine + '\n')
  }
  return home
}

test('enforce + approval_policy="never" → heads-up fires', async () => {
  const home = makeHome('approval_policy = "never"')
  const { code, stderr } = await runSessionStart({ home, mode: 'enforce' })
  rmSync(home, { recursive: true, force: true })
  assert.equal(code, 0)
  assert.match(stderr, /approval_policy is "never"/)
  assert.match(stderr, /blocked regardless/)
})

test('enforce + approval_policy="on-request" → no heads-up', async () => {
  const home = makeHome('approval_policy = "on-request"')
  const { stderr } = await runSessionStart({ home, mode: 'enforce' })
  rmSync(home, { recursive: true, force: true })
  assert.doesNotMatch(stderr, /approval_policy is "never"/)
  assert.match(stderr, /governance active/)
})

test('observe + approval_policy="never" → no heads-up (observe is log-only)', async () => {
  const home = makeHome('approval_policy = "never"')
  const { stderr } = await runSessionStart({ home, mode: 'observe' })
  rmSync(home, { recursive: true, force: true })
  assert.doesNotMatch(stderr, /approval_policy is "never"/)
})

test('no config.toml → no heads-up, no crash', async () => {
  const home = makeHome(null)
  const { code, stderr } = await runSessionStart({ home, mode: 'enforce' })
  rmSync(home, { recursive: true, force: true })
  assert.equal(code, 0)
  assert.doesNotMatch(stderr, /approval_policy is "never"/)
})
