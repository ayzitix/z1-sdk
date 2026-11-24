/**
 * `runProcess` children are spawned `detached` (own process group) so a timeout
 * can sweep the whole tree — which also means nothing kills them when the host
 * does. `killAllRunProcesses` is what makes them ownable, and this spec asserts
 * on the *process*, never on the promise: a reaped child must not be able to
 * write its sentinel file, and its pid must be gone.
 *
 * `ModuleWorker.dispose()` calls the same reaper (`runtime.close()` reaches
 * `dispose()`); `installRunProcessExitReaper` covers a host that ends without
 * closing.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, expect, test } from 'vitest'
import type { FsService, ToolService } from '@z1/runtime'

import { ModuleWorker, type WorkerHostServices } from '../src/index.ts'
import {
  installRunProcessExitReaper,
  killAllRunProcesses,
  liveRunProcessPids,
  runProcess,
} from '../src/process-run.ts'

/** Every started run, settled or not, so nothing outlives the suite. */
const started: Promise<unknown>[] = []

/**
 * The one worker this file creates.
 *
 * `vitest.config.ts` runs each spec file in its own forked process, so this
 * file's `liveRunProcesses` registry holds only the children of this worker —
 * which is what makes "dispose reaped *its* child" testable at all. Any other
 * spec shares neither the module state nor the process.
 */
let isolationWorker: ModuleWorker | undefined

const ECHO_DIR = fileURLToPath(new URL('./fixtures/echo', import.meta.url))
const RUNNER_NODE = 'com.example.echo.runner'
/** The worker rejects any node the manifest does not declare, so all of them. */
const ECHO_NODE_IDS = [
  'com.example.echo.echo',
  'com.example.echo.reader',
  'com.example.echo.crasher',
  'com.example.echo.sleeper',
  'com.example.echo.runner',
  'com.example.echo.llmer',
  'com.example.echo.modeller',
  'com.example.echo.tasker',
  'com.example.echo.denied',
  'com.example.echo.fetcher',
  'com.example.echo.subgrapher',
]

afterEach(async () => {
  // Dispose before the reaper: a worker left alive by a failing test must not
  // hold the next one's registry.
  const worker = isolationWorker
  isolationWorker = undefined
  if (worker !== undefined) await worker.dispose().catch(() => undefined)
  // A reaper that already ran is a no-op; anything a test left registered is
  // swept here rather than outliving the suite.
  await killAllRunProcesses()
  await Promise.allSettled(started.splice(0))
})

/** Resolve when `path` exists and is non-empty. */
async function readWhenWritten(path: string): Promise<string> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim()
      if (text.length > 0) return text
    }
    if (Date.now() > deadline) throw new Error(`expected ${path} to be written`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Spawn a child that writes its own pid as soon as it starts and a sentinel
 * `sentinelAfterMs` later. Its tool timeout is far longer than the test window,
 * so only an external reaper can stop that sentinel from appearing.
 */
function startSentinelChild(dir: string, sentinelAfterMs: number): Promise<unknown> {
  const script = [
    `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'child.pid'))}, String(process.pid))`,
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'sentinel'))}, 'x'), ${sentinelAfterMs})`,
    'setInterval(() => {}, 1000)',
  ].join(';')
  const pending = runProcess(process.execPath, ['-e', script], {
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '' },
    // The tool's own timeout must be much longer than the test window, so a
    // pass cannot come from the timeout path.
    timeoutMs: 60_000,
    maxOutputBytes: 4096,
  })
  started.push(pending)
  return pending
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The pid file is written by the child, which can be before `spawn` returned to
 * this process, so the registry is polled rather than assumed.
 */
async function waitRegistered(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!liveRunProcessPids().includes(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} was never registered`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('reaping kills an in-flight runProcess before it can write its sentinel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'z1-orphan-'))
  startSentinelChild(dir, 3_000)
  const pid = Number(await readWhenWritten(join(dir, 'child.pid')))
  await waitRegistered(pid)

  await killAllRunProcesses('SIGTERM')

  expect(liveRunProcessPids()).not.toContain(pid)
  // The assertion is on the process: the sentinel is due at +3 s from spawn.
  await new Promise((resolve) => setTimeout(resolve, 3_500))
  expect(existsSync(join(dir, 'sentinel'))).toBe(false)
  expect(isAlive(pid)).toBe(false)
}, 20_000)

