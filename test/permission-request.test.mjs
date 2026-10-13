import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callKey, commandKey } from '../scripts/lib/call-key.mjs'

// E-145: the Codex PermissionRequest hook answers Codex's approval prompts from
// the decision PreToolUse already made for the same call — auto-allow /
// auto-deny / decline→native-prompt — and never asks the guard a second time
// (a second decide opened a guard run nothing ever closed).

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'scripts', 'permission-request.mjs')

function startMockServer(handler) {
  return new Promise((resolve) => {
    const requests = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null
        requests.push({ method: req.method, url: req.url, body: parsed })
        const r = handler({ method: req.method, url: req.url, body: parsed }) ?? { status: 200, body: { ok: true } }
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

function runHook({ apiUrl, mode = 'enforce', input, env = {}, runs = [] }) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-pr-home-'))
  const fakeTmp = join(fakeHome, 'tmp')
  try { mkdirSync(fakeTmp, { recursive: true }) } catch {}
  // Run-state PreToolUse would have saved for earlier calls.
  const stateDir = join(fakeTmp, 'vaibot-codex')
  mkdirSync(stateDir, { recursive: true })
  runs.forEach((r, i) => writeFileSync(join(stateDir, `tu_${i}.json`), JSON.stringify(r)))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        HOME: fakeHome,
        TMPDIR: fakeTmp,
        VAIBOT_API_URL: apiUrl,
        VAIBOT_GUARD_BASE_URL: apiUrl,
        VAIBOT_GUARD_TOKEN: 'test-guard-token',
        VAIBOT_API_KEY: 'test-key',
        VAIBOT_MODE: mode,
        VAIBOT_TIMEOUT_MS: '2000',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => { try { rmSync(fakeHome, { recursive: true, force: true }) } catch {}; reject(err) })
    child.on('exit', (code) => {
      try { rmSync(fakeHome, { recursive: true, force: true }) } catch {}
      resolve({ code, stdout, stderr })
    })
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

const baseInput = {
  session_id: 'sess_test',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
  hook_event_name: 'PermissionRequest',
  cwd: process.cwd(),
  model: 'codex-default',
  permission_mode: 'on-request',
  turn_id: 'turn_1',
}

// What PreToolUse saved for a shell call. Codex's PreToolUse sees {command};
// its PermissionRequest for the same call adds a description.
function shellRun(command, extra = {}) {
  return {
    run_id: 'run_pre',
    decision: 'allow',
    tool_name: 'Bash',
    tool_use_id: 'tu_pre',
    session_id: 'sess_test',
    turn_id: 'turn_1',
    approval_required: false,
    intent_key: callKey('Bash', { command }, process.cwd()),
    command_key: commandKey('Bash', { command }),
    effective_mode: 'enforce',
    ts: Date.now(),
    ...extra,
  }
}

function askFor(command) {
  return { ...baseInput, tool_input: { command, description: `May I run ${command} outside the sandbox?` } }
}

// The guard must never be asked: every request it receives is a failure here.
async function run(opts) {
  const server = await startMockServer(() => ({ status: 500, body: { ok: false } }))
  try {
    const out = await runHook({ apiUrl: server.url, ...opts })
    return { ...out, requests: server.requests }
  } finally {
    await server.close()
  }
}

function behavior(stdout) {
  return stdout.trim() === '' ? 'decline' : JSON.parse(stdout).hookSpecificOutput.decision.behavior
}

test('PreToolUse allowed this call → behavior: "allow", without asking the guard again', async () => {
  const { code, stdout, requests } = await run({ input: askFor('ls'), runs: [shellRun('ls')] })
  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest')
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow')
  assert.equal(requests.length, 0, 'no second decide: it opened a guard run nothing ever closed')
})

test('approved while held (phone / dashboard / email) → allow', async () => {
  const runs = [shellRun('curl https://example.com', { decision: 'approval_required', approval: 'approved' })]
  const { stdout } = await run({ input: askFor('curl https://example.com'), runs })
  assert.equal(behavior(stdout), 'allow')
})

test('PreToolUse denied this call → behavior: "deny" with a message', async () => {
  const { stdout } = await run({ input: askFor('format-disk'), runs: [shellRun('format-disk', { decision: 'deny' })] })
  const out = JSON.parse(stdout)
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny')
  assert.match(out.hookSpecificOutput.decision.message, /VAIBot denied Bash/)
})

test('still needs a person (observe-mode escalation) → decline → native prompt', async () => {
  const runs = [shellRun('curl https://example.com', { decision: 'approval_required', approval_required: true })]
  const { code, stdout } = await run({ input: askFor('curl https://example.com'), runs })
  assert.equal(code, 0)
  assert.equal(stdout.trim(), '', 'declining means empty stdout so Codex runs its native approval flow')
})

test('the guard reported observe → decline, whatever VAIBOT_MODE says', async () => {
  const { stdout } = await run({ input: askFor('ls'), runs: [shellRun('ls', { effective_mode: 'observe' })] })
  assert.equal(behavior(stdout), 'decline')
})

test('a non-shell call is matched by its exact input', async () => {
  const input = { ...baseInput, tool_name: 'apply_patch', tool_input: { path: 'a.txt', patch: '+x' } }
  const runs = [{
    ...shellRun('unused'),
    tool_name: 'apply_patch',
    intent_key: callKey('apply_patch', input.tool_input, process.cwd()),
    command_key: null,
  }]
  const { stdout } = await run({ input, runs })
  assert.equal(behavior(stdout), 'allow')
})

for (const [name, runs] of [
  ['no PreToolUse run at all', []],
  ['a different command', [shellRun('ls -la')]],
  ["another session's run", [shellRun('ls', { session_id: 'sess_other' })]],
  ['a run from another turn', [shellRun('ls', { turn_id: 'turn_0' })]],
  ['a run older than 10 minutes', [shellRun('ls', { ts: Date.now() - 11 * 60 * 1000 })]],
]) {
  test(`${name} → decline (the human decides; PreToolUse is the floor)`, async () => {
    const { code, stdout, requests } = await run({ input: askFor('ls'), runs })
    assert.equal(code, 0)
    assert.equal(stdout.trim(), '')
    assert.equal(requests.length, 0)
  })
}

test('mcp__vaibot__ tools are skipped', async () => {
  const { code, stdout, requests } = await run({ input: { ...baseInput, tool_name: 'mcp__vaibot__status' }, runs: [shellRun('ls')] })
  assert.equal(code, 0)
  assert.equal(stdout.trim(), '')
  assert.equal(requests.length, 0, 'self/governance tools must not be gated')
})
