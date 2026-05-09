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

```bash
codex plugin marketplace add vaibot-io/codex-circuitbreaker-plugin
```

Codex pulls the marketplace, presents the install dialog, you confirm. Plugin lands at `~/.codex/plugins/cache/vaibot-io/vaibot-codex-circuitbreaker/0.1.0/`. On first tool call (or session start) the plugin auto-bootstraps a free-tier VAIBot account using a machine fingerprint and saves credentials to `~/.vaibot/credentials.json`.

After install, restart your Codex session so it picks up the new hook config and MCP server registration.

## Recommended Codex config

For best UX, set Codex's approval policy to `on-request` so VAIBot's `approval_required` decisions trigger Codex's native approval prompt:

```toml
# ~/.codex/config.toml
approval_policy = "on-request"
```

If you have `approval_policy = "never"`, Codex auto-approves all tool calls — VAIBot's flagging will still produce a receipt and a stderr warning, but no inline prompt fires. Approve from the dashboard instead.

## What you see at runtime

**Allowed tool** — passes through silently. A receipt is recorded in the background.

**Approval required** — VAIBot writes a flag message to stderr and to Codex's `systemMessage` channel:

```
VAIBot: VAIBot flagged this Bash call as elevated risk — outbound network call.
        content_hash: sha256:a3f9c1...
        Approving here will record your decision in the VAIBot audit chain.
```

If your `approval_policy` is `on-request` or `untrusted`, Codex's native approval prompt fires alongside the message. Approving lets the action run; the receipt is closed as approved on next `PostToolUse`. Denying leaves the receipt to be swept and closed as denied by the next hook (`Stop` or the next `PreToolUse`).

If you later approve the same action from the dashboard, retrying executes it automatically — VAIBot caches an approval pointer keyed on `(tool, command, cwd)`.

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

Tool calls are denied when the policy returns `deny`. Tool calls flagged `approval_required` are silent-allowed in the hook (Codex's `PreToolUse` doesn't support `ask`); pair with `approval_policy = "on-request"` for a native prompt.

```bash
export VAIBOT_MODE=enforce
```

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
    │  (or silent-allow + msg)     │                            │
    │                              │                            │
    ├─ [tool executes or blocked]  │                            │
    │  [native prompt may fire     │                            │
    │   for approval_required]     │                            │
    │                              │                            │
    ├─ PostToolUse ───────────────►│                            │
    │  (tool_response)             ├─ PATCH /approve            │
    │                              ├─ finalizeReceipt()         │
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

- **`approval_required` UX**: Codex's `PreToolUse` doesn't support `ask` / escalate-to-human. The plugin silent-allows, emits a `systemMessage`, and depends on Codex's `approval_policy` setting to fire a native prompt. Set `approval_policy = "on-request"` for best behaviour.
- **Slash commands** are exposed as MCP tools rather than native `/vaibot <verb>` syntax (Codex doesn't support plugin-level slash commands as of 2026-05-08).
- **Some tool calls aren't intercepted by Codex's hook system** — per the official docs, "WebSearch and other non-shell tools are not intercepted." Codex governance is strong but not bulletproof; the same caveat applies to all hook-based agent governance.

A v0.2 release will add native slash commands and `PermissionRequest`-based approval injection if/when Codex's plugin surface supports it.
