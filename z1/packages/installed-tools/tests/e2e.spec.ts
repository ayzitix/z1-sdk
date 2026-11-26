import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { InstalledToolError, createInstalledToolService } from '../src/index.ts'
import { HAS_SIBLING, SIBLING_SDK, asRecord, fakeInner, recorder } from './fakes.ts'

/**
 * The whole path, against the real checkout.
 *
 * Nothing here fakes z2q: each tool is a `tool.ts` project, `installTool`
 * builds it (static review, esbuild, the sandbox manifest read) and writes the
 * approval, and the service then lists it and runs it in the QuickJS sandbox.
 * That is why the suite is skipped on a machine without the sibling checkout —
 * and why every assertion below is about the wiring between the two packages
 * rather than about z2q's own behaviour.
 *
 * The network and env cases never open a connection: `net: false` refuses before
 * the relay starts, and a host ceiling that misses the manifest's host refuses
 * before a socket exists, so no loopback server and no child process is needed
 * (z2q's `AGENTS.md` rule 7 applies only to a fetch that must succeed).
 */

/** What `installTool` returns that these tests read. */
interface Installed {
  readonly name: string
  readonly version: string
  readonly path: string
  readonly sha256: string
}

let z2q: {
  installTool(options: {
    toolsDir: string
    dir: string
    approvedBy?: string
  }): Promise<Installed>
}

let scratch: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'z1-installed-tools-e2e-'))
  z2q = (await import(pathToFileURL(join(SIBLING_SDK, 'dist', 'index.js')).href)) as typeof z2q
}, 60_000)

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

let projects = 0

interface InstalledProject {
  readonly workspace: string
  readonly toolsDir: string
  readonly installed: Installed
}

/**
 * Write a tool project, build it through `installTool` and install it into
 * `<workspace>/.z2q/tools`, which is where the service looks by default.
 *
 * One project per test: a fixture that another test tampers with cannot make
 * this one lie.
 */
async function install(source: string): Promise<InstalledProject> {
  projects += 1
  const root = join(scratch, `case-${String(projects)}`)
  const project = join(root, 'project')
  const workspace = join(root, 'workspace')
  await mkdir(project, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(project, 'tool.ts'), source, 'utf8')
  const toolsDir = join(workspace, '.z2q', 'tools')
  const installed = await z2q.installTool({ toolsDir, dir: project, approvedBy: 'e2e' })
  return { workspace, toolsDir, installed }
}

/** The tool test 1 lists and calls: it writes one file inside the workspace. */
const WRITE_NOTE = `
import { defineTool } from 'z1-tool-sdk'
import { z } from 'zod'

export const tool = defineTool({
  name: 'tool.write-note',
  version: '1.2.0',
  description: 'Write a note into the workspace and report the path and size it wrote.',
  parameters: z.object({ text: z.string().default('note') }),
  capabilities: { fs: { write: ['**/*'] }, limits: { timeoutMs: 5000 } },
  run: async (ctx, args) => {
    // The sandbox refuses a write into a directory that does not exist yet, so
    // the note lands beside the workspace root rather than under a new folder.
    await ctx.fs.write('note.txt', args.text)
    return { path: 'note.txt', bytes: args.text.length }
  },
})
`

/** Test 4: a write the manifest appears to grant but the sandbox refuses. */
const ESCAPE = `
import { defineTool } from 'z1-tool-sdk'
import { z } from 'zod'

export const tool = defineTool({
  name: 'tool.escape-attempt',
  version: '1.0.0',
  description: 'Attempt to write outside the workspace so the sandbox has to refuse it.',
  parameters: z.object({}),
  capabilities: { fs: { write: ['**/*'] }, limits: { timeoutMs: 5000 } },
  run: async (ctx) => {
    await ctx.fs.write('../escaped.txt', 'escaped')
    return { wrote: true }
  },
})
`

/** Test 5: reaches a loopback host the manifest declares. */
const FETCH = `
import { defineTool } from 'z1-tool-sdk'
import { z } from 'zod'

export const tool = defineTool({
  name: 'tool.fetch-loopback',
  version: '1.0.0',
  description: 'Fetch one loopback URL and return the status the network reported.',
  parameters: z.object({}),
  capabilities: { net: { hosts: ['127.0.0.1'] }, limits: { timeoutMs: 5000 } },
  run: async (ctx) => {
    const response = await ctx.net.fetch('http://127.0.0.1:9/')
    return { status: response.status }
  },
})
`

/** Test 5: needs one declared secret and fails loudly without it. */
const READS_ENV = `
import { defineTool } from 'z1-tool-sdk'
import { z } from 'zod'

export const tool = defineTool({
  name: 'tool.reads-env',
  version: '1.0.0',
  description: 'Read one declared environment variable and return it to the caller.',
  parameters: z.object({}),
  capabilities: { env: { read: ['Z1_TEST_TOKEN'] }, limits: { timeoutMs: 5000 } },
  run: async (ctx) => {
    const token = ctx.env.Z1_TEST_TOKEN
    if (token === undefined) throw new Error('Z1_TEST_TOKEN is required')
    return { token }
  },
})
`

