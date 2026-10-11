import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcriptOutcome, transcriptFailure } from '../scripts/lib/finalize.mjs'

// Codex runs PostToolUse only for a call it counts as succeeded and has no failure
// hook. A non-zero shell exit reaches PostToolUse with only its output; an MCP
// error, a failed apply_patch, and a denied call reach no PostToolUse at all.
// Every run the plugin opens must still be closed exactly once, with the result
// the call actually had.

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRE = join(__dirname, '..', 'scripts', 'pre-tool-use.mjs')
const POST = join(__dirname, '..', 'scripts', 'post-tool-use.mjs')
const STOP = join(__dirname, '..', 'scripts', 'stop.mjs')

function startMockGuard(decision = 'allow') {
  return new Promise((resolve) => {
    const requests = []
    const server = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        const body = b ? JSON.parse(b) : null
        requests.push({ url: req.url, body })
        const out = req.url === '/v1/decide/tool'
          ? { ok: true, runId: 'run_decided', risk: { risk: 'high' }, decision: { decision, reason: 'policy says no' } }
          : { ok: true }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) }))
  })
}

function scenario(entries = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vaibot-codex-unfinished-'))
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  const stateDir = join(tmp, 'vaibot-codex')
  mkdirSync(join(stateDir, 'pending'), { recursive: true })
  mkdirSync(join(home, '.vaibot'), { recursive: true })
  const paths = {}
  for (const [id, f] of Object.entries(entries)) {
    paths[id] = join(stateDir, `${id}.json`)
    writeFileSync(paths[id], JSON.stringify({ tool_name: 'Bash', tool_use_id: id, run_id: `run_${id}`, approval_required: false, session_id: 'sA', turn_id: 't1', ts: Date.now(), ...f }))
  }
  return { root, home, tmp, stateDir, paths }
}

function transcript(root, items) {
  const path = join(root, 'rollout.jsonl')
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id: 'sA' } })]
  for (const [id, status, exit_code] of items) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'item_started', item: { id, type: 'CommandExecution' } } }))
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { id, type: 'CommandExecution', status, exit_code } } }))
  }
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

function run(script, sc, guardUrl, input, env = {}) {
  writeFileSync(join(sc.home, '.vaibot', 'credentials.json'), JSON.stringify({ version: 3, active_env: 'staging', environments: { staging: { governance: { url: guardUrl }, provenance: { url: guardUrl }, api_key: 'test-key' } } }))
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [script], {
      env: { ...process.env, HOME: sc.home, TMPDIR: sc.tmp, VAIBOT_API_URL: guardUrl, VAIBOT_GUARD_BASE_URL: guardUrl, VAIBOT_GUARD_TOKEN: 't', VAIBOT_API_KEY: 'test-key', VAIBOT_MODE: 'enforce', VAIBOT_TIMEOUT_MS: '2000', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    c.stdout.on('data', (d) => { stdout += d })
    c.on('error', reject)
    c.on('exit', (code) => resolve({ code, stdout }))
    c.stdin.end(JSON.stringify(input))
  })
}

const post = (id, extra = {}) => ({ hook_event_name: 'PostToolUse', session_id: 'sA', turn_id: 't1', cwd: '/tmp', tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'x' }, tool_response: '', transcript_path: null, ...extra })
const stop = (session_id, extra = {}) => ({ hook_event_name: 'Stop', session_id, turn_id: 't1', cwd: '/tmp', stop_hook_active: false, transcript_path: null, ...extra })
const finalizes = (g) => g.requests.filter((r) => r.url === '/v1/finalize/tool')

async function withScenario(entries, decision, fn) {
  const g = await startMockGuard(decision)
  const sc = scenario(entries)
  try { await fn(g, sc) } finally {
    await g.close()
    rmSync(sc.root, { recursive: true, force: true })
  }
}

test('transcriptOutcome reads the completed record for this call only', () => {
  const sc = scenario()
  try {
    const t = transcript(sc.root, [['exec-a', 'completed', 0], ['exec-b', 'failed', 2]])
    assert.deepEqual(transcriptOutcome(t, 'exec-b'), { status: 'failed', exitCode: 2 })
    assert.deepEqual(transcriptOutcome(t, 'exec-a'), { status: 'completed', exitCode: 0 })
    assert.equal(transcriptOutcome(t, 'exec-zzz'), null)
    assert.equal(transcriptOutcome(join(sc.root, 'missing.jsonl'), 'exec-a'), null)
    assert.equal(transcriptOutcome(null, 'exec-a'), null)
    assert.equal(transcriptFailure({ status: 'failed', exitCode: 2 }), 'exit code 2')
    assert.equal(transcriptFailure({ status: 'failed', exitCode: null }), 'tool call failed')
    assert.equal(transcriptFailure({ status: 'completed', exitCode: 0 }), null)
    assert.equal(transcriptFailure(null), null)
  } finally { rmSync(sc.root, { recursive: true, force: true }) }
})

