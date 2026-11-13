import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { ModuleStore } from '@z1/module'
import type { Json } from '@z1/node'
import type { ApprovalService, ToolService } from '@z1/runtime'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createRuntime, loadRuntimeConfig, type Runtime, type RunHandle } from '../src/index.ts'

/** The example module that ships with the repo. */
const MODULE_SOURCE = fileURLToPath(new URL('../../../examples/modules/z1-tools', import.meta.url))

const MODULE_ID = 'com.z1.tools'
const MODULE_VERSION = '0.1.0'

/** The exact v1 tool set, in the order the module advertises it. */
const TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'apply_patch',
  'list',
  'glob',
  'grep',
  'tree',
  'stat',
  'mkdir',
  'move',
  'shell',
  'git.status',
  'git.diff',
  'git.log',
  'system.info',
  'todo.write',
  'todo.read',
]

/**
 * v1 tools must never ask for approval. Any request is a bug, so this service
 * fails the test instead of answering: every tool below runs without it.
 */
const noApprovals: ApprovalService = {
  request: async () => {
    throw new Error('v1 tools must not request approval')
  },
}

const exec = promisify(execFile)

let root: string
let workspace: string
let modulesDir: string
let runtime: Runtime
let handle: RunHandle
let tools: ToolService

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-tools-module-'))
  workspace = join(root, 'workspace')
  modulesDir = join(root, 'modules')
  await mkdir(workspace, { recursive: true })

  const store = new ModuleStore(modulesDir)
  store.propose(MODULE_SOURCE)
  store.approve(MODULE_ID, MODULE_VERSION)
  store.activate(MODULE_ID, MODULE_VERSION)

  runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: workspace,
      env: {},
      overrides: {
        dbPath: join(root, `runs-${randomUUID()}.db`),
        graphsPath: join(root, 'graphs'),
        modulesPath: modulesDir,
      },
    }),
  )

  handle = await runtime.beginRun({ runId: `run_${randomUUID()}`, approval: noApprovals })
  tools = handle.services.tools
})

afterAll(async () => {
  await handle?.dispose()
  await runtime?.close()
  await rm(root, { recursive: true, force: true })
})

/** Every tool returns text; `Json` is the service signature's type. */
async function call(name: string, args: Record<string, Json> = {}): Promise<string> {
  const result = await tools.call(name, args as Json)
  expect(typeof result).toBe('string')
  return result as string
}

const inWorkspace = (...segments: string[]): string => join(workspace, ...segments)

