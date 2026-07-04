# Changelog

All notable changes to `@vaibot/codex-circuitbreaker-plugin`.

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
