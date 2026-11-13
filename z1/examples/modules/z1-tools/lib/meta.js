/**
 * Metadata tools: `system.info` and the workspace todo list.
 *
 * The todo list is plain JSON at `.z1/todos.json` in the workspace, so it can
 * be inspected, diffed and deleted with ordinary tools.
 *
 * @module z1-tools/meta
 */

import { join, resolve } from 'node:path'

import { fail, isRecord } from './args.js'
import { displayPath } from './paths.js'
import { plural } from './text.js'

export const TODO_PATH = '.z1/todos.json'
export const TODO_STATUSES = ['pending', 'in_progress', 'done']

function todoFile(ctx) {
  return join(resolve(ctx.workspace), TODO_PATH)
}

export function systemInfo(ctx) {
  return [
    `platform ${process.platform}`,
    `arch ${process.arch}`,
    `node ${process.version}`,
    `workspace ${resolve(ctx.workspace)}`,
  ].join('\n')
}

function normalizeItems(raw) {
  const items = raw['items']
  if (!Array.isArray(items)) fail('todo.write.items must be an array')
  return items.map((item, index) => {
    const where = `todo.write.items[${index}]`
    if (!isRecord(item)) fail(`${where} must be an object`)
    const text = item['text']
    if (typeof text !== 'string' || text.trim().length === 0) {
      fail(`${where}.text must be a non-empty string`)
    }
    const status = item['status'] ?? 'pending'
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status)) {
      fail(`${where}.status must be one of ${TODO_STATUSES.join(', ')}`)
    }
    return { text, status }
  })
}

export async function todoWrite(ctx, raw) {
  const items = normalizeItems(raw)
  const path = todoFile(ctx)
  const content = `${JSON.stringify({ items }, null, 2)}\n`

  try {
    await ctx.fs.write(path, content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`cannot write "${TODO_PATH}": ${message}`)
  }
  return `wrote ${displayPath(ctx.workspace, path)} (${plural(items.length, 'item')})`
}

export async function todoRead(ctx) {
  const path = todoFile(ctx)
  let text
  try {
    text = await ctx.fs.read(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ENOENT')) return `${JSON.stringify({ items: [] }, null, 2)}`
    fail(`cannot read "${TODO_PATH}": ${message}`)
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`${TODO_PATH} is not valid JSON: ${message}`)
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['items'])) {
    fail(`${TODO_PATH} must contain an object with an "items" array`)
  }
  return `${JSON.stringify(parsed, null, 2)}`
}
