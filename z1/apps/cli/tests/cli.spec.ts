import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runCli, type CliIO } from '../src/cli.ts'

const HELLO = fileURLToPath(new URL('../../../examples/hello.graph.json', import.meta.url))
const AGENT = fileURLToPath(new URL('../../../examples/agent.graph.json', import.meta.url))

/** Set once per suite; every run gets `--db` so no test pollutes `.z1/runs.db`. */
let dbPath = ''

interface Captured {
  readonly io: CliIO
  stdout(): string
  stderr(): string
}

function capture(isTTY = false): Captured {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      isTTY,
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

async function run(
  argv: readonly string[],
  options: { isTTY?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  const args =
    argv[0] === 'run' && !argv.includes('--db') ? [...argv, '--db', dbPath] : [...argv]
  const io = capture(options.isTTY ?? false)
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
      expect(err).toContain('RESUME_MISMATCH')
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
