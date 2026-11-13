/**
 * `shell`: one command, argv only, no shell string.
 *
 * The child is spawned by the host through the brokered `ctx.process.run`, so
 * `process.spawn` in the manifest decides which executables are reachable. The
 * result is text: the exit status followed by stdout and stderr.
 *
 * @module z1-tools/shell
 */

import { resolve } from 'node:path'

import { fail, positiveInteger, stringArg } from './args.js'
import { resolvePath } from './paths.js'

export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 300_000

/** Run one argv command; shared by `shell` and the read-only git tools. */
export function runCommand(ctx, request) {
  return ctx.process.run(request)
}

export async function shellTool(ctx, raw) {
  const command = stringArg(raw, 'command', 'shell')
  const args = raw['args']
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
      fail('shell.args must be an array of strings')
    }
  }
  const cwd =
    raw['cwd'] === undefined ? resolve(ctx.workspace) : resolvePath(ctx, raw['cwd'], 'shell.cwd')
  const timeoutMs = positiveInteger(raw, 'timeoutMs', 'shell', MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS

  let result
  try {
    result = await runCommand(ctx, { command, args: args ?? [], cwd, timeoutMs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`shell: cannot run "${command}": ${message}`)
  }

  const parts = [`exit ${result.code === null ? 'null' : result.code}`]
  const stdout = result.stdout.replace(/\n+$/, '')
  const stderr = result.stderr.replace(/\n+$/, '')
  if (stdout !== '') parts.push('--- stdout ---', stdout)
  if (stderr !== '') parts.push('--- stderr ---', stderr)
  if (result.truncated === true) parts.push('(output truncated)')
  return parts.join('\n')
}
