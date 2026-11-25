import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import {
  TOOL_SDK_ENV,
  ToolCreatorError,
  ToolCreatorUnavailableError,
  createZ2qPort,
  loadToolCreatorPort,
} from '../src/index.ts'

/**
 * The sibling checkout, when this machine has it.
 *
 * The suite must pass without it: z2q is not published on npm, and a person who
 * only has this repository cannot be expected to own a second one.
 */
const SIBLING_SDK =
  process.env['Z1_TOOL_SDK_PATH'] ?? 'C:/Users/oleksii/Documents/z1-projects/z1-tool-sdk'
const HAS_SIBLING = existsSync(join(SIBLING_SDK, 'dist', 'index.js'))

let scratch: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'z1-tool-creator-port-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Write `files` under a fresh directory and return it. */
async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(scratch, 'tree-'))
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, text, 'utf8')
  }
  return root
}

describe('a missing sdk', () => {
  test('a path that does not exist names the variable and the checkout', async () => {
    const error = await loadToolCreatorPort({ path: join(scratch, 'absent') }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ToolCreatorUnavailableError)
    expect((error as ToolCreatorError).code).toBe('tool_creator_unavailable')
    expect((error as Error).message).toContain(TOOL_SDK_ENV)
    expect((error as Error).message).toContain('not published on npm')
  })

  test('the variable is read when no path is passed', async () => {
    vi.stubEnv(TOOL_SDK_ENV, join(scratch, 'also-absent'))

    const error = await loadToolCreatorPort().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ToolCreatorUnavailableError)
    expect((error as Error).message).toContain(join(scratch, 'also-absent'))
  })

  test('a file that is not JavaScript is reported as an import failure', async () => {
    const root = await writeTree({ 'index.js': 'this is not javascript {{{' })

    const error = await loadToolCreatorPort({ path: join(root, 'index.js') }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ToolCreatorUnavailableError)
    expect((error as Error).message).toContain('cannot import')
    expect((error as Error).message).toContain(TOOL_SDK_ENV)
  })

  test('a module without the creator export is not mistaken for the sdk', async () => {
    const root = await writeTree({ 'index.js': 'export const somethingElse = 1' })

    const error = await loadToolCreatorPort({ path: root }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ToolCreatorUnavailableError)
    expect((error as Error).message).toContain('"createToolCreator"')
  })

  test('a module that is not even an object is refused', () => {
    expect(() => createZ2qPort(undefined, { workspace: scratch })).toThrow(
      ToolCreatorUnavailableError,
    )
  })
})

