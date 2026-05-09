import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'scripts', 'pre-tool-use.mjs')
const STATE_DIR = join(tmpdir(), 'vaibot-codex')

function clearState() {
  try { rmSync(STATE_DIR, { recursive: true, force: true }) } catch {}
}

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
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        VAIBOT_API_URL: apiUrl,
        VAIBOT_API_KEY: 'test-key',
        VAIBOT_MODE: mode,
        VAIBOT_TIMEOUT_MS: '2000',
        VAIBOT_DASHBOARD_URL: 'https://www.vaibot.io',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

const baseInput = {
  session_id: 'sess_test',
  tool_name: 'Bash',
  tool_use_id: 'tu_1',
  tool_input: { command: 'echo hi' },
  hook_event_name: 'PreToolUse',
  cwd: process.cwd(),
  model: 'codex-default',
  turn_id: 'turn_1',
}

test('enforce + allow → exit 0, empty stdout (silent allow)', async () => {
  clearState()
  const server = await startMockServer((req) => {
    if (req.url === '/v2/governance/decide') {
      return {
        status: 200,
        body: {
          ok: true,
          run_id: 'run_allow',
          risk: { risk: 'low', reason: 'safe' },
          decision: { decision: 'allow', reason: 'low risk' },
          shadow_decision: { decision: 'allow', reason: 'low risk' },
          content_hash: 'sha256:allow',
        },
      }
    }
    return null
  })

  const { code, stdout } = await runHook({ apiUrl: server.url, input: baseInput })
  await server.close()

  assert.equal(code, 0)
  // Per Codex spec: omitting permissionDecision = allow. We emit nothing on stdout.
  assert.equal(stdout.trim(), '')
})

test('enforce + deny → permissionDecision: "deny" with reason', async () => {
  clearState()
  const server = await startMockServer((req) => {
    if (req.url === '/v2/governance/decide') {
      return {
        status: 200,
        body: {
          ok: true,
          run_id: 'run_deny',
          risk: { risk: 'critical', reason: 'destructive' },
          decision: { decision: 'deny', reason: 'destructive command' },
          shadow_decision: { decision: 'deny', reason: 'destructive command' },
          content_hash: 'sha256:deny',
        },
      }
    }
    if (req.url?.startsWith('/v2/governance/finalize/')) {
      return { status: 200, body: { ok: true } }
    }
    return null
  })

  const { code, stdout } = await runHook({
    apiUrl: server.url,
    input: { ...baseInput, tool_input: { command: 'rm -rf /' } },
  })
  await server.close()

  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /destructive/)
})

test('enforce + approval_required → silent allow + systemMessage with VAIBot flag text', async () => {
  clearState()
  const server = await startMockServer((req) => {
    if (req.url === '/v2/governance/decide') {
      return {
        status: 200,
        body: {
          ok: true,
          run_id: 'run_ask',
          risk: { risk: 'high', reason: 'outbound network' },
          decision: { decision: 'approval_required', reason: 'outbound network call' },
          shadow_decision: { decision: 'approval_required', reason: 'outbound network call' },
          content_hash: 'sha256:askhash',
        },
      }
    }
    return null
  })

  const { code, stdout, stderr } = await runHook({
    apiUrl: server.url,
    input: { ...baseInput, tool_input: { command: 'curl https://example.com' } },
  })
  await server.close()

  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  // No permissionDecision (silent allow)
  assert.equal(out.hookSpecificOutput, undefined)
  // systemMessage carries the VAIBot flag text
  assert.match(out.systemMessage, /VAIBot flagged this Bash call as high risk/)
  assert.match(out.systemMessage, /outbound network call/)
  assert.match(out.systemMessage, /content_hash: sha256:askhash/)
  // Stderr also carries the message
  assert.match(stderr, /VAIBot:.*outbound network call/)
})

test('observe mode + approval_required → silent allow + stderr verdict only', async () => {
  clearState()
  const server = await startMockServer((req) => {
    if (req.url === '/v2/governance/decide') {
      return {
        status: 200,
        body: {
          ok: true,
          run_id: 'run_obs',
          risk: { risk: 'high', reason: 'safe-ish' },
          decision: { decision: 'allow', reason: 'observe-coerced' },
          shadow_decision: { decision: 'approval_required', reason: 'would-have-asked' },
          content_hash: 'sha256:obs',
        },
      }
    }
    return null
  })

  const { code, stdout, stderr } = await runHook({
    apiUrl: server.url,
    mode: 'observe',
    input: baseInput,
  })
  await server.close()

  assert.equal(code, 0)
  // Observe mode → empty stdout (silent allow), verdict only on stderr
  assert.equal(stdout.trim(), '')
  assert.match(stderr, /VAIBot \[observe\]: Bash would be approval_required/)
})

test('mcp__vaibot__ tools are skipped without an API call', async () => {
  clearState()
  const server = await startMockServer(() => null)
  const { code, stdout, stderr } = await runHook({
    apiUrl: server.url,
    input: { ...baseInput, tool_name: 'mcp__vaibot__status' },
  })
  await server.close()

  assert.equal(code, 0)
  assert.equal(stdout.trim(), '')
  assert.equal(server.requests.length, 0, 'API should not be hit for mcp__vaibot__ tools')
})

test('API 5xx in enforce mode + FAIL_OPEN=true → exit 0', async () => {
  clearState()
  const server = await startMockServer(() => ({ status: 500, body: { error: 'oops' } }))

  const { code } = await runHook({
    apiUrl: server.url,
    input: baseInput,
    env: { VAIBOT_FAIL_OPEN: 'true' },
  })
  await server.close()

  assert.equal(code, 0, 'fail-open should allow despite 500')
})

test('API 5xx in enforce mode without FAIL_OPEN → exit 2 (deny)', async () => {
  clearState()
  const server = await startMockServer(() => ({ status: 500, body: { error: 'oops' } }))

  const { code, stderr } = await runHook({
    apiUrl: server.url,
    input: baseInput,
  })
  await server.close()

  assert.equal(code, 2, 'fail-closed by default')
  assert.match(stderr, /governance API returned 500/)
})

test('mode=observe + API 5xx → exit 0 (observe always allows)', async () => {
  clearState()
  const server = await startMockServer(() => ({ status: 500, body: { error: 'oops' } }))

  const { code } = await runHook({
    apiUrl: server.url,
    mode: 'observe',
    input: baseInput,
  })
  await server.close()

  assert.equal(code, 0)
})
