import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ChatMessage } from '@z1/node'
import { afterEach, describe, expect, test } from 'vitest'

import {
  SessionClearedError,
  SessionCorruptError,
  createSessionStore,
  type SessionStore,
} from '../src/index.ts'
import { acquireLock } from '../src/fsutil.ts'
import { LOCK_FILE } from '../src/paths.ts'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix = 'z1-session-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function open(cwd: string, env: Record<string, string | undefined> = {}): SessionStore {
  return createSessionStore({ cwd, env })
}

function newSession(store: SessionStore, cwd: string, name?: string) {
  return store.create({
    ...(name === undefined ? {} : { name }),
    cwd,
    model: { provider: 'river', model: 'deepseek-ai/test' },
    contextWindow: 131_072,
    maxSteps: 64,
  })
}

function user(text: string): ChatMessage {
  return { role: 'user', content: text }
}

function assistant(text: string): ChatMessage {
  return { role: 'assistant', content: text }
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sessionDir(store: SessionStore, id: string): string {
  return join(store.root, 'sessions', id)
}

function lockPath(store: SessionStore, id: string): string {
  return join(sessionDir(store, id), LOCK_FILE)
}

function eventLines(store: SessionStore, id: string): string[] {
  const text = readFileSync(join(sessionDir(store, id), 'events.jsonl'), 'utf8')
  return text.split('\n').filter((line) => line !== '')
}

function eventOrds(store: SessionStore, id: string): number[] {
  return eventLines(store, id).map((line) => (JSON.parse(line) as { ord: number }).ord)
}

const CHILD = fileURLToPath(new URL('./race-child.ts', import.meta.url))

function spawnChild(args: readonly string[]) {
  const child = spawn(process.execPath, ['--experimental-strip-types', CHILD, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  // Created at spawn time: `once(child, 'exit')` would hang if the child exits
  // before the test starts waiting for it.
  const exited = new Promise<number | null>((settle) => {
    child.once('exit', (code) => {
      settle(code)
    })
  })
  return { exited, out: () => stdout, err: () => stderr }
}

function waitForFile(file: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`)
    sleepSync(2)
  }
}

describe('concurrency', () => {
  test(
    'an append and a clear in two processes never leave a corrupt transcript',
    { timeout: 60_000 },
    async () => {
      const cwd = tempDir()
      const store = open(cwd)
      const id = newSession(store, cwd).meta.id
      // ~1.4 MB; a replay takes a few ms and an fsync'd append a few more, so a
      // clear from the other process has a real window to land inside one.
      const seed: ChatMessage[] = Array.from({ length: 5_000 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${String(index)} ${'seed '.repeat(36)}`,
      }))
      store.appendTurn(id, seed)

      const runner = spawnChild(['rounds', cwd, id, '80', '2', '40'])

      const rejections: Error[] = []
      let cleared = 0
      let contended = 0
      // Bounded by count, not by `exitCode`: `exitCode` is only updated by the
      // event loop, which this synchronous loop deliberately starves. Both
      // processes are alive for the whole loop, which is the point.
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const started = performance.now()
        try {
          store.clear(id)
          cleared += 1
        } catch (error) {
          rejections.push(error as Error)
        }
        if (performance.now() - started > 3) contended += 1
        sleepSync(4)
      }
      const code = await runner.exited

      expect(runner.err()).toBe('')
      expect(code).toBe(0)
      // The race actually happened: at least one clear won a turn.
      expect(cleared).toBeGreaterThan(0)
      const stats = JSON.parse(runner.out().trim().split('\n').at(-1) ?? '{}') as {
        rounds?: number
        cleared?: number
        locked?: number
      }
      expect(stats.rounds).toBeGreaterThan(0)
      // Evidence of overlap, not just two processes taking turns: either the
      // child's guarded append was rejected by a clear that landed between its
      // read and its write, or a clear waited on the child's lock.
      expect((stats.cleared ?? 0) + (stats.locked ?? 0) + contended).toBeGreaterThan(0)
      // A clear that could not get the lock is the documented clean refusal.
      for (const error of rejections) expect(error.message).toMatch(/could not acquire/)

      // Whatever the interleaving was, the log is readable and self-consistent:
      // ords contiguous from 0 (the old unlocked code could write a log whose
      // first line was `ord 1`), count matches, no torn tail.
      const after = store.load(id)
      expect(after).toBeDefined()
      expect(after?.tornTail).toBe(false)
      expect(after?.meta.messageCount).toBe(after?.messages.length)
      const ords = eventOrds(store, id)
      expect(ords).toEqual(ords.map((_, index) => index))
      expect(existsSync(lockPath(store, id))).toBe(false)

      // The session is still usable by a client that reloads before appending.
      store.appendTurn(id, [...(after?.messages ?? []), user('after')], {
        generation: after?.meta.generation ?? 0,
      })
      expect(store.load(id)?.messages.at(-1)).toEqual(user('after'))
      store.clear(id)
      expect(store.load(id)?.messages).toEqual([])
      const settled = store.load(id)
      store.appendTurn(id, [user('fresh')], { generation: settled?.meta.generation ?? 0 })
      expect(store.load(id)?.messages).toEqual([user('fresh')])
    },
  )

  test(
    'a clear waits for a writer that holds the lock instead of truncating under it',
    { timeout: 30_000 },
    async () => {
      const cwd = tempDir()
      const store = open(cwd)
      const id = newSession(store, cwd).meta.id
      store.appendTurn(id, [user('one'), assistant('1')])
      const barrier = join(tempDir('z1-barrier-'), 'ready')

      const runner = spawnChild(['hold', cwd, id, '300', barrier])
      waitForFile(barrier, 10_000)
      expect(existsSync(lockPath(store, id))).toBe(true)

      const started = performance.now()
      store.clear(id)
      const waited = performance.now() - started
      const code = await runner.exited

      expect(runner.err()).toBe('')
      expect(code).toBe(0)
      // The lock is held for 300 ms from before the barrier file appears.
      expect(waited).toBeGreaterThan(200)
      expect(store.load(id)?.messages).toEqual([])
      expect(store.load(id)?.meta.generation).toBe(1)
      expect(existsSync(lockPath(store, id))).toBe(false)
    },
  )
})

