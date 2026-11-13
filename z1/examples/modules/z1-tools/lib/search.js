/**
 * Search and inventory tools: `list`, `glob`, `grep` and `tree`.
 *
 * Every walk goes through the brokered `ctx.fs.list`/`ctx.fs.read`, is bounded
 * in depth and entries, and reports truncation instead of walking forever.
 *
 * Symlinks are never followed: the broker reports a link as its own entry
 * (`type: "symlink"`), the walk only recurses into `dir`, and `grep` only reads
 * `file`, so a link inside the workspace cannot make a search leave it. `list`
 * still shows the link itself as `link <path>`. `grep` silently skips files
 * over 1 MiB and files whose first 8 KiB contains a NUL byte.
 *
 * @module z1-tools/search
 */

import {
  fail,
  optionalBoolean,
  optionalInteger,
  optionalString,
  positiveInteger,
  stringArg,
} from './args.js'
import { displayPath, resolvePath, toPosix, workspaceRoot } from './paths.js'
import { BINARY_SNIFF_BYTES, MAX_READ_BYTES, splitLines } from './text.js'

/** Deepest recursion accepted by `list`, `glob` and `grep`. */
export const MAX_DEPTH = 8
/** Most entries one walk collects before reporting truncation. */
export const MAX_ENTRIES = 5000
/** Most matches `grep` returns by default. */
export const MAX_GREP_RESULTS = 200
/** Deepest tree `tree` renders. */
export const MAX_TREE_DEPTH = 7
/** Most entries `tree` renders. */
export const MAX_TREE_ENTRIES = 3000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function relPosix(base, path) {
  const rel = toPosix(path).slice(toPosix(base).length)
  return rel.startsWith('/') ? rel.slice(1) : rel
}

/**
 * Walk `base` depth first through the broker.
 *
 * `depth` counts levels below `base`: its immediate children are depth 1.
 * A symlink is collected as an entry but never recursed into, so the walk
 * cannot be steered outside the workspace by a link.
 */
export async function walk(ctx, base, maxDepth, options = {}) {
  const entries = []
  let truncated = false

  const visit = async (directory, depth) => {
    if (depth > maxDepth || truncated) return
    let listed
    try {
      listed = await ctx.fs.list(directory)
    } catch (error) {
      fail(`cannot list "${displayPath(ctx.workspace, directory)}": ${errorMessage(error)}`)
    }
    const children = Array.isArray(listed.entries) ? listed.entries : []
    for (const entry of children) {
      if (options.skipGit === true && entry.name === '.git') continue
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        return
      }
      entries.push({
        name: entry.name,
        path: entry.path,
        type: entry.type,
        ...(entry.size === undefined ? {} : { size: entry.size }),
        depth,
      })
      // Only real directories are entered; a symlink is an entry, not a path.
      if (entry.type === 'dir' && depth < maxDepth) await visit(entry.path, depth + 1)
    }
  }

  await visit(base, 1)
  return { entries, truncated }
}

export async function listTool(ctx, raw) {
  const base = await resolvePath(ctx, raw['path'], 'list.path')
  const recursive = optionalBoolean(raw, 'recursive', 'list') === true
  const requested = positiveInteger(raw, 'maxDepth', 'list', MAX_DEPTH)
  const maxDepth = requested ?? (recursive ? MAX_DEPTH : 1)

  const { entries, truncated } = await walk(ctx, base, maxDepth)
  const lines = entries.map((entry) => {
    const path = displayPath(ctx.workspace, entry.path)
    if (entry.type === 'dir') return `dir ${path}`
    if (entry.type === 'symlink') return `link ${path}`
    const size = entry.size === undefined ? '?' : String(entry.size)
    return `file ${path} (${size})`
  })
  if (truncated) lines.push(`… (${MAX_ENTRIES}-entry limit reached)`)

  return lines.join('\n')
}

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character
}

/** Anchored glob: `**` crosses `/`, `*` and `?` do not. */
export function globToRegExp(pattern) {
  let source = '^'
  let index = 0
  while (index < pattern.length) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 2
        if (pattern[index] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        index += 1
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      index += 1
      source += '[^/]'
      continue
    }
    source += escapeRegex(character)
    index += 1
  }
  return new RegExp(`${source}$`)
}

function normalizeGlob(pattern) {
  return pattern.startsWith('./') ? pattern.slice(2) : pattern
}

