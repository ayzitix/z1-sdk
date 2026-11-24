/**
 * Cancelling an execution (or a service call) whose work is a `process.run`
 * child used to leave the child running and, 2 s later, SIGKILL the whole
 * module worker.
 *
 * The fixture node/service never looks at `ctx.signal`: it is blocked inside
 * the `process.run` RPC, which is exactly where a signal cannot reach it. The
 * only way out is the host ending the child group, which makes the RPC reject,
 * lets the node unwind, and lets it acknowledge `cancelled` — disarming the
 * worker kill timer.
 *
 * Like `process-run-orphans.spec.ts`, every assertion is on the *process*: the
 * child writes its pid immediately and a sentinel 8 s later, so a killed child
 * can no longer write that sentinel, and its pid must be gone. Liveness uses
 * the OS (`tasklist` on Windows, `ps` on POSIX), never a signal-0 probe: a
 * stale Node handle can report a dead pid as alive.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, expect, test } from 'vitest'
import type { FsService, ToolService } from '@z1/runtime'

import { ModuleWorker, type WorkerHostServices } from '../src/index.ts'
import { killAllRunProcesses } from '../src/process-run.ts'

const BLOCKER_DIR = fileURLToPath(new URL('./fixtures/blocker', import.meta.url))
const BLOCKER_NODE = 'com.example.blocker.node'
const BLOCKER_SERVICES = ['blocker']

/** The sentinel is due this long after the child starts. */
const SENTINEL_AFTER_MS = 8_000

/**
 * The one worker this file creates. `vitest.config.ts` runs each spec file in
 * its own forked process, so this file's registries hold only this worker's
 * children.
 */
let isolationWorker: ModuleWorker | undefined

afterEach(async () => {
  const worker = isolationWorker
  isolationWorker = undefined
  if (worker !== undefined) await worker.dispose().catch(() => undefined)
  await killAllRunProcesses()
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Resolve when `path` exists and is non-empty. */
async function readWhenWritten(path: string): Promise<string> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim()
      if (text.length > 0) return text
    }
    if (Date.now() > deadline) throw new Error(`expected ${path} to be written`)
    await delay(20)
  }
}

/**
 * Ask the operating system whether `pid` is a running process.
 *
 * Only an explicit, parseable "no such process" counts as dead; if the probe
 * itself cannot run, the test fails loudly instead of guessing.
 */
function isAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    // No match prints "INFO: No tasks are running which match the specified
    // criteria."; a match prints one CSV row whose first field is the image.
    const trimmed = output.trim()
    if (trimmed.length === 0 || trimmed.startsWith('INFO:')) return false
    return trimmed.split('\n')[0]?.includes(`"${pid}"`) === true
  }
  try {
    execFileSync('ps', ['-p', String(pid)], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function moduleDirServices(): WorkerHostServices {
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

/**
 * A worker over `fixtures/blocker`. Every `execute` here takes a signal, so
 * `#abortExecution` runs — and a node still stuck in `process.run` when the
 * assert window closes would surface as `state === 'dead'`.
 */
function blockerWorker(): ModuleWorker {
  const worker = new ModuleWorker({
    moduleDir: BLOCKER_DIR,
    entry: 'index.js',
    manifestNodeIds: [BLOCKER_NODE],
    manifestServiceIds: BLOCKER_SERVICES,
    capabilities: {
      fs: { read: ['${moduleDir}/**'] },
      process: { spawn: ['node'] },
    },
    services: moduleDirServices(),
  })
  isolationWorker = worker
  return worker
}

test('aborting an execution whose node sits in process.run reaps the child and keeps the worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'z1-blocker-node-'))
  const worker = blockerWorker()
  await worker.start()

  const controller = new AbortController()
  const execution = worker.execute(
    BLOCKER_NODE,
    {},
    { dir, sentinelAfterMs: SENTINEL_AFTER_MS },
    null,
    controller.signal,
  )
  execution.catch(() => undefined)

  // The child is genuinely running before the abort: the rest of the test
  // asserts on what the cancel does to it.
  const pidText = await readWhenWritten(join(dir, 'child.pid'))
  const pid = Number(pidText)
  expect(isAlive(pid)).toBe(true)

  controller.abort(new Error('test cancel'))

  await expect(execution).rejects.toThrow(/cancelled/)

  // Bounded wait: past the kill grace AND past the worker's 2 s kill timer.
  // The window ends *after* the sentinel's due time, so a surviving child has
  // had its chance to write it — otherwise "sentinel never appeared" would be
  // a claim about the clock, not about the child.
  await delay(SENTINEL_AFTER_MS + 500)

  // Collect every observation before asserting, so one failure report shows
  // whether the child survived, whether it wrote the sentinel, and whether the
  // worker was SIGKILLed — rather than stopping at the first of the three.
  const observed = {
    workerState: worker.state,
    childAlive: isAlive(pid),
    sentinelWritten: existsSync(join(dir, 'sentinel')),
  }
  // The failure the fix exists for: the node never unwound, so the host used
  // to SIGKILL the whole module worker 2 s after the abort.
  expect(observed).toEqual({ workerState: 'ready', childAlive: false, sentinelWritten: false })
}, 40_000)

test('cancelling one execution reaps only its child; a sibling keeps the worker alive', async () => {
  // The cancel now kills a process group. It must be the *cancelled* call's
  // group only: the worker hosts other runs, and one of them being blocked in
  // its own `process.run` is the case that used to take the whole worker down.
  const victimDir = mkdtempSync(join(tmpdir(), 'z1-blocker-victim-'))
  const survivorDir = mkdtempSync(join(tmpdir(), 'z1-blocker-survivor-'))
  const worker = blockerWorker()
  await worker.start()

  const controller = new AbortController()
  const victim = worker.execute(
    BLOCKER_NODE,
    {},
    { dir: victimDir, sentinelAfterMs: SENTINEL_AFTER_MS },
    null,
    controller.signal,
  )
  victim.catch(() => undefined)
  // No signal: this one must finish on its own terms, untouched by the cancel.
  // Its sentinel is due well after this test's window, so a surviving child is
  // still *running* at the assert — alive and not yet sentineled.
  const survivor = worker.execute(
    BLOCKER_NODE,
    {},
    { dir: survivorDir, sentinelAfterMs: SENTINEL_AFTER_MS * 10 },
    null,
  )
  // Dispose rejects the survivor; that rejection is expected and consumed.
  survivor.catch(() => undefined)
  const victimPid = Number(await readWhenWritten(join(victimDir, 'child.pid')))
  const survivorPid = Number(await readWhenWritten(join(survivorDir, 'child.pid')))

  controller.abort(new Error('test cancel'))

  await expect(victim).rejects.toThrow(/cancelled/)
  // Past the worker kill timer AND the victim's sentinel time, so both the
  // "worker acked" and "child never ran on" halves are observable. The
  // survivor's sentinel is 80 s out, so *its* absence here means nothing and
  // is not asserted — liveness of its child is the claim.
  await delay(SENTINEL_AFTER_MS + 500)

  // The victim's child is gone; the sibling's is alive and untouched. Collected
  // first for the same reason as the test above.
  const observed = {
    workerState: worker.state,
    victimAlive: isAlive(victimPid),
    victimSentinel: existsSync(join(victimDir, 'sentinel')),
    survivorAlive: isAlive(survivorPid),
  }
  expect(observed).toEqual({
    workerState: 'ready',
    victimAlive: false,
    victimSentinel: false,
    survivorAlive: true,
  })

  // The survivor is still blocked in its own call. Disposing the worker is the
  // "everything" path and must still reach it.
  await worker.dispose()
  isolationWorker = undefined
  await killAllRunProcesses('SIGTERM')
  await delay(500)
  expect(isAlive(survivorPid)).toBe(false)
}, 60_000)

test('a timed-out service call reaps the process.run child it started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'z1-blocker-service-'))
  const worker = blockerWorker()
  await worker.startAll()

  await expect(
    worker.serviceCall('blocker', 'block', [dir, SENTINEL_AFTER_MS], { timeoutMs: 500 }),
  ).rejects.toThrow(/exceeded its 500ms timeout/)

  const pid = Number(await readWhenWritten(join(dir, 'child.pid')))
  // Past the sentinel's due time, so its absence is evidence (see above).
  await delay(SENTINEL_AFTER_MS + 500)

  // The module service never looks at `ctx.signal`, so only the timeout path
  // reaping its child can end it — the worker is not killed on this path.
  const observed = {
    workerState: worker.state,
    childAlive: isAlive(pid),
    sentinelWritten: existsSync(join(dir, 'sentinel')),
  }
  expect(observed).toEqual({ workerState: 'ready', childAlive: false, sentinelWritten: false })
}, 40_000)
