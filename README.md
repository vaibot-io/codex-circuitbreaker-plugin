# VAIBot Governance Plugin for Codex CLI

A Codex CLI plugin that intercepts every tool call, evaluates it against your governance policy, and enforces the decision before execution proceeds — with cryptographically signed, on-chain-anchored audit receipts of every decision.

VAIBot ships parallel plugins for Claude Code, OpenClaw, and now Codex CLI. One VAIBot account works across all three.

## Plugin vs. MCP server

| | MCP server | This plugin |
|---|---|---|
| Agent queries policy / status | ✓ | ✗ |
| Agent approves actions in-session | ✓ | ✓ |
| Enforcement happens before execution | ✗ | ✓ |
| Agent can skip or bypass the check | ✓ | ✗ |
| Audit trail the agent can't forge | ✗ | ✓ |

The MCP server gives the agent a way to query and interact with VAIBot. This plugin is what makes governance **mandatory** — it hooks into Codex's `PreToolUse` event before the tool executes, regardless of what the agent chooses to do. Most deployments use both: the plugin for mandatory pre-execution enforcement, the MCP server so the agent can surface policy context and manage approvals in-session. The postinstall script wires both.

## Quick start

Install in two steps from inside the Codex CLI:

```bash
# 1. Register the marketplace (clones the repo into Codex's marketplace cache)
codex plugin marketplace add vaibot-io/codex-circuitbreaker-plugin

# 2. Install the plugin from that marketplace via Codex's plugin picker:
#    Run `codex plugin` to open the plugin directory, choose `vaibot-codex`,
#    and install `vaibot-codex-circuitbreaker`.
```

The plugin lands at `~/.codex/plugins/cache/vaibot-io/vaibot-codex-circuitbreaker/<version>/` (e.g. `0.1.2/`). On first tool call (or session start) it auto-bootstraps a free-tier VAIBot account using a machine fingerprint and saves credentials to `~/.vaibot/credentials.json`.

After install, restart your Codex session so it picks up the new hook config and MCP server registration.

## What you see at runtime

**Allowed tool** — passes through silently. A receipt is recorded in the background.

**Approval required (enforce mode)** — VAIBot **blocks** the tool call via `permissionDecision: "deny"` and surfaces actionable approval instructions in the deny reason. Codex shows the deny inline to the agent and the user:

```
VAIBot blocked this Bash call — high risk: outbound network call
content_hash: sha256:a3f9c1…

To approve and retry, do ONE of:
  • Open https://www.vaibot.io/verify/decision/sha256%3Aa3f9c1…
  • Run: vaibot approve sha256:a3f9c1…

After approving, ask the agent to retry the same action — the
plugin will short-circuit on the cached approval and allow it.
```

The receipt is recorded as `blocked_until_approved`. When you approve out-of-band (dashboard or `vaibot approve <hash>` CLI) and then ask the agent to retry the same intent, the plugin reads its cached approval pointer, sends `approved_content_hash` to the server, and the server short-circuits to `previously_approved: true`. The retry passes through as `allow` — the loop terminates.

**Native approval prompts (`PermissionRequest`)** — when Codex itself is about to ask you to approve an action (a sandbox/network escalation, an `on-request` confirmation), VAIBot's `PermissionRequest` hook routes that prompt through the guard: it **auto-approves** what the guard allows (so you aren't asked about safe actions), **auto-denies** what the guard denies, and **declines** for anything that needs a human — letting Codex show its normal approval prompt. This layers on top of the `PreToolUse` floor; `PreToolUse` still independently blocks hard-denies and `approval_required` actions regardless of your `approval_policy`.

**Hard deny** — the tool is blocked outright via `permissionDecision: "deny"`. Codex shows the deny reason inline.

**In observe mode** — all tools proceed, but the policy verdict is logged to stderr:

```
VAIBot [observe]: Bash would be approval_required — outbound network call.
```

## Modes

### Observe (default)

All tool calls are allowed. The governance verdict is logged to stderr but never enforced. Use this to audit your agent's behaviour before enabling enforcement.

```bash
export VAIBOT_MODE=observe
```

### Enforce

Tool calls are blocked when the policy returns `deny` or `approval_required`. `approval_required` blocks come with actionable approval instructions; once you approve out-of-band, asking the agent to retry the same action lets it through via the cached-approval short-circuit. `deny` is terminal — no retry path.

