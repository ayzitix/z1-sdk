/**
 * Read-only git tools: `git.status`, `git.diff` and `git.log`.
 *
 * They run `git` through `ctx.process.run` in the workspace. Nothing here
 * stages, commits or rewrites history.
 *
 * A `ref` is attacker-controlled input, so one that starts with `-` is refused
 * outright and the ref is passed after `--end-of-options`, with any pathspec
 * after `--`. That keeps `ref: "--output=/tmp/x"` (or `-O`, `--no-index`, ...)
 * from turning a read-only diff into a write.
 *
 * @module z1-tools/git
 */

import { resolve } from 'node:path'

import { fail, optionalBoolean, optionalInteger, optionalString } from './args.js'
import { resolvePath } from './paths.js'
import { runCommand } from './shell.js'

const GIT_TIMEOUT_MS = 30_000

async function git(ctx, args) {
  let result
  try {
    result = await runCommand(ctx, {
      command: 'git',
      args,
      cwd: resolve(ctx.workspace),
      timeoutMs: GIT_TIMEOUT_MS,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`git ${args[0]} could not run: ${message}`)
  }
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).trim()
    fail(`git ${args[0]} failed: ${detail}`)
  }
  return result.stdout.replace(/\s+$/, '')
}

/** Absolute path for a git pathspec: resolves relative to the workspace. */
async function pathspec(ctx, value, tool) {
  return await resolvePath(ctx, value, `${tool}.path`)
}

/** A revision is data, never an option. */
function revision(ref, tool) {
  if (ref.startsWith('-')) {
    fail(`${tool}.ref must not start with "-"`)
  }
  return ref
}

export async function gitStatus(ctx) {
  return git(ctx, ['status', '--porcelain'])
}

export async function gitDiff(ctx, raw) {
  const staged = optionalBoolean(raw, 'staged', 'git.diff') === true
  const ref = optionalString(raw, 'ref', 'git.diff')
  const path = raw['path'] === undefined ? undefined : await pathspec(ctx, raw['path'], 'git.diff')

  const args = ['diff']
  if (staged) args.push('--staged')
  if (ref !== undefined) args.push('--end-of-options', revision(ref, 'git.diff'))
  if (path !== undefined) args.push('--', path)
  return git(ctx, args)
}

export async function gitLog(ctx, raw) {
  const limit = optionalInteger(raw, 'limit', 'git.log', 1, 200) ?? 20
  const path = raw['path'] === undefined ? undefined : await pathspec(ctx, raw['path'], 'git.log')

  const args = ['log', '--pretty=format:%h %ad %s', '--date=short', `--max-count=${limit}`]
  if (path !== undefined) args.push('--', path)
  return git(ctx, args)
}
