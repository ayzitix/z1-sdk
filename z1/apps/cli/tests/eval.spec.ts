import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, expect, test } from 'vitest'

import { runCli, type CliIO } from '../src/cli.ts'

let root = ''
let workspace = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-eval-'))
  workspace = join(root, 'workspace')
})

/** A fresh parent per test, so a failing case left behind cannot leak. */
async function freshWorkspace(name: string): Promise<string> {
  return join(root, `ws-${name}`)
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

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

async function run(
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const io = capture()
  const code = await runCli(argv, io.io)
  return { code, out: io.stdout(), err: io.stderr() }
}

async function caseFile(id: string, cases: unknown): Promise<string> {
  const file = join(root, `${id}.json`)
  await writeFile(file, JSON.stringify(cases), 'utf8')
  return file
}

test('a passing suite exits 0 and reports its metrics', async () => {
  const file = await caseFile('pass', {
    cases: [
      { id: 'echo', message: 'hello', expect: { outputContains: ['mock: hello'], maxSteps: 1 } },
    ],
  })

  const { code, out } = await run(['eval', file, '--workspace', await freshWorkspace('pass')])
  expect(code).toBe(0)
  expect(out).toContain('echo')
  expect(out).toContain('pass')
  expect(out).toMatch(/summary\s+passed 1\/1/)
  expect(out).toContain('medianSteps 1')
})

test('a failing assertion is named and the command exits 1', async () => {
  const file = await caseFile('fail', {
    cases: [{ id: 'wrong', message: 'hello', expect: { outputContains: ['not there'] } }],
  })

  const { code, out } = await run(['eval', file, '--workspace', await freshWorkspace('fail')])
  expect(code).toBe(1)
  expect(out).toContain('outputContains "not there"')
  expect(out).toContain('mock: hello')
})

test('a step budget is enforced from the journal', async () => {
  const file = await caseFile('budget', {
    cases: [{ id: 'steps', message: 'hello', expect: { maxSteps: 0 } }],
  })

  const { code, out } = await run([
    'eval',
    file,
    '--workspace',
    await freshWorkspace('budget'),
  ])
  expect(code).toBe(1)
  expect(out).toContain('steps 1 > maxSteps 0')
})

test('a negative budget is a load error, not a failed case', async () => {
  const file = await caseFile('negative', {
    cases: [{ id: 'tools', message: 'hello', expect: { maxToolErrors: -1 } }],
  })
  const { code, err } = await run(['eval', file, '--workspace', await freshWorkspace('negative')])
  expect(code).toBe(2)
  expect(err).toContain('must be a non-negative integer')
})

test('--json returns a machine-readable summary', async () => {
  const file = await caseFile('json', {
    cases: [
      { id: 'one', message: 'hello', expect: { outputContains: ['mock: hello'] } },
      { id: 'two', message: 'hello', expect: { outputContains: ['missing'] } },
    ],
  })

  const { code, out } = await run([
    'eval',
    file,
    '--workspace',
    await freshWorkspace('json'),
    '--json',
  ])
  expect(code).toBe(1)
  const parsed = JSON.parse(out) as {
    cases: { id: string; passed: boolean }[]
    summary: { passed: number; failed: number; passRate: number; totalTokens: number }
  }
  expect(parsed.cases.map((entry) => [entry.id, entry.passed])).toEqual([
    ['one', true],
    ['two', false],
  ])
  expect(parsed.summary.passed).toBe(1)
  expect(parsed.summary.failed).toBe(1)
  expect(parsed.summary.passRate).toBe(0.5)
})

test('cases run in a copy of their fixture and cannot collide', async () => {
  const fixture = join(root, 'fixture')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'seed.txt'), 'seeded', 'utf8')

  const file = await caseFile('fixture', {
    cases: [
      {
        id: 'sees-fixture',
        message: 'hello',
        fixture,
        expect: { files: [{ path: 'seed.txt', contains: 'seeded' }] },
      },
      {
        id: 'writes-own',
        message: 'hello',
        fixture,
        expect: { files: [{ path: 'seed.txt', contains: 'seeded' }] },
      },
    ],
  })

  const parent = await freshWorkspace('fixture')
  const { code } = await run(['eval', file, '--workspace', parent, '--jobs', '2'])
  expect(code).toBe(0)

  // Passing cases are removed; the parent workspace still exists but holds no
  // case directories.
  const leftovers = existsSync(parent) ? await readdir(parent) : []
  expect(leftovers).toEqual([])
})

test('a fixture with a symlink is refused', async () => {
  const fixture = join(root, 'fixture-link')
  const { mkdir, symlink } = await import('node:fs/promises')
  await mkdir(fixture, { recursive: true })
  await symlink('/etc/passwd', join(fixture, 'leak.txt'))

  const file = await caseFile('fixture-link', {
    cases: [{ id: 'x', message: 'hello', fixture, expect: { maxSteps: 1 } }],
  })
  const { code, err } = await run(['eval', file, '--workspace', await freshWorkspace('link')])
  expect(code).toBe(2)
  expect(err).toContain('symlink')
})

test('a missing fixture directory is a load error, not a failed case', async () => {
  const file = await caseFile('bad-fixture', {
    cases: [{ id: 'x', message: 'hello', fixture: './nope', expect: { maxSteps: 1 } }],
  })
  const { code, err } = await run(['eval', file, '--workspace', await freshWorkspace('fixture-bad')])
  expect(code).toBe(2)
  expect(err).toContain('is not a directory')
})

test('a case without assertions is rejected', async () => {
  const file = await caseFile('no-expect', { cases: [{ id: 'x', message: 'hello', expect: {} }] })
  const { code, err } = await run(['eval', file, '--workspace', await freshWorkspace('no-expect')])
  expect(code).toBe(2)
  expect(err).toContain('must assert at least one thing')
})

test('--cassette replays a recorded suite without a provider', async () => {
  const db = join(root, 'record.db')
  const recorded = await run([
    'run',
    '--template',
    'agent.loop',
    '--message',
    'hello',
    '--json',
    '--db',
    db,
    '--cwd',
    root,
  ])
  expect(recorded.code).toBe(0)
  const runId = (JSON.parse(recorded.out) as { runId: string }).runId

  const cassette = join(root, 'suite.jsonl')
  const exported = await run(['cassette', 'export', runId, '--db', db, '-o', cassette])
  expect(exported.code).toBe(0)

  const file = await caseFile('cassette', {
    cases: [{ id: 'replayed', message: 'hello', expect: { outputContains: ['mock: hello'] } }],
  })
  const { code, out } = await run([
    'eval',
    file,
    '--workspace',
    await freshWorkspace('cassette'),
    '--cassette',
    cassette,
  ])
  expect(code).toBe(0)
  expect(out).toContain('pass')
})
