/**
 * Journaled model traffic.
 *
 * Every `chat` call becomes an `llm.request`/`llm.response` pair. The wire
 * payloads are stored in the journal's content-addressed `blobs` table, so an
 * event row stays small and identical prompts dedupe; the event carries only
 * the sha256 of the canonical, redacted payload. The hash is also what a
 * cassette matches a replay against.
 *
 * The decorator wraps the *resolved* service in bootstrap rather than a node,
 * so real providers, module adapters and a cassette replay are recorded by the
 * same code. Deltas are not recorded per chunk: only the final result is.
 *
 * @module @z1/runtime/recording
 */

import { createHash } from 'node:crypto'

import { canonicalJson } from '@z1/graph'
import type { ChatRequest, ChatResult } from '@z1/node'

import { currentLlmCallContext } from './llm-context.ts'
import type { Journal, LlmService, RunEvent } from './types.ts'

/** `full` stores payload blobs, `hashes` stores only hashes, `off` records nothing. */
export type RecordLlmMode = 'full' | 'hashes' | 'off'

/** A journal that can also hold payload blobs; `SqliteJournal` satisfies this. */
export interface BlobJournal extends Journal {
  putBlob(bytes: Uint8Array, mime: string): string
}

export interface RecordLlmOptions {
  readonly inner: LlmService
  readonly journal: BlobJournal
  readonly mode: RecordLlmMode
  /** Fallback attribution for a call made outside an executor scope. */
  readonly runId?: string
  /** Live listener, mirroring `RuntimeServices.onEvent`. */
  readonly onEvent?: (event: RunEvent) => void
}

/** Path recorded for a model call that no node scope owns (e.g. a module). */
export const AMBIENT_LLM_PATH = '(ambient)'

const JSON_MIME = 'application/json'

/**
 * Credential-shaped field names. Redaction is by key, so a payload cannot leak
 * a bearer header or an env-style `*_KEY` value even if a caller smuggles one
 * into `model.params`.
 */
const SECRET_FIELD =
  /(^|[_-])(authorization|api[_-]?key|bearer|credential|credentials|secret|password|passphrase|token)$/i
/** camelCase variants the separator rule misses: `accessToken`, `apiKey`. */
const SECRET_SUFFIX = /[a-z0-9](Token|Key|Secret|Password|Credential)$/

const REDACTED = '[redacted]'

/**
 * Deep copy of a payload with credential-shaped fields replaced. Applied to
 * both directions: redaction is the reason a replayed response can differ from
 * the live one, which is the safe direction to err in.
 */
function isSecretField(field: string): boolean {
  return SECRET_FIELD.test(field) || SECRET_SUFFIX.test(field)
}

export function redactLlmPayload(value: unknown, field?: string): unknown {
  if (field !== undefined && isSecretField(field)) return REDACTED
  if (Array.isArray(value)) return value.map((entry) => redactLlmPayload(entry))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const copy: Record<string, unknown> = {}
    // A header pair (`{ name: 'Authorization', value: '…' }`) hides the secret
    // behind a harmless key, so the pair is masked as a unit.
    const headerPair =
      typeof source['name'] === 'string' && isSecretField(source['name'])
    for (const [key, entry] of Object.entries(source)) {
      // `undefined` is not JSON; canonicalJson drops it, so skip it here too.
      if (entry === undefined) continue
      if (headerPair && key === 'value') {
        copy[key] = REDACTED
        continue
      }
      copy[key] = redactLlmPayload(entry, key)
    }
    return copy
  }
  // Proxies, class instances and host objects were never valid JSON; keep them
  // intact and let `canonicalJson` reject a payload that is not serializable.
  return value
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Stable textual form of a request: sorted keys, redacted, no `undefined`. */
export function canonicalLlmRequest(request: ChatRequest): string {
  return canonicalJson(redactLlmPayload(request))
}

/** sha256 of {@link canonicalLlmRequest}: the cassette's matching key. */
export function llmRequestHash(request: ChatRequest): string {
  return sha256(canonicalLlmRequest(request))
}

/** Stable textual form of a response, used for its blob hash. */
export function canonicalLlmResponse(result: ChatResult): string {
  return canonicalJson(redactLlmPayload(result))
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Payload of a `llm.request` blob, typed for readers that trust the journal. */
export function decodeLlmPayload<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

/**
 * Wrap `inner` so each call is journaled. `off` returns the service untouched:
 * no event rows and no blobs, not a filtered writer.
 */
export function createRecordingLlmService(options: RecordLlmOptions): LlmService {
  if (options.mode === 'off') return options.inner
  const { inner, journal, mode } = options

  /**
   * Recording is observational: a journal that refuses the row (an unknown
   * run, a closed handle) must not change the outcome of the model call.
   */
  const record = async (event: RunEvent): Promise<void> => {
    try {
      await journal.append(event)
    } catch {
      // The call still happened; the response event carries the same hashes.
    }
    options.onEvent?.(event)
  }

  const get = options.inner.get?.bind(options.inner)

  return {
    // A metadata read is not a model turn: it is not recorded, but it must keep
    // working through the wrapper or a module could not inspect a provider.
    ...(get === undefined
      ? {}
      : {
          get: async (
            request: Parameters<NonNullable<LlmService['get']>>[0],
            signal?: AbortSignal,
          ) => await get(request, signal),
        }),
    chat: async (request, onDelta) => {
      const scope = currentLlmCallContext()
      const runId = scope?.runId ?? options.runId
      // A call no run can claim is still served, just not journaled: writing an
      // event under a guessed run id would corrupt that run's history.
      if (runId === undefined) return await inner.chat(request, onDelta)

      const path = scope?.path ?? AMBIENT_LLM_PATH
      const attempt = scope?.attempt ?? 1
      const provider = request.model.provider
      const model = request.model.model

      const requestText = canonicalLlmRequest(request)
      const requestHash = sha256(requestText)
      const requestBlob =
        mode === 'full' ? journal.putBlob(bytesOf(requestText), JSON_MIME) : undefined
      const requestEvent: RunEvent = {
        type: 'llm.request',
        runId,
        path,
        provider,
        model,
        attempt,
        requestHash,
        ...(requestBlob === undefined ? {} : { requestBlob }),
        at: Date.now(),
      }
      await record(requestEvent)

      const startedAt = Date.now()
      let result
      try {
        result = await inner.chat(request, onDelta)
      } catch (error) {
        // A turn that throws still happened; without this row the journal shows
        // a request with no outcome and every attempt count is wrong.
        await record({
          type: 'llm.failed',
          runId,
          path,
          provider,
          model,
          attempt,
          error: error instanceof Error ? error.message : String(error),
          latencyMs: Date.now() - startedAt,
          at: Date.now(),
        })
        throw error
      }
      const latencyMs = Date.now() - startedAt

      const responseText = canonicalLlmResponse(result)
      const responseHash = sha256(responseText)
      const responseBlob =
        mode === 'full' ? journal.putBlob(bytesOf(responseText), JSON_MIME) : undefined
      const responseEvent: RunEvent = {
        type: 'llm.response',
        runId,
        path,
        provider,
        model,
        attempt,
        responseHash,
        ...(responseBlob === undefined ? {} : { responseBlob }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        latencyMs,
        stopReason: result.stopReason,
        at: Date.now(),
      }
      await record(responseEvent)
      return result
    },
  }
}
