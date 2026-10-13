import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { rmSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// An escalation in enforce mode is held (POST /v1/hold) so the person can
// answer it on the VAIBot Authenticator, in the dashboard or from the email
// while Codex waits in PreToolUse. Anything that isn't a clear answer keeps the
// existing deny-with-retry path.

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRE = join(__dirname, '..', 'scripts', 'pre-tool-use.mjs')
const POST = join(__dirname, '..', 'scripts', 'post-tool-use.mjs')

function startGuard({ hold, statuses = [] }) {
  return new Promise((resolve) => {
    const requests = []
    let polls = 0
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null
        requests.push({ url: req.url, body: parsed })
        let r = { status: 200, body: { ok: true } }
        if (req.url === '/v1/decide/tool') {
          r = { status: 200, body: { ok: true, runId: 'run_held', effective_mode: 'enforce', risk: { risk: 'high' }, decision: { decision: 'approve', reason: 'outbound network call', approvalId: 'appr_held' } } }
        }
        if (req.url === '/v1/hold') r = hold
        if (req.url === '/v1/approvals/status') {
          const s = statuses[Math.min(polls++, statuses.length - 1)] ?? 'pending'
          r = { status: 200, body: { ok: true, approvals: [{ approvalId: 'appr_held', status: s.status ?? s, resolutionSource: s.source ?? null }] } }
        }
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

function seedCreds(home, url) {
  mkdirSync(join(home, '.vaibot'), { recursive: true })
  writeFileSync(join(home, '.vaibot', 'credentials.json'), JSON.stringify({
    version: 3, active_env: 'staging',
    environments: { staging: { api_key: 'test-key', governance: { url }, provenance: { url } } },
  }))
}

function runScript(script, { home, guardUrl, input, env = {} }) {
  const tmp = join(home, 'tmp')
  mkdirSync(tmp, { recursive: true })
  seedCreds(home, guardUrl)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: tmp,
        VAIBOT_API_URL: guardUrl,
        VAIBOT_GUARD_BASE_URL: guardUrl,
        VAIBOT_GUARD_TOKEN: 't',
        VAIBOT_API_KEY: 'test-key',
        VAIBOT_MODE: 'enforce',
        VAIBOT_TIMEOUT_MS: '2000',
        VAIBOT_HOLD_POLL_MS: '50',
        VAIBOT_HOLD_WAIT_MS: '3000',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, out: stdout.trim() ? JSON.parse(stdout) : null }))
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

const input = {
  session_id: 'sess_h',
  turn_id: 'turn_h',
  tool_name: 'Bash',
  tool_use_id: 'tu_h',
  tool_input: { command: 'curl https://example.com' },
  hook_event_name: 'PreToolUse',
  cwd: process.cwd(),
}
const held = (channels = { authenticator: true, email: true, dashboard: true }) =>
  ({ status: 200, body: { ok: true, held: true, approvalId: 'appr_held', runId: 'run_held', channels } })

function stateFiles(home) {
  const dir = join(home, 'tmp', 'vaibot-codex')
  try { return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8'))) } catch { return [] }
}
function pointerCount(home) {
  try { return readdirSync(join(home, 'tmp', 'vaibot-codex', 'pending')).length } catch { return 0 }
}

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'vaibot-codex-hold-'))
  try { return await fn(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

test('approved on the phone → allowed, and PostToolUse reports the approval', () => withHome(async (home) => {
  const g = await startGuard({ hold: held(), statuses: ['pending', { status: 'approved', source: 'authenticator' }] })
  try {
    const { code, out } = await runScript(PRE, { home, guardUrl: g.url, input })
    assert.equal(code, 0)
    assert.equal(out, null, 'no output = allow in Codex')
    assert.deepEqual(g.requests.find((r) => r.url === '/v1/hold').body, { runId: 'run_held', sessionId: 'sess_h' })
    const [run] = stateFiles(home)
    assert.equal(run.approval, 'approved')
    assert.equal(run.approval_required, false)
    assert.equal(pointerCount(home), 0, 'no retry pointer: the call runs now')

    await runScript(POST, { home, guardUrl: g.url, input: { ...input, hook_event_name: 'PostToolUse', tool_response: 'ok' } })
    const fin = g.requests.find((r) => r.url === '/v1/finalize/tool')
    assert.equal(fin.body.runId, 'run_held')
    assert.equal(fin.body.result.approval, 'approved')
    assert.equal(fin.body.result.outcome, 'allowed')
  } finally { await g.close() }
}))

test('denied by email → denied with where, closed at once as the person\'s refusal', () => withHome(async (home) => {
  const g = await startGuard({ hold: held(), statuses: [{ status: 'denied', source: 'email' }] })
  try {
    const { out } = await runScript(PRE, { home, guardUrl: g.url, input })
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(out.hookSpecificOutput.permissionDecisionReason,
      'Denied from the email link (VAIBot). Do not retry this action unless the user asks.')
    const fin = g.requests.find((r) => r.url === '/v1/finalize/tool')
    assert.deepEqual(fin.body, { sessionId: 'codex', runId: 'run_held', result: { outcome: 'denied_by_reviewer', approval: 'denied' } })
    assert.equal(stateFiles(home).length, 0)
    assert.equal(pointerCount(home), 0)
  } finally { await g.close() }
}))

test('no answer in time → denied, pointing at VAIBot; the retry pointer is kept', () => withHome(async (home) => {
  const g = await startGuard({ hold: held(), statuses: ['pending'] })
  try {
    const started = Date.now()
    const { out } = await runScript(PRE, { home, guardUrl: g.url, input, env: { VAIBOT_HOLD_WAIT_MS: '400' } })
    assert.ok(Date.now() - started < 2500)
    const reason = out.hookSpecificOutput.permissionDecisionReason
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(reason, /^VAIBot is holding this Bash call for approval — high risk: outbound network call\n/)
    assert.match(reason, /Approve it in VAIBot \(on your phone, in the VAIBot dashboard, from the email\)/)
    assert.doesNotMatch(reason, /vaibot approve|verify\/decision/)
    assert.equal(pointerCount(home), 1, 'approving later still lets the retry through')
    assert.equal(g.requests.filter((r) => r.url === '/v1/finalize/tool').length, 0)
  } finally { await g.close() }
}))

test('held but only the dashboard can answer → no wait, pointed at the dashboard', () => withHome(async (home) => {
  const g = await startGuard({ hold: held({ authenticator: false, email: false, dashboard: true }), statuses: [{ status: 'approved' }] })
  try {
    const { out } = await runScript(PRE, { home, guardUrl: g.url, input })
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Approve it in VAIBot \(in the VAIBot dashboard\)/)
    assert.equal(g.requests.some((r) => r.url === '/v1/approvals/status'), false)
  } finally { await g.close() }
}))

for (const [name, hold] of [
  ['an older guard without /v1/hold', { status: 404, body: { ok: false } }],
  ['a call the guard could not hold', { status: 200, body: { ok: true, held: false, reason: 'offline' } }],
]) {
  test(`${name} → the existing deny-with-retry instructions, unchanged`, () => withHome(async (home) => {
    const g = await startGuard({ hold })
    try {
      const { out } = await runScript(PRE, { home, guardUrl: g.url, input })
      const reason = out.hookSpecificOutput.permissionDecisionReason
      assert.equal(reason,
        'VAIBot blocked this Bash call — high risk: outbound network call\n' +
        'content_hash: appr_held\n' +
        '\nTo approve and retry, do ONE of:\n' +
        '  • Open https://www.vaibot.io/verify/decision/appr_held\n' +
        '  • Run: vaibot approve appr_held\n' +
        '\nAfter approving, ask the agent to retry the same action — the\n' +
        'plugin will short-circuit on the cached approval and allow it.')
      assert.equal(g.requests.some((r) => r.url === '/v1/approvals/status'), false)
      assert.equal(pointerCount(home), 1)
    } finally { await g.close() }
  }))
}

test('the wait is capped inside the hook timeout, whatever VAIBOT_HOLD_WAIT_MS says', async () => {
  const { MAX_HOLD_WAIT_MS } = await import('../scripts/lib/hold.mjs')
  const hooks = JSON.parse(readFileSync(join(__dirname, '..', 'hooks', 'hooks.json'), 'utf-8'))
  const timeoutS = hooks.hooks.PreToolUse[0].hooks[0].timeout
  // Codex treats a timed-out hook as no decision, i.e. allow: leave room for the decide.
  assert.ok(MAX_HOLD_WAIT_MS + 20_000 <= timeoutS * 1000, `${MAX_HOLD_WAIT_MS} ms wait vs ${timeoutS} s timeout`)
  assert.ok(existsSync(join(__dirname, '..', 'scripts', 'lib', 'hold.mjs')))
})

test("another session's retry pointer is not presented — the call is held, not denied", () => withHome(async (home) => {
  const statuses = ['pending']
  const g = await startGuard({ hold: held(), statuses })
  try {
    // Session A asked, nobody answered: it keeps a retry pointer for this call.
    await runScript(PRE, { home, guardUrl: g.url, input: { ...input, session_id: 'sess_a' }, env: { VAIBOT_HOLD_WAIT_MS: '200' } })
    assert.equal(pointerCount(home), 1)
    g.requests.length = 0
    statuses.splice(0, statuses.length, { status: 'approved', source: 'authenticator' })
    // Session B makes the same call: it must not present A's approval.
    const { out } = await runScript(PRE, { home, guardUrl: g.url, input: { ...input, session_id: 'sess_b' } })
    const decide = g.requests.find((r) => r.url === '/v1/decide/tool')
    assert.equal(decide.body.approval, undefined)
    assert.equal(out, null, 'held and approved on the phone → allowed')
  } finally { await g.close() }
}))
