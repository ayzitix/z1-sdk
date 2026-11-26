/**
 * The wiring: one more tool in the inventory, every other name untouched, and a
 * host-side write that never asks the run's `fs` service for anything.
 *
 * The last point is the one worth a test of its own. `env.keys` reads and writes
 * `.env` with `node:fs` inside the host process, so it must not gain — or grant
 * — a filesystem capability: a run's `fs` service stays exactly as the host
 * composed it, and the mock here records that nothing was written through it.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createMockRuntimeServices } from '@z1/runtime'

import {
  ENV_KEYS_TOOL_NAME,
  createEnvKeysService,
  envKeysSchema,
} from '../src/index.ts'
import { asRecord, fakeInner, removeDirectory, temporaryDirectory } from './helpers.ts'

let root: string

beforeAll(async () => {
  root = await temporaryDirectory('wiring')
})

afterAll(async () => {
  await removeDirectory(root)
})

describe('list()', () => {
  test('appends the one schema to the inner inventory, in the inner order', async () => {
    const tools = createEnvKeysService({ inner: fakeInner(['read', 'grep']), workspace: root })

    const schemas = await tools.list()

    expect(schemas.map((schema) => schema.name)).toEqual(['read', 'grep', ENV_KEYS_TOOL_NAME])
    expect(schemas[2]).toBe(envKeysSchema)
  })

  test('warns once when the wrapped service already advertises the name', async () => {
    const warnings: string[] = []
    const tools = createEnvKeysService({
      inner: fakeInner([ENV_KEYS_TOOL_NAME]),
      workspace: root,
      log: (level, message) => {
        if (level === 'warn') warnings.push(message)
      },
    })

    await tools.list()
    await tools.list()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('already advertises')
  })
})

describe('call()', () => {
  test('a name the service does not own reaches the inner service untouched', async () => {
    const inner = fakeInner(['read'], { result: () => ({ by: 'inner' }) })
    const tools = createEnvKeysService({ inner, workspace: root })

    expect(await tools.call('read', { path: 'a.ts' })).toEqual({ by: 'inner' })
    expect(inner.calls).toEqual([{ name: 'read', args: { path: 'a.ts' } }])
  })

  test('an inner throw is passed through as it is', async () => {
    const failure = new Error('inner refused')
    const tools = createEnvKeysService({ inner: fakeInner(['read'], { error: failure }), workspace: root })

    await expect(tools.call('read', {})).rejects.toBe(failure)
  })

  test('writes through node:fs, not the run\'s fs service', async () => {
    const dir = join(root, 'broker')
    await mkdir(dir, { recursive: true })
    const services = createMockRuntimeServices()
    const tools = createEnvKeysService({ inner: services.tools, workspace: dir })

    // The call goes through the tool service — the same path the executor and
    // the model use — and the file appears on disk.
    const result = await tools.call(ENV_KEYS_TOOL_NAME, {
      action: 'set',
      name: 'API_KEY',
      value: 'sk-live-0123456789abcdef',
    })

    expect(asRecord(result)['file']).toBe('.env')
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('API_KEY=sk-live-0123456789abcdef\n')
    // The mock fs service is what a run's `ctl.fs` would be. Nothing here asked
    // it for anything, which is what keeps the tool capability-free.
    expect(services.files.size).toBe(0)
    // The inner (mock) tools service never saw the call either: the name is
    // this service's to route.
    expect(services.toolCalls).toEqual([])
  })
})
