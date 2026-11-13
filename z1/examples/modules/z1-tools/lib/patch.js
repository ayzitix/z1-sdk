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
 * Every SEARCH block must match exactly once, all blocks are applied before
 * anything is written, and a single mismatch aborts the whole patch.
 *
 * @module z1-tools/patch
 */

import { fail, stringArg } from './args.js'
import { displayPath, resolvePath } from './paths.js'
import { excerpt, plural, splitLines } from './text.js'

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

/** Apply every block in memory, then write the changed files. */
export async function applyPatch(ctx, raw) {
  const blocks = parsePatch(stringArg(raw, 'patch', 'apply_patch'))
  const files = new Map()
  const order = []

  for (const block of blocks) {
    const path = resolvePath(ctx, block.path, 'apply_patch.path')
    const shown = displayPath(ctx.workspace, path)
    let state = files.get(path)
    if (state === undefined) {
      let content
      try {
        content = await ctx.fs.read(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        fail(`apply_patch: cannot read "${shown}": ${message}`)
      }
      state = { path, shown, content, added: 0, removed: 0 }
      files.set(path, state)
      order.push(state)
    }

    const found = countOccurrences(state.content, block.oldText)
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

    const at = state.content.indexOf(block.oldText)
    state.content =
      state.content.slice(0, at) + block.newText + state.content.slice(at + block.oldText.length)
    state.added += blockLineCount(block.newText)
    state.removed += blockLineCount(block.oldText)
  }

  for (const state of order) {
    try {
      await ctx.fs.write(state.path, state.content)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail(`apply_patch: cannot write "${state.shown}": ${message}`)
    }
  }

  const header = `patched ${plural(blocks.length, 'block')} in ${plural(order.length, 'file')}`
  const lines = order.map((state) => `${state.shown} (+${state.added} -${state.removed})`)
  return [header, ...lines].join('\n')
}
