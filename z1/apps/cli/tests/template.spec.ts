import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runCli, type CliIO } from '../src/cli.ts'

const HELLO = fileURLToPath(new URL('../../../examples/hello.graph.json', import.meta.url))

let dbPath = ''
let directory = ''

interface Captured {
  readonly io: CliIO
  stdout(): string
  stderr(): string
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), isTTY: false },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

async function run(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const args = argv[0] === 'run' && !argv.includes('--db') ? [...argv, '--db', dbPath] : [...argv]
  const io = capture()
  const code = await runCli(args, io.io)
  return { code, out: io.stdout(), err: io.stderr() }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'z1-cli-template-'))
  dbPath = join(directory, 'runs.db')
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('z1 template', () => {
  test('run --template agent.loop completes with the mock provider', async () => {
    const { code, out, err } = await run([
      'run',
      '--template',
      'agent.loop',
      '--message',
      '[[tool:echo]] hi',
      '--json',
    ])

    expect(err).toBe('')
    expect(code).toBe(0)
    const result = JSON.parse(out) as { status: string; outputs: Record<string, unknown> }
    expect(result.status).toBe('completed')
    expect(result.outputs['output']).toBe('mock: done')
  })

  test('template list shows the built-in agent loop', async () => {
    const { code, out, err } = await run(['template', 'list'])

    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain('agent.loop@1.0.0')
    expect(out).toContain('Agent loop')
  })

  test('template list --json prints metadata', async () => {
    const { code, out } = await run(['template', 'list', '--json'])

    expect(code).toBe(0)
    const templates = JSON.parse(out) as { id: string; version: string; title: string }[]
    expect(templates).toContainEqual(
      expect.objectContaining({ id: 'agent.loop', version: '1.0.0', title: 'Agent loop' }),
    )
  })

  test('a graph file and --template together are a usage error', async () => {
    const { code, err } = await run(['run', HELLO, '--template', 'agent.loop'])

    expect(code).toBe(2)
    expect(err).toContain('mutually exclusive')
  })

  test('an unknown template exits 1', async () => {
    const { code, err } = await run(['run', '--template', 'missing.template', '--message', 'hi'])

    expect(code).toBe(1)
    expect(err).toContain('unknown template "missing.template"')
  })
})
