import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// E-145: the Codex PermissionRequest hook routes Codex's approval prompts through
// the guard — auto-allow / auto-deny / decline→native-prompt. PreToolUse stays
// the deny-only floor; this hook only drives the inline approval UX.

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

function runHook({ apiUrl, mode = 'enforce', input, env = {} }) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-pr-home-'))
  const fakeTmp = join(fakeHome, 'tmp')
  try { mkdirSync(fakeTmp, { recursive: true }) } catch {}
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

function decideResponse(decision, reason, approvalId) {
  return {
    status: 200,
    body: {
      ok: true,
      runId: 'run_pr',
      risk: { risk: 'medium', reason: reason ?? '' },
      decision: { decision, reason: reason ?? '', ...(approvalId ? { approvalId } : {}) },
    },
  }
}

test('guard allow → behavior: "allow" (auto-approve, no human prompt)', async () => {
  const server = await startMockServer((req) =>
    req.url === '/v1/decide/tool' ? decideResponse('allow', 'low risk') : null,
  )
  const { code, stdout } = await runHook({ apiUrl: server.url, input: { ...baseInput, tool_input: { command: 'ls' } } })
  await server.close()

  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest')
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow')
})

test('guard deny → behavior: "deny" with a message', async () => {
  const server = await startMockServer((req) =>
    req.url === '/v1/decide/tool' ? decideResponse('deny', 'destructive command') : null,
  )
  const { code, stdout } = await runHook({ apiUrl: server.url, input: { ...baseInput, tool_input: { command: 'rm -rf /' } } })
  await server.close()

  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest')
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny')
  assert.match(out.hookSpecificOutput.decision.message, /destructive command/)
})

test('guard approve (needs human) → decline (empty stdout) → native prompt', async () => {
  const server = await startMockServer((req) =>
    req.url === '/v1/decide/tool' ? decideResponse('approve', 'outbound network call', 'appr_1') : null,
  )
  const { code, stdout } = await runHook({ apiUrl: server.url, input: { ...baseInput, tool_input: { command: 'curl https://example.com' } } })
  await server.close()

  assert.equal(code, 0)
  assert.equal(stdout.trim(), '', 'declining means empty stdout so Codex runs its native approval flow')
})

test('observe mode → decline without calling the guard', async () => {
  const server = await startMockServer((req) =>
    req.url === '/v1/decide/tool' ? decideResponse('deny', 'would-deny') : null,
  )
  const { code, stdout } = await runHook({ apiUrl: server.url, mode: 'observe', input: baseInput })
  await server.close()

  assert.equal(code, 0)
  assert.equal(stdout.trim(), '')
  assert.equal(server.requests.length, 0, 'observe mode must not auto-decide')
})

test('mcp__vaibot__ tools are skipped without a guard call', async () => {
  const server = await startMockServer(() => null)
  const { code, stdout } = await runHook({ apiUrl: server.url, input: { ...baseInput, tool_name: 'mcp__vaibot__status' } })
  await server.close()

  assert.equal(code, 0)
  assert.equal(stdout.trim(), '')
  assert.equal(server.requests.length, 0, 'self/governance tools must not be gated')
})

test('guard unreachable (5xx) → decline (defer to human; PreToolUse is the floor)', async () => {
  const server = await startMockServer(() => ({ status: 500, body: { error: 'oops' } }))
  const { code, stdout } = await runHook({ apiUrl: server.url, input: baseInput })
  await server.close()

  assert.equal(code, 0)
  assert.equal(stdout.trim(), '', 'a guard outage must not auto-allow or auto-deny — the human decides')
})
