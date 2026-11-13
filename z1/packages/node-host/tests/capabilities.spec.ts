import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { FsService, LlmService, ToolService } from '@z1/runtime'
import {
  ModuleWorker,
  type FsListEntry,
  type ProcessRunResult,
  type WorkerCapabilityDenial,
  type WorkerHostOptions,
  type WorkerHostServices,
} from '../src/index.ts'

const MODULE_DIR = fileURLToPath(new URL('./fixtures/capabilities', import.meta.url))
const NODE_IDS = ['com.example.caps.list', 'com.example.caps.run']
const LIST_NODE = 'com.example.caps.list'
const RUN_NODE = 'com.example.caps.run'

const workers: ModuleWorker[] = []
let root = ''

function services(denials: WorkerCapabilityDenial[]): WorkerHostServices {
  const fs: FsService = {
    read: async () => {
      throw new Error('fs.read is not used by this fixture')
    },
    write: async () => {
      throw new Error('fs.write is not used by this fixture')
    },
  }
  const tools: ToolService = {
    call: async () => {
      throw new Error('unexpected tool call')
    },
    list: async () => [],
  }
  const llm: LlmService = {
    chat: async () => {
      throw new Error('unexpected llm call')
    },
  }
  return {
    fs,
    tools,
    llm,
    approval: { request: async () => 'allowed-once' },
    onCapabilityDenied: (denial) => denials.push(denial),
  }
}

function createWorker(
  denials: WorkerCapabilityDenial[] = [],
  overrides: Partial<WorkerHostOptions> = {},
): ModuleWorker {
  const worker = new ModuleWorker({
    moduleDir: MODULE_DIR,
    entry: 'index.js',
    manifestNodeIds: NODE_IDS,
    capabilities: {
      fs: { read: ['${moduleDir}/**', `${root}`, `${root}/**`] },
      process: { spawn: ['node'] },
    },
    services: services(denials),
    ...overrides,
  })
  workers.push(worker)
  return worker
}

function entry(entries: FsListEntry[], name: string): FsListEntry {
  const found = entries.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`missing entry "${name}"`)
  return found
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-caps-'))
  await writeFile(join(root, 'a.txt'), 'abc')
  await writeFile(join(root, 'b.txt'), '')
  await mkdir(join(root, 'nested'))
  await symlink(join(root, 'a.txt'), join(root, 'link.txt'))
  await symlink(join(root, 'nested'), join(root, 'linkdir'))
})

afterAll(async () => {
  for (const worker of workers.splice(0)) await worker.dispose().catch(() => undefined)
  if (root.length > 0) await rm(root, { recursive: true, force: true })
})

describe('fs.list', () => {
  test('returns sorted entries typed without following symlinks', async () => {
    const worker = createWorker()
    await worker.start()

    const listed = await worker.execute(LIST_NODE, {}, { path: root }, null)
    expect(listed['path']).toBe(root)
    const entries = listed['entries'] as FsListEntry[]

    expect(entries.map((item) => item.name)).toEqual([
      'a.txt',
      'b.txt',
      'link.txt',
      'linkdir',
      'nested',
    ])

    expect(entry(entries, 'a.txt')).toMatchObject({ type: 'file', size: 3 })
    expect(entry(entries, 'b.txt')).toMatchObject({ type: 'file', size: 0 })
    expect(entry(entries, 'nested')).toEqual({
      name: 'nested',
      path: join(root, 'nested'),
      type: 'dir',
    })
    expect(entry(entries, 'link.txt')).toEqual({
      name: 'link.txt',
      path: join(root, 'link.txt'),
      type: 'symlink',
    })
    // A symlink to a directory is still a symlink: list does not follow it.
    expect(entry(entries, 'linkdir')).toEqual({
      name: 'linkdir',
      path: join(root, 'linkdir'),
      type: 'symlink',
    })
  }, 20_000)

  test('denies a directory outside the granted read patterns', async () => {
    const denials: WorkerCapabilityDenial[] = []
    const worker = createWorker(denials)
    await worker.start()

    await expect(worker.execute(LIST_NODE, {}, { path: '/etc' }, null)).rejects.toThrow(
      /capability denied for fs\.list/,
    )
    expect(denials.map((denial) => denial.kind)).toContain('fs.list')
  }, 20_000)

  test('propagates a missing directory', async () => {
    const worker = createWorker()
    await worker.start()

    await expect(
      worker.execute(LIST_NODE, {}, { path: join(root, 'missing') }, null),
    ).rejects.toThrow(/ENOENT/)
  }, 20_000)
})

describe('process.run', () => {
  test('runs an allowed command and reports its status', async () => {
    const worker = createWorker()
    await worker.start()

    const result = (await worker.execute(
      RUN_NODE,
      {},
      { command: process.execPath, args: ['-e', "console.log('ok')"] },
      null,
    )) as unknown as ProcessRunResult

    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('ok\n')
    expect(result.stderr).toBe('')
    expect(result.truncated).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  }, 20_000)

  test('denies a command outside process.spawn', async () => {
    const denials: WorkerCapabilityDenial[] = []
    const worker = createWorker(denials, { capabilities: { process: { spawn: ['echo'] } } })
    await worker.start()

    await expect(
      worker.execute(RUN_NODE, {}, { command: process.execPath, args: ['-v'] }, null),
    ).rejects.toThrow(/capability denied for process\.run/)
    expect(denials.map((denial) => denial.kind)).toContain('process.run')
  }, 20_000)

  test('denies a cwd outside fs.read', async () => {
    const denials: WorkerCapabilityDenial[] = []
    const worker = createWorker(denials)
    await worker.start()

    await expect(
      worker.execute(
        RUN_NODE,
        {},
        { command: process.execPath, args: ['-v'], cwd: '/etc' },
        null,
      ),
    ).rejects.toThrow(/capability denied for process\.run/)
    expect(denials.some((denial) => denial.detail.includes('cwd /etc'))).toBe(true)
  }, 20_000)

  test('kills a child that exceeds its timeout', async () => {
    const worker = createWorker()
    await worker.start()

    const result = (await worker.execute(
      RUN_NODE,
      {},
      {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        timeoutMs: 100,
      },
      null,
    )) as unknown as ProcessRunResult

    expect(result.code).toBeNull()
    expect(result.signal).toMatch(/^SIG/)
    expect(result.durationMs).toBeGreaterThanOrEqual(90)
  }, 20_000)

  test('truncates stdout and stderr against one shared byte budget', async () => {
    const worker = createWorker()
    await worker.start()

    const result = (await worker.execute(
      RUN_NODE,
      {},
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(4096))"],
        maxOutputBytes: 64,
      },
      null,
    )) as unknown as ProcessRunResult

    expect(result.truncated).toBe(true)
    expect(result.stdout).toHaveLength(64)
  }, 20_000)

  test('passes request env on top of a minimal PATH-only environment', async () => {
    const worker = createWorker()
    await worker.start()

    const result = (await worker.execute(
      RUN_NODE,
      {},
      {
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({ home: process.env.HOME ?? null, tag: process.env.Z1_TAG ?? null, path: typeof process.env.PATH }))',
        ],
        env: { Z1_TAG: 'ok' },
      },
      null,
    )) as unknown as ProcessRunResult

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ home: null, tag: 'ok', path: 'string' })
  }, 20_000)

  test('passes args as argv without shell interpretation', async () => {
    const worker = createWorker()
    await worker.start()

    const result = (await worker.execute(
      RUN_NODE,
      {},
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', 'a b; echo pwned'],
      },
      null,
    )) as unknown as ProcessRunResult

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('a b; echo pwned')
  }, 20_000)
})
