import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModuleStore, type ModuleManifest } from '@z1/module'
import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createRuntime, loadRuntimeConfig, type Runtime } from '../src/index.ts'
import { composeToolService, type ToolServiceMember } from '../src/tool-composite.ts'

/** A log sink shaped like `ModuleServiceLog`, keeping level + message. */
function recorder(): { log: (level: string, message: string) => void; lines: string[] } {
  const lines: string[] = []
  return { lines, log: (level, message) => lines.push(`${level} ${message}`) }
}

function schema(name: string): ToolSchema {
  return { name, description: `${name} tool`, parameters: { type: 'object' } }
}

/** A member whose `list()` returns `names` and whose `call()` echoes its id. */
function member(
  moduleId: string,
  version: string,
  names: readonly string[],
  options: { rejectList?: Error; tools?: ToolService } = {},
): ToolServiceMember {
  const instance: ToolService =
    options.tools ??
    ({
      async list() {
        if (options.rejectList !== undefined) throw options.rejectList
        return names.map(schema)
      },
      async call(name: string, args: Json) {
        return { by: moduleId, name, args }
      },
    } satisfies ToolService)
  return { moduleId, version, instance }
}

describe('tool-service composition', () => {
  test('list() concatenates members in candidate order and call() routes by owner', async () => {
    const names: string[] = []
    const { log } = recorder()
    const tools = composeToolService(
      [member('com.a', '1.0.0', ['read', 'write']), member('com.b', '1.0.0', ['web.search'])],
      log,
    )

    expect((await tools.list()).map((tool) => tool.name)).toEqual(['read', 'write', 'web.search'])
    names.push(...(await tools.list()).map((tool) => tool.name))
    expect(names).toEqual(['read', 'write', 'web.search'])

    expect(await tools.call('read', { path: '/' })).toEqual({
      by: 'com.a',
      name: 'read',
      args: { path: '/' },
    })
    expect(await tools.call('web.search', { q: 'z1' })).toEqual({
      by: 'com.b',
      name: 'web.search',
      args: { q: 'z1' },
    })
  })

  test('call() before list() builds the same routing table', async () => {
    const { log } = recorder()
    const tools = composeToolService([member('com.a', '1.0.0', ['read'])], log)
    expect(await tools.call('read', {})).toEqual({ by: 'com.a', name: 'read', args: {} })
  })

  test('an unknown name throws the tools-shaped error', async () => {
    const { log } = recorder()
    const tools = composeToolService([member('com.a', '1.0.0', ['read'])], log)
    await expect(tools.call('nope', {})).rejects.toThrow('unknown tool "nope"')
  })

  test('a duplicate name keeps the first member, warns, and does not throw', async () => {
    const { log, lines } = recorder()
    const tools = composeToolService(
      [member('com.a', '1.0.0', ['read']), member('com.b', '2.0.0', ['read', 'web.search'])],
      log,
    )

    expect((await tools.list()).map((tool) => tool.name)).toEqual(['read', 'web.search'])
    expect(await tools.call('read', {})).toEqual({ by: 'com.a', name: 'read', args: {} })
    expect(lines).toContain(
      'warn service tools: duplicate tool "read" from com.b@2.0.0 ignored, keeps com.a@1.0.0',
    )
  })

  test("one member's list() rejection does not hide the others", async () => {
    const { log, lines } = recorder()
    const tools = composeToolService(
      [
        member('com.broken', '1.0.0', [], { rejectList: new Error('worker died') }),
        member('com.good', '1.0.0', ['web.search']),
      ],
      log,
    )

    expect((await tools.list()).map((tool) => tool.name)).toEqual(['web.search'])
    expect(await tools.call('web.search', {})).toEqual({ by: 'com.good', name: 'web.search', args: {} })
    await expect(tools.call('anything-else', {})).rejects.toThrow('unknown tool "anything-else"')
    expect(lines.some((line) => line.includes('com.broken@1.0.0') && line.includes('worker died'))).toBe(
      true,
    )
  })

  test('every member failing propagates the first error', async () => {
    const { log } = recorder()
    const tools = composeToolService(
      [
        member('com.one', '1.0.0', [], { rejectList: new Error('first failure') }),
        member('com.two', '1.0.0', [], { rejectList: new Error('second failure') }),
      ],
      log,
    )
    await expect(tools.list()).rejects.toThrow('first failure')
  })
})

// --- end to end through the composition root -----------------------------

let root: string
const runtimes: Runtime[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-tool-composite-'))
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(root, { recursive: true, force: true })
})

async function install(
  storeRoot: string,
  options: { id: string; version: string; services: NonNullable<ModuleManifest['services']>; code: string },
): Promise<void> {
  const source = await mkdtemp(join(root, 'src-'))
  const manifest: ModuleManifest = {
    schemaVersion: 1,
    id: options.id,
    version: options.version,
    title: options.id,
    license: 'MIT',
    engines: { z1: '>=0.1.0' },
    entry: 'index.js',
    nodes: [],
    services: options.services,
  }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(join(source, 'index.js'), options.code)
  const store = new ModuleStore(storeRoot)
  store.propose(source)
  store.approve(options.id, options.version)
  store.activate(options.id, options.version)
}

