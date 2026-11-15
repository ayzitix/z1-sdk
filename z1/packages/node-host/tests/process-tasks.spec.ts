/**
 * Background tasks are host-owned: a worker cannot spawn a child, and the
 * request/response `process.run` cannot model a dev server. These tests pin the
 * lifecycle (start → poll by cursor → exit/kill) and the output bound.
 */

import { afterEach, expect, test } from 'vitest'

import { ProcessTasks, type BackgroundTaskSnapshot } from '../src/index.ts'

const tasks: ProcessTasks[] = []

function newTasks(maxOutputChars?: number): ProcessTasks {
  const instance = new ProcessTasks(
    maxOutputChars === undefined ? {} : { maxOutputChars },
  )
  tasks.push(instance)
  return instance
}

afterEach(async () => {
  // `dispose()` is async: it signals each group, waits out a bounded grace and
  // then SIGKILLs whatever is left.
  await Promise.all(tasks.splice(0).map((instance) => instance.dispose()))
})

/** Poll until the task has ended, whatever the status said in between. */
async function settled(
  instance: ProcessTasks,
  id: string,
): Promise<BackgroundTaskSnapshot> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const snapshot = instance.poll({ id })
    // `kill` reports the intent immediately; the process is gone only once the
    // exit event has landed.
    if (snapshot.endedAt !== null) return snapshot
    if (Date.now() > deadline) throw new Error(`task ${id} did not settle`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('a task runs, prints, exits and is read by cursor', async () => {
  const instance = newTasks()
  const started = instance.start({
    command: process.execPath,
    args: ['-e', "console.log('one'); console.error('two')"],
    cwd: process.cwd(),
  })
  expect(started.id).toMatch(/^bg_/)
  expect(started.status).toBe('running')

  const finished = await settled(instance, started.id)
  expect(finished.status).toBe('exited')
  expect(finished.exitCode).toBe(0)
  // stdout and stderr share one stream, like a terminal.
  expect(finished.output).toContain('one')
  expect(finished.output).toContain('two')
  expect(finished.size).toBeGreaterThan(0)

  // The cursor is absolute: a second poll returns no old bytes.
  const next = instance.poll({ id: started.id, cursor: finished.cursor })
  expect(next.output).toBe('')
  expect(next.cursor).toBe(finished.cursor)
})

test('a long-running task is killed as a process group', async () => {
  const instance = newTasks()
  const started = instance.start({
    command: process.execPath,
    // A child of its own: killing only the parent would leave this one alive.
    args: ['-e', "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']); setInterval(()=>{},1000)"],
    cwd: process.cwd(),
  })

  const killed = instance.kill({ id: started.id })
  // A signal is a request, not a death certificate: the task is `stopping`
  // until the exit event lands.
  expect(killed.status).toBe('stopping')
  expect(killed.killSignal).toBe('SIGTERM')
  expect(killed.endedAt).toBeNull()

  const finished = await settled(instance, started.id)
  expect(finished.status).toBe('killed')
  expect(finished.killSignal).toBe('SIGTERM')
  expect(finished.endedAt).not.toBeNull()
  expect(finished.endedAt).toBeGreaterThanOrEqual(finished.startedAt)
})

test('kill leaves output written before death readable at the returned cursor', async () => {
  const instance = newTasks()
  const started = instance.start({
    command: process.execPath,
    args: [
      '-e',
      // Prints, then keeps running: the line is in the buffer when the signal
      // arrives, and a cursor that jumped to the end would lose it.
      "process.stdout.write('before-death'); setInterval(()=>{},1000)",
    ],
    cwd: process.cwd(),
  })

  // Polling here does not move any stored cursor, so the kill below is the
  // caller's first read.
  const deadline = Date.now() + 10_000
  while (!instance.poll({ id: started.id }).output.includes('before-death')) {
    if (Date.now() > deadline) throw new Error('task never wrote before-death')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  const killed = instance.kill({ id: started.id })
  // The signal is only a request, but it must not consume the output either.
  expect(killed.status).toBe('stopping')
  expect(killed.cursor).toBe(0)
  expect(killed.more).toBe(true)
  expect(killed.output).toContain('before-death')

  const after = instance.poll({ id: started.id, cursor: killed.cursor })
  expect(after.output).toContain('before-death')
  expect(after.cursor).toBe(killed.cursor + 'before-death'.length)

  const finished = await settled(instance, started.id)
  expect(finished.status).toBe('killed')
  // Killing an already-ended task still reports the unread text, not an empty
  // snapshot at the end of the buffer.
  const replayed = instance.kill({ id: started.id })
  expect(replayed.status).toBe('killed')
  expect(replayed.output).toContain('before-death')
})

test('a poller never sees the exit before the output streams are drained', async () => {
  const instance = newTasks()
  // An escaped grandchild (its own process group, so the group kill that
  // follows the leader's exit misses it) inherits the stdout pipe and writes
  // into it after the leader is reaped. Those bytes reach the host between
  // `exit` and `close`, which is exactly the window a terminal status published
  // on `exit` would close early, losing them.
  const script = [
    "const { spawn } = require('node:child_process')",
    "spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('late-write\\\\n'), 150)\"], { detached: true, stdio: 'inherit' })",
    "process.stdout.write('leader-before-exit\\n')",
    'setTimeout(() => process.exit(0), 40)',
  ].join('; ')

  const started = instance.start({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
  })

  const deadline = Date.now() + 10_000
  let early = 0
  let terminal: BackgroundTaskSnapshot | undefined
  while (terminal === undefined) {
    const snapshot = instance.poll({ id: started.id })
    const late = snapshot.output.includes('late-write')
    if (snapshot.status === 'exited' || snapshot.status === 'killed') {
      // The terminal status is what a poller stops on: every byte, including
      // the one written after the leader died, must already be there.
      if (!late) early += 1
      terminal = snapshot
    }
    if (Date.now() > deadline) throw new Error('task never reached a terminal status')
    if (terminal === undefined) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  expect(early).toBe(0)
  expect(terminal.output).toContain('leader-before-exit')
  expect(terminal.output).toContain('late-write')
  expect(terminal.endedAt).not.toBeNull()
  // Output stays readable after the exit, from the start and from the end.
  expect(instance.poll({ id: started.id, cursor: 0 }).output).toContain('late-write')
  expect(instance.poll({ id: started.id, cursor: terminal.size }).output).toBe('')
})

test('a cursor walker gets the output whether it arrives before or at the exit', async () => {
  const instance = newTasks()

  /** Read like a client: poll, advance the cursor, accumulate what came back. */
  const walk = async (id: string) => {
    let snapshot = instance.poll({ id })
    let text = snapshot.output
    let beforeExit = text.length > 0 && snapshot.status !== 'exited' && snapshot.status !== 'killed'
    const deadline = Date.now() + 10_000
    while (snapshot.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      snapshot = instance.poll({ id, cursor: snapshot.cursor })
      text += snapshot.output
      if (snapshot.output.length > 0 && snapshot.status !== 'exited' && snapshot.status !== 'killed') {
        beforeExit = true
      }
    }
    return { snapshot, text, beforeExit }
  }

  // Output first: the line is readable while the task is still alive, so the
  // terminal snapshot that follows has nothing left to return.
  const early = instance.start({
    command: process.execPath,
    args: [
      '-e',
      "console.log('early-output'); setTimeout(() => process.exit(0), 200)",
    ],
    cwd: process.cwd(),
  })
  const earlyWalk = await walk(early.id)
  expect(earlyWalk.beforeExit).toBe(true)
  expect(earlyWalk.text).toContain('early-output')
  expect(earlyWalk.snapshot.status).toBe('exited')

  // Output last: the leader is reaped first and the line reaches the host with
  // the end of the stream, so it can only be in the terminal snapshot.
  const lateScript = [
    "const { spawn } = require('node:child_process')",
    "spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('late-write\\\\n'), 120)\"], { detached: true, stdio: 'inherit' })",
    'setTimeout(() => process.exit(0), 40)',
  ].join('; ')
  const late = instance.start({
    command: process.execPath,
    args: ['-e', lateScript],
    cwd: process.cwd(),
  })
  const lateWalk = await walk(late.id)
  expect(lateWalk.text).toContain('late-write')
  expect(lateWalk.snapshot.status).toBe('exited')
  expect(lateWalk.snapshot.endedAt).not.toBeNull()
})

test('an unknown task id is an error, not a silent empty result', async () => {
  const instance = newTasks()
  expect(() => instance.poll({ id: 'bg_nope' })).toThrow(/unknown background task/)
  expect(() => instance.kill({ id: 'bg_nope' })).toThrow(/unknown background task/)
})

test('the retained buffer keeps the tail and reports what it dropped', async () => {
  const instance = newTasks(64)
  const started = instance.start({
    command: process.execPath,
    args: ['-e', "process.stdout.write('A'.repeat(200)); console.log('TAIL')"],
    cwd: process.cwd(),
  })
  await settled(instance, started.id)

  const snapshot = instance.poll({ id: started.id, cursor: 0 })
  expect(snapshot.truncated).toBe(true)
  expect(snapshot.output.length).toBeLessThanOrEqual(64)
  expect(snapshot.output).toContain('TAIL')

  // A cursor past the retained head is served from the tail, not from zero.
  const tail = instance.poll({ id: started.id, cursor: snapshot.size - 6 })
  expect(tail.output).toContain('TAIL')
})

test('list shows every task and dispose stops the running ones', async () => {
  const instance = newTasks()
  const running = instance.start({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(),
  })
  const quick = instance.start({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    cwd: process.cwd(),
  })
  await settled(instance, quick.id)
  expect(instance.list().map((task) => task.id).sort()).toEqual(
    [running.id, quick.id].sort(),
  )

  await instance.dispose()
  // After dispose the registry is gone; the child must not be left behind.
  expect(instance.list()).toHaveLength(0)
  const deadline = Date.now() + 5_000
  let alive = true
  while (alive && Date.now() < deadline) {
    try {
      process.kill(running.pid ?? 0, 0)
      await new Promise((resolve) => setTimeout(resolve, 20))
    } catch {
      alive = false
    }
  }
  expect(alive).toBe(false)
})
