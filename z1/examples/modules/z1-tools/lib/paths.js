/**
 * Path rules for every tool.
 *
 * The workspace is the project folder the host hands the worker as
 * `ctx.workspace`. Relative paths resolve there, absolute paths are used as
 * given, and results show a workspace-relative path whenever the target is
 * inside the workspace (`.` for the workspace itself).
 *
 * @module z1-tools/paths
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

import { fail } from './args.js'

/** Absolute paths pass through; relative ones resolve against the workspace. */
export function resolvePath(ctx, value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty path string`)
  }
  return isAbsolute(value) ? resolve(value) : resolve(ctx.workspace, value)
}

export function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/** True when `target` is the workspace or a path below it. */
export function insideWorkspace(workspace, target) {
  const root = resolve(workspace)
  const rel = relative(root, resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Workspace-relative when inside it, absolute otherwise. */
export function displayPath(workspace, target) {
  const resolved = resolve(target)
  if (!insideWorkspace(workspace, resolved)) return toPosix(resolved)
  const rel = relative(resolve(workspace), resolved)
  return rel === '' ? '.' : toPosix(rel)
}
