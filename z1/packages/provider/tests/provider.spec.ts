import { createServer } from 'node:http'
import { describe, expect, test } from 'vitest'
import type { LlmService } from '@z1/runtime'
import {
  DEFAULT_PROVIDERS,
  MOCK_PROVIDER,
  ProviderRegistry,
  providersFromEnv,
  resolveApiKey,
  resolveBaseUrl,
  type ProviderConfig,
} from '../src/index.ts'

const mock: LlmService = {
  chat: async () => ({
    message: { role: 'assistant', content: 'mock reply' },
    toolCalls: [],
    stopReason: 'stop',
  }),
}

function request(provider: string): {
  model: { provider: string; model: string }
  messages: { role: 'user'; content: string }[]
} {
  return {
    model: { provider, model: 'test-model' },
    messages: [{ role: 'user', content: 'hi' }],
  }
}

function defaultConfig(id: string): ProviderConfig {
  const found = DEFAULT_PROVIDERS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no default provider "${id}"`)
  return found
}

describe('defaults', () => {
  test('ships river and openai with their key variables and endpoints', () => {
    expect(DEFAULT_PROVIDERS.map((config) => config.id)).toEqual(['river', 'openai'])
    expect(defaultConfig('river')).toEqual({
      id: 'river',
      protocol: 'openai-completions',
      envKey: 'RIVER_API_KEY',
      baseURL: 'https://api.river.ai/v1',
    })
    expect(defaultConfig('openai')).toEqual({
      id: 'openai',
      protocol: 'openai-completions',
      envKey: 'OPENAI_API_KEY',
      baseURL: 'https://api.openai.com/v1',
    })
  })

  test('providersFromEnv without Z1_PROVIDERS returns the defaults', () => {
    expect(providersFromEnv({})).toEqual(DEFAULT_PROVIDERS)
    expect(providersFromEnv({ Z1_PROVIDERS: '' })).toEqual(DEFAULT_PROVIDERS)
  })
})

describe('providersFromEnv', () => {
  test('overrides a default by id and appends a custom provider', () => {
    const merged = providersFromEnv({
      Z1_PROVIDERS: JSON.stringify([
        { id: 'river', envKey: 'ALT_RIVER_KEY', baseURL: 'https://gateway.example/v1' },
        {
          id: 'acme',
          envKey: 'ACME_API_KEY',
          baseURL: 'https://acme.example/v1',
          headers: { 'x-tenant': 'z1' },
        },
      ]),
    })

    expect(merged.map((config) => config.id)).toEqual(['river', 'openai', 'acme'])
    expect(merged[0]).toEqual({
      id: 'river',
      envKey: 'ALT_RIVER_KEY',
      baseURL: 'https://gateway.example/v1',
    })
    expect(merged[2]).toEqual({
      id: 'acme',
      envKey: 'ACME_API_KEY',
      baseURL: 'https://acme.example/v1',
      headers: { 'x-tenant': 'z1' },
    })
  })

  test.each([
    ['{', /not valid JSON/],
    ['{}', /must be a JSON array/],
    ['["acme"]', /Z1_PROVIDERS\[0\] must be an object/],
    ['[{"baseURL":"u","envKey":"K"}]', /Z1_PROVIDERS\[0\]\.id must be a non-empty string/],
    ['[{"id":"a","baseURL":"u"}]', /Z1_PROVIDERS\[0\]\.envKey must be a non-empty string/],
    ['[{"id":"a","envKey":"K"}]', /Z1_PROVIDERS\[0\]\.baseURL must be a non-empty string/],
    [
      '[{"id":"a","envKey":"K","baseURL":"u","protocol":"anthropic"}]',
      /protocol must be "openai-completions"/,
    ],
    [
      '[{"id":"a","envKey":"K","baseURL":"u","headers":{"x":1}}]',
      /headers must be an object of string values/,
    ],
    [
      '[{"id":"a","envKey":"K","baseURL":"u"},{"id":"a","envKey":"L","baseURL":"v"}]',
      /lists provider "a" more than once/,
    ],
  ])('rejects invalid configuration %#', (raw, pattern) => {
    expect(() => providersFromEnv({ Z1_PROVIDERS: raw })).toThrow(pattern)
  })
})

describe('environment resolution', () => {
  test('a per-provider base URL override wins', () => {
    expect(resolveBaseUrl(defaultConfig('river'), { Z1_RIVER_BASE_URL: 'http://gateway' })).toBe(
      'http://gateway',
    )
    expect(resolveBaseUrl(defaultConfig('river'), {})).toBe('https://api.river.ai/v1')
    expect(resolveBaseUrl(defaultConfig('river'), { Z1_RIVER_BASE_URL: '' })).toBe(
      'https://api.river.ai/v1',
    )
  })

  test('a custom id becomes upper snake case', () => {
    const config: ProviderConfig = {
      id: 'acme-gateway',
      envKey: 'ACME_KEY',
      baseURL: 'https://acme.example/v1',
    }
    expect(
      resolveBaseUrl(config, { Z1_ACME_GATEWAY_BASE_URL: 'http://local:1234/v1' }),
    ).toBe('http://local:1234/v1')
  })

  test('resolveApiKey ignores an unset or empty variable', () => {
    const config = defaultConfig('river')
    expect(resolveApiKey(config, { RIVER_API_KEY: 'secret' })).toBe('secret')
    expect(resolveApiKey(config, { RIVER_API_KEY: '' })).toBeUndefined()
    expect(resolveApiKey(config, {})).toBeUndefined()
  })
})

describe('ProviderRegistry', () => {
  test('has() knows configured providers and an available mock', () => {
    const registry = new ProviderRegistry({ env: {} })
    expect(registry.has('river')).toBe(true)
    expect(registry.has('openai')).toBe(true)
    expect(registry.has('acme')).toBe(false)
    expect(registry.has(MOCK_PROVIDER)).toBe(false)
    expect(new ProviderRegistry({ env: {}, mock }).has(MOCK_PROVIDER)).toBe(true)
  })

  test('missingCredentials names each provider and its variable', () => {
    const registry = new ProviderRegistry({ env: { RIVER_API_KEY: 'secret' } })
    expect(registry.missingCredentials()).toEqual([
      { id: 'openai', envKey: 'OPENAI_API_KEY' },
    ])
  })

  test('routes the mock provider to the injected service', async () => {
    const registry = new ProviderRegistry({ env: {}, mock })
    const result = await registry.create().chat(request(MOCK_PROVIDER))
    expect(result.message.content).toBe('mock reply')
  })

  test('construction never needs a credential, chat does', async () => {
    const registry = new ProviderRegistry({ env: {} })
    await expect(registry.create().chat(request('river'))).rejects.toThrow(
      'missing RIVER_API_KEY for provider "river"',
    )
  })

  test('an unknown provider throws', async () => {
    const registry = new ProviderRegistry({ env: {} })
    await expect(registry.create().chat(request('nowhere'))).rejects.toThrow(
      'unknown provider "nowhere"; known providers: river, openai',
    )
  })

  test('the mock id without a mock service is unknown', async () => {
    const registry = new ProviderRegistry({ env: {} })
    await expect(registry.create().chat(request(MOCK_PROVIDER))).rejects.toThrow(
      'unknown provider "mock"',
    )
  })

  test('a custom provider from Z1_PROVIDERS uses its endpoint, key and headers', async () => {
    let authorization = ''
    let tenant = ''
    let path = ''
    const server = createServer((incoming, response) => {
      authorization = incoming.headers.authorization ?? ''
      tenant = String(incoming.headers['x-tenant'] ?? '')
      path = incoming.url ?? ''
      incoming.resume()
      incoming.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'custom reply' }, finish_reason: 'stop' }],
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server has no port')

    try {
      const env = {
        Z1_PROVIDERS: JSON.stringify([
          {
            id: 'acme',
            envKey: 'ACME_API_KEY',
            baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
            headers: { 'x-tenant': 'z1' },
          },
        ]),
        ACME_API_KEY: 'acme-secret',
      }
      const registry = new ProviderRegistry({ providers: providersFromEnv(env), env, mock })
      const result = await registry.create().chat(request('acme'))

      expect(result.message.content).toBe('custom reply')
      expect(authorization).toBe('Bearer acme-secret')
      expect(tenant).toBe('z1')
      expect(path).toBe('/v1/chat/completions')
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  })
})
