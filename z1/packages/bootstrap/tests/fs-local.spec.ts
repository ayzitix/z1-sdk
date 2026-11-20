import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ApprovalService } from '@z1/runtime'
import { afterAll, beforeAll, expect, test } from 'vitest'

import {
  createLocalFsService,
  createRuntime,
  loadRuntimeConfig,
  type Runtime,
} from '../src/index.ts'

let root: string
const runtimes: Runtime[] = []

const approval: ApprovalService = { request: async () => 'allowed-once' }

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-fs-local-'))
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(root, { recursive: true, force: true })
})

test('local write/read round-trips and creates nested directories', async () => {
  const fs = createLocalFsService(root)
  const path = join(root, 'nested', 'deeper', 'note.txt')

  await fs.write(path, 'hello workspace')
  expect(await fs.read(path)).toBe('hello workspace')
  // The same bytes are on disk, not in a map.
  expect(await readFile(path, 'utf8')).toBe('hello workspace')
})

test('a relative path is resolved against the workspace, not process.cwd()', async () => {
  const fs = createLocalFsService(root)

  await fs.write('relative/note.txt', 'inside')
  expect(await readFile(join(root, 'relative', 'note.txt'), 'utf8')).toBe('inside')
  expect(await fs.read('relative/note.txt')).toBe('inside')
})

test('a path that escapes the workspace is refused', async () => {
  const fs = createLocalFsService(root)

  await expect(fs.write('../escape.txt', 'x')).rejects.toThrow(/escapes the workspace root/)
  await expect(fs.write(join(root, '..', 'escape.txt'), 'x')).rejects.toThrow(
    /escapes the workspace root/,
  )
  await expect(fs.read('/etc/passwd')).rejects.toThrow(/escapes the workspace root/)
})

test('the module broker may pass an absolute path it has already vetted', async () => {
  const fs = createLocalFsService(root, { allowAbsolute: true })
  const outside = join(tmpdir(), `z1-fs-absolute-${String(process.pid)}.txt`)

  try {
    await fs.write(outside, 'granted')
    expect(await fs.read(outside)).toBe('granted')
    await expect(fs.write('../still-relative.txt', 'x')).rejects.toThrow(
      /escapes the workspace root/,
    )
  } finally {
    await rm(outside, { force: true })
  }
})

test('reading a missing file names the path', async () => {
  const fs = createLocalFsService(root)
  const missing = join(root, 'nested', 'absent.txt')

  await expect(fs.read(missing)).rejects.toThrow(missing)
})

test('fsMode "memory" keeps the in-memory mock and touches no disk', async () => {
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: root,
      env: {},
      overrides: {
        dbPath: join(root, 'memory.db'),
        modulesPath: join(root, 'modules'),
        useModules: false,
        fsMode: 'memory',
      },
    }),
  )
  runtimes.push(runtime)

  const handle = await runtime.beginRun({ approval })
  try {
    const path = join(root, 'memory-only.txt')
    await handle.services.fs.write(path, 'in memory')
    expect(await handle.services.fs.read(path)).toBe('in memory')
    await expect(access(path)).rejects.toThrow()
  } finally {
    await handle.dispose()
  }
})

test('fsMode defaults to the local service and a run override still wins', async () => {
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: root,
      env: {},
      overrides: {
        dbPath: join(root, 'default.db'),
        modulesPath: join(root, 'modules-default'),
        useModules: false,
      },
    }),
  )
  runtimes.push(runtime)

  const handle = await runtime.beginRun({
    approval,
    fs: { read: async () => 'from override', write: async () => {} },
  })
  try {
    expect(await handle.services.fs.read(join(root, 'whatever.txt'))).toBe('from override')
  } finally {
    await handle.dispose()
  }
})