test('PostToolUse: a shell command that exits non-zero is finalized ok:false', async () => {
  await withScenario({ 'exec-b': {} }, 'allow', async (g, sc) => {
    const t = transcript(sc.root, [['exec-a', 'completed', 0], ['exec-b', 'failed', 3]])
    await run(POST, sc, g.url, post('exec-b', { transcript_path: t }))
    const result = finalizes(g)[0].body.result
    assert.equal(result.ok, false)
    assert.equal(result.outcome, 'blocked')
    assert.equal(result.error, 'exit code 3')
  })
})

test('PostToolUse: exit 0, or no transcript record, is finalized allowed as before', async () => {
  await withScenario({ 'exec-a': {}, 'exec-c': {} }, 'allow', async (g, sc) => {
    const t = transcript(sc.root, [['exec-a', 'completed', 0]])
    await run(POST, sc, g.url, post('exec-a', { transcript_path: t }))
    await run(POST, sc, g.url, post('exec-c', { transcript_path: t }))
    assert.deepEqual(finalizes(g).map((r) => r.body.result), [{ outcome: 'allowed' }, { outcome: 'allowed' }])
  })
})

test('PostToolUse: a call that ran longer than five minutes is still finalized', async () => {
  await withScenario({ 'exec-long': { ts: Date.now() - 20 * 60 * 1000 } }, 'allow', async (g, sc) => {
    await run(POST, sc, g.url, post('exec-long'))
    assert.equal(finalizes(g).length, 1)
    assert.equal(finalizes(g)[0].body.runId, 'run_exec-long')
  })
})

test("Stop closes this session's runs that no PostToolUse closed, as failed", async () => {
  await withScenario({
    'mcp-fail': { tool_name: 'mcp__srv__tool' },
    'exec-fail': {},
    'other-session': { session_id: 'sB' },
    'ask': { approval_required: true },
  }, 'allow', async (g, sc) => {
    const t = transcript(sc.root, [['exec-fail', 'failed', 2]])
    const r = await run(STOP, sc, g.url, stop('sA', { transcript_path: t }))
    assert.equal(r.stdout, '', 'Stop emits nothing (plain text is invalid for Codex)')
    const byRun = Object.fromEntries(finalizes(g).map((x) => [x.body.runId, x.body.result]))
    assert.deepEqual(Object.keys(byRun).sort(), ['run_exec-fail', 'run_mcp-fail'])
    assert.deepEqual(byRun['run_exec-fail'], { ok: false, outcome: 'blocked', error: 'exit code 2' })
    assert.deepEqual(byRun['run_mcp-fail'], { ok: false, outcome: 'blocked', error: 'tool call did not complete successfully' })
    assert.ok(!existsSync(sc.paths['mcp-fail']) && !existsSync(sc.paths['exec-fail']))
    assert.ok(existsSync(sc.paths['other-session']), "another session's call may still be running")
    assert.ok(!existsSync(sc.paths.ask), 'the approval sweep still clears asks, and records nothing for them')
  })
})

test('Stop closes each run once: a second Stop finds nothing to close', async () => {
  await withScenario({ 'mcp-fail': {} }, 'allow', async (g, sc) => {
    await run(STOP, sc, g.url, stop('sA'))
    await run(STOP, sc, g.url, stop('sA'))
    assert.equal(finalizes(g).length, 1)
  })
})

test('PreToolUse: a denied call is closed blocked at once and leaves no run-state', async () => {
  await withScenario({}, 'deny', async (g, sc) => {
    const r = await run(PRE, sc, g.url, { hook_event_name: 'PreToolUse', session_id: 'sA', turn_id: 't1', cwd: '/tmp', tool_name: 'Bash', tool_use_id: 'exec-deny', tool_input: { command: 'echo hi' }, transcript_path: null })
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny')
    const f = finalizes(g)
    assert.equal(f.length, 1)
    assert.equal(f[0].body.runId, 'run_decided')
    assert.deepEqual(f[0].body.result, { ok: false, outcome: 'blocked', error: 'Plugin enforced: deny — policy says no' })
    assert.deepEqual(readdirSync(sc.stateDir).filter((x) => x.endsWith('.json')), [])
  })
})
