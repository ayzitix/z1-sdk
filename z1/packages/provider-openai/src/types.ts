/** Retry policy for transient upstream failures (429, 5xx, network errors). */
export interface OpenAiRetryOptions {
  /** Total attempts, including the first one. `1` disables retry. Default 3. */
  attempts?: number
  /** First backoff step in milliseconds. Default 1000. */
  baseDelayMs?: number
  /** Upper bound for the exponential backoff in milliseconds. Default 30000. */
  maxDelayMs?: number
}

export interface OpenAiProviderOptions {
  /** API root, e.g. `https://api.river.ai/v1`. A trailing slash is ignored. */
  baseURL: string
  apiKey: string
  /** Extra request headers, merged over the defaults. */
  headers?: Record<string, string>
  /** Injection point for tests and for hosts with a custom fetch. */
  fetch?: typeof fetch
  /** Retry policy for rate limits and transient upstream errors. */
  retry?: OpenAiRetryOptions
  /** Cancels in-flight requests and any pending retry backoff. */
  signal?: AbortSignal
}
