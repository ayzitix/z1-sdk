/**
 * Retry policy shared by the provider and the hosts that construct it.
 *
 * River answers back-to-back agent calls with `429` rate-limit responses; a
 * retry with backoff turns that into a slower run instead of a failed one.
 *
 * @module @z1/provider-openai/retry
 */

import type { OpenAiRetryOptions } from './types.ts'

export interface ResolvedRetryOptions {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: ResolvedRetryOptions = {
  attempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
}

/** Env keys honoured by {@link retryOptionsFromEnv}. */
export const RETRY_ENV = {
  attempts: 'Z1_LLM_RETRY_ATTEMPTS',
  baseDelayMs: 'Z1_LLM_RETRY_BASE_MS',
  maxDelayMs: 'Z1_LLM_RETRY_MAX_MS',
} as const

export function resolveRetryOptions(
  retry: OpenAiRetryOptions | undefined,
): ResolvedRetryOptions {
  const attempts = positiveInt(retry?.attempts, DEFAULT_RETRY.attempts)
  const baseDelayMs = nonNegativeInt(retry?.baseDelayMs, DEFAULT_RETRY.baseDelayMs)
  const maxDelayMs = nonNegativeInt(retry?.maxDelayMs, DEFAULT_RETRY.maxDelayMs)
  return { attempts, baseDelayMs, maxDelayMs }
}

/** Reads `Z1_LLM_RETRY_*`; unset or malformed values fall back to the defaults. */
export function retryOptionsFromEnv(
  env: Record<string, string | undefined>,
): OpenAiRetryOptions {
  return {
    attempts: envInt(env[RETRY_ENV.attempts], DEFAULT_RETRY.attempts),
    baseDelayMs: envInt(env[RETRY_ENV.baseDelayMs], DEFAULT_RETRY.baseDelayMs),
    maxDelayMs: envInt(env[RETRY_ENV.maxDelayMs], DEFAULT_RETRY.maxDelayMs),
  }
}

/** 429 and 5xx are transient; every other status is final. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * `retry-after` in seconds or as an HTTP date; `undefined` when absent or
 * unparsable so the caller falls back to exponential backoff.
 */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (trimmed.length === 0) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return seconds <= 0 ? 0 : Math.round(seconds * 1000)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

/** `min(maxDelayMs, baseDelayMs * 2^(attempt-1))` plus deterministic jitter. */
export function backoffMs(attempt: number, retry: ResolvedRetryOptions): number {
  const exponential = retry.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(retry.maxDelayMs, exponential) + attempt * 17
}

/** Rejects with an AbortError as soon as `signal` aborts. */
export function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError())
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortError(): Error {
  const error = new Error('openai-compatible request aborted')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}
