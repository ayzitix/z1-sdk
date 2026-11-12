/**
 * Provider routing for `ServerOptions.live`.
 *
 * A graph may mix model nodes, so routing happens per request rather than per
 * run: `river`/`openai` go to the OpenAI-compatible client, every other
 * provider keeps the deterministic mock. The real client is built lazily so a
 * mock-only graph never needs a credential; a missing key throws from `chat`,
 * which the executor turns into a failed node (and thus a failed run) instead
 * of a server crash.
 *
 * @module @z1/server/live-llm
 */

import { createOpenAiLlmService } from '@z1/provider-openai'
import type { ChatDelta, ChatRequest, ChatResult } from '@z1/node'
import type { LlmService } from '@z1/runtime'

export type LiveProvider = 'river' | 'openai'

interface ProviderEnv {
  readonly apiKey: string
  readonly baseUrl: string
  readonly defaultBaseUrl: string
}

const PROVIDER_ENV: Record<LiveProvider, ProviderEnv> = {
  river: {
    apiKey: 'RIVER_API_KEY',
    baseUrl: 'RIVER_BASE_URL',
    defaultBaseUrl: 'https://api.river.ai/v1',
  },
  openai: {
    apiKey: 'OPENAI_API_KEY',
    baseUrl: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
}

export function isLiveProvider(value: string): value is LiveProvider {
  return value === 'river' || value === 'openai'
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/** One shared override wins so a whole run can be pointed at a gateway. */
export function resolveBaseUrl(
  provider: LiveProvider,
  env: NodeJS.ProcessEnv,
): string {
  const spec = PROVIDER_ENV[provider]
  for (const candidate of [env['Z1_OPENAI_BASE_URL'], env[spec.baseUrl]]) {
    if (hasText(candidate)) return candidate
  }
  return spec.defaultBaseUrl
}

export class LiveLlmRouter implements LlmService {
  readonly #mock: LlmService
  readonly #env: NodeJS.ProcessEnv
  readonly #live = new Map<LiveProvider, LlmService>()

  constructor(mock: LlmService, env: NodeJS.ProcessEnv) {
    this.#mock = mock
    this.#env = env
  }

  async chat(
    request: ChatRequest,
    onDelta?: (delta: ChatDelta) => void,
  ): Promise<ChatResult> {
    const provider = request.model.provider
    if (!isLiveProvider(provider)) return await this.#mock.chat(request, onDelta)
    return await this.#service(provider).chat(request, onDelta)
  }

  #service(provider: LiveProvider): LlmService {
    const existing = this.#live.get(provider)
    if (existing !== undefined) return existing
    const spec = PROVIDER_ENV[provider]
    const apiKey = this.#env[spec.apiKey]
    if (!hasText(apiKey)) {
      throw new Error(
        `missing ${spec.apiKey} for provider "${provider}"; start the server with live: false or export the key`,
      )
    }
    const created = createOpenAiLlmService({
      apiKey,
      baseURL: resolveBaseUrl(provider, this.#env),
    })
    this.#live.set(provider, created)
    return created
  }
}