```bash
export VAIBOT_MODE=enforce
```

Note: VAIBot enforcement is independent of Codex's `approval_policy` setting. Whether you have `approval_policy = "never"`, `"on-request"`, or `"untrusted"`, VAIBot's verdict is what gates the tool call when `VAIBOT_MODE=enforce`. Setting `approval_policy = "on-request"` is no longer required for VAIBot to gate — it remains useful if you want Codex's native confirmation UI for non-VAIBot decisions.

## Slash commands — accessed via MCP tools

Codex CLI doesn't currently support custom slash commands at the plugin layer (verified against `developers.openai.com/codex/plugins/build`, 2026-05-08). The Claude Code plugin's `/vaibot status`, `/vaibot pending`, etc. ship in this plugin as **MCP tools** invoked conversationally:

| What you'd type in Claude Code | What you say in Codex | Underlying call |
|---|---|---|
| `/vaibot status` | "show my vaibot status" | `mcp__vaibot__status` |
| `/vaibot pending` | "list pending vaibot approvals" | `mcp__vaibot__pending` |
| `/vaibot approve <hash>` | "approve vaibot hash <hash>" | `mcp__vaibot__approve` |
| `/vaibot deny <hash>` | "deny vaibot hash <hash>" | `mcp__vaibot__deny` |
| `/vaibot recent` | "show recent vaibot receipts" | `mcp__vaibot__recent` |
| `/vaibot policy` | "show my vaibot policy" | `mcp__vaibot__policy` |
| `/vaibot policy request <p>` | "request a vaibot policy denying <pattern>" | `mcp__vaibot__policy_request` |

When Codex exposes a slash-command extension API in a future version, native registrations will be added in a minor version bump.

## Auto-bootstrap

On first run with no API key, the plugin calls `POST /v2/bootstrap` with a machine fingerprint and provisions a free-tier account. Credentials are saved to `~/.vaibot/credentials.json` (mode 0600) and reused on every subsequent run.

The credentials file is **shared across all VAIBot plugins**: claudecode, openclaw, codex. Installing this plugin alongside any other VAIBot plugin reuses the existing account; you don't get duplicate accounts on the same machine.

If the account was already provisioned but the local key is missing, you'll see:

```
VAIBot: account exists but API key not found locally.
  Check ~/.vaibot/credentials.json or set VAIBOT_API_KEY manually.
```

To claim your account and approve from the dashboard, visit the URL printed on first run.

## Configuration

All environment variables are optional.

| Variable | Default | Description |
|---|---|---|
| `VAIBOT_API_KEY` | _(auto-provisioned)_ | Bearer token for the governance API |
| `VAIBOT_MODE` | `observe` | `observe` or `enforce` |
| `VAIBOT_API_URL` | `https://api.vaibot.io` | API base URL |
| `VAIBOT_TIMEOUT_MS` | `10000` | Request timeout in ms |
| `VAIBOT_FAIL_OPEN` | `false` | If `true`, allow tool calls when the API is unreachable |
| `VAIBOT_DEBUG` | _(unset)_ | Set to `1` for verbose decision logging |
| `VAIBOT_DASHBOARD_URL` | `https://www.vaibot.io` | Used in claim-account messages |
| `VAIBOT_BREAKER_FAILURE_THRESHOLD` | `3` | Transient API failures within `WINDOW_MS` that trip the local breaker |
| `VAIBOT_BREAKER_WINDOW_MS` | `10000` | Sliding window for failure counting, in ms |
| `VAIBOT_BREAKER_COOLDOWN_MS` | `60000` | Auto-reset window after the breaker trips, in ms |
| `VAIBOT_BREAKER_DENYLIST` | _(empty)_ | Tool names always blocked when tripped (the un-overridable safety floor) |

## Local breaker (offline fallback)

When the V2 governance API is unreachable, repeated transient failures trip a
local circuit breaker that takes over until the API recovers. Sliding window:
`VAIBOT_BREAKER_FAILURE_THRESHOLD` failures inside `VAIBOT_BREAKER_WINDOW_MS`
trip the breaker for `VAIBOT_BREAKER_COOLDOWN_MS`. While tripped:

- The local **risk classifier** re-decides each call: classifier-safe tools
  pass through with a stderr breadcrumb.
