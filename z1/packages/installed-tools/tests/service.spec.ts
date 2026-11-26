import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { Json } from '@z1/node'

import { InstalledToolError, createInstalledToolService } from '../src/index.ts'
import { HAS_SIBLING, SIBLING_SDK, fakeInner, installFixture, recorder } from './fakes.ts'

/**
 * The decorator without a sandbox call.
 *
 * Two layers here. What the routing and the refusals look like is pinned with
 * no checkout at all — a machine without z2q still has to answer every name the
 * run already had. What the inventory looks like is pinned against the real
 * checkout, because the schema of an installed tool is built from the manifest
 * that only z2q verifies: without it there is nothing to advertise, which is
 * the whole point of the skip below.
 */

let scratch: string
let missingSdk: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'z1-installed-tools-service-'))
  // A directory that is certainly not a z2q checkout: no dist, no build.
  missingSdk = join(scratch, 'no-checkout')
  await mkdir(missingSdk, { recursive: true })
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** A fresh working directory, one per test, so no inventory leaks sideways. */
async function workspace(): Promise<string> {
  return await mkdtemp(join(scratch, 'ws-'))
}

/** Every path under `dir`, so a test can prove nothing was written. */
async function tree(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { recursive: true })
  return entries.map((entry) => entry.replaceAll('\\', '/')).sort()
}

describe('routing', () => {
  test('a name no approval claims reaches the inner service unchanged', async () => {
    const inner = fakeInner(['read'], { result: () => ({ by: 'inner' }) })
    const service = createInstalledToolService({
      inner,
      workspace: await workspace(),
      sdkPath: missingSdk,
    })
    const args: Json = { path: 'a.txt', flags: [1, 2] }

    expect(await service.call('read', args)).toEqual({ by: 'inner' })
    expect(inner.calls).toEqual([{ name: 'read', args }])
  })

  test('a name that is not a directory name is never turned into a path', async () => {
    const inner = fakeInner(['read'])
    const directory = await workspace()
    await mkdir(join(directory, '.z2q', 'tools'), { recursive: true })
    const service = createInstalledToolService({
      inner,
      workspace: directory,
      sdkPath: missingSdk,
    })

    for (const name of ['..', '../escape', 'a/b', 'c\\d', 'stream:name', '.']) {
      await service.call(name, {})
    }

    expect(inner.calls.map((call) => call.name)).toEqual([
      '..',
      '../escape',
      'a/b',
      'c\\d',
      'stream:name',
      '.',
    ])
  })

  test('nothing installed means the inner inventory, and not one log line', async () => {
    const inner = fakeInner(['read', 'grep'])
    const log = recorder()
    const service = createInstalledToolService({
      inner,
      workspace: await workspace(),
      sdkPath: missingSdk,
      log: log.log,
    })

    expect((await service.list()).map((schema) => schema.name)).toEqual(['read', 'grep'])
    expect(log.lines).toEqual([])
  })
})

describe('a machine without the checkout', () => {
  test('list() warns once, names the path and keeps the inventory', async () => {
    const directory = await workspace()
    await installFixture({ toolsDir: join(directory, '.z2q', 'tools') })
    const inner = fakeInner(['read'])
    const log = recorder()
    const service = createInstalledToolService({
      inner,
      workspace: directory,
      sdkPath: missingSdk,
      log: log.log,
    })

    expect((await service.list()).map((schema) => schema.name)).toEqual(['read'])
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]?.level).toBe('warn')
    expect(log.lines[0]?.message).toContain('tool_unavailable')
    expect(log.lines[0]?.message).toContain(missingSdk)

    // Once per cause: a second listing is not a second warning.
    await service.list()
    expect(log.lines).toHaveLength(1)
  })

  test('call() of an installed name fails with a message naming the path', async () => {
    const directory = await workspace()
    await installFixture({ toolsDir: join(directory, '.z2q', 'tools'), name: 'tool.orphan' })
    const inner = fakeInner([])
    const service = createInstalledToolService({
      inner,
      workspace: directory,
      sdkPath: missingSdk,
    })

    const error = await service.call('tool.orphan', {}).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(InstalledToolError)
    expect((error as InstalledToolError).code).toBe('tool_unavailable')
    expect((error as InstalledToolError).tool).toBe('tool.orphan')
    expect((error as Error).message).toContain('tool.orphan failed: tool_unavailable')
    expect((error as Error).message).toContain(missingSdk)
    // A refusal is not a fallback: the inner service never saw the name.
    expect(inner.calls).toEqual([])
  })

  test('a failed load is not cached, so a checkout built later is picked up', async () => {
    const directory = await workspace()
    await installFixture({ toolsDir: join(directory, '.z2q', 'tools'), name: 'tool.late' })
    const sdkPath = join(scratch, 'late-checkout')
    const service = createInstalledToolService({
      inner: fakeInner([]),
      workspace: directory,
      sdkPath,
    })

    const first = await service.call('tool.late', {}).catch((caught: unknown) => caught)
    expect((first as Error).message).toContain(sdkPath)

    // An unbuilt directory appears between the two calls; the refusal must name
    // it rather than the one the first call saw.
    await mkdir(join(sdkPath, 'dist'), { recursive: true })
    await writeFile(join(sdkPath, 'dist', 'index.js'), 'export {}\n', 'utf8')
    await mkdir(join(sdkPath, 'dist', 'runtime'), { recursive: true })
    await writeFile(join(sdkPath, 'dist', 'runtime', 'index.js'), 'export {}\n', 'utf8')

    const second = await service.call('tool.late', {}).catch((caught: unknown) => caught)
    expect(second).not.toBe(first)
    // The modules exist but export nothing: still a refusal, and still coded.
    expect((second as InstalledToolError).code).toBe('tool_unavailable')
    expect((second as Error).message).toContain('not a built z2q checkout')
  })
})