describe.skipIf(!HAS_SIBLING)('an installed tool end to end', () => {
  test('list() advertises it and call() runs it against the workspace', async () => {
    const { workspace, installed } = await install(WRITE_NOTE)
    const manifest = JSON.parse(
      await readFile(join(installed.path, 'dist', 'tool.json'), 'utf8'),
    ) as { description: string; parameters: Record<string, unknown> }
    const service = createInstalledToolService({
      inner: fakeInner(['read']),
      workspace,
      sdkPath: SIBLING_SDK,
    })

    const schemas = await service.list()
    expect(schemas.map((schema) => schema.name)).toEqual(['read', installed.name])
    expect(schemas[1]).toEqual({
      name: installed.name,
      description: manifest.description,
      parameters: manifest.parameters,
    })

    expect(await service.call(installed.name, { text: 'from a run' })).toEqual({
      path: 'note.txt',
      bytes: 'from a run'.length,
    })
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('from a run')
  }, 60_000)

  test('a bundle edited after the install is skipped by list() and refused by call()', async () => {
    const { workspace, installed } = await install(WRITE_NOTE)
    await writeFile(join(installed.path, 'dist', 'index.js'), 'export const tool = {}\n', 'utf8')
    const log = recorder()
    const service = createInstalledToolService({
      inner: fakeInner(['read']),
      workspace,
      sdkPath: SIBLING_SDK,
      log: log.log,
    })

    expect((await service.list()).map((schema) => schema.name)).toEqual(['read'])
    const warning = log.lines.find((line) => line.level === 'warn')
    expect(warning?.message).toContain(installed.name)
    expect(warning?.message).toContain('sha_mismatch')

    const error = await service.call(installed.name, {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(InstalledToolError)
    expect((error as Error).message).toContain(`${installed.name} failed: sha_mismatch`)
  }, 60_000)

  test('a write outside the workspace is refused and leaves no file behind', async () => {
    const { workspace, installed } = await install(ESCAPE)
    const service = createInstalledToolService({
      inner: fakeInner([]),
      workspace,
      sdkPath: SIBLING_SDK,
    })
    const outside = join(workspace, '..', 'escaped.txt')
    expect(existsSync(outside)).toBe(false)

    const error = await service.call(installed.name, {}).catch((caught: unknown) => caught)

    expect((error as InstalledToolError).code).toBe('path_outside_workspace')
    expect((error as Error).message).toContain('path_outside_workspace')
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(join(workspace, '..', '..', 'escaped.txt'))).toBe(false)
  }, 60_000)
})

describe.skipIf(!HAS_SIBLING)('the host policy', () => {
  test('net: false turns the network off whatever the manifest grants', async () => {
    const { workspace, installed } = await install(FETCH)
    const service = createInstalledToolService({
      inner: fakeInner([]),
      workspace,
      sdkPath: SIBLING_SDK,
      net: false,
    })

    const error = await service.call(installed.name, {}).catch((caught: unknown) => caught)

    expect((error as InstalledToolError).code).toBe('net_disabled')
    expect((error as Error).message).toContain('net_disabled')
  }, 60_000)

  test('a net ceiling can only lower what the manifest declares', async () => {
    const { workspace, installed } = await install(FETCH)
    const service = createInstalledToolService({
      inner: fakeInner([]),
      workspace,
      sdkPath: SIBLING_SDK,
      net: { hosts: ['other.test'] },
    })

    const error = await service.call(installed.name, {}).catch((caught: unknown) => caught)

    expect((error as InstalledToolError).code).toBe('net_denied')
    expect((error as Error).message).toContain('"127.0.0.1"')
  }, 60_000)

  test('env: false leaves a declared name absent and the tool throws its own error', async () => {
    const { workspace, installed } = await install(READS_ENV)
    const service = createInstalledToolService({
      inner: fakeInner([]),
      workspace,
      sdkPath: SIBLING_SDK,
      env: false,
    })

    const error = await service.call(installed.name, {}).catch((caught: unknown) => caught)

    expect((error as InstalledToolError).code).toBe('tool_threw')
    expect((error as Error).message).toContain('Z1_TEST_TOKEN is required')
  }, 60_000)

  test('env.read supplies a value, and the default inherits a declared name', async () => {
    const { workspace, installed } = await install(READS_ENV)

    const supplied = createInstalledToolService({
      inner: fakeInner([]),
      workspace,
      sdkPath: SIBLING_SDK,
      env: { read: { Z1_TEST_TOKEN: 'from-read' } },
    })
    expect(await supplied.call(installed.name, {})).toEqual({ token: 'from-read' })

    // The default is `{ inherit: true }`: only the declared name resolves, and
    // it resolves from the host environment as the runtime snapshot finds it.
    vi.stubEnv('Z1_TEST_TOKEN', 'from-host')
    const inherited = createInstalledToolService({
      inner: fakeInner([]),
      workspace,
      sdkPath: SIBLING_SDK,
    })
    expect(await inherited.call(installed.name, {})).toEqual({ token: 'from-host' })
  }, 60_000)
})

describe.skipIf(!HAS_SIBLING)('the tool result', () => {
  test('is the tool plain JSON, not the sandbox envelope', async () => {
    const { workspace, installed } = await install(WRITE_NOTE)
    const service = createInstalledToolService({
      inner: fakeInner([]),
      workspace,
      sdkPath: SIBLING_SDK,
    })

    const result = asRecord(await service.call(installed.name, {}))

    // `durationMs`, `audit`, `tool` and `version` belong to z2q's `run` result
    // and must not reach the model as part of a tool's answer.
    expect(Object.keys(result).sort()).toEqual(['bytes', 'path'])
  }, 60_000)
})
