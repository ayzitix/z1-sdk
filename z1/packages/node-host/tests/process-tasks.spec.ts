/**
 * Background tasks are host-owned: a worker cannot spawn a child, and the
 * request/response `process.run` cannot model a dev server. These tests pin the
 * lifecycle (start → poll by cursor → exit/kill) and the output bound.
 */

import { afterEach, expect, test } from 'vitest'

import { ProcessTasks, type BackgroundTaskSnapshot } from '../src/index.ts'

const tasks: ProcessTasks[] = []

function newTasks(maxOutputBytes?: number): ProcessTasks {
  const instance = new ProcessTasks(
    maxOutputBytes === undefined ? {} : { maxOutputBytes },
  )
  tasks.push(instance)
  return instance
}

afterEach(() => {
  for (const instance of tasks.splice(0)) instance.dispose()
})

/** Poll until the task leaves `running`, with a wall-clock guard. */
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
  expect(killed.status).toBe('killed')
  const finished = await settled(instance, started.id)
  expect(finished.status).toBe('killed')
  expect(finished.endedAt).not.toBeNull()
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

  instance.dispose()
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
