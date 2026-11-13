/**
 * `apply_patch`: a SEARCH/REPLACE patch of one or more files.
 *
 * Each block names a file, then quotes the exact text to find and its
 * replacement:
 *
 * ```text
 * src/app.js
 * <<<<<<< SEARCH
 * const port = 3000
 * =======
 * const port = 8080
 * >>>>>>> REPLACE
 * ```
 *
 * Every SEARCH block must match exactly once (in LF or in the file's own
 * line-ending style), all blocks are applied in memory first, and a single
 * mismatch aborts the whole patch. Changed files are written to a temporary
 * file next to each original and then renamed into place by one helper child,
 * so a failure while writing or renaming restores every original.
 *
 * @module z1-tools/patch
 */

import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { fail, stringArg } from './args.js'
import { runHelper } from './host.js'
import { displayPath, resolvePath } from './paths.js'
import { detectEol, excerpt, plural, splitLines, toEol } from './text.js'

/**
 * Commit helper: rename every prepared temp file over its target, keeping the
 * previous content in memory so a late failure can be rolled back.
 */
const COMMIT_SCRIPT = [
  "const fs = require('node:fs/promises')",
  'async function main() {',
  '  const pairs = JSON.parse(process.argv[1])',
  '  const done = []',
  '  try {',
  '    for (const pair of pairs) {',
  '      let previous = null',
  '      try {',
  '        previous = await fs.readFile(pair.to)',
  '      } catch (error) {',
  '        if (error === null || typeof error !== "object" || error.code !== "ENOENT") throw error',
  '      }',
  '      done.push({ to: pair.to, previous })',
  '      await fs.rename(pair.from, pair.to)',
  '    }',
  '  } catch (error) {',
  '    for (const step of done.reverse()) {',
  '      try {',
  '        if (step.previous === null) await fs.unlink(step.to)',
  '        else await fs.writeFile(step.to, step.previous)',
  '      } catch {}',
  '    }',
  '    throw error',
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

function blockLineCount(text) {
  return text === '' ? 0 : splitLines(text).length
}

/** Parse the patch text into `{ path, oldText, newText }` blocks, in order. */
export function parsePatch(patch) {
  if (typeof patch !== 'string' || patch.trim().length === 0) {
    fail('apply_patch.patch must be a non-empty string')
  }

  const lines = patch.split(/\r?\n/)
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index].trim()
    if (line === '') {
      index += 1
      continue
    }
    if (line.startsWith('<<<<<<<') || line === '=======' || line.startsWith('>>>>>>>')) {
      fail(`apply_patch: expected a file path at line ${index + 1}, found "${line}"`)
    }

    const path = line
    index += 1
    if (index >= lines.length || !lines[index].trim().startsWith('<<<<<<< SEARCH')) {
      fail(`apply_patch: expected "<<<<<<< SEARCH" after "${path}"`)
    }

    index += 1
    const oldLines = []
    while (index < lines.length && lines[index].trim() !== '=======') {
      oldLines.push(lines[index])
      index += 1
    }
    if (index >= lines.length) fail(`apply_patch: missing "=======" for "${path}"`)

    index += 1
    const newLines = []
    while (index < lines.length && !lines[index].trim().startsWith('>>>>>>> REPLACE')) {
      newLines.push(lines[index])
      index += 1
    }
    if (index >= lines.length) fail(`apply_patch: missing ">>>>>>> REPLACE" for "${path}"`)
    index += 1

    const oldText = oldLines.join('\n')
    if (oldText === '') {
      fail(`apply_patch: the SEARCH block for "${path}" is empty; quote the text to replace`)
    }
    blocks.push({ path, oldText, newText: newLines.join('\n') })
  }

  if (blocks.length === 0) fail('apply_patch.patch contains no SEARCH/REPLACE block')
  return blocks
}

/** Write every changed file to a sibling temp file, then rename them in. */
async function commit(ctx, states) {
  const temps = []
  try {
    for (const state of states) {
      const temp = join(
        dirname(state.path),
        `.${basename(state.path)}.z1-${randomUUID()}.tmp`,
      )
      try {
        await ctx.fs.write(temp, state.content)
      } catch (error) {
        fail(`apply_patch: cannot write "${state.shown}": ${errorMessage(error)}`)
      }
      temps.push({ from: temp, to: state.path })
    }
    const label = `apply_patch: cannot write ${plural(states.length, 'file')}`
    await runHelper(ctx, COMMIT_SCRIPT, [JSON.stringify(temps)], label)
  } finally {
    // Renamed temps are gone; a failed run leaves the originals untouched.
    for (const entry of temps) {
      try {
        await unlink(entry.from)
      } catch {
        // already renamed away, or never created
      }
    }
  }
}

/** Apply every block in memory, then commit the changed files atomically. */
export async function applyPatch(ctx, raw) {
  const blocks = parsePatch(stringArg(raw, 'patch', 'apply_patch'))
  const files = new Map()
  const order = []

  for (const block of blocks) {
    const path = await resolvePath(ctx, block.path, 'apply_patch.path')
    const shown = displayPath(ctx, path)
    let state = files.get(path)
    if (state === undefined) {
      let content
      try {
        content = await ctx.fs.read(path)
      } catch (error) {
        fail(`apply_patch: cannot read "${shown}": ${errorMessage(error)}`)
      }
      state = { path, shown, content, eol: detectEol(content), added: 0, removed: 0 }
      files.set(path, state)
      order.push(state)
    }

    // Search as written, then in the file's own line-ending style.
    let needle = block.oldText
    let found = countOccurrences(state.content, needle)
    if (found === 0) {
      needle = toEol(block.oldText, state.eol)
      found = countOccurrences(state.content, needle)
    }
    if (found === 0) {
      fail(
        `apply_patch: no match for "${excerpt(block.oldText)}" in ${shown}; ` +
          'quote the current text exactly',
      )
    }
    if (found > 1) {
      fail(
        `apply_patch: "${excerpt(block.oldText)}" matches ${plural(found, 'time')} in ${shown}; ` +
          'include more context so the block is unique',
      )
    }

    const replacement = toEol(block.newText, state.eol)
    const at = state.content.indexOf(needle)
    state.content =
      state.content.slice(0, at) + replacement + state.content.slice(at + needle.length)
    state.added += blockLineCount(block.newText)
    state.removed += blockLineCount(block.oldText)
  }

  await commit(ctx, order)

  const header = `patched ${plural(blocks.length, 'block')} in ${plural(order.length, 'file')}`
  const lines = order.map((state) => `${state.shown} (+${state.added} -${state.removed})`)
  return [header, ...lines].join('\n')
}
