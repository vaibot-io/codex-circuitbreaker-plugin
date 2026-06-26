# Vendored dependencies

## `vaibot-guard/` — a committed, real-file copy of `@vaibot/guard`

**Current version: `1.0.2`** (the same version the `vaibot` CLI installs globally — keep them in lockstep).

### Why this is vendored (and not a normal dependency)

Codex installs a plugin by **copying the plugin's files** into its cache
(`~/.codex/plugins/cache/...`) — it does **not** run `npm install`, so there is no
`node_modules` and bare `@vaibot/guard/*` imports would throw `ERR_MODULE_NOT_FOUND`.
So the guard is committed here and the hook scripts import it by **relative path**
(`../vendor/vaibot-guard/scripts/...`), making the plugin self-contained on every
Codex install path (local source, `git-subdir`, GitHub shorthand).

Two hard requirements, both satisfied here:

- **Real files, no symlinks.** Codex's recursive copy (`copy_dir_recursive`) silently
  drops symlinks, so this must never be a pnpm/workspace symlink. Refresh only via
  `npm pack` (below), never by linking the workspace package.
- **Same version as the CLI-installed guard.** A version skew between this copy and a
  guard already running on the host can break adopt-not-duplicate (the per-host
  singleton). Bump this in lockstep with `@vaibot/guard` releases.

### How to refresh after an `@vaibot/guard` release

```sh
cd packages/codex-circuitbreaker-plugin
npm pack @vaibot/guard@<version>            # downloads vaibot-guard-<version>.tgz
rm -rf vendor/vaibot-guard && mkdir -p vendor/vaibot-guard
tar xzf vaibot-guard-<version>.tgz && cp -RL package/. vendor/vaibot-guard/ && rm -rf package vaibot-guard-<version>.tgz
find vendor/vaibot-guard -type l    # must print nothing (zero symlinks)
node --test test/*.test.mjs         # hooks spawn against the vendored copy
```

Then update the version above and the `devDependencies["@vaibot/guard"]` pin in
`package.json`.
