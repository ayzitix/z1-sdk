/**
 * One-shot `node -e` helpers.
 *
 * The worker runs under Node's permission model, which denies `realpath`,
 * `stat`, `readdir`, `rename` and `readFile` on every path outside the module
 * directory, and the broker exposes only `read`/`write`/`list`/`stat`. The few
 * operations the broker lacks therefore run in a child spawned through
 * `ctx.process.run`: argv only, no shell string, no extra dependency. Each
 * helper prints JSON (or nothing) on stdout and its message on stderr.
 *
 * @module z1-tools/host
 */

import { resolve } from 'node:path'

import { fail } from './args.js'

export const HELPER_TIMEOUT_MS = 15_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run `node -e <source> ...args` in the workspace and return its stdout.
 *
 * `label` prefixes every failure, so callers report the tool operation rather
 * than the helper's own stack.
 */
export async function runHelper(ctx, source, args, label) {
  let result
  try {
    result = await ctx.process.run({
      command: process.execPath,
      args: ['-e', source, ...args],
      cwd: resolve(ctx.workspace),
      timeoutMs: HELPER_TIMEOUT_MS,
    })
  } catch (error) {
    fail(`${label}: ${errorMessage(error)}`)
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    fail(`${label}: ${detail}`)
  }
  return result.stdout
}
