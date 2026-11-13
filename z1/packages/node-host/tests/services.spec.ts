import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { InstalledModule, ModuleServiceDeclaration } from '@z1/module'
import type { ChatRequest } from '@z1/node'
import { ModuleServiceRuntime } from '../src/services.ts'

const created: string[] = []

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'z1-node-host-services-'))
  created.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const LLM: ModuleServiceDeclaration = { id: 'llm', kind: 'llm', trusted: true }

function installed(
  code: string,
  services: ModuleServiceDeclaration[] = [LLM],
): InstalledModule {
  const directory = temporary()
  writeFileSync(join(directory, 'index.js'), code)
  return {
    manifest: {
      schemaVersion: 1,
      id: 'com.example.mock-llm',
      version: '1.0.0',
      title: 'Mock LLM',
      license: 'MIT',
      engines: { z1: '>=0.1.0' },
      entry: 'index.js',
      nodes: [],
      services,
    },
    integrity: '0'.repeat(64),
    directory,
    active: true,
    installedAt: Date.now(),
    grant: {
      moduleId: 'com.example.mock-llm',
      version: '1.0.0',
      integrity: '0'.repeat(64),
      capabilities: {},
      services,
      grantedAt: Date.now(),
      futureVersions: false,
    },
  }
}

const GOOD = `
export const state = { ctx: null, disposeCalls: 0 }
export const services = {
  llm(ctx) {
    state.ctx = ctx
    return {
      async chat(request) {
        const users = request.messages.filter((m) => m.role === 'user')
        return {
          message: { role: 'assistant', content: 'fixed: ' + (users.at(-1)?.content ?? '') },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      dispose() { state.disposeCalls += 1 },
    }
  },
}
`

const request: ChatRequest = {
  model: { provider: 'stub', model: 'stub-1' },
  messages: [{ role: 'user', content: 'hello' }],
}

describe('ModuleServiceRuntime', () => {
  test('starts a declared llm service and passes a ctx to the factory', async () => {
    const module = installed(GOOD)
    const runtime = new ModuleServiceRuntime()
    const started = await runtime.start(module, { log: () => {} })

    const llm = started.services['llm'] as {
      chat: (r: ChatRequest) => Promise<{ message: { content: string } }>
    }
    expect(await llm.chat(request)).toMatchObject({ message: { content: 'fixed: hello' } })

    const entry = (await import(pathToFileURL(join(module.directory, 'index.js')).href)) as {
      state: { ctx: Record<string, unknown> | null }
    }
    expect(entry.state.ctx?.['moduleId']).toBe('com.example.mock-llm')
    expect(entry.state.ctx?.['version']).toBe('1.0.0')
    expect(entry.state.ctx?.['directory']).toBe(module.directory)
    expect(typeof entry.state.ctx?.['log']).toBe('function')
    expect(typeof entry.state.ctx?.['get']).toBe('function')

    await started.dispose()
  })

  test('rejects a declared service with no factory, naming the module and id', async () => {
    const module = installed('export const services = {}\n')
    await expect(new ModuleServiceRuntime().start(module)).rejects.toThrow(
      /com\.example\.mock-llm.*"llm"/,
    )
  })

  test('rejects a service whose instance lacks the required methods', async () => {
    const module = installed(
      'export const services = { llm: () => ({ list: async () => [] }) }\n',
    )
    await expect(new ModuleServiceRuntime().start(module)).rejects.toThrow(/must implement chat/)
  })

  test('dispose calls the instance once and is safe to repeat', async () => {
    const module = installed(GOOD)
    const started = await new ModuleServiceRuntime().start(module)
    await started.dispose()
    await started.dispose()

    const entry = (await import(pathToFileURL(join(module.directory, 'index.js')).href)) as {
      state: { disposeCalls: number }
    }
    expect(entry.state.disposeCalls).toBe(1)
  })

  test('a module with no services starts nothing', async () => {
    const module = installed('export const services = {}\n', [])
    const started = await new ModuleServiceRuntime().start(module)
    expect(started.services).toEqual({})
    await started.dispose()
  })
})
