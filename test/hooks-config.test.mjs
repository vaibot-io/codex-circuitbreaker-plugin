import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOKS = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks

// Codex compiles a matcher the way `HookMatcher::new` does (codex-rs/hooks/src/engine/
// matcher.rs): "" and "*" match everything, a name made only of [A-Za-z0-9_|] is an
// exact list, anything else goes to the Rust `regex` crate. A matcher that crate
// rejects makes Codex drop the whole hook group with an "invalid matcher" warning.
// The crate has no look-around and no backreferences, so those are what we check for.
const RUST_REGEX_UNSUPPORTED = [/\(\?=/, /\(\?!/, /\(\?<=/, /\(\?<!/, /\\[1-9]/, /\\k</]

function matcherProblem(matcher) {
  if (matcher === '' || matcher === '*') return null
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return null
  const bad = RUST_REGEX_UNSUPPORTED.find((re) => re.test(matcher))
  if (bad) return `uses ${bad.source}, which Codex's regex engine rejects`
  try { new RegExp(matcher) } catch (e) { return `is not a valid regex: ${e.message}` }
  return null
}

const groups = Object.entries(HOOKS).flatMap(([event, gs]) => gs.map((g) => ({ event, ...g })))

test('every hook matcher is one Codex accepts', () => {
  for (const g of groups) {
    if (g.matcher === undefined) continue
    assert.equal(matcherProblem(g.matcher), null, `${g.event} matcher ${JSON.stringify(g.matcher)}`)
  }
})

test('the matcher check rejects look-around', () => {
  assert.notEqual(matcherProblem('^(?!mcp__vaibot__).*'), null)
  assert.notEqual(matcherProblem('(?<=x)y'), null)
  assert.equal(matcherProblem('mcp__.*__write.*'), null)
  assert.equal(matcherProblem('startup|resume|clear'), null)
})

test('the tool hooks run for every tool', () => {
  for (const event of ['PreToolUse', 'PermissionRequest', 'PostToolUse']) {
    assert.ok(HOOKS[event]?.length, `${event} is wired`)
    for (const g of HOOKS[event]) assert.equal(g.matcher, '*', `${event} matches every tool`)
  }
})

// Codex gives a plugin hook PLUGIN_ROOT (and CLAUDE_PLUGIN_ROOT) in its environment
// (codex-rs/hooks/src/engine/discovery.rs, append_plugin_hook_sources). Any other
// name expands to "" under `sh -lc`, and the command looks for /scripts/<file>.
test('every hook command points at a script that exists', () => {
  for (const g of groups) {
    for (const h of g.hooks) {
      const m = h.command.match(/^node "\$PLUGIN_ROOT\/(scripts\/[\w.-]+\.mjs)"$/)
      assert.ok(m, `${g.event} command names a plugin script: ${h.command}`)
      assert.ok(existsSync(join(ROOT, m[1])), `${m[1]} exists`)
    }
  }
})

test('every tool hook script exempts the governance tools itself', () => {
  const scripts = { PreToolUse: 'pre-tool-use.mjs', PermissionRequest: 'permission-request.mjs', PostToolUse: 'post-tool-use.mjs' }
  for (const [event, file] of Object.entries(scripts)) {
    const src = readFileSync(join(ROOT, 'scripts', file), 'utf8')
    assert.ok(src.includes("toolName.startsWith('mcp__vaibot__')"), `${event} script exempts mcp__vaibot__*`)
  }
})