describe.skipIf(!HAS_SIBLING)('the inventory', () => {
  test('one schema per installed tool, after the inner ones and sorted', async () => {
    const directory = await workspace()
    const toolsDir = join(directory, '.z2q', 'tools')
    const parameters: Record<string, Json> = {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    const beta = await installFixture({ toolsDir, name: 'tool.beta', description: 'Beta tool.' })
    const alpha = await installFixture({
      toolsDir,
      name: 'tool.alpha',
      version: '2.1.0',
      description: 'Alpha tool with real parameters.',
      parameters,
    })
    const inner = fakeInner(['read', 'grep'])
    const service = createInstalledToolService({ inner, workspace: directory, sdkPath: SIBLING_SDK })

    const schemas = await service.list()

    expect(schemas.map((schema) => schema.name)).toEqual([
      'read',
      'grep',
      'tool.alpha',
      'tool.beta',
    ])
    expect(schemas[2]).toEqual({
      name: 'tool.alpha',
      description: 'Alpha tool with real parameters.',
      parameters: alpha.manifest['parameters'],
    })
    expect(schemas[3]?.description).toBe('Beta tool.')
    expect(parameters).toEqual(alpha.manifest['parameters'])
    expect(beta.version).toBe('1.0.0')
  })

  test('an explicit toolsDir is read instead of the workspace default', async () => {
    const directory = await workspace()
    const toolsDir = await mkdtemp(join(scratch, 'elsewhere-'))
    await installFixture({ toolsDir, name: 'tool.elsewhere' })
    const service = createInstalledToolService({
      inner: fakeInner([]),
      workspace: directory,
      toolsDir,
      sdkPath: SIBLING_SDK,
    })

    expect((await service.list()).map((schema) => schema.name)).toEqual(['tool.elsewhere'])
  })

  test('an inner tool keeps its name, and the collision is said once', async () => {
    const directory = await workspace()
    await installFixture({ toolsDir: join(directory, '.z2q', 'tools'), name: 'read' })
    const log = recorder()
    const service = createInstalledToolService({
      inner: fakeInner(['read']),
      workspace: directory,
      sdkPath: SIBLING_SDK,
      log: log.log,
    })

    expect((await service.list()).map((schema) => schema.description)).toEqual(['read tool'])
    await service.list()

    const warnings = log.lines.filter((line) => line.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('"read"')
    expect(warnings[0]?.message).toContain('keeps the name')
  })

  test('listing writes nothing into the tools directory', async () => {
    const directory = await workspace()
    const toolsDir = join(directory, '.z2q', 'tools')
    await installFixture({ toolsDir, name: 'tool.read-only' })
    const before = await tree(toolsDir)
    const service = createInstalledToolService({
      inner: fakeInner(['read']),
      workspace: directory,
      sdkPath: SIBLING_SDK,
    })

    await service.list()
    await service.call('read', {})

    expect(await tree(toolsDir)).toEqual(before)
  })
})
