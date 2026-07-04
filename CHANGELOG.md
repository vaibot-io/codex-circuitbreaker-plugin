# Changelog

All notable changes to `@vaibot/codex-circuitbreaker-plugin`.

## [Unreleased] — fresh-install & enforce-by-default

### Changed
- **Default posture is now `enforce`** (was `observe`) in both `pre-tool-use.mjs`
  (the hard enforcement floor) and `permission-request.mjs` (approval UX). When the
  guard is reachable it publishes the account's `effective_mode`, which wins; this
  default only governs the guard-DOWN fallback.
- **Fresh-install degrade in the hard floor:** when the local guard daemon can't be
  reached or launched (the genuine fresh-install signal) and there's no prior
  rendezvous lock, a non-catastrophic tool is **allowed-with-audit** so the box can
  bootstrap the daemon. The catastrophic floor (classifier `DANGEROUS`) is still
  enforced locally, and an established install whose lock is present stays
  fail-closed (deny) + alerts (possible tampering).
- **A reachable-but-erroring guard/endpoint (5xx, decide failure) stays
  fail-closed** under enforce — degrade applies only to a truly-absent local daemon,
  never to an endpoint that responded.
- Synced vendored `@vaibot/guard` (system-config commands → approval on the command
  head, `policy.default.json` v0.3, launcher boot log + 10s cold-start budget).

### Notes
- Guard-UP behavior is unchanged (account mode wins). See the guard's
  `THREAT-MODEL.md` §9 for the tamper-resistance analysis this is scoped against.
