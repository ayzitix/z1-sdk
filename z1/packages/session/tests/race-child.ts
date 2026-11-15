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
 *
 * Any outcome the store documents as clean (SessionClearedError, a lock
 * timeout) is a pass; only an unexpected error is a failure, and it is reported
 * through the exit code because that is what the parent reads.
 */

import { writeFileSync } from 'node:fs'
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
  process.exit(2)
}

const store = createSessionStore({ cwd, env: {} })

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

process.exit(0)
