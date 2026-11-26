import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import type { Json } from '@z1/node'

import {
  TOOL_CREATE_NAME,
  ToolCreatorError,
  ToolCreatorUnavailableError,
  createToolCreatorService,
  toolCreateSchema,
} from '../src/index.ts'
import { asRecord, fakeInner, fakePort, foreignError, proposal } from './fakes.ts'

const WORKSPACE = '/work'
const PROPOSALS = `${WORKSPACE}/.z2q/proposals/tool.find-todos-1-1700000000000`

let scratch: string

beforeAll(async () => {
  // An empty directory that certainly has no z2q checkout inside it, so the
  // "sdk is absent" tests do not depend on what this machine has installed.
  scratch = await mkdtemp(join(tmpdir(), 'z1-tool-creator-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createToolCreatorService', () => {
  test('list() appends tool.create and keeps the inner order', async () => {
    const service = createToolCreatorService({
      inner: fakeInner(['read', 'grep', 'shell']),
      workspace: WORKSPACE,
    })

    const schemas = await service.list()

    expect(schemas.map((schema) => schema.name)).toEqual(['read', 'grep', 'shell', TOOL_CREATE_NAME])
    expect(schemas[3]).toEqual(toolCreateSchema)
  })

  test('call("tool.create") returns the proposal and hands the port the exact request', async () => {
    const port = fakePort({
      summary: proposal({
        history: [['tool.ts:3 invalid_source'], ['tool.ts:9 invalid_source']],
        smoke: {
          ok: true,
          runs: [
            { ok: true, denied: 0 },
            { ok: true, denied: 2, code: 'denied' },
          ],
        },
      }),
    })
    const service = createToolCreatorService({ inner: fakeInner(['read']), workspace: WORKSPACE, port })

    const result = asRecord(
      await service.call(TOOL_CREATE_NAME, {
        name: 'tool.find-todos',
        purpose: 'Find TODO comments in the workspace.',
        examples: [{ glob: 'src/**/*.ts' }],
      }),
    )

    expect(port.proposals).toEqual([
      {
        request: {
          name: 'tool.find-todos',
          purpose: 'Find TODO comments in the workspace.',
          examples: [{ glob: 'src/**/*.ts' }],
        },
        options: { workspace: WORKSPACE },
      },
    ])
    expect(result).toEqual({
      name: 'tool.find-todos',
      version: '0.1.0',
      sha256: 'a'.repeat(64),
      projectDir: PROPOSALS,
      attempts: 1,
      history: [['tool.ts:3 invalid_source'], ['tool.ts:9 invalid_source']],
      smoke: {
        ok: true,
        runs: [
          { ok: true, denied: 0 },
          { ok: true, denied: 2, code: 'denied' },
        ],
      },
      capabilities: { lines: ['Reads workspace files matching "**/*".'], risk: 'read-only' },
      next: `run \`z1 tool install ${PROPOSALS}\` to install it`,
    })
    // The whole point of the tool: it proposes, a person installs.
    expect(port.installs).toEqual([])
  })

  test('a promised port is awaited like an injected one', async () => {
    const port = fakePort()
    const service = createToolCreatorService({
      inner: fakeInner([]),
      workspace: WORKSPACE,
      port: Promise.resolve(port),
    })

    const result = asRecord(
      await service.call(TOOL_CREATE_NAME, { name: 'tool.find-todos', purpose: 'Find TODOs.' }),
    )

    expect(result['projectDir']).toBe(PROPOSALS)
    expect(port.proposals).toHaveLength(1)
  })

  test('a service with no port reports how to enable the creator', async () => {
    vi.stubEnv('Z1_TOOL_SDK_PATH', join(scratch, 'absent-checkout'))
    const inner = fakeInner(['read'])
    const service = createToolCreatorService({ inner, workspace: WORKSPACE })

    const error = await service
      .call(TOOL_CREATE_NAME, { name: 'tool.find-todos', purpose: 'Find TODOs.' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ToolCreatorUnavailableError)
    expect(error).toBeInstanceOf(ToolCreatorError)
    expect((error as ToolCreatorError).code).toBe('tool_creator_unavailable')
    expect((error as Error).message).toContain('Z1_TOOL_SDK_PATH')
    expect((error as Error).message).toContain('not published on npm')
    expect(inner.calls).toEqual([])
  })

  const refusals: [string, Json][] = [
    ['no fields', {}],
    ['a blank purpose', { name: 'tool.find-todos', purpose: '   ' }],
    ['a name without the prefix', { name: 'nope', purpose: 'Find TODOs.' }],
    ['a path-like name', { name: 'tool../escape', purpose: 'Find TODOs.' }],
    ['non-array examples', { name: 'tool.find-todos', purpose: 'Find TODOs.', examples: 'src' }],
  ]

  test.each(refusals)('a call with %s is refused before the port is touched', async (_label, args) => {
    const port = fakePort()
    const service = createToolCreatorService({ inner: fakeInner([]), workspace: WORKSPACE, port })

    const error = await service
      .call(TOOL_CREATE_NAME, args)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ToolCreatorError)
    expect((error as ToolCreatorError).code).toBe('invalid_request')
    expect((error as Error).message.startsWith('invalid_request: ')).toBe(true)
    expect(port.proposals).toEqual([])
  })

  test('a review failure surfaces with its code and issues, not a stack', async () => {
    const issues = [
      { code: 'invalid_source', message: 'tool.ts:3 a dynamic import is not allowed' },
    ]
    const port = fakePort({
      error: foreignError(
        'review_failed',
        'the model did not produce a source that passes review after 2 attempt(s): tool.ts:3 a dynamic import is not allowed',
        issues,
      ),
    })
    const service = createToolCreatorService({ inner: fakeInner([]), workspace: WORKSPACE, port })

    const error = await service
      .call(TOOL_CREATE_NAME, { name: 'tool.find-todos', purpose: 'Find TODOs.' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ToolCreatorError)
    expect((error as ToolCreatorError).code).toBe('review_failed')
    expect((error as ToolCreatorError).issues).toEqual(issues)
    expect((error as Error).message.startsWith('review_failed: ')).toBe(true)
    expect((error as Error).message).not.toContain('\n')
    expect((error as Error).message).not.toContain('    at ')
  })

  test('an uncoded failure keeps its message and gets a code', async () => {
    const port = fakePort({ error: new Error('the disk filled up') })
    const service = createToolCreatorService({ inner: fakeInner([]), workspace: WORKSPACE, port })

    const error = await service
      .call(TOOL_CREATE_NAME, { name: 'tool.find-todos', purpose: 'Find TODOs.' })
      .catch((caught: unknown) => caught)

    expect((error as ToolCreatorError).code).toBe('tool_creator_failed')
    expect((error as Error).message).toBe('tool_creator_failed: the disk filled up')
  })

  test('a call for any other tool reaches the inner service unchanged', async () => {
    const port = fakePort()
    const inner = fakeInner(['read'])
    const service = createToolCreatorService({ inner, workspace: WORKSPACE, port })

    const result = await service.call('read', { path: 'README.md' })

    expect(result).toEqual({ tool: 'read', args: { path: 'README.md' } })
    expect(inner.calls).toEqual([{ name: 'read', args: { path: 'README.md' } }])
    expect(port.proposals).toEqual([])
  })

  test('an inner failure reaches the caller as the same error', async () => {
    const failure = new Error('permission denied')
    const port = fakePort()
    const service = createToolCreatorService({
      inner: fakeInner(['read'], { error: failure }),
      workspace: WORKSPACE,
      port,
    })

    await expect(service.call('read', { path: '/etc/shadow' })).rejects.toBe(failure)
    expect(port.proposals).toEqual([])
  })

  test('a wrapped service that already has tool.create is named in a warning', async () => {
    const lines: string[] = []
    const service = createToolCreatorService({
      inner: fakeInner(['read', TOOL_CREATE_NAME]),
      workspace: WORKSPACE,
      log: (level, message) => lines.push(`${level} ${message}`),
    })

    await service.list()
    await service.list()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(TOOL_CREATE_NAME)
  })
})

describe('toolCreateSchema', () => {
  test('advertises exactly the three arguments parseRequest accepts', () => {
    expect(toolCreateSchema.name).toBe(TOOL_CREATE_NAME)
    expect(toolCreateSchema.description).toContain('nothing is installed')
    // The smoke test is real execution with the declared grants, and the model
    // is the one who tells the user what happened: the description has to say so.
    expect(toolCreateSchema.description).toContain('smoke test already ran the new tool')
    expect(toolCreateSchema.description).toContain('any declared host and environment variable')
    const properties = asRecord(toolCreateSchema.parameters['properties'] ?? null)
    expect(Object.keys(properties)).toEqual(['name', 'purpose', 'examples'])
    expect(asRecord(toolCreateSchema.parameters)['required']).toEqual(['name', 'purpose'])
  })
})
