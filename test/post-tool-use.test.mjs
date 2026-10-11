import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'scripts', 'post-tool-use.mjs')

function startMockGuard() {
  return new Promise((resolve) => {
    const requests = []
    const server = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        requests.push({ url: req.url, body: b ? JSON.parse(b) : null })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) }))
  })
}

// Run-state lives in a per-test TMPDIR so other suites' sweeps can't touch it.
function sandbox(entries) {
  const root = mkdtempSync(join(tmpdir(), 'vaibot-codex-post-'))
  const stateDir = join(root, 'vaibot-codex')
  mkdirSync(stateDir, { recursive: true })
  const paths = {}
  for (const [id, f] of Object.entries(entries)) {
    paths[id] = join(stateDir, `${id}.json`)
    writeFileSync(paths[id], JSON.stringify({ tool_name: 'Bash', tool_use_id: id, run_id: `run_${id}`, approval_required: false, ts: Date.now(), ...f }))
  }
  return { root, paths }
}

function runPost(root, guardUrl, input) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, TMPDIR: root, VAIBOT_GUARD_BASE_URL: guardUrl, VAIBOT_GUARD_TOKEN: 't', VAIBOT_TIMEOUT_MS: '2000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    c.on('error', reject)
    c.on('exit', (code) => resolve({ code }))
    c.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', turn_id: 't', cwd: '/tmp', model: 'm', permission_mode: 'default', transcript_path: null, tool_name: 'Bash', tool_input: { command: 'x' }, ...input }))
  })
}

const finalizes = (g) => g.requests.filter((r) => r.url === '/v1/finalize/tool')

test('a call whose run-state is gone never finalizes a DIFFERENT call of the same tool', async () => {
  // Codex sends tool_use_id on every PostToolUse. The newest same-tool entry
  // belongs to another call; finalizing it records this call's result there.
  const g = await startMockGuard()
  const sb = sandbox({ tu_other: {} })
  try {
    await runPost(sb.root, g.url, { tool_use_id: 'tu_mine', tool_response: 'ok' })
    assert.equal(finalizes(g).length, 0)
    assert.ok(existsSync(sb.paths.tu_other), "the other call's run-state is untouched")
  } finally {
    await g.close()
    rmSync(sb.root, { recursive: true, force: true })
  }
})

test('the call with its own run-state is finalized against its own run', async () => {
  const g = await startMockGuard()
  const sb = sandbox({ tu_mine: {}, tu_other: {} })
  try {
    await runPost(sb.root, g.url, { tool_use_id: 'tu_mine', tool_response: 'ok' })
    assert.deepEqual(finalizes(g).map((r) => r.body.runId), ['run_tu_mine'])
    assert.deepEqual(finalizes(g)[0].body.result, { outcome: 'allowed' })
  } finally {
    await g.close()
    rmSync(sb.root, { recursive: true, force: true })
  }
})

test('a detected failure is finalized ok:false, which is what the guard reads as failed', async () => {
  const g = await startMockGuard()
  const sb = sandbox({ tu_fail: {} })
  try {
    await runPost(sb.root, g.url, { tool_use_id: 'tu_fail', tool_response: { error: 'exit status 1' } })
    const result = finalizes(g)[0].body.result
    assert.equal(result.ok, false)
    assert.equal(result.outcome, 'blocked')
    assert.equal(result.error, 'exit status 1')
  } finally {
    await g.close()
    rmSync(sb.root, { recursive: true, force: true })
  }
})
