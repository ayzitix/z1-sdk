/**
 * Static templates live on disk as `<id>.json`:
 *
 * ```json
 * { "id": "hello", "version": "1.0.0", "title": "Hello", "graph": { … } }
 * ```
 *
 * The graph is parsed with `parseGraph`, so a malformed file fails at load
 * time with the file name in the message instead of during a run.
 *
 * @module @z1/template/static
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseGraph, type GraphDocument } from '@z1/graph'

import type { GraphTemplate, TemplateMeta } from './types.ts'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

/** Wrap a parsed graph in the static template shape. */
export function staticTemplate(meta: TemplateMeta, graph: GraphDocument): GraphTemplate {
  return { ...meta, kind: 'static', graph }
}

function readFileShape(file: string): { meta: TemplateMeta; graph: unknown } {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`"${file}" is not valid JSON: ${errorMessage(error)}`)
  }
  if (!isRecord(raw)) throw new Error(`"${file}" must be a JSON object`)

  const meta: TemplateMeta = {
    id: requiredText(raw['id'], `"${file}": id`),
    version: requiredText(raw['version'], `"${file}": version`),
    title: requiredText(raw['title'], `"${file}": title`),
  }
  const description = raw['description']
  if (description !== undefined) {
    if (typeof description !== 'string') {
      throw new Error(`"${file}": description must be a string`)
    }
    meta.description = description
  }

  if (raw['graph'] === undefined) throw new Error(`"${file}": graph is required`)
  return { meta, graph: raw['graph'] }
}

/**
 * Every valid `*.json` template in `directory`, in file-name order. A missing
 * directory is simply no templates; an invalid file throws with its path.
 */
export function loadStaticTemplates(directory: string): GraphTemplate[] {
  if (!existsSync(directory)) return []

  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
  return files.map((name) => {
    const file = join(directory, name)
    const { meta, graph } = readFileShape(file)
    let parsed: GraphDocument
    try {
      parsed = parseGraph(graph)
    } catch (error) {
      throw new Error(`"${file}": ${errorMessage(error)}`)
    }
    return staticTemplate(meta, parsed)
  })
}
