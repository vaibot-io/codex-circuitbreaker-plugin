# Changelog

All notable changes to `@vaibot/codex-circuitbreaker-plugin`.

## [Unreleased]

### Fixed
- **Every call is finalized with the result it had.** Codex runs `PostToolUse` only
  for a call it counts as succeeded, and has no failure hook. The plugin now closes
  every run it opens exactly once:
  - a shell command that exits non-zero is finalized `ok: false` with its exit code
    (`exit code 2`), read from the session transcript Codex passes to the hook. When
    the transcript has no record of the call, the result is recorded as before;
  - at the end of a turn, `Stop` finalizes this session's runs that no `PostToolUse`
    closed (a failed MCP call or `apply_patch`) as `ok: false`, with the failure the
    transcript reports, or `tool call did not complete successfully`. Another
    session's runs are left alone;
  - a call the plugin denies is finalized `blocked` when it is denied, since it never runs;
  - a call that runs for longer than five minutes is still finalized by its own
    `PostToolUse`. Its run-state is now kept until the call finishes (or for a day).
- **The retry pointer is keyed on the exact call.** It was keyed on a summary of the
  call (`"apply_patch <path>"` for patches and edits), so every change to one file shared
  one pointer, and a retry could present a *different* change's approval id. It's now
  tool + full input (stable key order) + cwd, as in the claudecode plugin.
- **PostToolUse never finalizes a different call.** When this call's run-state was
  gone, it fell back to "the newest entry for this tool", which belongs to another call.
  Codex sends `tool_use_id` on every PostToolUse, so the fallback now applies only to
  input without one.
- **Detected failures are recorded as failed.** The finalize now carries `ok: false`,
  which is what the guard reads. Before, a failure was recorded as allowed. Codex's
  schema types `tool_response` as any JSON value, so detection still depends on an
  `error` / `is_error` field being present.
- **Stop no longer records a denial nobody gave, and neither sweep touches another
  session's calls.** Stop PATCHed the cloud `/v2/receipts/:hash/deny` for every
  leftover `approval_required` entry. That was wrong twice over: the only id a hook holds
  is the guard's local approval id, so the call could only 404, and a codex escalation
  is never a human "No" (enforce answers it out-of-band; Codex reports no answer to its
  own prompt). Stop now records nothing and needs no API key. Both sweeps, PreToolUse
  and Stop, also cleared such entries for **every** Codex session on the machine, which
  included another session's observe-mode call that was still running, whose PostToolUse
  then had nothing to finalize. An entry is now cleared only when it is this session's
  and from an earlier turn (or the turn has ended, for Stop), or when it has been
  abandoned for over a day. Run-state records `session_id` and `turn_id`, and the rule
  lives in one shared `scripts/lib/sweep.mjs`.
- **Approving out-of-band and retrying now lets the call through.** In enforce mode, a
  call that needs approval is denied with instructions to approve on the dashboard or
  with `vaibot approve`, then retry. The plugin saves a retry pointer so the retry
  presents that approval. But the denied call also left its run-state behind
  (`approval_required: true`), and the next hook's sweep took it and **deleted the
  pointer with it**. That was either the retry's own PreToolUse, which sweeps before
  reading the pointer, or Stop at the end of the turn. The retry then presented
  nothing, the guard escalated again, and the call was denied again, every time.

  A denied call never runs, so no PostToolUse would ever consume its run-state. The
  deny branch now drops that entry and keeps the pointer. Observe mode, where the call
  does run and PostToolUse finalizes it, is unchanged. The existing retry test passed
  only because both of its calls had the same `tool_use_id`, which the sweep skips. The
  new tests use a new id for the retry, as a real retry has, with and without Stop in
  between.

  Full effect needs guard **2.3.1**. Until it's vendored, a retry made *before* the
  approval is granted gets a hard `Approval not approved (status=pending)` deny, and
  that deny clears the pointer. 2.3.1 asks again under the same approval instead.

## [1.3.2] — 2026-09-28 — the governance exemption, and guard 2.3.0

### Changed
- **Vendored guard refreshed to 2.3.0**, taken from the published tarball and verified
  against the digest the registry reports (`ecdd56a7f87604435e06a2eafc6de4b96bb7918b`),
  so the committed copy is provably what npm serves. It brings:

  - the **git classification fix** — `git -C <path> …` no longer launders
    `reset --hard`, `clean -f` or `push --force` from ask to allow, and `branch -D` /
    `tag -d` are no longer classified as reads;
  - **`floorAsk`**, a verdict tier no preset can make silent;
  - **approval leases** and **batch approvals**, which this breaker inherits through
    the guard's decision path rather than implementing itself.

  **This changes what runs without asking, on the `permissive` preset.** The guard
  gained a third verdict tier — `floorAsk`, which always asks and which no preset can
  lower — so actions that cannot be undone by whoever authorised them now prompt even
  under `permissive`, which previously never prompted. Measured on the vendored
  classifier this breaker uses in-process:

  | command | 2.2.1 | 2.3.0 |
  |---|---|---|
  | `git branch -D <branch>` | allow | **ask** |
  | `git -C <path> reset --hard` | allow | **ask** |
  | `npm publish` · `cargo publish` | allow | **ask** |
  | `git status` · `npm test` | allow | allow |

  Routine work is untouched — there is a test table asserting exactly that, so the
  tier cannot drift into "ask about everything". If the new prompts are unwelcome, the
  lever is the preset, not the breaker version.

