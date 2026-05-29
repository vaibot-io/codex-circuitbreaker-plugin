import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { rmSync, existsSync, mkdtempSync, mkdirSync, readdirSync, statSync, chmodSync, readFileSync } from 'node:fs'
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

function runHook({ apiUrl, mode = 'enforce', input, env = {}, cwd, sharedHome }) {
  // Per-call fake HOME (and TMPDIR-equivalent state dir) so breaker state and
  // run-state in $TMPDIR/vaibot-codex/ don't pollute either the user's real
  // ~/.vaibot or other parallel test files. Tests that need state to persist
  // across calls (e.g. retry-after-approval) pass `sharedHome` to reuse one.
  const fakeHome = sharedHome ?? mkdtempSync(join(tmpdir(), 'vaibot-codex-test-home-'))
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
        VAIBOT_DASHBOARD_URL: 'https://www.vaibot.io',
        ...env,
      },
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => {
      if (!sharedHome) { try { rmSync(fakeHome, { recursive: true, force: true }) } catch {} }
      reject(err)
    })
    child.on('exit', (code) => {
      if (!sharedHome) { try { rmSync(fakeHome, { recursive: true, force: true }) } catch {} }
      resolve({ code, stdout, stderr })
    })
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
    if (req.url === '/v1/decide/tool') {
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
    if (req.url === '/v1/decide/tool') {
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

test('enforce + approval_required → deny with actionable approval instructions', async () => {
  clearState()
  const server = await startMockServer((req) => {
    if (req.url === '/v1/decide/tool') {
      return {
        status: 200,
        body: {
          ok: true,
          runId: 'run_ask',
          risk: { risk: 'high', reason: 'outbound network' },
          decision: { decision: 'approve', reason: 'outbound network call', approvalId: 'appr_ask' },
        },
      }
    }
    if (req.url?.startsWith('/v2/governance/finalize/')) {
      return { status: 200, body: { ok: true } }
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
  // Enforce: deny with actionable reason — not silent allow.
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  const denyReason = out.hookSpecificOutput.permissionDecisionReason
  assert.match(denyReason, /VAIBot blocked this Bash call/)
  assert.match(denyReason, /high risk/)
  assert.match(denyReason, /outbound network call/)
  assert.match(denyReason, /content_hash: appr_ask/)
  // Approval path: at least one approve route must be surfaced.
  assert.match(denyReason, /vaibot\.io\/verify\/decision\//)
  assert.match(denyReason, /vaibot approve appr_ask/)
  // Retry instruction so the user knows the action will succeed after approval.
  assert.match(denyReason, /retry/i)
  // Stderr mirrors the message for the operator.
  assert.match(stderr, /VAIBot blocked/)
})

test('enforce + approval_required → retry after approval short-circuits to allow (terminating loop)', async () => {
  // Both calls share one fake HOME (and thus one TMPDIR + STATE_DIR) so the
  // pending-approval pointer written by call 1 is readable by call 2.
  const sharedHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-retry-home-'))
  // First call: server returns approval_required, plugin denies + writes pending pointer.
  const server1 = await startMockServer((req) => {
    if (req.url === '/v1/decide/tool') {
      return {
        status: 200,
        body: {
          ok: true,
          runId: 'run_retry_1',
          risk: { risk: 'high', reason: 'outbound network' },
          decision: { decision: 'approve', reason: 'needs approval', approvalId: 'appr_retry' },
        },
      }
    }
    if (req.url?.startsWith('/v2/governance/finalize/')) {
      return { status: 200, body: { ok: true } }
    }
    return null
  })

  const denyResult = await runHook({
    apiUrl: server1.url,
    input: { ...baseInput, tool_input: { command: 'curl https://example.com' } },
    sharedHome,
  })
  await server1.close()
  assert.equal(JSON.parse(denyResult.stdout).hookSpecificOutput.permissionDecision, 'deny')

  // Second call (the retry, after user approves out-of-band): server sees the
  // plugin pass approved_content_hash from the saved pointer, re-verifies
  // intent, and returns previously_approved=true. Plugin coerces to allow.
  const server2 = await startMockServer((req) => {
    if (req.url === '/v1/decide/tool') {
      // Assert the plugin presents the saved approvalId to the guard on retry.
      assert.equal(
        req.body.approval?.approvalId, 'appr_retry',
        'plugin must present the saved approvalId on retry',
      )
      // The guard redeems the approval and returns allow.
      return {
        status: 200,
        body: {
          ok: true,
          runId: 'run_retry_2',
          risk: { risk: 'high', reason: 'outbound network' },
          decision: { decision: 'allow', reason: 'approved by user' },
        },
      }
    }
    return null
  })

  const allowResult = await runHook({
    apiUrl: server2.url,
    input: { ...baseInput, tool_input: { command: 'curl https://example.com' } },
    sharedHome,
  })
  await server2.close()
  try { rmSync(sharedHome, { recursive: true, force: true }) } catch {}

  // Allow path: empty stdout (omitting permissionDecision = allow per Codex spec).
  assert.equal(allowResult.code, 0)
  assert.equal(allowResult.stdout.trim(), '')
})

test('observe mode + approval_required → silent allow + stderr verdict only', async () => {
  clearState()
  const server = await startMockServer((req) => {
    if (req.url === '/v1/decide/tool') {
      return {
        status: 200,
        body: {
          ok: true,
          runId: 'run_obs',
          risk: { risk: 'high', reason: 'safe-ish' },
          decision: { decision: 'approve', reason: 'would-have-asked' },
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
  assert.match(stderr, /guard decide failed \(500\)/)
})

test('regression (Change 1): bootstrap fingerprint is cwd-independent', async () => {
  // Pre-Change-1 the fingerprint formula was sha256(user@host:cwd), which gave
  // every cwd its own bootstrap account. This test pins down the new formula:
  // running bootstrap from two different cwds (and two different empty HOMEs
  // so creds aren't reused) must produce the SAME fingerprint, i.e. one
  // bootstrap account per machine.
  clearState()
  const bootstrapPayloads = []
  const server = await startMockServer((req) => {
    if (req.url === '/v2/bootstrap') {
      bootstrapPayloads.push(req.body)
      return {
        status: 201,
        body: {
          ok: true,
          api_key: 'bk_fp_test',
          user_id: 'usr_fp_test',
          account_id: '0xfp',
          wallet_address: '0xfp',
          wallet_network: 'base-sepolia',
        },
      }
    }
    if (req.url === '/v1/decide/tool') {
      return {
        status: 200,
        body: {
          ok: true,
          run_id: 'r_fp',
          risk: { risk: 'low', reason: 'safe' },
          decision: { decision: 'allow', reason: 'ok' },
          shadow_decision: { decision: 'allow', reason: 'ok' },
          content_hash: 'sha256:fp',
        },
      }
    }
    return null
  })

  const tmpHomeA = mkdtempSync(join(tmpdir(), 'vaibot-fp-home-a-'))
  const tmpHomeB = mkdtempSync(join(tmpdir(), 'vaibot-fp-home-b-'))
  const cwdA = mkdtempSync(join(tmpdir(), 'vaibot-fp-cwd-a-'))
  const cwdB = mkdtempSync(join(tmpdir(), 'vaibot-fp-cwd-b-'))

  try {
    await runHook({
      apiUrl: server.url,
      input: baseInput,
      env: { VAIBOT_API_KEY: '', HOME: tmpHomeA },
      cwd: cwdA,
    })
    await runHook({
      apiUrl: server.url,
      input: baseInput,
      env: { VAIBOT_API_KEY: '', HOME: tmpHomeB },
      cwd: cwdB,
    })
  } finally {
    await server.close()
    for (const d of [tmpHomeA, tmpHomeB, cwdA, cwdB]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  }

  assert.equal(bootstrapPayloads.length, 2, 'bootstrap should fire twice (once per fresh HOME)')
  assert.ok(bootstrapPayloads[0].fingerprint, 'fingerprint should be present in payload')
  assert.equal(
    bootstrapPayloads[0].fingerprint,
    bootstrapPayloads[1].fingerprint,
    'fingerprints from different cwds should match (Change 1: cwd dropped from formula)',
  )
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

test('STATE_DIR is created 0o700 and saved state files are 0o600 (no metadata leak on shared hosts)', async () => {
  // sharedHome → spawn uses TMPDIR=<sharedHome>/tmp, so the hook's STATE_DIR
  // is <sharedHome>/tmp/vaibot-codex/ and we can inspect it after the call.
  const sharedHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-perms-'))
  const stateDir = join(sharedHome, 'tmp', 'vaibot-codex')
  try {
    const server = await startMockServer(() => ({
      status: 200,
      body: {
        ok: true,
        run_id: 'run_perms',
        risk: { risk: 'low', reason: 'safe' },
        decision: { decision: 'allow', reason: 'ok' },
        shadow_decision: { decision: 'allow', reason: 'ok' },
        content_hash: 'sha256:perms',
      },
    }))
    await runHook({ apiUrl: server.url, input: baseInput, sharedHome })
    await server.close()

    const dirMode = statSync(stateDir).mode & 0o777
    assert.equal(dirMode, 0o700, `STATE_DIR should be 0o700, got 0o${dirMode.toString(8)}`)

    const stateFiles = readdirSync(stateDir).filter((f) => f.endsWith('.json'))
    assert.ok(stateFiles.length > 0, 'expected at least one state file')
    for (const f of stateFiles) {
      const m = statSync(join(stateDir, f)).mode & 0o777
      assert.equal(m, 0o600, `state file ${f} should be 0o600, got 0o${m.toString(8)}`)
    }
  } finally {
    try { rmSync(sharedHome, { recursive: true, force: true }) } catch {}
  }
})

test('STATE_DIR perms are tightened on the fly when a legacy 0o755 dir already exists', async () => {
  // Simulates an upgrade from an older plugin version that created STATE_DIR
  // with default (umask-respecting) perms. The current code must chmod down to
  // 0o700 on next touch — otherwise the leak persists across plugin upgrades.
  const sharedHome = mkdtempSync(join(tmpdir(), 'vaibot-codex-perms-legacy-'))
  const stateDir = join(sharedHome, 'tmp', 'vaibot-codex')
  try {
    mkdirSync(stateDir, { recursive: true })
    chmodSync(stateDir, 0o755)
    assert.equal(statSync(stateDir).mode & 0o777, 0o755, 'precondition: legacy 0o755 dir')

    const server = await startMockServer(() => ({
      status: 200,
      body: {
        ok: true,
        run_id: 'run_chmod',
        risk: { risk: 'low', reason: 'safe' },
        decision: { decision: 'allow', reason: 'ok' },
        shadow_decision: { decision: 'allow', reason: 'ok' },
        content_hash: 'sha256:chmod',
      },
    }))
    await runHook({ apiUrl: server.url, input: baseInput, sharedHome })
    await server.close()

    assert.equal(statSync(stateDir).mode & 0o777, 0o700, 'legacy dir should be tightened to 0o700')
  } finally {
    try { rmSync(sharedHome, { recursive: true, force: true }) } catch {}
  }
})
