import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { askIsOver, ASK_ABANDON_MS } from '../scripts/lib/sweep.mjs'

// The sweeps (PreToolUse and Stop) clear only approval_required run-state that
// is known to be over, and record nothing. The state dir is shared by every
// Codex session; clearing another session's still-running call left its
// PostToolUse with nothing to finalize, and Stop PATCHed a cloud /deny for a
// "No" nobody gave (with a local id the API can only 404 on).

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRE = join(__dirname, '..', 'scripts', 'pre-tool-use.mjs')
const STOP = join(__dirname, '..', 'scripts', 'stop.mjs')

test('askIsOver: the rule', () => {
  const now = Date.now()
  const e = (f) => ({ approval_required: true, ts: now, ...f })
  const me = { sessionId: 'sA', turnId: 't2', now }
  assert.equal(askIsOver(e({ session_id: 'sB', turn_id: 't1' }), me), false, 'another session: its call may be running')
  assert.equal(askIsOver(e({ session_id: 'sA', turn_id: 't1' }), me), true, 'this session, earlier turn')
  assert.equal(askIsOver(e({ session_id: 'sA', turn_id: 't2' }), me), false, 'this session, current turn')
  assert.equal(askIsOver(e({ session_id: 'sA', turn_id: 't2' }), { ...me, turnEnded: true }), true, 'Stop: the turn is over')
  assert.equal(askIsOver(e({ session_id: 'sB', turn_id: 't2' }), { ...me, turnEnded: true }), false, 'Stop never clears another session')
  assert.equal(askIsOver(e({ turn_id: 't1' }), me), false, 'legacy, unattributed: kept')
  assert.equal(askIsOver(e({ session_id: 'sB', ts: now - ASK_ABANDON_MS - 1 }), me), true, 'abandoned, any session')
  assert.equal(askIsOver(e({ ts: now - ASK_ABANDON_MS - 1 }), me), true, 'abandoned legacy')
})

function startMockServer() {
  return new Promise((resolve) => {
    const requests = []
    const server = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url })
        const body = req.url === '/v1/decide/tool'
          ? { ok: true, runId: 'run_x', decision: { decision: 'allow', reason: 'ok' } }
          : { ok: true }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) }))
  })
}

function scenario(entries) {
  const root = mkdtempSync(join(tmpdir(), 'vaibot-codex-sweep-'))
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  const stateDir = join(tmp, 'vaibot-codex')
  mkdirSync(join(stateDir, 'pending'), { recursive: true })
  mkdirSync(join(home, '.vaibot'), { recursive: true })
  const paths = {}
  for (const [name, f] of Object.entries(entries)) {
    paths[name] = join(stateDir, `${name}.json`)
    writeFileSync(paths[name], JSON.stringify({ tool_name: 'Bash', run_id: `run_${name}`, content_hash: `appr_${name}`, approval_required: true, intent_key: `ik_${name}`, ts: Date.now(), ...f }))
    writeFileSync(join(stateDir, 'pending', `ik_${name}.json`), '{}')
  }
  return { root, home, tmp, paths, pointer: (n) => join(stateDir, 'pending', `ik_${n}.json`) }
}

function run(script, sc, apiUrl, input) {
  writeFileSync(join(sc.home, '.vaibot', 'credentials.json'), JSON.stringify({ version: 3, active_env: 'staging', environments: { staging: { governance: { url: apiUrl }, provenance: { url: apiUrl }, api_key: 'test-key' } } }))
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [script], {
      env: { ...process.env, HOME: sc.home, TMPDIR: sc.tmp, VAIBOT_API_URL: apiUrl, VAIBOT_GUARD_BASE_URL: apiUrl, VAIBOT_GUARD_TOKEN: 't', VAIBOT_API_KEY: 'test-key', VAIBOT_MODE: 'observe', VAIBOT_TIMEOUT_MS: '2000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    c.stdout.on('data', (d) => { stdout += d })
    c.on('error', reject)
    c.on('exit', (code) => resolve({ code, stdout }))
    c.stdin.end(JSON.stringify(input))
  })
}

const stopInput = (session_id, turn_id) => ({ hook_event_name: 'Stop', session_id, turn_id, cwd: '/tmp', model: 'm', permission_mode: 'default', stop_hook_active: false, transcript_path: null, last_assistant_message: null })
const preInput = (session_id, turn_id) => ({ hook_event_name: 'PreToolUse', session_id, turn_id, tool_name: 'Bash', tool_use_id: `tu_${turn_id}_${Math.random().toString(36).slice(2)}`, tool_input: { command: 'echo hi' }, cwd: '/tmp', model: 'm', permission_mode: 'default', transcript_path: null })

test("Stop clears its own session's leftovers, never another session's, and records nothing", async () => {
  const server = await startMockServer()
  const sc = scenario({ mine: { session_id: 'sA', turn_id: 't1' }, theirs: { session_id: 'sB', turn_id: 't9' } })
  try {
    const r = await run(STOP, sc, server.url, stopInput('sA', 't1'))
    assert.equal(r.stdout, '', 'Stop emits nothing (plain text is invalid for Codex)')
    assert.ok(!existsSync(sc.paths.mine) && !existsSync(sc.pointer('mine')))
    assert.ok(existsSync(sc.paths.theirs) && existsSync(sc.pointer('theirs')), "another session's call may still be running")
    assert.equal(server.requests.length, 0, 'no PATCH /deny, no finalize: nobody is known to have said no')
  } finally {
    await server.close()
    rmSync(sc.root, { recursive: true, force: true })
  }
})

test("PreToolUse clears this session's earlier turns only", async () => {
  const server = await startMockServer()
  const sc = scenario({
    earlier: { session_id: 'sA', turn_id: 't1' },
    current: { session_id: 'sA', turn_id: 't2' },
    other: { session_id: 'sB', turn_id: 't1' },
  })
  try {
    await run(PRE, sc, server.url, preInput('sA', 't2'))
    assert.ok(!existsSync(sc.paths.earlier), "an earlier turn's call has had its PostToolUse")
    assert.ok(existsSync(sc.paths.current), "the current turn's call may still be running")
    assert.ok(existsSync(sc.paths.other), "another session's is left alone")
    assert.equal(server.requests.filter((r) => r.method === 'PATCH').length, 0)
  } finally {
    await server.close()
    rmSync(sc.root, { recursive: true, force: true })
  }
})

test('run-state records the session and turn it belongs to', async () => {
  const server = await startMockServer()
  const sc = scenario({})
  try {
    const input = preInput('sRec', 'tRec')
    await run(PRE, sc, server.url, input)
    const { readFileSync } = await import('node:fs')
    const state = JSON.parse(readFileSync(join(sc.tmp, 'vaibot-codex', `${input.tool_use_id}.json`), 'utf-8'))
    assert.equal(state.session_id, 'sRec')
    assert.equal(state.turn_id, 'tRec')
  } finally {
    await server.close()
    rmSync(sc.root, { recursive: true, force: true })
  }
})
