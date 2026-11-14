/**
 * Journal → cassette export.
 *
 * The journal records what a model call *was*; a cassette is the portable,
 * replayable subset of that. Export pairs each `llm.request` with the
 * `llm.response` at the same path and attempt, then resolves both blob hashes.
 *
 * Only the run's own events are exported: an inherited prefix belongs to the
 * ancestor run and is replayed there, not re-recorded here.
 *
 * @module @z1/bootstrap/cassette
 */

import { readFileSync } from 'node:fs'

import type { SqliteJournal } from '@z1/journal'
import type { ChatRequest, ChatResult } from '@z1/node'
import {
  CASSETTE_VERSION,
  decodeLlmPayload,
  parseCassette,
  type CassetteTurn,
} from '@z1/runtime'

export class CassetteExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CassetteExportError'
  }
}

function payload<T>(journal: SqliteJournal, hash: string | undefined, what: string): T {
  if (hash === undefined) {
    throw new CassetteExportError(
      `${what} has no payload blob: the run was recorded with Z1_RECORD_LLM=hashes or off. Re-run with "full" to export a cassette`,
    )
  }
  const blob = journal.getBlob(hash)
  if (blob === undefined) {
    throw new CassetteExportError(`${what} blob ${hash} is missing from the journal`)
  }
  return decodeLlmPayload<T>(blob.bytes)
}

/** Recorded model turns of one run, in journal order. */
export function exportCassette(journal: SqliteJournal, runId: string): readonly CassetteTurn[] {
  const open = new Map<string, { path: string; attempt: number; requestBlob?: string; requestHash: string; provider: string; model: string }>()
  const turns: CassetteTurn[] = []

  for (const { event } of journal.ownedEvents(runId)) {
    if (event.type === 'llm.request') {
      open.set(`${event.path}\u0000${String(event.attempt)}`, {
        path: event.path,
        attempt: event.attempt,
        requestHash: event.requestHash,
        provider: event.provider,
        model: event.model,
        ...(event.requestBlob === undefined ? {} : { requestBlob: event.requestBlob }),
      })
      continue
    }
    if (event.type !== 'llm.response') continue

    const key = `${event.path}\u0000${String(event.attempt)}`
    const request = open.get(key)
    if (request === undefined) {
      throw new CassetteExportError(
        `llm.response at ${event.path} (attempt ${String(event.attempt)}) has no matching llm.request`,
      )
    }
    open.delete(key)

    turns.push({
      version: CASSETTE_VERSION,
      path: request.path,
      provider: request.provider,
      model: request.model,
      attempt: request.attempt,
      requestHash: request.requestHash,
      request: payload<ChatRequest>(journal, request.requestBlob, `request at ${request.path}`),
      response: payload<ChatResult>(journal, event.responseBlob, `response at ${event.path}`),
    })
  }

  if (turns.length === 0) {
    throw new CassetteExportError(`run "${runId}" has no recorded model calls`)
  }
  return turns
}

/** Read and validate a cassette file. */
export function loadCassette(file: string): readonly CassetteTurn[] {
  return parseCassette(readFileSync(file, 'utf8'))
}
