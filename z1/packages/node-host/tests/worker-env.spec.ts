import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { ModuleStore } from '@z1/module'
import type { Json, NodeContext, NodeRegistry } from '@z1/node'
import type {
  ApprovalService,
  FsService,
  LlmService,
  ToolService,
} from '@z1/runtime'
import {
  ModuleRuntime,
  workerEnvironment,
  type WorkerHostServices,
} from '../src/index.ts'

const ENV_PROBE = fileURLToPath(new URL('./fixtures/env-probe', import.meta.url))
const ENV_PROBE_ID = 'com.example.env'
const ENV_PROBE_NODE = 'com.example.env.read'

const roots: string[] = []
const runtimes: ModuleRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.dispose().catch(() => undefined)
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

function hostServices(): WorkerHostServices {
  const fs: FsService = {
    read: async () => {
      throw new Error('fs.read is not stubbed in this test')
    },
    write: async () => {
      throw new Error('fs.write is not stubbed in this test')
    },
  }
  const tools: ToolService = { call: async () => null, list: async () => [] }
  const llm: LlmService = {
    chat: async () => ({
      message: { role: 'assistant', content: 'host-pong' },
      toolCalls: [],
      stopReason: 'stop',
    }),
  }
  const approval: ApprovalService = { request: async () => 'allowed-once' }
  return { llm, tools, fs, approval }
}

async function runtimeWithProbe(env?: Record<string, string>): Promise<ModuleRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'z1-worker-env-'))
  roots.push(root)
  const store = new ModuleStore(root)
  store.propose(ENV_PROBE)
  store.install(ENV_PROBE_ID, '1.0.0', {
    capabilities: {},
    services: [],
    futureVersions: false,
  })
  store.activate(ENV_PROBE_ID)
  const runtime = new ModuleRuntime({
    store,
    services: hostServices(),
    ...(env === undefined ? {} : { env }),
  })
  runtimes.push(runtime)
  return runtime
}

async function readWorkerEnv(registry: NodeRegistry): Promise<Record<string, string | null>> {
  const definition = registry.get(ENV_PROBE_NODE, '1.0.0')
  if (definition === undefined) throw new Error('env probe node is not registered')
  const ctx = {
    runId: 'run-1',
    nodeId: ENV_PROBE_NODE,
    path: ENV_PROBE_NODE,
    attempt: 0,
    input: {} as Json,
    config: {},
    signal: new AbortController().signal,
    log: () => {},
    emit: () => {},
  } as unknown as NodeContext<unknown>
  const outputs = (await definition.execute(ctx)) as Record<string, unknown>
  return JSON.parse(String(outputs['env'])) as Record<string, string | null>
}

const SOURCE: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin',
  TZ: 'UTC',
  TMPDIR: '/tmp',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_MESSAGES: 'C',
  Z1_SEARX_URL: 'http://127.0.0.1:8888',
  Z1_SEARX_STATE: 'starting:1700000000000',
  Z1_WEB_TIMEOUT_MS: '5000',
  Z1_WEB_AUTOSTART: 'off',
  Z1_GITHUB_TOKEN: 'gh-token',
  Z1_STACK_KEY: 'stack-key',
  HTTP_PROXY: 'http://proxy:3128',
  HTTPS_PROXY: 'http://proxy:3128',
  NO_PROXY: 'localhost',
  http_proxy: 'http://proxy:3128',
  https_proxy: 'http://proxy:3128',
  no_proxy: 'localhost',
  RIVER_API_KEY: 'river-secret',
  Z1_PRIVATE_SECRET: 'private-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  UNRELATED: 'nope',
}

describe('workerEnvironment', () => {
  test('keeps process basics, z1 web settings and proxies', () => {
    const env = workerEnvironment(SOURCE)
    for (const key of [
      'PATH',
      'TZ',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'LC_MESSAGES',
      'Z1_SEARX_URL',
      'Z1_SEARX_STATE',
      'Z1_WEB_TIMEOUT_MS',
      'Z1_WEB_AUTOSTART',
      'Z1_GITHUB_TOKEN',
      'Z1_STACK_KEY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ]) {
      expect(env[key], key).toBe(SOURCE[key])
    }
  })

  test('drops secrets and unrelated variables', () => {
    const env = workerEnvironment(SOURCE)
    for (const key of [
      'RIVER_API_KEY',
      'Z1_PRIVATE_SECRET',
      'AWS_SECRET_ACCESS_KEY',
      'UNRELATED',
    ]) {
      expect(env, key).not.toHaveProperty(key)
    }
    // Nothing beyond the allowlist survived.
    expect(Object.keys(env).sort()).toEqual(
      [
        'PATH',
        'TZ',
        'TMPDIR',
        'LANG',
        'LC_ALL',
        'LC_MESSAGES',
        'Z1_SEARX_URL',
        'Z1_SEARX_STATE',
        'Z1_WEB_TIMEOUT_MS',
        'Z1_WEB_AUTOSTART',
        'Z1_GITHUB_TOKEN',
        'Z1_STACK_KEY',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'no_proxy',
      ].sort(),
    )
  })

  test('skips undefined values and always yields PATH', () => {
    expect(workerEnvironment({ Z1_SEARX_URL: undefined })).toEqual({ PATH: '' })
    expect(workerEnvironment({ PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })
})

describe('a module worker inherits one environment', () => {
  test('the allowlisted settings reach module code', async () => {
    const runtime = await runtimeWithProbe(workerEnvironment(SOURCE))
    const seen = await readWorkerEnv(await runtime.start())
    expect(seen['PATH']).toBe(SOURCE['PATH'])
    expect(seen['LC_ALL']).toBe('en_US.UTF-8')
    expect(seen['Z1_SEARX_URL']).toBe('http://127.0.0.1:8888')
    expect(seen['Z1_SEARX_STATE']).toBe('starting:1700000000000')
    expect(seen['Z1_GITHUB_TOKEN']).toBe('gh-token')
    // The host process itself may hold these; the child must not.
    expect(seen['RIVER_API_KEY']).toBeNull()
    expect(seen['Z1_PRIVATE_SECRET']).toBeNull()
    expect(seen['AWS_SECRET_ACCESS_KEY']).toBeNull()
  }, 30_000)

  test('no env option keeps the PATH-only child (backward compatible)', async () => {
    // Prove the host has the variable while the child does not: without `env`
    // the worker must not inherit the host environment.
    const previous = process.env['Z1_SEARX_URL']
    process.env['Z1_SEARX_URL'] = 'http://host-only:8888'
    try {
      const runtime = await runtimeWithProbe()
      const seen = await readWorkerEnv(await runtime.start())
      expect(seen['Z1_SEARX_URL']).toBeNull()
      expect(typeof seen['PATH']).toBe('string')
    } finally {
      if (previous === undefined) delete process.env['Z1_SEARX_URL']
      else process.env['Z1_SEARX_URL'] = previous
    }
  }, 30_000)
})