- Tools in `VAIBOT_BREAKER_DENYLIST` are blocked outright.
- Anything the classifier would ask/deny is denied with an actionable reason
  (approval can't be requested while offline — wait for cooldown or API recovery).

Only 5xx responses and network errors count as transient failures. 401/403
(authentication) and other 4xx responses do **not** trip the breaker — those
are real verdicts or config problems, not transient outages.

Breaker state persists at `~/.vaibot/breaker-state/codex.json` (mode `0o600`)
so trip state survives Codex restarts. In observe mode the breaker still
tracks failures but never blocks — it just logs a breadcrumb when tripped.

## How decisions flow

```
Codex CLI                      VAIBot API                    On-chain
    │                              │                            │
    ├─ SessionStart ──────────────►│  bootstrap-if-missing      │
    │                              │                            │
    ├─ PreToolUse ────────────────►│                            │
    │  (tool, input)               ├─ classifyRisk()            │
    │                              ├─ makeDecision()            │
    │                              ├─ buildReceipt()            │
    │                              ├─ anchorProvenance() ──────►│
    │◄─ allow / deny ─────────────┤                            │
    │  (deny carries approval URL  │                            │
    │   when approval_required)    │                            │
    │                              │                            │
    ├─ [tool executes or blocked]  │                            │
    │                              │                            │
    │  ── retry after approval ──► │                            │
    │  approved_content_hash echo  ├─ previously_approved=true  │
    │◄─ allow ─────────────────────┤                            │
    │                              │                            │
    ├─ PostToolUse ───────────────►│                            │
    │  (tool_response)             ├─ finalizeReceipt()         │
    │                              │                            │
    └─ Stop ──────────────────────►│  sweep deny pending        │
```

## Skipped tools

Tools matching `mcp__vaibot__.*` are skipped automatically (matcher uses negative lookahead) so the governance plugin doesn't govern its own MCP queries.

## Codex CLI vs ChatGPT Codex

This plugin targets the **`codex` CLI** (locally installed). It does **not** work with ChatGPT Codex (the cloud-sandboxed agent in chatgpt.com), which runs in OpenAI's infrastructure and doesn't expose a `PreToolUse` hook surface to plugins. For ChatGPT Codex, register VAIBot's MCP server in your remote MCP config; that gives you the agent-callable surface but not mandatory enforcement.

## Disable / uninstall

Disable from Codex's plugin browser (`codex /plugins`) or via config:

```toml
# ~/.codex/config.toml
[plugins."vaibot-codex-circuitbreaker@vaibot-io"]
enabled = false
```

Or uninstall:

```
codex /plugins → find "VAIbot Governance" → Uninstall
```

State written outside `~/.codex/`:

- `~/.vaibot/credentials.json` — shared with other VAIBot plugins; remove only if you also uninstall those.
- `$TMPDIR/vaibot-codex/` — per-session run state; safe to clear at any time.

## Community & support

**[Join the VAIBot Discord](https://discord.gg/mSHYtP5nV)** — get help, share feedback, and connect with other users.

VAIBot is in early access. If you're installing this plugin now, you're among the first developers putting verifiable AI governance into Codex production. Founding members get direct access to the VAIBot team, early previews, and recognition in the project.

## Limitations (v0.1)

- **`approval_required` UX**: the mandatory `PreToolUse` floor blocks `approval_required` actions (`permissionDecision: "deny"`) with actionable approval instructions, because it can't rely on your `approval_policy` to surface a prompt. The user approves out-of-band (dashboard or `vaibot approve <hash>` CLI) and asks the agent to retry; the cached `approved_content_hash` short-circuits the next decide call to allow. Separately, the `PermissionRequest` hook now drives Codex's **native** approval prompts when they fire — auto-approving guard-safe actions, auto-denying guard-dangerous ones, and deferring genuine asks to you. (Codex's `PreToolUse` itself still has no `ask`/escalate return — `permissionDecision: "ask"` is parsed but unsupported — so the floor denies rather than asks.)
- **Slash commands** are exposed as MCP tools rather than native `/vaibot <verb>` syntax (Codex doesn't support plugin-level slash commands as of 2026-05-08).
- **Some tool calls aren't intercepted by Codex's hook system** — per the official docs, "WebSearch and other non-shell tools are not intercepted." Codex governance is strong but not bulletproof; the same caveat applies to all hook-based agent governance.

A v0.2 release will add native `/vaibot <verb>` slash commands if/when Codex's plugin surface supports plugin-level slash commands.
