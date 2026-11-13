/**
 * Filesystem tools: `write`, `edit`, `stat`, `mkdir` and `move`.
 *
 * Reads and writes go through the host's `ctx.fs` broker, so the manifest's
 * `fs` grant decides what the module may touch and denials stay auditable.
 * The broker exposes only `read`/`write`/`list`, so the two operations it
 * lacks — `stat` (mtime) and `move` (rename) — run as a tiny `node -e` helper
 * through `ctx.process.run`: argv only, no shell string, no extra dependency.
 * `mkdir` uses `node:fs` directly, which Node's permission model only allows
 * inside the granted write patterns.
 *
 * @module z1-tools/fs
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { fail, optionalBoolean, positiveInteger, stringArg } from './args.js'
import { displayPath, resolvePath } from './paths.js'
import {
  MAX_READ_BYTES,
  MAX_READ_LINES,
  byteLength,
  excerpt,
  plural,
  readWindow,
} from './text.js'

/** Operations Node's permission model denies inside the worker's own process. */
const HELPER_SCRIPT = [
  "const fs = require('node:fs/promises')",
  "const path = require('node:path')",
  'async function main() {',
  "  const op = process.argv[1]",
  "  if (op === 'stat') {",
  '    const info = await fs.lstat(process.argv[2])',
  '    const type = info.isSymbolicLink()',
  "      ? 'symlink'",
  "      : info.isDirectory()",
  "        ? 'dir'",
  "        : info.isFile()",
  "          ? 'file'",
  "          : 'other'",
  '    process.stdout.write(',
  '      JSON.stringify({ type, size: info.isFile() ? info.size : 0, mtime: info.mtime.toISOString() }),',
  '    )',
  '    return',
  '  }',
  "  if (op === 'move') {",
  '    const from = process.argv[2]',
  '    const to = process.argv[3]',
  '    await fs.mkdir(path.dirname(to), { recursive: true })',
  '    try {',
  '      await fs.rename(from, to)',
  '    } catch (error) {',
  "      if (error && error.code === 'EXDEV') {",
  '        await fs.cp(from, to, { recursive: true })',
  '        await fs.rm(from, { recursive: true, force: true })',
  '      } else {',
  '        throw error',
  '      }',
  '    }',
  "    process.stdout.write('{}')",
  '    return',
  '  }',
  "  throw new Error('unknown filesystem helper op ' + op)",
  '}',
  'main().catch((error) => {',
  '  const detail = error && error.message ? error.message : String(error)',
  '  process.stderr.write(detail)',
  '  process.exit(1)',
  '})',
].join('\n')

const HELPER_TIMEOUT_MS = 15_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function runHelper(ctx, args) {
  let result
  try {
    result = await ctx.process.run({
      command: process.execPath,
      args: ['-e', HELPER_SCRIPT, ...args],
      cwd: resolve(ctx.workspace),
      timeoutMs: HELPER_TIMEOUT_MS,
    })
  } catch (error) {
    fail(`filesystem helper could not start: ${errorMessage(error)}`)
  }
  if (result.code !== 0) {
    fail(result.stderr.trim() || `filesystem helper exited ${result.code}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail('filesystem helper returned malformed output')
  }
}

function countOccurrences(text, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const at = text.indexOf(needle, index)
    if (at < 0) return count
    count += 1
    index = at + needle.length
  }
}

export async function readTool(ctx, raw) {
  const path = resolvePath(ctx, raw['path'], 'read.path')
  const shown = displayPath(ctx.workspace, path)
  const offset = positiveInteger(raw, 'offset', 'read') ?? 1
  const limit = positiveInteger(raw, 'limit', 'read', MAX_READ_LINES) ?? MAX_READ_LINES

  let text
  try {
    text = await ctx.fs.read(path)
  } catch (error) {
    fail(`cannot read "${shown}": ${errorMessage(error)}`)
  }

  const bytes = byteLength(text)
  if (bytes > MAX_READ_BYTES) {
    fail(
      `cannot read "${shown}": ${bytes} bytes is over the ${MAX_READ_BYTES}-byte limit; ` +
        'read a smaller range',
    )
  }

  const window = readWindow(text, offset, limit)
  if (window.body === '') {
    return `(no lines: ${shown} has ${plural(window.total, 'line')})`
  }
  if (!window.truncated) return window.body
  return `${window.body}\n… (truncated: lines ${window.first}-${window.last} of ${window.total})`
}

export async function writeTool(ctx, raw) {
  const path = resolvePath(ctx, raw['path'], 'write.path')
  const content = raw['content']
  if (typeof content !== 'string') fail('write.content must be a string')
  const bytes = byteLength(content)

  try {
    await ctx.fs.write(path, content)
  } catch (error) {
    fail(`cannot write "${displayPath(ctx.workspace, path)}": ${errorMessage(error)}`)
  }
  return `wrote ${displayPath(ctx.workspace, path)} (${bytes} bytes)`
}

export async function editTool(ctx, raw) {
  const path = resolvePath(ctx, raw['path'], 'edit.path')
  const oldText = stringArg(raw, 'oldText', 'edit')
  const newText = raw['newText']
  if (typeof newText !== 'string') fail('edit.newText must be a string')
  const replaceAll = optionalBoolean(raw, 'replaceAll', 'edit') === true
  const shown = displayPath(ctx.workspace, path)

  let before
  try {
    before = await ctx.fs.read(path)
  } catch (error) {
    fail(`cannot read "${shown}": ${errorMessage(error)}`)
  }

  const found = countOccurrences(before, oldText)
  if (found === 0) {
    fail(`edit: "${excerpt(oldText)}" does not occur in ${shown}`)
  }
  if (found > 1 && !replaceAll) {
    fail(
      `edit: "${excerpt(oldText)}" occurs ${plural(found, 'time')} in ${shown}; ` +
        'pass replaceAll: true to replace every occurrence',
    )
  }

  const after = replaceAll
    ? before.split(oldText).join(newText)
    : before.slice(0, before.indexOf(oldText)) +
      newText +
      before.slice(before.indexOf(oldText) + oldText.length)

  try {
    await ctx.fs.write(path, after)
  } catch (error) {
    fail(`cannot write "${shown}": ${errorMessage(error)}`)
  }
  return `edited ${shown} (${plural(found, 'replacement')})`
}

export async function statTool(ctx, raw) {
  const path = resolvePath(ctx, raw['path'], 'stat.path')
  const shown = displayPath(ctx.workspace, path)
  let info
  try {
    info = await runHelper(ctx, ['stat', path])
  } catch (error) {
    fail(`cannot stat "${shown}": ${errorMessage(error)}`)
  }
  return `${info.type} ${info.size} ${info.mtime} ${shown}`
}

export async function mkdirTool(ctx, raw) {
  const path = resolvePath(ctx, raw['path'], 'mkdir.path')
  const shown = displayPath(ctx.workspace, path)
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    fail(`cannot create "${shown}": ${errorMessage(error)}`)
  }
  return `created ${shown}`
}

export async function moveTool(ctx, raw) {
  const from = resolvePath(ctx, raw['from'], 'move.from')
  const to = resolvePath(ctx, raw['to'], 'move.to')
  const shownFrom = displayPath(ctx.workspace, from)
  const shownTo = displayPath(ctx.workspace, to)
  try {
    await runHelper(ctx, ['move', from, to])
  } catch (error) {
    fail(`cannot move "${shownFrom}" to "${shownTo}": ${errorMessage(error)}`)
  }
  return `moved ${shownFrom} -> ${shownTo}`
}
