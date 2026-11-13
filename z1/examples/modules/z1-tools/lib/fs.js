/**
 * Filesystem tools: `write`, `edit`, `stat`, `mkdir` and `move`.
 *
 * Reads and writes go through the host's `ctx.fs` broker, so the manifest's
 * `fs` grant decides what the module may touch and denials stay auditable.
 * `stat` uses the brokered `ctx.fs.stat` (lstat semantics: a symlink reports
 * itself, not its target). The broker has no `rename`, and the worker runs
 * under Node's permission model, which denies it even on write-granted paths,
 * so `move` runs a tiny `node -e` helper through `ctx.process.run`: argv only,
 * no shell string, no extra dependency. `mkdir` uses `node:fs` directly, which
 * Node's permission model only allows inside the granted write patterns.
 *
 * Every path is contained by `resolvePath` before use; `move` checks both ends.
 *
 * @module z1-tools/fs
 */

import { mkdir } from 'node:fs/promises'

import { fail, optionalBoolean, positiveInteger, stringArg } from './args.js'
import { runHelper } from './host.js'
import { displayPath, resolvePath } from './paths.js'
import {
  BINARY_SNIFF_BYTES,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  byteLength,
  detectEol,
  excerpt,
  plural,
  readWindow,
  toEol,
} from './text.js'

/**
 * `move` helper: rename within the workspace, falling back to copy-and-delete
 * when the source and destination are on different devices.
 */
const MOVE_SCRIPT = [
  "const fs = require('node:fs/promises')",
  "const path = require('node:path')",
  'async function main() {',
  '  const from = process.argv[1]',
  '  const to = process.argv[2]',
  '  await fs.mkdir(path.dirname(to), { recursive: true })',
  '  try {',
  '    await fs.rename(from, to)',
  '  } catch (error) {',
  '    if (error !== null && typeof error === "object" && error.code === "EXDEV") {',
  '      await fs.cp(from, to, { recursive: true })',
  '      await fs.rm(from, { recursive: true, force: true })',
  '    } else {',
  '      throw error',
  '    }',
  '  }',
  '}',
  'main().catch((error) => {',
  '  const detail = error && error.message ? error.message : String(error)',
  '  process.stderr.write(detail)',
  '  process.exit(1)',
  '})',
].join('\n')

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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
  const path = await resolvePath(ctx, raw['path'], 'read.path')
  const shown = displayPath(ctx, path)
  const offset = positiveInteger(raw, 'offset', 'read') ?? 1
  const limit = positiveInteger(raw, 'limit', 'read', MAX_READ_LINES) ?? MAX_READ_LINES

  // Guard before loading: a huge file or a binary is refused by metadata only.
  let info
  try {
    info = await ctx.fs.stat(path)
  } catch (error) {
    fail(`cannot read "${shown}": ${errorMessage(error)}`)
  }
  if (info.type === 'file' && info.size > MAX_READ_BYTES) {
    fail(`cannot read "${shown}": file is ${info.size} bytes; use shell sed -n`)
  }

  let text
  try {
    text = await ctx.fs.read(path)
  } catch (error) {
    fail(`cannot read "${shown}": ${errorMessage(error)}`)
  }
  if (text.slice(0, BINARY_SNIFF_BYTES).includes('\0')) {
    fail(`cannot read "${shown}": binary file: ${shown}`)
  }

  const window = readWindow(text, offset, limit)
  if (window.body === '') {
    return `(no lines: ${shown} has ${plural(window.total, 'line')})`
  }
  if (!window.truncated) return window.body
  return `${window.body}\n… (truncated: lines ${window.first}-${window.last} of ${window.total})`
}

export async function writeTool(ctx, raw) {
  const path = await resolvePath(ctx, raw['path'], 'write.path')
  const content = raw['content']
  if (typeof content !== 'string') fail('write.content must be a string')
  const bytes = byteLength(content)

  try {
    await ctx.fs.write(path, content)
  } catch (error) {
    fail(`cannot write "${displayPath(ctx, path)}": ${errorMessage(error)}`)
  }
  return `wrote ${displayPath(ctx, path)} (${bytes} bytes)`
}

export async function editTool(ctx, raw) {
  const path = await resolvePath(ctx, raw['path'], 'edit.path')
  const oldText = stringArg(raw, 'oldText', 'edit')
  const newText = raw['newText']
  if (typeof newText !== 'string') fail('edit.newText must be a string')
  const replaceAll = optionalBoolean(raw, 'replaceAll', 'edit') === true
  const shown = displayPath(ctx, path)

  let before
  try {
    before = await ctx.fs.read(path)
  } catch (error) {
    fail(`cannot read "${shown}": ${errorMessage(error)}`)
  }

  // Match the text as given first, then in the file's own line-ending style, so
  // a block copied from a CRLF file works and one pasted from a LF tool works.
  const eol = detectEol(before)
  let needle = oldText
  let found = countOccurrences(before, needle)
  if (found === 0) {
    needle = toEol(oldText, eol)
    found = countOccurrences(before, needle)
  }
  if (found === 0) {
    fail(`edit: "${excerpt(oldText)}" does not occur in ${shown}`)
  }
  if (found > 1 && !replaceAll) {
    fail(
      `edit: "${excerpt(oldText)}" occurs ${plural(found, 'time')} in ${shown}; ` +
        'pass replaceAll: true to replace every occurrence',
    )
  }

  const replacement = toEol(newText, eol)
  const after = replaceAll
    ? before.split(needle).join(replacement)
    : before.slice(0, before.indexOf(needle)) +
      replacement +
      before.slice(before.indexOf(needle) + needle.length)

  try {
    await ctx.fs.write(path, after)
  } catch (error) {
    fail(`cannot write "${shown}": ${errorMessage(error)}`)
  }
  return `edited ${shown} (${plural(found, 'replacement')})`
}

export async function statTool(ctx, raw) {
  const path = await resolvePath(ctx, raw['path'], 'stat.path')
  const shown = displayPath(ctx, path)
  let info
  try {
    info = await ctx.fs.stat(path)
  } catch (error) {
    fail(`cannot stat "${shown}": ${errorMessage(error)}`)
  }
  const size = info.type === 'file' ? info.size : 0
  return `${info.type} ${size} ${new Date(info.mtimeMs).toISOString()} ${shown}`
}

export async function mkdirTool(ctx, raw) {
  const path = await resolvePath(ctx, raw['path'], 'mkdir.path')
  const shown = displayPath(ctx, path)
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    fail(`cannot create "${shown}": ${errorMessage(error)}`)
  }
  return `created ${shown}`
}

export async function moveTool(ctx, raw) {
  const from = await resolvePath(ctx, raw['from'], 'move.from')
  const to = await resolvePath(ctx, raw['to'], 'move.to')
  const shownFrom = displayPath(ctx, from)
  const shownTo = displayPath(ctx, to)
  const label = `cannot move "${shownFrom}" to "${shownTo}"`
  await runHelper(ctx, MOVE_SCRIPT, [from, to], label)
  return `moved ${shownFrom} -> ${shownTo}`
}