describe('createZ2qPort', () => {
  interface Recorded {
    creator: { workspace: string; generate?: unknown; toolsDir?: string }
    request: { name: string; purpose: string; examples?: { input: unknown }[] }
  }

  /** A hand-written stand-in: only the exports the port reads. */
  function sdkModule(recorded: Recorded[], installs: Record<string, unknown>[] = []): unknown {
    return {
      createToolCreator: (creator: Recorded['creator']) => ({
        async propose(request: Recorded['request']) {
          recorded.push({ creator, request })
          return {
            projectDir: '/work/.z2q/proposals/tool.find-todos-1-1',
            sha256: 'a'.repeat(64),
            attempts: 1,
            manifest: { name: request.name, version: '0.2.0' },
            summary: { lines: ['Writes workspace files matching "**/*.md".'], risk: 'writes' },
            history: [{ attempt: 1, issues: ['tool.ts:3 invalid_source'] }],
            smoke: {
              ok: true,
              runs: [
                { ok: true, denied: 0 },
                { ok: true, denied: 1, code: 'denied' },
              ],
            },
          }
        },
      }),
      async installTool(options: Record<string, unknown>) {
        installs.push(options)
        return { path: '/tools/tool.find-todos/0.2.0', name: 'tool.find-todos', version: '0.2.0' }
      },
    }
  }

  test('propose forwards the request and narrows the proposal to JSON', async () => {
    const recorded: Recorded[] = []
    const port = createZ2qPort(sdkModule(recorded), {
      workspace: '/work',
      generate: async () => 'source',
    })

    const summary = await port.propose(
      { name: 'tool.find-todos', purpose: 'Find TODOs.', examples: [{ glob: 'src/**' }] },
      { workspace: '/run' },
    )

    expect(recorded).toEqual([
      {
        creator: {
          workspace: resolve('/run'),
          generate: expect.any(Function),
          toolsDir: join(resolve('/work'), '.z2q', 'tools'),
        },
        request: {
          name: 'tool.find-todos',
          purpose: 'Find TODOs.',
          examples: [{ input: { glob: 'src/**' } }],
        },
      },
    ])
    expect(summary).toEqual({
      name: 'tool.find-todos',
      version: '0.2.0',
      sha256: 'a'.repeat(64),
      projectDir: '/work/.z2q/proposals/tool.find-todos-1-1',
      attempts: 1,
      history: [['tool.ts:3 invalid_source']],
      smoke: {
        ok: true,
        runs: [
          { ok: true, denied: 0 },
          { ok: true, denied: 1, code: 'denied' },
        ],
      },
      capabilities: { lines: ['Writes workspace files matching "**/*.md".'], risk: 'writes' },
      next: 'run `z1 tool install /work/.z2q/proposals/tool.find-todos-1-1` to install it',
    })
  })

  test('propose without a model call explains what the host is missing', async () => {
    const recorded: Recorded[] = []
    const port = createZ2qPort(sdkModule(recorded), { workspace: '/work' })

    const error = await port
      .propose({ name: 'tool.find-todos', purpose: 'Find TODOs.' }, { workspace: '/run' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ToolCreatorError)
    expect((error as ToolCreatorError).code).toBe('model_unavailable')
    expect((error as Error).message).toContain('generate')
    expect(recorded).toEqual([])
  })

  test('install hashes the bundle and installs under the workspace', async () => {
    const dir = await writeTree({ 'dist/index.js': 'bundle' })
    const installs: Record<string, unknown>[] = []
    const port = createZ2qPort(sdkModule([], installs), { workspace: scratch })

    const installed = await port.install(dir, { approvedBy: 'oleksii' })

    expect(installs).toEqual([
      {
        toolsDir: join(scratch, '.z2q', 'tools'),
        dir,
        approvedBy: 'oleksii',
        expectSha256: createHash('sha256').update('bundle').digest('hex'),
      },
    ])
    expect(installed).toEqual({
      path: '/tools/tool.find-todos/0.2.0',
      name: 'tool.find-todos',
      version: '0.2.0',
    })
  })

  test('install refuses a proposal with no bundle', async () => {
    const installs: Record<string, unknown>[] = []
    const port = createZ2qPort(sdkModule([], installs), { workspace: scratch })

    const error = await port.install(join(scratch, 'nowhere'), {}).catch((caught: unknown) => caught)

    expect((error as ToolCreatorError).code).toBe('install_failed')
    expect((error as Error).message).toContain(join('dist', 'index.js'))
    expect(installs).toEqual([])
  })
})

describe.skipIf(!HAS_SIBLING)('the sibling z2q checkout', () => {
  test('loads from the checkout root', async () => {
    const port = await loadToolCreatorPort({ workspace: scratch, path: SIBLING_SDK })

    expect(typeof port.propose).toBe('function')
    expect(typeof port.install).toBe('function')
  })

  test('loads from the dist directory and from the entry file', async () => {
    const fromDist = await loadToolCreatorPort({ path: join(SIBLING_SDK, 'dist') })
    const fromFile = await loadToolCreatorPort({ path: join(SIBLING_SDK, 'dist', 'index.js') })

    expect(typeof fromDist.propose).toBe('function')
    expect(typeof fromFile.propose).toBe('function')
  })

  test('loads through Z1_TOOL_SDK_PATH and refuses to propose without a model call', async () => {
    vi.stubEnv(TOOL_SDK_ENV, SIBLING_SDK)
    const port = await loadToolCreatorPort({ workspace: scratch })

    const error = await port
      .propose({ name: 'tool.find-todos', purpose: 'Find TODOs.' }, { workspace: scratch })
      .catch((caught: unknown) => caught)

    expect((error as ToolCreatorError).code).toBe('model_unavailable')
  })
})