test('a finished child is deregistered, so a later reap cannot signal a reused pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'z1-orphan-'))
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('done')"], {
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '' },
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('done')
  // `close` has landed, so the child is no longer owned.
  expect(liveRunProcessPids()).toEqual([])

  await expect(killAllRunProcesses('SIGTERM')).resolves.toBeUndefined()
  expect(liveRunProcessPids()).toEqual([])
})

test('reaping twice is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'z1-orphan-'))
  startSentinelChild(dir, 3_000)
  const pid = Number(await readWhenWritten(join(dir, 'child.pid')))
  await waitRegistered(pid)

  await killAllRunProcesses('SIGTERM')
  await expect(killAllRunProcesses('SIGTERM')).resolves.toBeUndefined()
  await expect(killAllRunProcesses('SIGKILL')).resolves.toBeUndefined()

  await new Promise((resolve) => setTimeout(resolve, 3_500))
  expect(existsSync(join(dir, 'sentinel'))).toBe(false)
  expect(isAlive(pid)).toBe(false)
}, 20_000)

test('the exit reaper installs one listener however often it is called', () => {
  const before = process.listenerCount('exit')
  installRunProcessExitReaper()
  installRunProcessExitReaper()
  installRunProcessExitReaper()
  expect(process.listenerCount('exit')).toBeLessThanOrEqual(before + 1)
  if (before === 0) expect(process.listenerCount('exit')).toBe(1)
})

test('an already-exited child does not throw and an empty registry reaps promptly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'z1-orphan-'))
  const pidPath = join(dir, 'child.pid')
  const result = await runProcess(
    process.execPath,
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`],
    {
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    },
  )
  expect(result.code).toBe(0)
  const pid = Number(await readWhenWritten(pidPath))
  expect(isAlive(pid)).toBe(false)

  // A child that is already gone must not cost a grace period: `exited()`
  // resolves immediately for it.
  const began = Date.now()
  await expect(killAllRunProcesses('SIGTERM')).resolves.toBeUndefined()
  expect(Date.now() - began).toBeLessThan(2_000)
  await expect(killAllRunProcesses()).resolves.toBeUndefined()
  expect(liveRunProcessPids()).toEqual([])
})

/** Minimal host services: `process.run` needs no LLM, tools or approval. */
function isolationServices(): WorkerHostServices {
  const fs: FsService = {
    read: async (path) => readFileSync(path, 'utf8'),
    write: async (_path, data) => data,
  }
  const tools: ToolService = {
    call: async (name) => {
      throw new Error(`unexpected tool call "${name}"`)
    },
    list: async () => [],
  }
  return { fs, tools }
}

test('disposing the worker reaps the process.run child its node started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'z1-orphan-dispose-'))
  const worker = new ModuleWorker({
    moduleDir: ECHO_DIR,
    entry: 'index.js',
    manifestNodeIds: ECHO_NODE_IDS,
    capabilities: {
      fs: { read: ['${moduleDir}/**'] },
      process: { spawn: ['node'] },
    },
    services: isolationServices(),
  })
  isolationWorker = worker
  await worker.start()

  // The node resolves once its `process.run` call settles — which is only when
  // the child ends. It must stay pending until the reaper kills the child.
  const execution = worker.execute(RUNNER_NODE, {}, { dir }, null)
  started.push(execution)
  execution.catch(() => undefined)

  const pid = Number(await readWhenWritten(join(dir, 'child.pid')))
  // Registered means this process owns it: the registry lives in this fork.
  await waitRegistered(pid)
  expect(isAlive(pid)).toBe(true)

  // The node's call has not settled yet: its child is genuinely in flight, so
  // whatever happens next comes from dispose, not from the child finishing.
  let settled = false
  void execution.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(settled).toBe(false)

  await worker.dispose()

  // The assertion is on the process, not on the promise: disposal must not
  // merely reject the call while the detached child keeps running.
  expect(isAlive(pid)).toBe(false)
  expect(liveRunProcessPids()).not.toContain(pid)

  // The sentinel is due at +3 s from the child's start; disposal happened long
  // before that, so a live child would write it.
  await new Promise((resolve) => setTimeout(resolve, 3_500))
  expect(existsSync(join(dir, 'sentinel'))).toBe(false)
  expect(isAlive(pid)).toBe(false)
}, 40_000)