export async function globTool(ctx, raw) {
  const pattern = normalizeGlob(stringArg(raw, 'pattern', 'glob'))
  const base =
    raw['path'] === undefined
      ? workspaceRoot(ctx)
      : await resolvePath(ctx, raw['path'], 'glob.path')
  const matcher = globToRegExp(pattern)

  const { entries, truncated } = await walk(ctx, base, MAX_DEPTH, { skipGit: true })
  const matches = []
  for (const entry of entries) {
    if (entry.type === 'dir') continue
    const rel = relPosix(base, entry.path)
    if (matcher.test(rel)) matches.push(displayPath(ctx.workspace, entry.path))
  }
  matches.sort()

  if (truncated) matches.push(`… (${MAX_ENTRIES}-entry limit reached)`)
  return matches.join('\n')
}

/** Merge the context windows around each matching line index. */
function contextRanges(indexes, context) {
  const ranges = []
  for (const index of indexes) {
    const start = Math.max(0, index - context)
    const end = index + context
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }
  return ranges
}

export async function grepTool(ctx, raw) {
  const pattern = stringArg(raw, 'pattern', 'grep')
  const base =
    raw['path'] === undefined
      ? workspaceRoot(ctx)
      : await resolvePath(ctx, raw['path'], 'grep.path')
  const fileGlob = optionalString(raw, 'glob', 'grep')
  const caseSensitive = optionalBoolean(raw, 'caseSensitive', 'grep') === true
  const context = optionalInteger(raw, 'context', 'grep', 0, 20) ?? 0
  const maxResults = positiveInteger(raw, 'maxResults', 'grep', MAX_GREP_RESULTS) ?? MAX_GREP_RESULTS

  let regex
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i')
  } catch (error) {
    fail(`grep.pattern is not a valid regular expression: ${errorMessage(error)}`)
  }
  const fileMatcher = fileGlob === undefined ? undefined : globToRegExp(normalizeGlob(fileGlob))

  const { entries } = await walk(ctx, base, MAX_DEPTH, { skipGit: true })
  const output = []
  let matches = 0
  let truncated = false

  for (const entry of entries) {
    if (truncated) break
    if (entry.type !== 'file') continue
    if (fileMatcher !== undefined && !fileMatcher.test(relPosix(base, entry.path))) continue
    // Files over 1 MiB are skipped without a note (see README).
    if (entry.size !== undefined && entry.size > MAX_READ_BYTES) continue

    let text
    try {
      text = await ctx.fs.read(entry.path)
    } catch {
      continue
    }
    // A NUL byte in the head is the usual "this is not text" signal.
    if (text.slice(0, BINARY_SNIFF_BYTES).includes('\0')) continue

    const lines = splitLines(text)
    const matched = []
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index])) matched.push(index)
    }
    if (matched.length === 0) continue
    const matchedSet = new Set(matched)

    const shown = displayPath(ctx.workspace, entry.path)
    for (const range of contextRanges(matched, context)) {
      for (let index = range.start; index < Math.min(range.end + 1, lines.length); index += 1) {
        const isMatch = matchedSet.has(index)
        if (isMatch) {
          if (matches >= maxResults) {
            truncated = true
            break
          }
          matches += 1
          output.push(`${shown}:${index + 1}: ${lines[index]}`)
        } else {
          output.push(`${shown}-${index + 1}- ${lines[index]}`)
        }
      }
      if (truncated) break
    }
  }

  if (truncated) output.push(`… (${maxResults}-result limit reached)`)
  return output.join('\n')
}

export async function treeTool(ctx, raw) {
  const base =
    raw['path'] === undefined
      ? workspaceRoot(ctx)
      : await resolvePath(ctx, raw['path'], 'tree.path')
  const depth = positiveInteger(raw, 'depth', 'tree', MAX_TREE_DEPTH) ?? 3

  const lines = [displayPath(ctx.workspace, base)]
  let count = 0
  let truncated = false

  const visit = async (directory, prefix, level) => {
    if (level > depth || truncated) return
    let listed
    try {
      listed = await ctx.fs.list(directory)
    } catch (error) {
      fail(`cannot list "${displayPath(ctx.workspace, directory)}": ${errorMessage(error)}`)
    }
    const children = (listed.entries ?? []).filter((entry) => entry.name !== '.git')
    for (let index = 0; index < children.length; index += 1) {
      if (count >= MAX_TREE_ENTRIES) {
        truncated = true
        return
      }
      const entry = children[index]
      count += 1
      const last = index === children.length - 1
      const label = entry.type === 'dir' ? `${entry.name}/` : entry.name
      lines.push(`${prefix}${last ? '└── ' : '├── '}${label}`)
      if (entry.type === 'dir' && level < depth) {
        await visit(entry.path, `${prefix}${last ? '    ' : '│   '}`, level + 1)
      }
    }
  }

  await visit(base, '', 1)
  if (truncated) lines.push('… (tree truncated)')
  return lines.join('\n')
}