describe('generation guard', () => {
  test('an append read before a clear is rejected and writes nothing', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    store.appendTurn(id, [user('one'), assistant('1')])

    const read = store.load(id)
    expect(read?.messages).toHaveLength(2)
    // A freshly created session has no generation on disk; it reads as 0.
    expect(read?.meta.generation).toBeUndefined()

    store.clear(id)
    const cleared = store.load(id)
    expect(cleared?.messages).toEqual([])
    expect(cleared?.meta.generation).toBe(1)

    const eventsFile = join(sessionDir(store, id), 'events.jsonl')
    const metaFile = join(sessionDir(store, id), 'meta.json')
    const eventsBefore = statSync(eventsFile).size
    const metaBefore = readFileSync(metaFile, 'utf8')

    let thrown: unknown
    try {
      store.appendTurn(id, [...(read?.messages ?? []), user('late')], {
        generation: read?.meta.generation ?? 0,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SessionClearedError)
    expect((thrown as SessionClearedError).id).toBe(id)
    expect((thrown as SessionClearedError).generation).toBe(1)
    // The rejection is not a partial write: neither file moved.
    expect(statSync(eventsFile).size).toBe(eventsBefore)
    expect(readFileSync(metaFile, 'utf8')).toBe(metaBefore)

    // Reloading at the new generation is the documented recovery.
    const fresh = store.load(id)
    store.appendTurn(id, [...(fresh?.messages ?? []), user('fresh')], {
      generation: fresh?.meta.generation ?? 0,
    })
    expect(store.load(id)?.messages).toEqual([user('fresh')])
    expect(eventOrds(store, id)).toEqual([0])
  })

  test('clear bumps the generation; clearing an empty session does not', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    const metaFile = join(sessionDir(store, id), 'meta.json')
    expect(store.list()[0]?.generation).toBe(0)

    store.appendTurn(id, [user('one')])
    store.clear(id)
    expect(store.load(id)?.meta.generation).toBe(1)
    expect(store.list()[0]?.generation).toBe(1)

    // Already empty: byte-for-byte untouched, generation and updatedAt included.
    const afterFirst = readFileSync(metaFile, 'utf8')
    store.clear(id)
    expect(readFileSync(metaFile, 'utf8')).toBe(afterFirst)
    expect(store.load(id)?.meta.generation).toBe(1)

    store.appendTurn(id, [user('two')])
    store.clear(id)
    expect(store.load(id)?.meta.generation).toBe(2)
    expect(store.list()[0]?.generation).toBe(2)
  })

  test('a meta.json without a generation reads as 0 and unguarded appends still work', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    const metaFile = join(sessionDir(store, id), 'meta.json')
    // Exactly the file an older build wrote: no `generation` key at all.
    const raw = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>
    delete raw['generation']
    writeFileSync(metaFile, `${JSON.stringify(raw, null, 2)}\n`)

    expect(store.load(id)?.meta.generation).toBeUndefined()
    expect(store.list()[0]?.generation).toBe(0)

    // No options: the old, unguarded contract.
    store.appendTurn(id, [user('one')])
    expect(store.load(id)?.messages).toEqual([user('one')])

    // An explicit 0 matches the normalised value.
    store.appendTurn(id, [user('one'), assistant('1')], { generation: 0 })
    expect(store.load(id)?.messages).toHaveLength(2)

    // Anything else is a caller that read a different transcript.
    expect(() =>
      store.appendTurn(id, [user('one'), assistant('1'), user('two')], { generation: 3 }),
    ).toThrow(SessionClearedError)
    expect(store.load(id)?.messages).toHaveLength(2)
  })
})

