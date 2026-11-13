/**
 * File-backed graph library: one pretty-printed JSON file per graph.
 *
 * Files are the durable form a human can diff, copy and commit; the journal
 * stores runs, never graphs, so this is the only place a graph outlives the
 * process. Writes go to a sibling temp file and are renamed into place, so a
 * crash or a concurrent read never sees a half-written graph.
 *
 * @module @z1/server/graphs
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { graphDigest, parseGraph, type GraphDocument } from '@z1/graph'
import {
  APP_ERRORS,
  appFault,
  graphNotFound,
  invalidParams,
  type GraphGetResult,
  type GraphSaveResult,
  type GraphSummary,
} from '@z1/protocol'

/** Path-safe ids: no separators, no leading dot, no traversal. */
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** On-disk shape of `<graphsPath>/<id>.json`. */
export interface GraphFile {
  version: number
  updatedAt: number
  graph: GraphDocument
}

type ReadResult =
  | { state: 'ok'; file: GraphFile }
  | { state: 'missing' }
  | { state: 'corrupt' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `graph.id` doubles as the file name, so an id the filesystem could interpret
 * as a path (or that collides with the temp-file scheme) is rejected up front.
 */
export function assertGraphId(id: string): string {
  if (!GRAPH_ID.test(id)) {
    throw invalidParams(
      `invalid graph id "${id}": expected ${String(GRAPH_ID)}`,
      { id },
    )
  }
  return id
}

/** A stored file, or `undefined` when the bytes are not a graph envelope. */
function envelope(value: unknown): GraphFile | undefined {
  if (!isRecord(value)) return undefined
  const version = value['version']
  const updatedAt = value['updatedAt']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  try {
    return { version, updatedAt, graph: parseGraph(value['graph']) }
  } catch {
    return undefined
  }
}

export class GraphStore {
  readonly #dir: string

  constructor(directory: string) {
    this.#dir = directory
  }

  /** Create the library directory; idempotent, called once at server start. */
  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.json`)
  }

  /** The stored envelope, or why there is none. */
  async #read(id: string): Promise<ReadResult> {
    let text: string
    try {
      text = await readFile(this.#path(id), 'utf8')
    } catch (error) {
      if (isRecord(error) && error['code'] === 'ENOENT') return { state: 'missing' }
      throw error
    }
    try {
      const stored = envelope(JSON.parse(text) as unknown)
      return stored === undefined ? { state: 'corrupt' } : { state: 'ok', file: stored }
    } catch {
      return { state: 'corrupt' }
    }
  }

  /** Newest first. A corrupt file is skipped: one bad file must not hide the rest. */
  async list(): Promise<GraphSummary[]> {
    const entries = await readdir(this.#dir, { withFileTypes: true })
    const summaries: GraphSummary[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      if (!GRAPH_ID.test(id)) continue
      const result = await this.#read(id)
      if (result.state !== 'ok') continue
      const { graph, version, updatedAt } = result.file
      summaries.push({
        id,
        ...(graph.title === undefined ? {} : { title: graph.title }),
        version,
        updatedAt,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        digest: graphDigest(graph),
      })
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async get(id: string): Promise<GraphGetResult> {
    assertGraphId(id)
    const result = await this.#read(id)
    if (result.state === 'missing') throw graphNotFound(id)
    if (result.state === 'corrupt') {
      // Distinguish "never saved" from "bytes unreadable": the latter is
      // recoverable only by re-saving, and silencing it would hide data loss.
      throw appFault(APP_ERRORS.graphInvalid, `graph file for "${id}" is corrupt`, { id })
    }
    return {
      graph: result.file.graph,
      version: result.file.version,
      updatedAt: result.file.updatedAt,
    }
  }

  async save(graph: GraphDocument, expectedVersion?: number): Promise<GraphSaveResult> {
    const id = assertGraphId(graph.id)
    const previous = await this.#read(id)
    // An absent or corrupt file has no usable version; reporting 0 lets a client
    // overwrite it with `expectedVersion: 0` instead of being locked out.
    const previousVersion = previous.state === 'ok' ? previous.file.version : 0
    if (expectedVersion !== undefined && expectedVersion !== previousVersion) {
      throw appFault(
        APP_ERRORS.conflict,
        `graph "${id}" is at version ${previousVersion}, not ${expectedVersion}`,
        { id, expectedVersion, version: previousVersion },
      )
    }

    const version = previousVersion + 1
    const updatedAt = Date.now()
    const file: GraphFile = { version, updatedAt, graph }
    await this.#write(id, `${JSON.stringify(file, null, 2)}\n`)
    return { id, version, updatedAt }
  }

  async #write(id: string, text: string): Promise<void> {
    const target = this.#path(id)
    const temp = `${target}.tmp-${randomUUID()}`
    await writeFile(temp, text, 'utf8')
    try {
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  /** Idempotent: deleting a graph that is already gone is a success. */
  async delete(id: string): Promise<void> {
    assertGraphId(id)
    await rm(this.#path(id), { force: true })
  }
}
