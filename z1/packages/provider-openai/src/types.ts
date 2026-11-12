export interface OpenAiProviderOptions {
  /** API root, e.g. `https://api.river.ai/v1`. A trailing slash is ignored. */
  baseURL: string
  apiKey: string
  /** Extra request headers, merged over the defaults. */
  headers?: Record<string, string>
  /** Injection point for tests and for hosts with a custom fetch. */
  fetch?: typeof fetch
}