/** A host-mode tools service exposing `names`; `call` echoes the module id. */
function toolsModule(id: string, names: readonly string[]): string {
  return `export const services = {
  tools() {
    return {
      async list() {
        return ${JSON.stringify(names.map((name) => schema(name)))}
      },
      async call(name, args) {
        return { by: ${JSON.stringify(id)}, name, args }
      },
    }
  },
}
`
}

async function makeRuntime(modulesPath: string): Promise<Runtime> {
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: root,
      // This suite pins how module tools compose, not the host decorators: with
      // `tool.create` or installed tools on by default they would add a name to
      // every assertion here and stand between the run and the module instance.
      env: { Z1_TOOL_CREATOR: '0', Z1_INSTALLED_TOOLS: '0' },
      overrides: {
        dbPath: join(root, `runs-${randomUUID()}.db`),
        graphsPath: join(root, 'graphs'),
        modulesPath,
        useServiceModules: true,
      },
    }),
  )
  runtimes.push(runtime)
  return runtime
}

describe('tool composition in a run', () => {
  test('two tools modules reach the run as one service', async () => {
    const modulesPath = join(root, 'store-two-tools')
    await install(modulesPath, {
      id: 'com.example.fs-tools',
      version: '1.0.0',
      services: [{ id: 'tools', kind: 'tools', trusted: true }],
      code: toolsModule('com.example.fs-tools', ['read', 'write']),
    })
    await install(modulesPath, {
      id: 'com.example.web-tools',
      version: '0.1.0',
      services: [{ id: 'tools', kind: 'tools', trusted: true }],
      code: toolsModule('com.example.web-tools', ['web.search', 'web.status']),
    })

    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    const runtime = await makeRuntime(modulesPath)
    const handle = await runtime.beginRun({ approval: { request: async () => 'allowed-once' } })
    spy.mockRestore()

    try {
      const names = (await handle.services.tools.list()).map((tool) => tool.name)
      expect(names).toEqual(['read', 'write', 'web.search', 'web.status'])
      expect(await handle.services.tools.call('web.search', { q: 'z1' })).toEqual({
        by: 'com.example.web-tools',
        name: 'web.search',
        args: { q: 'z1' },
      })
      expect(written.join('')).toContain(
        'service tools composed from com.example.fs-tools@1.0.0, com.example.web-tools@0.1.0',
      )
    } finally {
      await handle.dispose()
    }
  })

  test('a single tools module is used as-is, with no wrapper', async () => {
    const modulesPath = join(root, 'store-one-tools')
    const key = `tools-${randomUUID()}`
    await install(modulesPath, {
      id: 'com.example.solo-tools',
      version: '1.0.0',
      services: [{ id: 'tools', kind: 'tools', trusted: true }],
      code: `globalThis.__z1ToolInstances ??= {}
export const services = {
  tools() {
    const instance = {
      async list() {
        return [${JSON.stringify(schema('solo'))}]
      },
      async call(name, args) {
        return { name, args }
      },
    }
    globalThis.__z1ToolInstances[${JSON.stringify(key)}] = instance
    return instance
  },
}
`,
    })
    const runtime = await makeRuntime(modulesPath)
    const handle = await runtime.beginRun({ approval: { request: async () => 'allowed-once' } })
    try {
      const instances = (globalThis as { __z1ToolInstances?: Record<string, ToolService> })
        .__z1ToolInstances
      expect(handle.services.tools).toBe(instances?.[key])
      expect((await handle.services.tools.list()).map((tool) => tool.name)).toEqual(['solo'])
    } finally {
      await handle.dispose()
    }
  })

  test('no tools module keeps the built-in mock service', async () => {
    const modulesPath = join(root, 'store-no-tools')
    const runtime = await makeRuntime(modulesPath)
    const handle = await runtime.beginRun({ approval: { request: async () => 'allowed-once' } })
    try {
      expect(await handle.services.tools.list()).toEqual([])
      expect(await handle.services.tools.call('anything', { a: 1 })).toEqual({
        ok: true,
        name: 'anything',
        args: { a: 1 },
      })
    } finally {
      await handle.dispose()
    }
  })

  test('non-tools kinds keep the highest-version single choice', async () => {
    const modulesPath = join(root, 'store-llm-versions')
    const llm = (id: string, content: string): string => `export const services = {
  llm() {
    return {
      async chat() {
        return {
          message: { role: 'assistant', content: ${JSON.stringify(`${content}: hello`)} },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },
}
`
    await install(modulesPath, {
      id: 'com.example.old-llm',
      version: '1.0.0',
      services: [{ id: 'llm', kind: 'llm', trusted: true }],
      code: llm('com.example.old-llm', 'old'),
    })
    await install(modulesPath, {
      id: 'com.example.new-llm',
      version: '2.0.0',
      services: [{ id: 'llm', kind: 'llm', trusted: true }],
      code: llm('com.example.new-llm', 'new'),
    })

    const runtime = await makeRuntime(modulesPath)
    const handle = await runtime.beginRun({ approval: { request: async () => 'allowed-once' } })
    try {
      const result = await handle.services.llm.chat({
        model: { provider: 'mock', model: 'mock-1' },
        messages: [{ role: 'user', content: 'hello' }],
      })
      expect(result.message.content).toBe('new: hello')
    } finally {
      await handle.dispose()
    }
  })
})