### Fixed
- **A look-alike MCP server could take a tool namespace that was never governed.**
  Governance tools are exempt from the breaker so that a governance call cannot
  recurse into governing itself, and so that an operator can still lift containment
  from inside the agent. That exemption matched any tool name merely *beginning*
  with `mcp__vaibot` — its narrower arm was dead code behind an `||` — so a server
  called `vaibotage` was handed every tool under it: no containment check, no catastrophic floor, no policy at all. And
  because the exemption is tested *before* the containment check, it was a way
  around the account-wide stop added in 1.3.0 as well.

  The exemption now matches at the namespace boundary — exactly `mcp__vaibot`, or a
  name under `mcp__vaibot__`. Nothing an operator needs while contained changed.

## [1.3.1] — 2026-09-27 — vendored guard 2.2.1

### Changed
- Vendored guard refreshed to **2.2.1**, a declaration-only fix: the guard's
  `lib/guard-bootstrap.d.mts` was missing seven exports the module genuinely has.
  Runtime was never affected and this plugin's behaviour is unchanged; the version
  moved only because the vendored content did.

## [1.3.0] — 2026-09-26 — containment on every degraded path

### Added
- **The account-wide containment stop is honoured before any other decision.** The
  guard has enforced containment since 2.2.0, but only for calls that reach the
  daemon. Every path where this plugin degrades — daemon unreachable, no API key,
  breaker tripped, fail-open, hook timeout — skips that call, and so skipped
  containment; observe mode let everything through with a log line. Those are
  exactly the paths an account-wide block has to survive. The check now runs first,
  against the machine-wide record the guard writes, which needs no daemon, no
  network and no credentials.

## [1.2.0] — 2026-07-05 — account key recovery

### Changed
- On `bootstrapped:false` (account exists but no local API key — e.g. the key was
  lost), the plugin now presents **both** recovery paths instead of a dead end:
  run `vaibot login` (re-issues a key via your session) **or** set `VAIBOT_API_KEY` /
  check `credentials.json`. Both are valid; neither replaces the other.

## [1.1.0] — 2026-07-04 — fresh-install, graceful degrade & honest receipts

### Changed
- **Default posture is now `enforce`** (was `observe`) in both `pre-tool-use.mjs`
  (the hard enforcement floor) and `permission-request.mjs` (approval UX). When the
  guard is reachable it publishes the account's `effective_mode`, which wins; this
  default only governs the guard-DOWN fallback.
- **Guard-unreachable degrades to the local classifier instead of bricking:**
  - the catastrophic floor is always enforced locally (classifier `DANGEROUS` → deny);
  - **cold start** (fresh install, no rendezvous lock) → **allow-with-audit** so the box
    can bootstrap the daemon;
  - **established install** whose daemon is gone → **governs locally with the classifier**
    (classifier-safe tools + the `vaibot login` recovery path pass, risky tools are held,
    the floor denies) and **alerts** on possible tampering — a routine reboot no longer
    bricks a working box;
  - a **reachable-but-erroring** guard (5xx / decide failure) stays fail-closed.
- **A missing API key never bricks the agent** — it governs locally (safe tools run, risky
  tools are held since Codex can't prompt for approval mid-hook, the floor denies) instead
  of failing closed, and always leaves `vaibot login` reachable to recover.
- **Failing closed over an explicitly-`observe` account is now announced** to stderr, so an
  operator who chose audit-only isn't silently surprised during an outage.

### Vendored guard (2.1.0)
- Destructive host-config verbs hard-deny (`systemctl stop|disable|mask`, `service … stop`,
  `launchctl unload|remove|bootout`, `crontab` install) — matched on wrapped/absolute/`sh -c`
  forms, un-overridable by any preset.
- The guard's OWN lifecycle is allow-listed (systemd + macOS `launchctl io.vaibot.guard` +
  CLI + the `:39111` health probe), so managing the guard never prompts; teardown still denies.
- Honest receipts: `risk_level` matches the decision that drove the gate, and an allowed
  action reads `allowed` (not `blocked`).

### Notes
- Guard-UP behavior is unchanged (account mode wins). See the guard's
  `THREAT-MODEL.md` §9 for the tamper-resistance analysis this is scoped against.
