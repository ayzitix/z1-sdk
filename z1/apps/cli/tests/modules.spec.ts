import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { AuditEntry } from '@z1/module'
import { runCli, type CliIO } from '../src/cli.ts'

const ECHO_SOURCE = fileURLToPath(new URL('../../../examples/modules/echo', import.meta.url))

const ECHO_NODE = 'com.example.echo.echo'
const DENY_NODE = 'com.example.deny.reader'

interface Captured {
  readonly io: CliIO
  stdout(): string
  stderr(): string
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      isTTY: false,
      env: {},
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

interface Result {
  code: number
  out: string
  err: string
}

let modulesDir = ''
let directory = ''
let dbPath = ''
let echoGraph = ''
let denyGraph = ''

async function run(argv: readonly string[]): Promise<Result> {
  const io = capture()
  const code = await runCli(argv, io.io)
  return { code, out: io.stdout(), err: io.stderr() }
}

function moduleArgs(argv: readonly string[]): string[] {
  return [...argv, '--modules-dir', modulesDir]
}

function graphDocument(id: string, nodes: unknown[], edges: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, id, title: id, nodes, edges })
}

function traceEvents(stderr: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>)
      }
    } catch {
      // Non-JSON trace lines (module stderr) are irrelevant here.
    }
  }
  return events
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'z1-cli-modules-'))
  modulesDir = join(directory, 'store')
  dbPath = join(directory, 'runs.db')

  echoGraph = join(directory, 'echo.graph.json')
  await writeFile(
    echoGraph,
    graphDocument(
      'echo-graph',
      [
        {
          id: 'constant',
          type: 'z1.core.const',
          version: '1.0.0',
          config: { value: 'hello' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'echo',
          type: ECHO_NODE,
          version: '1.0.0',
          config: {},
          position: { x: 200, y: 0 },
        },
        {
          id: 'result',
          type: 'z1.core.output',
          version: '1.0.0',
          config: {},
          position: { x: 400, y: 0 },
        },
      ],
      [
        {
          id: 'e-const-text',
          kind: 'data',
          from: { node: 'constant', port: 'value' },
          to: { node: 'echo', port: 'text' },
        },
        {
          id: 'e-echo-value',
          kind: 'data',
          from: { node: 'echo', port: 'text' },
          to: { node: 'result', port: 'value' },
        },
        {
          id: 'f-echo-out',
          kind: 'flow',
          from: { node: 'echo', port: 'out' },
          to: { node: 'result', port: 'in' },
        },
      ],
    ),
    'utf8',
  )

  denyGraph = join(directory, 'deny.graph.json')
  await writeFile(
    denyGraph,
    graphDocument(
      'deny-graph',
      [
        {
          id: 'deny',
          type: DENY_NODE,
          version: '1.0.0',
          config: {},
          position: { x: 0, y: 0 },
        },
      ],
      [],
    ),
    'utf8',
  )
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('z1 module', () => {
  test('propose prints id and version and copies the example', async () => {
    const { code, out } = await run(moduleArgs(['module', 'propose', ECHO_SOURCE]))

    expect(code).toBe(0)
    expect(out).toContain('proposed com.example.echo@1.0.0')
    expect(out).toContain(ECHO_NODE)
    expect(out).toContain('next: z1 module approve com.example.echo@1.0.0')
  })

  test('approve activates the module and list --json reports it', async () => {
    const approved = await run(moduleArgs(['module', 'approve', 'com.example.echo']))
    expect(approved.code).toBe(0)
    expect(approved.out).toContain('approved com.example.echo@1.0.0')

    const listed = await run(moduleArgs(['module', 'list', '--json']))
    expect(listed.code).toBe(0)
    const modules: unknown = JSON.parse(listed.out.trimEnd())
    expect(modules).toEqual([
      expect.objectContaining({
        id: 'com.example.echo',
        version: '1.0.0',
        active: true,
        integrity: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ])
  })

  test('run executes the module node in a worker and the trace shows it', async () => {
    const { code, out, err } = await run([
      'run',
      echoGraph,
      '--json',
      '--trace',
      '--db',
      dbPath,
      '--modules-dir',
      modulesDir,
    ])

    expect(code).toBe(0)
    const result: unknown = JSON.parse(out.trimEnd())
    expect(result).toMatchObject({ status: 'completed', outputs: { output: 'hello!' } })

    const events = traceEvents(err)
    expect(
      events.some(
        (event) => event['type'] === 'node.completed' && event['nodeId'] === 'echo',
      ),
    ).toBe(true)
  })

  test('module approvals follow --module-approve, never --approve', async () => {
    const nodeId = 'com.example.approval.ask'
    const source = join(directory, 'approval-module')
    await mkdir(source, { recursive: true })
    await writeFile(
      join(source, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'com.example.approval',
        version: '1.0.0',
        title: 'Approval probe',
        license: 'MIT',
        engines: { z1: '>=0.1.0' },
        entry: 'index.js',
        nodes: [
          {
            id: nodeId,
            version: '1.0.0',
            title: 'Approval probe',
            category: 'example',
            inputs: [],
            outputs: [{ kind: 'data', id: 'text', schema: { type: 'string' } }],
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(source, 'index.js'),
      [
        'export const nodes = [',
        '  {',
        `    id: '${nodeId}',`,
        "    version: '1.0.0',",
        "    title: 'Approval probe',",
        "    category: 'example',",
        '    inputs: [],',
        "    outputs: [{ kind: 'data', id: 'text', schema: { type: 'string' } }],",
        '    async execute(ctx) {',
        "      const decision = await ctx.approval.request({ action: 'tool.call', target: 'demo' })",
        "      if (decision !== 'allowed-once') throw new Error(`module approval ${decision}`)",
        "      return { text: 'approved' }",
        '    },',
        '  },',
        ']',
        '',
      ].join('\n'),
      'utf8',
    )

    const approvalGraph = join(directory, 'approval.graph.json')
    await writeFile(
      approvalGraph,
      graphDocument(
        'approval-graph',
        [
          {
            id: 'ask',
            type: nodeId,
            version: '1.0.0',
            config: {},
            position: { x: 0, y: 0 },
          },
        ],
        [],
      ),
      'utf8',
    )

    expect((await run(moduleArgs(['module', 'propose', source]))).code).toBe(0)
    expect((await run(moduleArgs(['module', 'approve', 'com.example.approval']))).code).toBe(0)

    const runArgs = [
      'run',
      approvalGraph,
      '--json',
      '--db',
      dbPath,
      '--modules-dir',
      modulesDir,
    ]

    // Default `ask` has no terminal in tests: reject instead of blocking.
    const asked = await run(runArgs)
    expect(asked.code).toBe(1)
    expect(asked.err).toContain('not a terminal')

    // Node autonomy is a different policy and must not leak into module code.
    const approveAutoOnly = await run([...runArgs, '--approve', 'auto'])
    expect(approveAutoOnly.code).toBe(1)
    expect(approveAutoOnly.err).toContain('not a terminal')

    const auto = await run([...runArgs, '--module-approve', 'auto'])
    expect(auto.err).toBe('')
    expect(auto.code).toBe(0)
    expect(JSON.parse(auto.out.trimEnd())).toMatchObject({ status: 'completed' })

    const denied = await run([...runArgs, '--module-approve', 'deny'])
    expect(denied.code).toBe(1)
    expect(denied.err).toMatch(/module approval rejected/)

    const invalid = await run([...runArgs, '--module-approve', 'maybe'])
    expect(invalid.code).toBe(2)
    expect(invalid.err).toContain('invalid --module-approve')
  })

  test('audit --json records propose, approve and install', async () => {
    const { code, out } = await run(moduleArgs(['module', 'audit', '--json']))

    expect(code).toBe(0)
    const entries = JSON.parse(out.trimEnd()) as AuditEntry[]
    const types = new Set(entries.map((entry) => entry.type))
    expect(types.has('propose')).toBe(true)
    expect(types.has('approve')).toBe(true)
    expect(types.has('install')).toBe(true)
  })

  test('an undeclared fs read fails the run and lands in the audit as deny', async () => {
    const denyDirectory = join(directory, 'deny-module')
    await cp(ECHO_SOURCE, denyDirectory, { recursive: true })
    await writeFile(
      join(denyDirectory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'com.example.deny',
        version: '1.0.0',
        title: 'Denial probe',
        license: 'MIT',
        engines: { z1: '>=0.1.0' },
        entry: 'index.js',
        nodes: [
          {
            id: DENY_NODE,
            version: '1.0.0',
            title: 'Reader',
            category: 'example',
            inputs: [],
            outputs: [{ kind: 'data', id: 'text', schema: { type: 'string' } }],
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(denyDirectory, 'index.js'),
      [
        'export const nodes = [',
        '  {',
        `    id: '${DENY_NODE}',`,
        "    version: '1.0.0',",
        "    title: 'Reader',",
        "    category: 'example',",
        '    inputs: [],',
        "    outputs: [{ kind: 'data', id: 'text', schema: { type: 'string' } }],",
        '    async execute(ctx) {',
        "      const text = await ctx.fs.read('/etc/passwd')",
        '      return { text }',
        '    },',
        '  },',
        ']',
        '',
      ].join('\n'),
      'utf8',
    )

    expect((await run(moduleArgs(['module', 'propose', denyDirectory]))).code).toBe(0)
    expect((await run(moduleArgs(['module', 'approve', 'com.example.deny']))).code).toBe(0)

    const failed = await run([
      'run',
      denyGraph,
      '--json',
      '--db',
      dbPath,
      '--modules-dir',
      modulesDir,
    ])
    expect(failed.code).toBe(1)
    expect(failed.err).toMatch(/capability denied for fs\.read/)
    const result: unknown = JSON.parse(failed.out.trimEnd())
    expect(result).toMatchObject({ status: 'failed' })

    const audited = await run(moduleArgs(['module', 'audit', '--json']))
    const entries = JSON.parse(audited.out.trimEnd()) as AuditEntry[]
    expect(
      entries.some(
        (entry) => entry.type === 'deny' && entry.moduleId === 'com.example.deny',
      ),
    ).toBe(true)
  })

  test('rollback with a single version fails with a clear message', async () => {
    const { code, err } = await run(moduleArgs(['module', 'rollback', 'com.example.echo']))

    expect(code).toBe(1)
    expect(err).toContain('no earlier version of "com.example.echo"')
  })

  test('rollback after installing 1.1.0 reactivates 1.0.0', async () => {
    const source = join(directory, 'echo-1.1.0')
    await cp(ECHO_SOURCE, source, { recursive: true })
    const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as {
      version: string
      nodes: { version: string }[]
    }
    manifest.version = '1.1.0'
    for (const node of manifest.nodes) node.version = '1.1.0'
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    expect((await run(moduleArgs(['module', 'propose', source]))).code).toBe(0)
    expect((await run(moduleArgs(['module', 'approve', 'com.example.echo@1.1.0']))).code).toBe(0)

    const active110 = JSON.parse(
      (await run(moduleArgs(['module', 'list', '--json']))).out.trimEnd(),
    ) as { id: string; version: string; active: boolean }[]
    expect(
      active110.find((module) => module.id === 'com.example.echo' && module.active)?.version,
    ).toBe('1.1.0')

    const rolledBack = await run(moduleArgs(['module', 'rollback', 'com.example.echo']))
    expect(rolledBack.code).toBe(0)
    expect(rolledBack.out).toContain('rolled back com.example.echo to 1.0.0')

    const active100 = JSON.parse(
      (await run(moduleArgs(['module', 'list', '--json']))).out.trimEnd(),
    ) as { id: string; version: string; active: boolean }[]
    expect(
      active100.find((module) => module.id === 'com.example.echo' && module.active)?.version,
    ).toBe('1.0.0')
  })

  test('--no-modules rejects a module node with exit 2 and an unknown-node-type issue', async () => {
    const { code, err } = await run([
      'run',
      echoGraph,
      '--json',
      '--db',
      dbPath,
      '--modules-dir',
      modulesDir,
      '--no-modules',
    ])

    expect(code).toBe(2)
    expect(err).toContain('unknown-node-type')
    expect(err).toContain(ECHO_NODE)
  })
})
