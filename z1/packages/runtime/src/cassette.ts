/**
 * Cassette: a recorded set of model turns, replayable without a network.
 *
 * This is the test half of {@link ./recording.ts}. A cassette is JSONL, one turn
 * per line, and a turn keeps the *redacted* request as it was hashed for the
 * journal plus the response that was returned. Replay matches on
 * {@link llmRequestHash}, so the matching rule is the same one the journal uses
 * and cannot drift from it.
 *
 * A miss throws. It never falls back to the mock or to the network: a silent
 * fallback would make an eval pass on data it never recorded.
 *
 * @module @z1/runtime/cassette
 */

import type { ChatRequest, ChatResult } from '@z1/node'

import { currentLlmCallContext } from './llm-context.ts'
import { llmRequestHash } from './recording.ts'
import type { LlmService } from './types.ts'

/** Bumped when the on-disk shape changes in a way old files cannot satisfy. */
export const CASSETTE_VERSION = 1

export interface CassetteTurn {
  readonly version: number
  /** Execution path of the node that made the call, for reports only. */
  readonly path: string
  readonly provider: string
  readonly model: string
  readonly attempt: number
  /** sha256 of the canonical redacted request; the replay key. */
  readonly requestHash: string
  readonly request: ChatRequest
  readonly response: ChatResult
}

export class CassetteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CassetteError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string, line: number): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new CassetteError(`cassette line ${String(line)}: "${key}" must be a string`)
  }
  return value
}

/** Parse JSONL. A malformed line names itself, so a hand-edited file is fixable. */
export function parseCassette(text: string): readonly CassetteTurn[] {
  const turns: CassetteTurn[] = []
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line.length === 0) continue
    const lineNumber = index + 1

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new CassetteError(`cassette line ${String(lineNumber)}: not valid JSON`)
    }
    if (!isRecord(parsed)) {
      throw new CassetteError(`cassette line ${String(lineNumber)}: not an object`)
    }
    if (parsed['version'] !== CASSETTE_VERSION) {
      throw new CassetteError(
        `cassette line ${String(lineNumber)}: unsupported version ${String(parsed['version'])}; expected ${String(CASSETTE_VERSION)}`,
      )
    }
    if (!isRecord(parsed['request']) || !isRecord(parsed['response'])) {
      throw new CassetteError(
        `cassette line ${String(lineNumber)}: "request" and "response" must be objects`,
      )
    }
    const attempt = parsed['attempt']
    turns.push({
      version: CASSETTE_VERSION,
      path: requireString(parsed, 'path', lineNumber),
      provider: requireString(parsed, 'provider', lineNumber),
      model: requireString(parsed, 'model', lineNumber),
      attempt: typeof attempt === 'number' ? attempt : 1,
      requestHash: requireString(parsed, 'requestHash', lineNumber),
      request: parsed['request'] as unknown as ChatRequest,
      response: parsed['response'] as unknown as ChatResult,
    })
  }
  if (turns.length === 0) throw new CassetteError('cassette is empty')
  return turns
}

/** JSONL with a trailing newline, so `cat` and diff stay well behaved. */
export function formatCassette(turns: readonly CassetteTurn[]): string {
  return `${turns.map((turn) => JSON.stringify(turn)).join('\n')}\n`
}

export interface CassetteLlmOptions {
  /** Consumed once per hash; a repeated call without a new turn misses. */
  readonly turns: readonly CassetteTurn[]
}

/**
 * Serve `chat` from a cassette.
 *
 * The response is replayed as one text delta so a streaming caller still prints
 * it. Deltas are not part of the recording (they are a view of the response),
 * so emitting the whole text at once is the honest equivalent.
 */
export function createCassetteLlmService(options: CassetteLlmOptions): LlmService {
  const byHash = new Map<string, ChatResult>()
  for (const turn of options.turns) byHash.set(turn.requestHash, turn.response)

  return {
    chat: async (request: ChatRequest, onDelta) => {
      const hash = llmRequestHash(request)
      const response = byHash.get(hash)
      if (response === undefined) {
        const path = currentLlmCallContext()?.path ?? '(unknown)'
        throw new CassetteError(
          `cassette miss for ${request.model.provider}/${request.model.model} at ${path}: no recorded request with hash ${hash}`,
        )
      }
      const content = response.message.content
      if (onDelta !== undefined && typeof content === 'string' && content.length > 0) {
        onDelta({ type: 'text', text: content })
      }
      return response
    },
  }
}