describe('lock', () => {
  test('a callback that throws releases the lock', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    store.appendTurn(id, [user('one')])
    store.clear(id)

    // Throws from inside the locked section (generation guard).
    expect(() => store.appendTurn(id, [user('stale')], { generation: 0 })).toThrow(
      SessionClearedError,
    )
    expect(existsSync(lockPath(store, id))).toBe(false)
    // A leaked lock would make this take a second and fail.
    store.setMeta(id, { name: 'after the throw' })
    expect(store.load(id)?.meta.name).toBe('after the throw')
    expect(existsSync(lockPath(store, id))).toBe(false)
  })

  test('clear refuses a symlinked transcript and still releases the lock', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    store.appendTurn(id, [user('one')])
    const eventsFile = join(sessionDir(store, id), 'events.jsonl')
    const outside = join(tempDir('z1-outside-'), 'events.jsonl')
    writeFileSync(outside, 'kept\n')
    unlinkSync(eventsFile)
    symlinkSync(outside, eventsFile)

    expect(() => store.clear(id)).toThrow(SessionCorruptError)
    expect(existsSync(lockPath(store, id))).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('kept\n')
  })

  test('a lock is reclaimed only when its holder is dead; a live holder keeps it', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    const lock = lockPath(store, id)
    const old = new Date(Date.now() - 120_000)

    // A dead pid: reclaimed immediately, and the append that reclaimed it
    // released at the end.
    writeFileSync(lock, '99999\n', { mode: 0o600 })
    utimesSync(lock, old, old)
    store.appendTurn(id, [user('one')])
    expect(store.load(id)?.messages).toEqual([user('one')])
    expect(existsSync(lock)).toBe(false)

    // Dead pid with a *fresh* mtime: age is no longer what decides.
    writeFileSync(lock, '99999\n', { mode: 0o600 })
    store.appendTurn(id, [user('one'), assistant('1')])
    expect(store.load(id)?.messages).toHaveLength(2)
    expect(existsSync(lock)).toBe(false)

    // A live holder (`process.pid`): never reclaimed, however old the file is.
    const liveBody = `${String(process.pid)}\n`
    writeFileSync(lock, liveBody, { mode: 0o600 })
    utimesSync(lock, old, old)
    const inode = statSync(lock).ino
    const agedMtime = statSync(lock).mtimeMs
    expect(() => acquireLock(lock, { attempts: 3, retryMs: 5 })).toThrow(/could not acquire/)
    // The very same file is still there: no unlink-and-recreate.
    expect(statSync(lock).ino).toBe(inode)
    expect(statSync(lock).mtimeMs).toBe(agedMtime)
    expect(readFileSync(lock, 'utf8')).toBe(liveBody)

    // Reads are lock-free: a held lock does not block `load`.
    const started = performance.now()
    expect(store.load(id)?.messages).toHaveLength(2)
    expect(performance.now() - started).toBeLessThan(500)

    // A held lock is a clean, named refusal for a writer, not corruption.
    expect(() =>
      store.appendTurn(id, [user('one'), assistant('1'), user('two')]),
    ).toThrow(/could not acquire/)
    expect(readFileSync(lock, 'utf8')).toBe(liveBody)
    unlinkSync(lock)

    // No readable pid at all: the mtime fallback decides, and it is two
    // observations on the same inode, not "delete whatever looks old".
    writeFileSync(lock, '', { mode: 0o600 })
    const bodylessIno = statSync(lock).ino
    expect(() => acquireLock(lock, { attempts: 3, retryMs: 5 })).toThrow(/could not acquire/)
    expect(statSync(lock).ino).toBe(bodylessIno)
    expect(readFileSync(lock, 'utf8')).toBe('')

    // Old enough, still unowned: now it is reclaimed by the next writer.
    utimesSync(lock, old, old)
    const release = acquireLock(lock, { attempts: 3, retryMs: 5 })
    expect(readFileSync(lock, 'utf8').startsWith(`${String(process.pid)}\n`)).toBe(true)
    release()
    expect(existsSync(lock)).toBe(false)

    store.appendTurn(id, [user('one'), assistant('1'), user('two')])
    expect(store.load(id)?.messages).toHaveLength(3)
  })

  test(
    'a spawned live holder keeps its lock even when the file looks old',
    { timeout: 30_000 },
    async () => {
      const cwd = tempDir()
      const store = open(cwd)
      const id = newSession(store, cwd).meta.id
      const lock = lockPath(store, id)
      const barrier = join(tempDir('z1-barrier-'), 'held')
      const releaseFile = join(tempDir('z1-barrier-'), 'release')

      // The holder stays alive until this test releases it, so the writer below
      // spends its whole bounded wait against a *live* holder rather than
      // racing a fixed sleep.
      const runner = spawnChild(['hold-exit', cwd, id, barrier, releaseFile])
      waitForFile(barrier, 10_000)
      const body = readFileSync(lock, 'utf8')
      const holder = Number(body.split('\n')[0])
      expect(holder).toBeGreaterThan(0)

      // Age the file: liveness, not mtime, is what keeps this lock alive.
      const old = new Date(Date.now() - 3_600_000)
      utimesSync(lock, old, old)
      const inode = statSync(lock).ino
      expect(() => acquireLock(lock, { attempts: 3, retryMs: 5 })).toThrow(/could not acquire/)
      // A full default wait (~1 s of retries) still finds the holder alive: a
      // mtime an hour in the past never decides. The refusal is clean and the
      // lock is untouched, not deleted and re-created.
      expect(() => store.appendTurn(id, [user('one')])).toThrow(/could not acquire/)
      expect(statSync(lock).ino).toBe(inode)
      expect(readFileSync(lock, 'utf8')).toBe(body)

      writeFileSync(releaseFile, 'go\n')
      expect(runner.err()).toBe('')
      expect(await runner.exited).toBe(0)

      // Its pid is dead now, so the lock is reclaimed immediately even though a
      // human would call it ancient.
      store.appendTurn(id, [user('one')])
      expect(store.load(id)?.messages).toEqual([user('one')])
      expect(existsSync(lock)).toBe(false)
    },
  )

  test(
    'a heartbeat is unref\'d: the holder exits while its timer is still armed',
    { timeout: 30_000 },
    async () => {
      const cwd = tempDir()
      const store = open(cwd)
      const id = newSession(store, cwd).meta.id
      const lock = lockPath(store, id)
      const barrier = join(tempDir('z1-barrier-'), 'held')

      // The child ages the lock, waits on its own timer, and then lets the
      // event loop drain. A ref'd heartbeat would keep it alive forever.
      const runner = spawnChild(['heartbeat-exit', cwd, id, barrier, '160'])
      waitForFile(barrier, 10_000)
      const code = await runner.exited
      expect(runner.err()).toBe('')
      expect(runner.out()).toContain('done')
      expect(code).toBe(0)

      // The heartbeat fired at least once: the mtime the child aged to an hour
      // ago is fresh again, and the child never released the lock.
      expect(existsSync(lock)).toBe(true)
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(30_000)

      // Dead pid: reclaimed immediately by the next writer.
      store.appendTurn(id, [user('one')])
      expect(store.load(id)?.messages).toEqual([user('one')])
      expect(existsSync(lock)).toBe(false)
    },
  )

  test('a release refuses a lock that is no longer ours', () => {
    const dir = tempDir()
    const lock = join(dir, LOCK_FILE)

    // Stolen: same path, different inode, another owner's body.
    const first = acquireLock(lock, { heartbeatMs: 0 })
    const stolen = `${String(process.pid)}\n${'ab'.repeat(8)}\n`
    unlinkSync(lock)
    writeFileSync(lock, stolen, { mode: 0o600 })
    first()
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe(stolen)

    // Rewritten in place: same inode, somebody else's token.
    unlinkSync(lock)
    const second = acquireLock(lock, { heartbeatMs: 0 })
    const rewritten = `${String(process.pid)}\n${'cd'.repeat(8)}\n`
    writeFileSync(lock, rewritten, { mode: 0o600 })
    second()
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe(rewritten)

    unlinkSync(lock)
  })

  test('a heartbeat never refreshes a lock that was stolen', async () => {
    const dir = tempDir()
    const lock = join(dir, LOCK_FILE)
    const release = acquireLock(lock, { heartbeatMs: 20 })
    const stolen = `${String(process.pid)}\n${'ef'.repeat(8)}\n`
    const aged = new Date(Date.now() - 120_000)
    unlinkSync(lock)
    writeFileSync(lock, stolen, { mode: 0o600 })
    utimesSync(lock, aged, aged)
    const inode = statSync(lock).ino
    const mtime = statSync(lock).mtimeMs

    // Let the timer fire several times: it must see a foreign inode and stop.
    await new Promise<void>((settle) => setTimeout(settle, 120))

    expect(statSync(lock).ino).toBe(inode)
    expect(statSync(lock).mtimeMs).toBe(mtime)
    expect(readFileSync(lock, 'utf8')).toBe(stolen)

    release()
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe(stolen)
    unlinkSync(lock)
  })

  test('a count repair under the lock keeps a name, an archive and the runs list', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    store.appendTurn(id, [user('one'), assistant('1')])
    const metaFile = join(sessionDir(store, id), 'meta.json')
    const raw = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>

    // A crash after the events append: only the count is stale, and a rename
    // and an archive landed in the meantime.
    const staged = { ...raw, messageCount: 0, name: 'renamed', archived: true }
    writeFileSync(metaFile, `${JSON.stringify(staged, null, 2)}\n`)

    const loaded = store.load(id)
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.meta.messageCount).toBe(2)
    expect(loaded?.meta.name).toBe('renamed')
    expect(loaded?.meta.archived).toBe(true)

    // The repair re-read the file under the lock and merged one field.
    const repaired = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>
    expect(repaired['messageCount']).toBe(2)
    expect(repaired['name']).toBe('renamed')
    expect(repaired['archived']).toBe(true)
    expect(repaired['runs']).toEqual(raw['runs'])

    // A live holder blocks the repair: the read is still consistent in memory,
    // and nobody writes meta.json under a writer that owns the lock.
    writeFileSync(metaFile, `${JSON.stringify({ ...raw, messageCount: 0 }, null, 2)}\n`)
    const lock = lockPath(store, id)
    writeFileSync(lock, `${String(process.pid)}\n`, { mode: 0o600 })
    const during = store.load(id)
    expect(during?.messages).toHaveLength(2)
    expect(during?.meta.messageCount).toBe(2)
    const untouched = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>
    expect(untouched['messageCount']).toBe(0)
    unlinkSync(lock)

    // Once the holder is gone, the same read repairs the file.
    expect(store.load(id)?.meta.messageCount).toBe(2)
    const after = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>
    expect(after['messageCount']).toBe(2)
  })

  test('a release is idempotent', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    const lock = lockPath(store, id)

    const release = acquireLock(lock)
    expect(existsSync(lock)).toBe(true)
    release()
    expect(existsSync(lock)).toBe(false)
    release()
    expect(existsSync(lock)).toBe(false)
  })

  test('two appends on one session serialise with contiguous ordinals', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd).meta.id
    const second = open(cwd)

    store.appendTurn(id, [user('one')])
    // The second store read the session after the first append landed; the lock
    // is what makes "read, then append" safe when the two overlap in time.
    const read = second.load(id)
    second.appendTurn(id, [...(read?.messages ?? []), assistant('1')])

    expect(eventOrds(store, id)).toEqual([0, 1])
    expect(store.load(id)?.messages).toEqual([user('one'), assistant('1')])
    expect(store.load(id)?.meta.messageCount).toBe(2)
    expect(eventLines(store, id).every((line) => (JSON.parse(line) as { type: string }).type === 'message')).toBe(true)
  })

  test('.lock is not a session and never reaches list, load, latest or trash', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const id = newSession(store, cwd, 'locked').meta.id
    store.appendTurn(id, [user('one')])
    writeFileSync(lockPath(store, id), `${String(process.pid)}\n`, { mode: 0o600 })

    const listing = store.list()
    expect(listing).toHaveLength(1)
    expect(listing[0]?.id).toBe(id)
    expect(JSON.stringify(listing)).not.toContain(LOCK_FILE)

    const loaded = store.load(id)
    expect(loaded?.messages).toEqual([user('one')])
    expect(loaded?.tornTail).toBe(false)
    expect(store.latest()?.id).toBe(id)
    expect(JSON.stringify(loaded)).not.toContain(LOCK_FILE)

    // `remove` renames the directory (lock and all) and drops the lock inside
    // the trash copy; it must not fail while a lock file exists.
    expect(() => store.remove(id)).not.toThrow()
    expect(store.list()).toEqual([])
    expect(store.load(id)).toBeUndefined()
    const trash = readdirSync(join(store.root, '.trash'))
    expect(trash).toHaveLength(1)
    expect(readdirSync(join(store.root, '.trash', trash[0] ?? ''))).not.toContain(LOCK_FILE)
  })
})
