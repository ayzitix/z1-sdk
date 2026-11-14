/**
 * Provider registry as data: which providers exist, where each one's API lives,
 * and which environment variable carries its credential.
 *
 * Routing happens per request from `ModelHandle.provider`, so one graph may mix
 * providers. Clients are built on the first call for a provider, which keeps a
 * mock-only graph free of credential checks; a missing key throws from `chat`
 * rather than from registry construction.
 *
 * @module @z1/provider
 */

import {
  createOpenAiLlmService,
  retryOptionsFromEnv,
  type OpenAiProviderOptions,
} from '@z1/provider-openai'
import type { LlmService } from '@z1/runtime'

/** Wire protocol a provider speaks. Only OpenAI completions exist today. */
export type ProviderProtocol = 'openai-completions'

export interface ProviderConfig {
  /** Provider id as written in a `ModelHandle`, e.g. `river` or `openai`. */
  id: string
  /** Defaults to `openai-completions`. */
  protocol?: ProviderProtocol
  /** Environment variable holding the API key, e.g. `RIVER_API_KEY`. */
  envKey: string
  /** API root, e.g. `https://api.river.ai/v1`. */
  baseURL: string
  /** Extra request headers merged over the client defaults. */
  headers?: Record<string, string>
}

export type ProviderEnv = Record<string, string | undefined>

export interface ProviderRegistryOptions {
  /** Defaults to {@link DEFAULT_PROVIDERS}. */
  providers?: readonly ProviderConfig[]
  /** Credential source; defaults to an empty environment. */
  env?: ProviderEnv
  /** Deterministic service returned for the `mock` provider id. */
  mock?: LlmService
}

/** Reserved id that always resolves to {@link ProviderRegistryOptions.mock}. */
export const MOCK_PROVIDER = 'mock'

export const DEFAULT_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: 'river',
    protocol: 'openai-completions',
    envKey: 'RIVER_API_KEY',
    baseURL: 'https://api.river.ai/v1',
  },
  {
    id: 'openai',
    protocol: 'openai-completions',
    envKey: 'OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
  },
]

/** Baked-in providers merged with any `Z1_PROVIDERS` entries, keyed by id. */
export function providersFromEnv(env: ProviderEnv): ProviderConfig[] {
  const merged = DEFAULT_PROVIDERS.map(cloneConfig)
  const configured = parseConfigured(env['Z1_PROVIDERS'])
  if (configured === undefined) return merged

  const seen = new Set<string>()
  for (const config of configured) {
    if (seen.has(config.id)) {
      throw new Error(`Z1_PROVIDERS lists provider "${config.id}" more than once`)
    }
    seen.add(config.id)
    const index = merged.findIndex((candidate) => candidate.id === config.id)
    if (index >= 0) merged[index] = config
    else merged.push(config)
  }
  return merged
}

/** `Z1_<ID>_BASE_URL` wins over the configured default, e.g. `Z1_RIVER_BASE_URL`. */
export function resolveBaseUrl(config: ProviderConfig, env: ProviderEnv): string {
  const key = `Z1_${config.id.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()}_BASE_URL`
  const override = env[key]
  return override !== undefined && override !== '' ? override : config.baseURL
}

/** The configured key, or `undefined` when unset or empty. */
export function resolveApiKey(
  config: ProviderConfig,
  env: ProviderEnv,
): string | undefined {
  const value = env[config.envKey]
  return value === undefined || value === '' ? undefined : value
}

export class ProviderRegistry {
  readonly #configs: ProviderConfig[]
  readonly #env: ProviderEnv
  readonly #mock: LlmService | undefined

  constructor(options: ProviderRegistryOptions) {
    this.#configs = (options.providers ?? DEFAULT_PROVIDERS).map(cloneConfig)
    this.#env = options.env ?? {}
    this.#mock = options.mock
  }

  configs(): readonly ProviderConfig[] {
    return this.#configs
  }

  has(id: string): boolean {
    if (id === MOCK_PROVIDER) return this.#mock !== undefined
    return this.#configs.some((config) => config.id === id)
  }

  /** Every configured provider whose key is absent; reported before a run. */
  missingCredentials(): { id: string; envKey: string }[] {
    return this.#configs
      .filter((config) => resolveApiKey(config, this.#env) === undefined)
      .map((config) => ({ id: config.id, envKey: config.envKey }))
  }

  /** A routing {@link LlmService}; unknown provider ids throw at chat time. */
  create(): LlmService {
    const services = new Map<string, LlmService>()
    return {
      chat: async (request, onDelta) =>
        await this.#service(request.model.provider, services).chat(request, onDelta),
      listModels: async (request, signal) => {
        const service = this.#service(request.provider, services)
        if (service.listModels === undefined) {
          throw new Error(
            `provider "${request.provider}" does not support model discovery; name the model explicitly`,
          )
        }
        return await service.listModels(request, signal)
      },
    }
  }

  #service(id: string, services: Map<string, LlmService>): LlmService {
    const cached = services.get(id)
    if (cached !== undefined) return cached

    if (id === MOCK_PROVIDER) {
      if (this.#mock === undefined) {
        throw new Error(`unknown provider "${id}"; no mock service is configured`)
      }
      services.set(id, this.#mock)
      return this.#mock
    }

    const config = this.#configs.find((candidate) => candidate.id === id)
    if (config === undefined) {
      const known = this.#configs.map((candidate) => candidate.id).join(', ')
      throw new Error(
        `unknown provider "${id}"${known.length > 0 ? `; known providers: ${known}` : ''}`,
      )
    }

    const apiKey = resolveApiKey(config, this.#env)
    if (apiKey === undefined) throw new Error(`missing ${config.envKey} for provider "${id}"`)

    const options: OpenAiProviderOptions = {
      baseURL: resolveBaseUrl(config, this.#env),
      apiKey,
      retry: retryOptionsFromEnv(this.#env),
    }
    if (config.headers !== undefined) options.headers = config.headers

    const created = createOpenAiLlmService(options)
    services.set(id, created)
    return created
  }
}

function parseConfigured(raw: string | undefined): ProviderConfig[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Z1_PROVIDERS is not valid JSON: ${message}`)
  }
  if (!Array.isArray(parsed)) throw new Error('Z1_PROVIDERS must be a JSON array of provider configs')
  return parsed.map((entry, index) => readConfig(entry, `Z1_PROVIDERS[${String(index)}]`))
}

function readConfig(value: unknown, label: string): ProviderConfig {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)

  const config: ProviderConfig = {
    id: requiredText(value['id'], `${label}.id`),
    envKey: requiredText(value['envKey'], `${label}.envKey`),
    baseURL: requiredText(value['baseURL'], `${label}.baseURL`),
  }

  const protocol = value['protocol']
  if (protocol !== undefined) {
    if (protocol !== 'openai-completions') {
      throw new Error(`${label}.protocol must be "openai-completions"`)
    }
    config.protocol = protocol
  }

  const headers = value['headers']
  if (headers !== undefined) {
    if (!isRecord(headers) || Object.values(headers).some((entry) => typeof entry !== 'string')) {
      throw new Error(`${label}.headers must be an object of string values`)
    }
    config.headers = headers as Record<string, string>
  }

  return config
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function cloneConfig(config: ProviderConfig): ProviderConfig {
  const copy: ProviderConfig = {
    id: config.id,
    envKey: config.envKey,
    baseURL: config.baseURL,
  }
  if (config.protocol !== undefined) copy.protocol = config.protocol
  if (config.headers !== undefined) copy.headers = { ...config.headers }
  return copy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
