import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteJournal, type RunRecord } from '@z1/journal'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runCli, type CliIO } from '../src/cli.ts'

const HELLO = fileURLToPath(new URL('../../../examples/hello.graph.json', import.meta.url))
const AGENT = fileURLToPath(new URL('../../../examples/agent.graph.json', import.meta.url))
const AGENT_LIVE = fileURLToPath(
  new URL('../../../examples/agent.live.graph.json', import.meta.url),
)

/** Set once per suite; every run gets `--db` so no test pollutes `.z1/runs.db`. */
let dbPath = ''

interface Captured {
  readonly io: CliIO
  stdout(): string
  stderr(): string
}

function capture(
  isTTY = false,
  env?: Record<string, string | undefined>,
): Captured {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      isTTY,
      ...(env === undefined ? {} : { env }),
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

async function run(
  argv: readonly string[],
  options: { isTTY?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; out: string; err: string }> {
  const args =
    argv[0] === 'run' && !argv.includes('--db') ? [...argv, '--db', dbPath] : [...argv]
  const io = capture(options.isTTY ?? false, options.env)
  const code = await runCli(args, io.io)
  return { code, out: io.stdout(), err: io.stderr() }
}

describe('z1 cli', () => {
  let dbDirectory = ''

  beforeAll(async () => {
    dbDirectory = await mkdtemp(join(tmpdir(), 'z1-cli-db-'))
    dbPath = join(dbDirectory, 'runs.db')
  })

  afterAll(async () => {
    await rm(dbDirectory, { recursive: true, force: true })
  })
  test('list prints every built-in node', async () => {
    const { code, out } = await run(['list'])

    expect(code).toBe(0)
    const lines = out.trimEnd().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(11)
    expect(lines.some((line) => /^z1\.llm\.chat\s+1\.0\.0\s+llm\s+Chat/.test(line))).toBe(true)
    expect(lines.some((line) => /^z1\.tool\.call\s+1\.0\.0\s+tool\s+Call tool/.test(line))).toBe(
      true,
    )
  })

  test('validate accepts the hello example', async () => {
    const { code, out, err } = await run(['validate', HELLO])

    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toMatch(/^ok: 3 nodes, 3 edges\s*$/)
  })

  describe('invalid graph', () => {
    let directory = ''
    let invalid = ''

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'z1-cli-'))
      invalid = join(directory, 'invalid.graph.json')
      await writeFile(
        invalid,
        JSON.stringify({
          schemaVersion: 1,
          id: 'invalid',
          nodes: [
            { id: 'a', type: 'z1.core.input', version: '1.0.0', config: {}, position: { x: 0, y: 0 } },
          ],
          edges: [
            {
              id: 'e1',
              kind: 'data',
              from: { node: 'a', port: 'value' },
              to: { node: 'missing', port: 'value' },
            },
          ],
        }),
        'utf8',
      )
    })

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true })
    })

    test('validate reports the issue code and exits 2', async () => {
      const { code, err } = await run(['validate', invalid])

      expect(code).toBe(2)
      expect(err).toContain('dangling-edge')
    })
  })

  test('run hello prints a JSON result', async () => {
    const { code, out } = await run(['run', HELLO, '--input', '{"name":"world"}', '--json'])

    expect(code).toBe(0)
    const result: unknown = JSON.parse(out.trimEnd())
    expect(result).toMatchObject({ status: 'completed', outputs: { output: 'hello world' } })
  })

  test('run agent completes the model -> tool -> model spine', async () => {
    const { code, out, err } = await run([
      'run',
      AGENT,
      '--input',
      '"[[tool:echo]] hello"',
      '--json',
    ])

    expect(err).toBe('')
    expect(code).toBe(0)
    const result: unknown = JSON.parse(out.trimEnd())
    expect(result).toMatchObject({ status: 'completed', outputs: { output: 'mock: done' } })
  })

  test('--input and --input-file together are a usage error', async () => {
    const { code, err } = await run([
      'run',
      HELLO,
      '--input',
      '{"name":"a"}',
      '--input-file',
      join(tmpdir(), 'z1-input.json'),
    ])

    expect(code).toBe(2)
    expect(err).toContain('mutually exclusive')
  })

  describe('--message', () => {
    let directory = ''
    let passthrough = ''

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'z1-message-'))
      passthrough = join(directory, 'passthrough.graph.json')
      await writeFile(
        passthrough,
        JSON.stringify({
          schemaVersion: 1,
          id: 'passthrough',
          nodes: [
            {
              id: 'in1',
              type: 'z1.core.input',
              version: '1.0.0',
              config: {},
              position: { x: 0, y: 0 },
            },
            {
              id: 'out1',
              type: 'z1.core.output',
              version: '1.0.0',
              config: {},
              position: { x: 200, y: 0 },
            },
          ],
          edges: [
            {
              id: 'd1',
              kind: 'data',
              from: { node: 'in1', port: 'value' },
              to: { node: 'out1', port: 'value' },
            },
            {
              id: 'f1',
              kind: 'flow',
              from: { node: 'in1', port: 'out' },
              to: { node: 'out1', port: 'in' },
            },
          ],
        }),
        'utf8',
      )
    })

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true })
    })

    test('passes the text through as a string, not JSON', async () => {
      const { code, out, err } = await run([
        'run',
        passthrough,
        '--message',
        'hello there',
        '--json',
      ])

      expect(err).toBe('')
      expect(code).toBe(0)
      expect(JSON.parse(out.trimEnd())).toMatchObject({
        status: 'completed',
        outputs: { output: 'hello there' },
      })
    })

    test('does not parse JSON-looking text', async () => {
      const { code, out } = await run([
        'run',
        passthrough,
        '--message',
        '{"name":"a"}',
        '--json',
      ])

      expect(code).toBe(0)
      expect(JSON.parse(out.trimEnd())).toMatchObject({
        outputs: { output: '{"name":"a"}' },
      })
    })

    test('keeps multi-line text intact', async () => {
      const { code, out } = await run([
        'run',
        passthrough,
        '--message',
        'line one\nline two',
        '--json',
      ])

      expect(code).toBe(0)
      expect(JSON.parse(out.trimEnd())).toMatchObject({
        outputs: { output: 'line one\nline two' },
      })
    })

    test('--message with --input is a usage error', async () => {
      const { code, err } = await run([
        'run',
        passthrough,
        '--message',
        'hello',
        '--input',
        '{"name":"a"}',
      ])

      expect(code).toBe(2)
      expect(err).toContain('mutually exclusive')
    })
  })

  test('an unknown --approve value is a usage error', async () => {
    const { code, err } = await run(['run', HELLO, '--approve', 'maybe'])

    expect(code).toBe(2)
    expect(err).toContain('invalid --approve')
  })

  describe('approvals', () => {
    let directory = ''
    let asking = ''

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'z1-approval-'))
      asking = join(directory, 'ask.graph.json')
      await writeFile(
        asking,
        JSON.stringify({
          schemaVersion: 1,
          id: 'ask',
          nodes: [
            {
              id: 'in1',
              type: 'z1.core.input',
              version: '1.0.0',
              config: {},
              autonomy: { mode: 'ask' },
              position: { x: 0, y: 0 },
            },
            {
              id: 'out1',
              type: 'z1.core.output',
              version: '1.0.0',
              config: {},
              position: { x: 200, y: 0 },
            },
          ],
          edges: [
            {
              id: 'd1',
              kind: 'data',
              from: { node: 'in1', port: 'value' },
              to: { node: 'out1', port: 'value' },
            },
            {
              id: 'f1',
              kind: 'flow',
              from: { node: 'in1', port: 'out' },
              to: { node: 'out1', port: 'in' },
            },
          ],
        }),
        'utf8',
      )
    })

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true })
    })

    test('--approve deny fails the run on an ask-mode node', async () => {
      const { code, err } = await run(['run', asking, '--input', 'null', '--approve', 'deny'])

      expect(code).toBe(1)
      expect(err).toMatch(/rejected/i)
    })

    test('--approve ask without a terminal rejects instead of blocking', async () => {
      const { code, err } = await run(['run', asking, '--input', 'null', '--approve', 'ask'])

      expect(code).toBe(1)
      expect(err).toContain('not a terminal')
    })

    test('--suspend exits 4 and --resume completes the run', async () => {
      const suspended = await run(['run', asking, '--input', 'null', '--json', '--suspend'])

      expect(suspended.code).toBe(4)
      const payload = JSON.parse(suspended.out.trimEnd()) as {
        runId: string
        status: string
        pendingApproval?: { path: string }
      }
      expect(payload.status).toBe('suspended')
      expect(payload.pendingApproval?.path).toBe('in1')
      expect(suspended.err).toContain('pending approval: node.execute z1.core.input')

      const resumed = await run([
        'run',
        asking,
        '--input',
        'null',
        '--json',
        '--resume',
        payload.runId,
      ])

      expect(resumed.err).toBe('')
      expect(resumed.code).toBe(0)
      expect(JSON.parse(resumed.out.trimEnd())).toMatchObject({ status: 'completed' })
    })

    test('--resume without input reuses the journaled seed', async () => {
      const suspended = await run([
        'run',
        asking,
        '--input',
        '{"name":"seeded"}',
        '--json',
        '--suspend',
      ])

      expect(suspended.code).toBe(4)
      const payload = JSON.parse(suspended.out.trimEnd()) as { runId: string }

      // No `--input` at all: the runtime must fall back to the seed recorded in
      // `run.started` rather than seeing a different (`null`) seed.
      const resumed = await run(['run', asking, '--json', '--resume', payload.runId])
      expect(resumed.err).toBe('')
      expect(resumed.code).toBe(0)
      expect(JSON.parse(resumed.out.trimEnd())).toMatchObject({ status: 'completed' })

      const mismatch = await run([
        'run',
        asking,
        '--input',
        '{"name":"different"}',
        '--json',
        '--resume',
        payload.runId,
      ])
      expect(mismatch.code).toBe(1)
      expect(mismatch.err).toMatch(/^RESUME_MISMATCH: /m)
    })

    test('--resume with an unknown run id exits 1', async () => {
      const { code, err } = await run([
        'run',
        asking,
        '--input',
        'null',
        '--json',
        '--resume',
        'run_does_not_exist',
      ])

      expect(code).toBe(1)
      expect(err).toContain('unknown run')
    })

    test('--resume with a different graph reports RESUME_MISMATCH', async () => {
      const first = await run(['run', HELLO, '--input', '{"name":"a"}', '--json'])
      const payload = JSON.parse(first.out.trimEnd()) as { runId: string }

      const { code, err } = await run([
        'run',
        AGENT,
        '--input',
        '"[[tool:echo]] hello"',
        '--json',
        '--resume',
        payload.runId,
      ])

      expect(code).toBe(1)
      expect(err).toMatch(/^RESUME_MISMATCH: /m)
    })
  })

  describe('branch tree', () => {
    let directory = ''
    let db = ''

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'z1-tree-'))
      db = join(directory, 'runs.db')
    })

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true })
    })

    test('tree --json lists runs and a fork carries lineage', async () => {
      const first = await run(['run', HELLO, '--input', '{"name":"a"}', '--json', '--db', db])
      expect(first.code).toBe(0)
      const { runId } = JSON.parse(first.out.trimEnd()) as { runId: string }

      const forked = await run(['fork', runId, '--at', 'template', '--json', '--db', db])
      expect(forked.err).toBe('')
      expect(forked.code).toBe(0)
      const fork = JSON.parse(forked.out.trimEnd()) as {
        runId: string
        parentRunId: string
        forkSeq: number
      }
      expect(fork.parentRunId).toBe(runId)

      const tree = await run(['tree', '--db', db, '--json'])
      expect(tree.code).toBe(0)
      const records = JSON.parse(tree.out.trimEnd()) as RunRecord[]
      const ids = records.map((record) => record.runId)
      expect(ids).toContain(runId)
      expect(ids).toContain(fork.runId)
      expect(records.find((record) => record.runId === fork.runId)).toMatchObject({
        graphId: 'hello',
        status: 'running',
        parentRunId: runId,
        forkSeq: fork.forkSeq,
      })

      const text = await run(['tree', '--db', db])
      expect(text.code).toBe(0)
      expect(text.out).toContain(`${fork.runId}  running  hello  `)
      expect(text.out).toContain(`<- ${runId}@${String(fork.forkSeq)}`)
    })

    test('resuming a fork re-executes the forked node and leaves the source alone', async () => {
      const original = await run(['run', HELLO, '--input', '{"name":"fork"}', '--json', '--db', db])
      expect(original.code).toBe(0)
      const { runId } = JSON.parse(original.out.trimEnd()) as { runId: string }

      const before = new SqliteJournal(db)
      let beforeRecord: RunRecord | undefined
      let beforeEvents: ReturnType<SqliteJournal['read']> = []
      try {
        beforeRecord = before.getRun(runId)
        beforeEvents = before.read(runId)
      } finally {
        before.close()
      }
      expect(beforeRecord?.status).toBe('completed')

      const forked = await run(['fork', runId, '--at', 'template', '--json', '--db', db])
      expect(forked.code).toBe(0)
      const fork = JSON.parse(forked.out.trimEnd()) as { runId: string }

      const resumed = await run([
        'run',
        HELLO,
        '--input',
        '{"name":"fork"}',
        '--resume',
        fork.runId,
        '--approve',
        'auto',
        '--json',
        '--db',
        db,
      ])
      expect(resumed.err).toBe('')
      expect(resumed.code).toBe(0)
      expect(JSON.parse(resumed.out.trimEnd())).toMatchObject({ status: 'completed' })

      const after = new SqliteJournal(db)
      try {
        const forkedEvents = after.read(fork.runId)
        expect(
          forkedEvents.some(
            (event) =>
              event.type === 'node.started' && event.runId === fork.runId && event.path === 'template',
          ),
        ).toBe(true)
        expect(after.getRun(runId)).toEqual(beforeRecord)
        expect(after.read(runId)).toEqual(beforeEvents)
      } finally {
        after.close()
      }
    })

    test('fork --at an unknown path exits 1', async () => {
      const first = await run(['run', HELLO, '--input', '{"name":"b"}', '--json', '--db', db])
      const { runId } = JSON.parse(first.out.trimEnd()) as { runId: string }

      const { code, err } = await run(['fork', runId, '--at', 'nope', '--db', db])

      expect(code).toBe(1)
      expect(err).toContain('no node.started event')
    })

    test('tree on an empty database prints nothing and exits 0', async () => {
      const { code, out, err } = await run(['tree', '--db', join(directory, 'empty.db')])

      expect(err).toBe('')
      expect(code).toBe(0)
      expect(out).toBe('')
    })

    test('--live without the provider credential exits 1 before the run', async () => {
      const liveDb = join(directory, 'live.db')
      const { code, err } = await run(
        ['run', AGENT_LIVE, '--live', '--json', '--db', liveDb],
        { env: {} },
      )

      expect(code).toBe(1)
      expect(err).toContain('RIVER_API_KEY')
      const journal = new SqliteJournal(liveDb)
      try {
        expect(journal.listRuns()).toEqual([])
      } finally {
        journal.close()
      }
    })
  })

  describe('memory context', () => {
    let directory = ''
    let db = ''

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'z1-memory-'))
      db = join(directory, 'runs.db')
    })

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true })
    })

    test('prints the envelope of a completed run', async () => {
      const hello = await run(['run', HELLO, '--input', '{"name":"memo"}', '--json', '--db', db])
      expect(hello.code).toBe(0)
      const { runId } = JSON.parse(hello.out.trimEnd()) as { runId: string }

      const text = await run(['memory', 'context', runId, '--db', db])
      expect(text.code).toBe(0)
      expect(text.err).toBe('')
      expect(text.out).toContain('## Recent steps')

      const json = await run(['memory', 'context', runId, '--db', db, '--json'])
      expect(json.code).toBe(0)
      const envelope = JSON.parse(json.out.trimEnd()) as {
        text: string
        messages: { role: string; content: string }[]
        spine: string[]
        siblings: string[]
        recent: unknown[]
      }
      expect(envelope.text).toBe(text.out.trimEnd())
      expect(envelope.messages[0]?.role).toBe('system')
      expect(envelope.siblings).toEqual([])
      expect(envelope.recent.length).toBeGreaterThan(0)
    })

    test('a forked run reports its parent as an ancestor', async () => {
      const hello = await run(['run', HELLO, '--input', '{"name":"fork"}', '--json', '--db', db])
      expect(hello.code).toBe(0)
      const { runId } = JSON.parse(hello.out.trimEnd()) as { runId: string }

      const forked = await run(['fork', runId, '--at', 'template', '--json', '--db', db])
      expect(forked.code).toBe(0)
      const fork = JSON.parse(forked.out.trimEnd()) as { runId: string }

      const envelope = await run(['memory', 'context', fork.runId, '--db', db, '--json'])
      expect(envelope.code).toBe(0)
      const parsed = JSON.parse(envelope.out.trimEnd()) as { text: string; spine: string[] }
      expect(parsed.text).toContain('## Ancestors')
      expect(parsed.text).toContain(runId)
      expect(parsed.spine.join('\n')).toContain(runId)
    })

    test('an unknown run exits 1', async () => {
      const { code, err } = await run(['memory', 'context', 'run_missing', '--db', db])

      expect(code).toBe(1)
      expect(err).toContain('unknown run')
    })

    test('a missing subcommand is a usage error', async () => {
      const { code, err } = await run(['memory', 'nope'])

      expect(code).toBe(2)
      expect(err).toContain('unknown memory command')
    })
  })

  test('unknown command is a usage error', async () => {
    const { code, err } = await run(['nope'])

    expect(code).toBe(2)
    expect(err).toContain('usage: z1')
  })

  test('--trace writes run events to stderr', async () => {
    const { code, err } = await run([
      'run',
      HELLO,
      '--input',
      '{"name":"trace"}',
      '--trace',
      '--json',
    ])

    expect(code).toBe(0)
    expect(err).toMatch(/"type"\s*:\s*"run\.started"/)
    expect(err).toMatch(/"type"\s*:\s*"run\.completed"/)
  })
})
