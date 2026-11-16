/**
 * The second *process* `concurrency.spec.ts` uses to prove the per-session lock
 * serialises writers across processes, not just across calls in one process.
 * `vitest` only collects `*.spec.ts`, so this file is inert.
 *
 * Run with type stripping (`node --experimental-strip-types race-child.ts …`).
 *
 * Modes:
 *   rounds <cwd> <id> <rounds> <gapMs> <chunk>
 *     Each round is a real client turn: read the transcript, append `chunk`
 *     messages on top of it at the generation that read saw. The read-to-append
 *     window is where a concurrent `clear` used to land and leave a log whose
 *     ordinals started at the wrong number.
 *   hold <cwd> <id> <ms> <barrierFile>
 *     Take the session lock without writing anything, report via the barrier
 *     file, hold it for `ms`, release. The parent times a `clear` across it.
 *   hold-exit <cwd> <id> <barrierFile> <releaseFile> [capMs]
 *     Take the session lock, report via the barrier file, then wait for the
 *     parent to create `releaseFile` and exit **without releasing**: the parent
 *     holds a writer off a lock whose holder is guaranteed alive (no sleep to
 *     outlast), and the lock it leaves behind has a dead pid. `capMs` (default
 *     15 s) keeps a failing parent from stranding the child.
 *   heartbeat-exit <cwd> <id> <barrierFile> <waitMs>
 *     Take the lock with a 20 ms heartbeat, age its mtime to prove the
 *     heartbeat really refreshes it, report via the barrier file, wait `waitMs`
 *     on this process's own timer, then let the event loop drain: no release,
 *     no `process.exit`. If the heartbeat were not unref'd the process would
 *     never exit, and the lock it leaves behind has a dead pid.
 *
 * Any outcome the store documents as clean (SessionClearedError, a lock
 * timeout) is a pass; only an unexpected error is a failure, and it is reported
 * through the exit code because that is what the parent reads.
 */

import { existsSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createSessionStore } from '../src/index.ts'
import { acquireLock } from '../src/fsutil.ts'
import { LOCK_FILE } from '../src/paths.ts'
import type { ChatMessage } from '@z1/node'

function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function fail(message: string): never {
  console.error(`child: ${message}`)
  process.exit(3)
}

const [mode, cwd, id, ...rest] = process.argv.slice(2)
if (mode === undefined || cwd === undefined || id === undefined) {
  console.error('child: usage: race-child.ts rounds <cwd> <id> <rounds> <gapMs> <chunk>')
  console.error('child:        race-child.ts hold <cwd> <id> <ms> <barrierFile>')
  console.error('child:        race-child.ts hold-exit <cwd> <id> <barrierFile> <releaseFile> [capMs]')
  process.exit(2)
}

const store = createSessionStore({ cwd, env: {} })

/** `heartbeat-exit` must let the event loop decide when to exit. */
let explicitExit = true

if (mode === 'hold') {
  const holdMs = Number(rest[0] ?? '250')
  const barrier = rest[1]
  if (barrier === undefined) fail('hold needs a barrier file')
  const lock = join(store.root, 'sessions', id, LOCK_FILE)
  const release = acquireLock(lock)
  try {
    writeFileSync(barrier, `${String(process.pid)}\n`)
    sleep(holdMs)
  } finally {
    release()
  }
} else if (mode === 'hold-exit') {
  const barrier = rest[0]
  const releaseFile = rest[1]
  const capMs = Number(rest[2] ?? '15000')
  if (barrier === undefined || releaseFile === undefined) fail('hold-exit needs a barrier and a release file')
  const lock = join(store.root, 'sessions', id, LOCK_FILE)
  // Deliberately never released: the lock the parent reclaims afterwards has a
  // dead holder, which is the half of the liveness rule this mode proves.
  acquireLock(lock)
  writeFileSync(barrier, `${String(process.pid)}\n`)
  const deadline = Date.now() + capMs
  while (!existsSync(releaseFile) && Date.now() < deadline) sleep(2)
  // No `process.exit`: the unref'd heartbeat must not keep this alive.
  explicitExit = false
} else if (mode === 'heartbeat-exit') {
  const barrier = rest[0]
  const waitMs = Number(rest[1] ?? '120')
  if (barrier === undefined) fail('heartbeat-exit needs a barrier file')
  const lock = join(store.root, 'sessions', id, LOCK_FILE)
  // Deliberately never released and never explicitly released later either: the
  // heartbeat timer is the only thing that could keep the loop alive.
  acquireLock(lock, { heartbeatMs: 20 })
  // Old on purpose: only the heartbeat can make it look fresh again.
  const aged = new Date(Date.now() - 120_000)
  utimesSync(lock, aged, aged)
  writeFileSync(barrier, `${String(process.pid)}\n`)
  explicitExit = false
  setTimeout(() => {
    process.stdout.write('done\n')
  }, waitMs)
} else if (mode === 'rounds') {
  const rounds = Number(rest[0] ?? '10')
  const gap = Number(rest[1] ?? '10')
  const chunk = Number(rest[2] ?? '1')
  const results = { rounds: 0, cleared: 0, locked: 0, maxAppendMs: 0 }
  for (let round = 0; round < rounds; round += 1) {
    const loaded = store.load(id)
    if (loaded === undefined) fail('session disappeared')
    const next: ChatMessage[] = [...loaded.messages]
    for (let index = 0; index < chunk; index += 1) {
      next.push({ role: 'user', content: `child-${String(round)}-${String(index)} ${'x'.repeat(160)}` })
    }
    const startedAt = performance.now()
    try {
      // The generation the read saw: after a `clear` landed in between, this
      // must be rejected instead of re-inserting the turns the user deleted.
      store.appendTurn(id, next, { generation: loaded.meta.generation ?? 0 })
      results.rounds += 1
      results.maxAppendMs = Math.max(results.maxAppendMs, performance.now() - startedAt)
    } catch (error) {
      const name = (error as Error).name
      const message = (error as Error).message
      if (name === 'SessionClearedError') results.cleared += 1
      else if (/could not acquire/.test(message)) results.locked += 1
      else fail(`${name}: ${message}`)
    }
    sleep(gap)
  }
  process.stdout.write(`${JSON.stringify(results)}\n`)
} else {
  fail(`unknown mode ${JSON.stringify(mode)}`)
}

if (explicitExit) process.exit(0)
