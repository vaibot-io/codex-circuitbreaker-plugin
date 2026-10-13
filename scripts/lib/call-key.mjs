/**
 * Keys for finding the run of a call across hooks.
 *
 * callKey: the exact call, for the retry pointer and for PermissionRequest
 * calls whose tool_input matches PreToolUse's.
 *
 * commandKey: matching a PermissionRequest to the PreToolUse run of the same
 * shell call. Codex fires PermissionRequest after PreToolUse, for the same
 * call, when it is about to ask the person itself (e.g. to run a command
 * outside the sandbox). It carries no tool_use_id, and for a shell command its
 * tool_input is not the one PreToolUse saw: it adds a `description` (the
 * justification shown in the prompt). So the run is found by session + tool +
 * the command itself.
 */
import { createHash } from 'node:crypto'

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The EXACT call — tool, full input (stable key order), cwd — not a summary of
 * it. extractCommand summarises apply_patch/Edit/Write as "<tool> <path>", so
 * every change to one file shared a pointer: a retry could present a DIFFERENT
 * change's approval id (guard 2.3.0: a hard pending-deny or a scope-mismatch
 * deny). Two different calls never share a key; a retry of the identical call
 * still finds its own.
 */
export function callKey(tool, input, cwd) {
  return createHash('sha256').update(`${tool}|${stableStringify(input ?? {})}|${cwd ?? ''}`).digest('hex').slice(0, 32)
}

/** A key for a shell call's command, or null for any other call. */
export function commandKey(toolName, toolInput) {
  const command = toolInput?.command
  if (typeof command !== 'string' || command === '') return null
  return createHash('sha256').update(`${toolName}|${command}`).digest('hex').slice(0, 32)
}
