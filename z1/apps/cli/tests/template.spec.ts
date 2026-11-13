import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  test('--template accepts an id@version spec', async () => {
    const { code, out, err } = await run([
      'run',
      '--template',
      'agent.loop@1.0.0',
      '--message',
      'hi',
      '--json',
    ])

    expect(err).toBe('')
    expect(code).toBe(0)
    expect(JSON.parse(out.trimEnd())).toMatchObject({ status: 'completed' })
  })

  test('--template with an unknown version exits 1', async () => {
    const { code, err } = await run([
      'run',
      '--template',
      'agent.loop@9.9.9',
      '--message',
      'hi',
    ])

    expect(code).toBe(1)
    expect(err).toContain('agent.loop@9.9.9')
  })

  test('--model naming a provider without --live warns and keeps the mock', async () => {
    const { code, out, err } = await run([
      'run',
      '--template',
      'agent.loop',
      '--model',
      'river/fast',
      '--message',
      'hi',
      '--json',
    ])

    expect(code).toBe(0)
    expect(err).toContain('model "river/fast" ignored without --live; using mock')
    expect(JSON.parse(out.trimEnd())).toMatchObject({ status: 'completed' })
  })

  test('--model on a graph file without --template is a usage error', async () => {
    const { code, err } = await run(['run', HELLO, '--model', 'mock/mock-1'])

    expect(code).toBe(2)
    expect(err).toContain('--model requires --template')
  })
})

describe('a malformed static template', () => {
  let templatesDir = ''

  beforeAll(async () => {
    templatesDir = await mkdtemp(join(tmpdir(), 'z1-cli-broken-template-'))
    await writeFile(join(templatesDir, 'broken.json'), '{ "id": "broken",', 'utf8')
  })

  afterAll(async () => {
    await rm(templatesDir, { recursive: true, force: true })
  })

  test('does not affect a graph run', async () => {
    const { code, err } = await run([
      'run',
      HELLO,
      '--input',
      '{"name":"a"}',
      '--json',
      '--templates-dir',
      templatesDir,
    ])

    expect(err).toBe('')
    expect(code).toBe(0)
  })

  test('template list names the file', async () => {
    const { code, err } = await run(['template', 'list', '--templates-dir', templatesDir])

    expect(code).toBe(1)
    expect(err).toContain('broken.json')
  })

  test('run --template names the file', async () => {
    const { code, err } = await run([
      'run',
      '--template',
      'agent.loop',
      '--message',
      'hi',
      '--templates-dir',
      templatesDir,
    ])

    expect(code).toBe(1)
    expect(err).toContain('broken.json')
  })
})