describe('z1 tools module', () => {
  test('exposes exactly the eighteen v1 tools', async () => {
    const schemas = await tools.list()
    expect(schemas.map((schema) => schema.name)).toEqual(TOOL_NAMES)
    for (const schema of schemas) {
      expect(schema.parameters['type']).toBe('object')
      expect(Array.isArray(schema.parameters['required'])).toBe(true)
      expect(schema.description?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('write reports bytes and read numbers lines', async () => {
    expect(await call('write', { path: 'notes/a.txt', content: 'hello\nworld\n' })).toBe(
      'wrote notes/a.txt (12 bytes)',
    )
    expect(await readFile(inWorkspace('notes', 'a.txt'), 'utf8')).toBe('hello\nworld\n')

    expect(await call('read', { path: 'notes/a.txt' })).toBe('1| hello\n2| world')
    expect(await call('read', { path: inWorkspace('notes', 'a.txt'), offset: 2, limit: 1 })).toBe(
      '2| world',
    )
    await expect(call('read', { path: 'notes/missing.txt' })).rejects.toThrow(/cannot read/)
  })

  test('edit refuses an ambiguous match and replaceAll replaces every one', async () => {
    await call('write', { path: 'notes/edit.txt', content: 'aa aa\n' })

    await expect(
      call('edit', { path: 'notes/edit.txt', oldText: 'aa', newText: 'bb' }),
    ).rejects.toThrow(/occurs 2 times/)
    await expect(call('edit', { path: 'notes/edit.txt', oldText: '', newText: 'x' })).rejects.toThrow(
      /non-empty/,
    )

    expect(
      await call('edit', {
        path: 'notes/edit.txt',
        oldText: 'aa',
        newText: 'bb',
        replaceAll: true,
      }),
    ).toBe('edited notes/edit.txt (2 replacements)')
    expect(await readFile(inWorkspace('notes', 'edit.txt'), 'utf8')).toBe('bb bb\n')
  })

  test('apply_patch changes two files atomically', async () => {
    await call('write', { path: 'patch/a.txt', content: 'one\ntwo\nthree\n' })
    await call('write', { path: 'patch/b.txt', content: 'alpha\nbeta\n' })

    const patch = [
      'patch/a.txt',
      '<<<<<<< SEARCH',
      'two',
      '=======',
      'TWO',
      '>>>>>>> REPLACE',
      'patch/a.txt',
      '<<<<<<< SEARCH',
      'three',
      '=======',
      'THREE!',
      '>>>>>>> REPLACE',
      'patch/b.txt',
      '<<<<<<< SEARCH',
      'beta',
      '=======',
      'BETA',
      '>>>>>>> REPLACE',
      '',
    ].join('\n')

    expect(await call('apply_patch', { patch })).toBe(
      'patched 3 blocks in 2 files\npatch/a.txt (+2 -2)\npatch/b.txt (+1 -1)',
    )
    expect(await call('read', { path: 'patch/a.txt' })).toBe('1| one\n2| TWO\n3| THREE!')
    expect(await call('read', { path: 'patch/b.txt' })).toBe('1| alpha\n2| BETA')

    const mismatch = [
      'patch/a.txt',
      '<<<<<<< SEARCH',
      'one',
      '=======',
      'ONE',
      '>>>>>>> REPLACE',
      'patch/b.txt',
      '<<<<<<< SEARCH',
      'not there',
      '=======',
      'x',
      '>>>>>>> REPLACE',
      '',
    ].join('\n')
    await expect(call('apply_patch', { patch: mismatch })).rejects.toThrow(/no match/)
    expect(await call('read', { path: 'patch/a.txt' })).toBe('1| one\n2| TWO\n3| THREE!')
  })

  test('list and glob walk the workspace', async () => {
    const listing = await call('list', { path: 'patch' })
    expect(listing).toContain('file patch/a.txt (15)')
    expect(listing).toContain('file patch/b.txt (11)')

    const top = await call('list', { path: '.' })
    expect(top).toContain('dir notes')
    expect(top).toContain('dir patch')

    const deep = await call('list', { path: '.', recursive: true, maxDepth: 2 })
    expect(deep).toContain('file notes/a.txt (12)')

    const matches = await call('glob', { pattern: '**/*.txt', path: '.' })
    expect(matches.split('\n')).toContain('patch/a.txt')
    expect(matches.split('\n')).toContain('notes/a.txt')
    expect(matches.split('\n')).not.toContain('notes/deep.txt')
  })

  test('grep returns path:line hits and dash context lines', async () => {
    await call('write', {
      path: 'grep.txt',
      content: 'alpha\nneedle here\nomega\nneedle again\n',
    })

    expect(await call('grep', { pattern: 'needle' })).toBe(
      'grep.txt:2: needle here\ngrep.txt:4: needle again',
    )

    const withContext = await call('grep', { pattern: 'needle here', context: 1 })
    expect(withContext).toContain('grep.txt-1- alpha')
    expect(withContext).toContain('grep.txt:2: needle here')
    expect(withContext).toContain('grep.txt-3- omega')

    await expect(call('grep', { pattern: '(' })).rejects.toThrow(/valid regular expression/)
  })

  test('tree renders directories and files', async () => {
    const tree = await call('tree', { path: '.', depth: 2 })
    expect(tree.split('\n')[0]).toBe('.')
    expect(tree).toMatch(/[├└]── patch\//)
    expect(tree).toMatch(/[├└]── grep\.txt/)
  })

  test('stat reports type, size and mtime', async () => {
    const stat = await call('stat', { path: 'patch/a.txt' })
    expect(stat).toMatch(/^file 15 \d{4}-\d{2}-\d{2}T[\d:.]+Z patch\/a\.txt$/)

    const directory = await call('stat', { path: 'patch' })
    expect(directory).toMatch(/^dir 0 /)
    await expect(call('stat', { path: 'nope.txt' })).rejects.toThrow(/cannot stat/)
  })

  test('mkdir creates parents and move renames', async () => {
    expect(await call('mkdir', { path: 'empty/nested' })).toBe('created empty/nested')
    expect(await call('stat', { path: 'empty/nested' })).toMatch(/^dir 0 /)
    await expect(call('read', { path: 'empty/nested' })).rejects.toThrow(/cannot read/)

    expect(await call('move', { from: 'patch/b.txt', to: 'patch/c.txt' })).toBe(
      'moved patch/b.txt -> patch/c.txt',
    )
    expect(await call('read', { path: 'patch/c.txt' })).toBe('1| alpha\n2| BETA')
    await expect(call('read', { path: 'patch/b.txt' })).rejects.toThrow(/cannot read/)
  })

  test('shell separates the exit code, stdout and stderr', async () => {
    const result = await call('shell', {
      command: 'node',
      args: ['-e', "console.log('shell-ok')"],
    })
    expect(result).toBe('exit 0\n--- stdout ---\nshell-ok')

    const failure = await call('shell', {
      command: 'node',
      args: ['-e', 'process.exit(3)'],
    })
    expect(failure).toBe('exit 3')

    const both = await call('shell', {
      command: 'node',
      args: ['-e', "console.error('bad'); console.log('good')"],
    })
    expect(both).toContain('--- stdout ---\ngood')
    expect(both).toContain('--- stderr ---\nbad')
  })

  test('system.info names the workspace', async () => {
    const info = await call('system.info')
    expect(info).toContain(`workspace ${workspace}`)
    expect(info).toMatch(/platform \S+/)
    expect(info).toMatch(/node v\d+\./)
  })

  test('todo.write and todo.read roundtrip through .z1/todos.json', async () => {
    expect(
      await call('todo.write', {
        items: [{ text: 'first task' }, { text: 'second task', status: 'in_progress' }],
      }),
    ).toBe('wrote .z1/todos.json (2 items)')

    const stored = JSON.parse(await readFile(inWorkspace('.z1', 'todos.json'), 'utf8')) as {
      items: Array<{ text: string; status: string }>
    }
    expect(stored.items).toEqual([
      { text: 'first task', status: 'pending' },
      { text: 'second task', status: 'in_progress' },
    ])

    const read = JSON.parse(await call('todo.read')) as typeof stored
    expect(read).toEqual(stored)
    expect(await call('todo.read')).toBe(`${JSON.stringify(stored, null, 2)}`)

    await expect(
      call('todo.write', { items: [{ text: 'x', status: 'blocked' }] }),
    ).rejects.toThrow(/status must be one of/)
  })

  test('relative and absolute paths both resolve against the workspace', async () => {
    expect(await call('write', { path: 'rel/deep.txt', content: 'rel\n' })).toBe(
      'wrote rel/deep.txt (4 bytes)',
    )
    expect(await readFile(inWorkspace('rel', 'deep.txt'), 'utf8')).toBe('rel\n')

    expect(
      await call('write', { path: inWorkspace('abs.txt'), content: 'abs\n' }),
    ).toBe('wrote abs.txt (4 bytes)')
    expect(await readFile(inWorkspace('abs.txt'), 'utf8')).toBe('abs\n')
    expect(await call('read', { path: inWorkspace('abs.txt') })).toBe('1| abs')

    // Absolute paths outside the workspace stay absolute.
    const outside = join(root, 'outside.txt')
    expect(await call('write', { path: outside, content: 'out\n' })).toBe(
      `wrote ${outside} (4 bytes)`,
    )
    expect(await call('read', { path: outside })).toBe('1| out')
  })

  test('git status, diff and log are read-only views of the workspace', async () => {
    await exec('git', ['init'], { cwd: workspace })
    await exec('git', ['config', 'user.email', 'z1-tests@example.com'], { cwd: workspace })
    await exec('git', ['config', 'user.name', 'z1 tests'], { cwd: workspace })
    await exec('git', ['add', '-A'], { cwd: workspace })
    await exec('git', ['commit', '-m', 'initial tools commit'], { cwd: workspace })

    expect(await call('git.status')).toBe('')

    await writeFile(inWorkspace('notes', 'a.txt'), 'hello\nchanged\n')
    const status = await call('git.status')
    expect(status).toContain(' M notes/a.txt')

    const diff = await call('git.diff')
    expect(diff).toContain('-world')
    expect(diff).toContain('+changed')

    const pathDiff = await call('git.diff', { path: 'notes/a.txt' })
    expect(pathDiff).toContain('notes/a.txt')

    const log = await call('git.log')
    expect(log).toMatch(/^[0-9a-f]+ \d{4}-\d{2}-\d{2} initial tools commit$/m)

    const one = await call('git.log', { limit: 1 })
    expect(one.split('\n')).toHaveLength(1)

    await exec('git', ['add', 'notes/a.txt'], { cwd: workspace })
    const staged = await call('git.diff', { staged: true })
    expect(staged).toContain('+changed')
  })

  test('mutating tools never request approval', async () => {
    // `noApprovals` throws on any request, so reaching this assertion at all
    // proves none of the tools above called `ctx.approval`.
    expect(await call('write', { path: 'no-approval.txt', content: 'ok\n' })).toBe(
      'wrote no-approval.txt (3 bytes)',
    )
    expect(await call('read', { path: 'no-approval.txt' })).toBe('1| ok')
  })
})
