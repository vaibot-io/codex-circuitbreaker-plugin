import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// End-to-end integration smoke for the env-namespaced credential store, run
// against the REAL wired pre-tool-use hook (not the resolver in isolation).
// A local stub stands in for the VAIBot API; VAIBOT_CREDS_DIR points the store
// at a temp dir. Proves the integrated wiring: per-env bootstrap, no cross-env
// clobber, correct key per env, the prefix guard, and v1→v2 migration.
//
// Complements the byte-parity test (vendored copy == @vaibot/shared source) and
// the unit tests in @vaibot/shared (resolver/store logic in isolation).

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pre-tool-use.mjs')

let server
let API_URL = ''
let requests = []
let bootstrapKey = 'vb_live_DEFAULT'
let walletNetwork = 'base'

before(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push({ path: req.url, method: req.method, auth: req.headers['authorization'] || null, body })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v2/bootstrap') {
        res.end(JSON.stringify({ api_key: bootstrapKey, account_id: '0xabc', user_id: 'u1', wallet_address: '0xabc', wallet_network: walletNetwork, bootstrapped: true }))
      } else if (req.url === '/v2/governance/decide') {
        res.end(JSON.stringify({ run_id: 'r1', content_hash: 'h1', decision: { decision: 'allow', reason: 'ok' }, shadow_decision: { decision: 'allow', reason: 'ok' }, risk: { risk: 'low' } }))
      } else if (req.url === '/v2/accounts/me') {
        res.end(JSON.stringify({ claimed: true }))
      } else {
        res.end(JSON.stringify({ ok: true }))
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  API_URL = `http://127.0.0.1:${server.address().port}`
})

after(() => server?.close())

function runHook({ credsDir, env, key, mode = 'observe' }) {
  return new Promise((resolve) => {
    const clean = { ...process.env }
    for (const k of Object.keys(clean)) if (k.startsWith('VAIBOT_')) delete clean[k]
    // Point the hook's tmp state dir (tmpdir()/vaibot-codex) at our isolated
    // credsDir so concurrent test files don't share global tmp run-state.
    const child = spawn(process.execPath, [HOOK], {
      env: { ...clean, TMPDIR: credsDir, VAIBOT_CREDS_DIR: credsDir, VAIBOT_API_URL: API_URL, VAIBOT_ENV: env, VAIBOT_MODE: mode, VAIBOT_TIMEOUT_MS: '3000', ...(key ? { VAIBOT_API_KEY: key } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('exit', (code) => resolve({ code, out, err }))
    child.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: 's1', tool_use_id: 't' + Math.random(), model: 'gpt-5-codex' }))
    child.stdin.end()
  })
}

const readStore = (dir) => JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf-8'))
const freshDir = () => mkdtempSync(join(tmpdir(), 'vbsmoke-'))
const didBootstrap = () => requests.some((r) => r.path === '/v2/bootstrap')
// Note: in Direction A the resolved key is handed to the guard via guardEnv,
// not carried on the decide call — so these tests assert creds resolution via
// the on-disk store + bootstrap behavior, not a Bearer header on /decide.

test('per-env bootstrap, no cross-env clobber, correct key per env', async () => {
  const dir = freshDir()
  try {
    requests = []; bootstrapKey = 'vb_live_PROD'; walletNetwork = 'base'
    await runHook({ credsDir: dir, env: 'production' })
    let s = readStore(dir)
    assert.equal(s.environments?.production?.api_key, 'vb_live_PROD')
    assert.equal(s.environments?.production?.wallet_address, '0xabc')
    assert.equal(s.environments?.production?.wallet_network, undefined, 'wallet_network must not be stored')

    requests = []; bootstrapKey = 'vb_stg_STG'; walletNetwork = 'base-sepolia'
    await runHook({ credsDir: dir, env: 'staging' })
    s = readStore(dir)
    assert.equal(s.environments?.staging?.api_key, 'vb_stg_STG')
    assert.equal(s.environments?.production?.api_key, 'vb_live_PROD', 'staging bootstrap clobbered production')
    assert.equal(s.active_env, 'staging')

    requests = []; bootstrapKey = 'vb_live_SHOULD_NOT_BE_USED'
    await runHook({ credsDir: dir, env: 'production' })
    assert.equal(didBootstrap(), false, 'should reuse stored key, not re-bootstrap')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prefix guard: a cross-env key is ignored, warned, and re-bootstrapped', async () => {
  const dir = freshDir()
  try {
    requests = []; bootstrapKey = 'vb_live_FRESH'
    const { err } = await runHook({ credsDir: dir, env: 'production', key: 'vb_stg_WRONGENV' })
    assert.match(err, /prefix doesn't match env="production"/)
    assert.equal(readStore(dir).environments?.production?.api_key, 'vb_live_FRESH')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy v1 flat credentials.json migrates to v2 in place', async () => {
  const dir = freshDir(); mkdirSync(dir, { recursive: true })
  try {
    const legacy = { api_key: 'vb_live_OLD', api_url: 'https://api.vaibot.io', account_id: '0xold', user_id: 'uold', wallet_address: '0xold', wallet_network: 'base', bootstrapped_at: '2026-01-01T00:00:00Z' }
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify(legacy))
    requests = []; bootstrapKey = 'vb_live_SHOULD_NOT_BOOTSTRAP'
    await runHook({ credsDir: dir, env: 'production' })
    const s = readStore(dir)
    assert.equal(s.version, 2)
    assert.equal(s.environments?.production?.api_key, 'vb_live_OLD')
    assert.equal(s.environments?.production?.account_id, undefined)
    assert.equal(s.environments?.production?.api_url, undefined)
    assert.ok(existsSync(join(dir, 'credentials.json.bak')), '.bak should be written')
    assert.equal(JSON.parse(readFileSync(join(dir, 'credentials.json.bak'), 'utf-8')).account_id, '0xold')
    assert.equal(didBootstrap(), false, 'legacy key should be reused, not re-bootstrapped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
