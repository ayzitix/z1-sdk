/**
 * Path rules for every tool.
 *
 * The workspace is the project folder the host hands the worker as
 * `ctx.workspace`. Every path a tool touches is contained by it:
 *
 * - a relative path resolves against the workspace;
 * - an absolute path is accepted only when its real path (symlinks followed)
 *   is the workspace or below it;
 * - a target that does not exist yet is checked through the real path of its
 *   nearest existing parent, so `../..` escapes and symlinks leaving the
 *   workspace are refused before anything is read or written.
 *
 * The refusal is always `path escapes workspace: <path>`. Results display a
 * workspace-relative path when the target is inside the workspace (`.` for the
 * workspace itself) and an absolute path otherwise.
 *
 * The worker cannot call `realpath` itself (Node's permission model denies
 * every read outside the module directory and the broker has no `realpath`),
 * so resolution runs in a one-shot helper child through `ctx.process.run`.
 *
 * @module z1-tools/paths
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

import { fail } from './args.js'
import { runHelper } from './host.js'

/** Resolve symlinks manually so a dangling link is still judged by its target. */
const RESOLVE_SCRIPT = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  'const target = path.resolve(process.argv[1])',
  'const root = fs.realpathSync(process.cwd())',
  'function resolveReal(start) {',
  '  let current = start',
  '  const suffix = []',
  '  let hops = 0',
  '  for (;;) {',
  '    try {',
  '      const real = fs.realpathSync(current)',
  '      return suffix.length === 0 ? real : path.join(real, ...suffix.slice().reverse())',
  '    } catch (error) {',
  '      const code = error === null || typeof error !== "object" ? undefined : error.code',
  '      if (code !== "ENOENT" && code !== "ENOTDIR") throw error',
  '    }',
  '    let info = null',
  '    try { info = fs.lstatSync(current) } catch {}',
  '    if (info !== null && info.isSymbolicLink()) {',
  '      hops += 1',
  '      if (hops > 40) throw new Error("too many symbolic links")',
  '      current = path.resolve(path.dirname(current), fs.readlinkSync(current))',
  '      continue',
  '    }',
  '    const parent = path.dirname(current)',
  '    if (parent === current) return path.join(current, ...suffix.slice().reverse())',
  '    suffix.push(path.basename(current))',
  '    current = parent',
  '  }',
  '}',
  'process.stdout.write(JSON.stringify({ root, path: resolveReal(target) }))',
].join('\n')

/** Real workspace roots, learnt from the first resolution for each context. */
const roots = new WeakMap()

/** The workspace as the filesystem sees it, once a path has been resolved. */
export function workspaceRoot(ctx) {
  return roots.get(ctx) ?? resolve(ctx.workspace)
}

async function resolveReal(ctx, candidate) {
  const label = `cannot resolve "${candidate}"`
  const stdout = await runHelper(ctx, RESOLVE_SCRIPT, [candidate], label)
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    fail(`${label}: malformed helper output`)
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.root !== 'string' ||
    typeof parsed.path !== 'string'
  ) {
    fail(`${label}: malformed helper output`)
  }
  return parsed
}

/**
 * Resolve and contain one tool path.
 *
 * Throws `path escapes workspace: <path>` for `..` escapes, absolute paths
 * outside the workspace and symlinks that point outside it.
 */
export async function resolvePath(ctx, value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty path string`)
  }
  const candidate = isAbsolute(value) ? resolve(value) : resolve(ctx.workspace, value)
  const resolved = await resolveReal(ctx, candidate)
  roots.set(ctx, resolved.root)
  if (!insideWorkspace(resolved.root, resolved.path)) {
    fail(`path escapes workspace: ${resolved.path}`)
  }
  return resolved.path
}

export function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/** True when `target` is the workspace or a path below it (lexical). */
export function insideWorkspace(workspace, target) {
  const root = resolve(workspace)
  const rel = relative(root, resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Workspace-relative when inside it, absolute otherwise. */
export function displayPath(ctx, target) {
  const root = typeof ctx === 'string' ? resolve(ctx) : workspaceRoot(ctx)
  const resolved = resolve(target)
  if (!insideWorkspace(root, resolved)) return toPosix(resolved)
  const rel = relative(root, resolved)
  return rel === '' ? '.' : toPosix(rel)
}
