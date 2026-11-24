/**
 * The filesystem primitives the store needs: an atomic rename for small state,
 * an fsync'd line append for the transcript, a per-session lock, and the
 * session id.
 *
 * @module @z1/session/fsutil
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Tries a rename gets before it is reported, and the pause between them. */
const WRITE_ATTEMPTS = 3
const WRITE_RETRY_MS = 20

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Rename, retrying the codes Windows reports while another process still holds
 * the source or the destination open (`EPERM`, `EBUSY`, `ENOTEMPTY`).
 *
 * `fail` builds the error a caller wants once every attempt was used, so each
 * caller can name what it was doing; the retry policy itself lives here, once.
 */
export function renameWithRetry(
  from: string,
  to: string,
  fail: (attempts: number, cause: unknown) => Error,
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY'
      if (!retryable || attempt >= WRITE_ATTEMPTS) throw fail(attempt, error)
      sleepSync(WRITE_RETRY_MS)
    }
  }
}

/** Best-effort directory fsync: makes a rename/new dirent durable on power loss. */
function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Some platforms/filesystems refuse directory fsync; the data is still written.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Write `data` so a reader sees either the old file or the new one: temp file
 * in the same directory, fsync, rename.
 *
 * The rename is retried briefly. On Windows a replace fails with `EPERM`/`EBUSY`
 * for as long as another process holds the destination open, so a reader that
 * is merely slower than this writer (or an antivirus scanning the fresh temp
 * file) used to fail a write that would have succeeded a moment later. A
 * failure that survives the retries is reported with the path and the cause: a
 * bare `rename` error names only the temp file and hides which transcript was
 * being replaced.
 */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE })
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(temporary, 'w', FILE_MODE)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameWithRetry(
      temporary,
      file,
      (attempts, cause) =>
        new Error(
          `session: could not acquire ${file} for an atomic write after ` +
            `${String(attempts)} attempt${attempts === 1 ? '' : 's'}: ${describe(cause)}`,
          { cause },
        ),
    )
  } catch (error) {
    // The temp file is this writer's own litter; never leave it behind for the
    // next reader to mistake for a transcript.
    try {
      unlinkSync(temporary)
    } catch {
      // Already gone, or a filesystem that refuses the cleanup too.
    }
    throw error
  }
  fsyncDir(dirname(file))
}

/**
 * Append whole lines and fsync before returning. A run must never report a turn
 * that is still sitting in a page cache, so there is no buffered writer here.
 */
export function appendLines(file: string, lines: readonly string[]): void {
  if (lines.length === 0) return
  const existed = existsSync(file)
  const fd = openSync(file, 'a', FILE_MODE)
  try {
    // `'a'` ignores the mode after creation; a copied 0644 transcript must be
    // tightened before more content is added.
    try {
      fchmodSync(fd, FILE_MODE)
    } catch {
      // Read-only/odd mounts still append if the OS allows it.
    }
    writeSync(fd, lines.map((line) => `${line}\n`).join(''))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (!existed) fsyncDir(dirname(file))
}

/**
 * `s_<YYYYMMDD>T<HHMMSS>-<6 hex>`, in UTC so the same store sorts the same way
 * on every machine. The hex suffix keeps two sessions in one second distinct.
 */
export function sessionId(now: Date): string {
  const iso = now.toISOString()
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 19).replace(/:/g, '')}`
  return `s_${stamp}-${randomBytes(3).toString('hex')}`
}

/** `YYYYMMDDTHHMMSS`, used to order `.trash` entries. */
export function timestampStamp(now: Date): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 19).replace(/:/g, '')}`
}

/** How long a caller waits for a per-session lock. */
export interface LockOptions {
  /** Tries before giving up. Default 50, i.e. roughly one second of waiting. */
  attempts?: number
  /** Busy-wait between tries, in milliseconds. Default 20. */
  retryMs?: number
  /**
   * Fallback staleness window, used **only** when the lock file carries no
   * readable pid (a crash between `open` and `write`, or a truncated file).
   * A lock whose pid is alive is never reclaimed, however old it is; a lock
   * whose pid is dead is reclaimed immediately. Default 10 s.
   */
  staleMs?: number
  /**
   * How often a held lock's mtime is refreshed so it never *looks* abandoned to
   * an older z1 that still uses the mtime rule. Default 2000 ms; `0` disables
   * the heartbeat. The timer is unref'd: it never keeps a process alive.
   */
  heartbeatMs?: number
  /** Clock, injectable for tests. Default `Date.now`. */
  now?: () => number
}

const LOCK_ATTEMPTS = 50
const LOCK_RETRY_MS = 20
const LOCK_STALE_MS = 10_000
const LOCK_HEARTBEAT_MS = 2_000

/**
 * Sleep without a dependency and without a busy loop. The store is synchronous
 * by design, so waiting for a lock cannot be async; `Atomics.wait` on a buffer
 * nobody shares is the one available blocking sleep.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

interface LockStamp {
  mtimeMs: number
  ino: number
}

function lockStamp(file: string): LockStamp | undefined {
  try {
    const stats = statSync(file)
    return { mtimeMs: stats.mtimeMs, ino: stats.ino }
  } catch {
    return undefined
  }
}

/**
 * The lock body is `<pid>\n<token>\n`; both lines are best effort, so a lock
 * left by a crashed writer that never finished its write can have neither.
 */
interface LockOwner {
  pid?: number
  token?: string
}

function readLockOwner(file: string): LockOwner | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n')
  const owner: LockOwner = {}
  const pid = (lines[0] ?? '').trim()
  if (/^\d{1,10}$/.test(pid)) {
    const parsed = Number(pid)
    if (parsed > 0) owner.pid = parsed
  }
  const token = (lines[1] ?? '').trim()
  if (/^[0-9a-f]{8,32}$/.test(token)) owner.token = token
  return owner
}

/**
 * `kill(pid, 0)` asks the kernel whether the process exists without signalling
 * it. `EPERM` means it exists and belongs to another user, which is still a
 * live holder. Anything else (`ESRCH`) means the pid is gone.
 */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove a lock nobody is holding any more.
 *
 * Liveness, not age, decides: a holder that is alive — however long its write
 * takes, however far the clock jumps, however long the process is suspended —
 * keeps its lock. A recorded pid that is dead is reclaimed immediately.
 *
 * Age is only a fallback for a lock whose pid cannot be read at all (a crash
 * between `open` and `write` leaves an empty file, and nothing else will ever
 * remove it). Even then two observations are required: the first decides that
 * the lock is old and unowned, the second proves it is still the *same* file.
 * A holder that released and re-created it in between has a different
 * mtime/inode/body and is left alone — we never delete a lock we did not see
 * abandoned.
 */
function reclaimIfStale(file: string, staleMs: number, now: () => number): void {
  const observed = lockStamp(file)
  if (observed === undefined) return
  const owner = readLockOwner(file)
  if (owner?.pid !== undefined) {
    if (isProcessAlive(owner.pid)) return
  } else if (now() - observed.mtimeMs <= staleMs) {
    // No readable pid: an unowned file is only reclaimed once it is old.
    return
  }
  const confirmed = lockStamp(file)
  if (confirmed === undefined) return
  if (confirmed.mtimeMs !== observed.mtimeMs || confirmed.ino !== observed.ino) return
  const confirmedOwner = readLockOwner(file)
  if (confirmedOwner?.pid !== owner?.pid || confirmedOwner?.token !== owner?.token) return
  try {
    unlinkSync(file)
  } catch {
    // Someone else reclaimed it first; the next attempt simply tries again.
  }
}

/**
 * Take `<session dir>/.lock`, exclusively, or throw after ~1 s of trying.
 *
 * `openSync(…, 'wx')` is atomic on every platform this store supports, so two
 * processes cannot both create the lock. The holder's pid and a random token
 * are written into the file; while the lock is held a heartbeat refreshes its
 * mtime every couple of seconds, so a live lock never even looks stale.
 *
 * Release is ownership-checked: the inode we created must still be the inode at
 * the path *and* its token must be ours. `unlinkSync(file)` on its own would
 * delete a lock acquired by somebody else after ours was (wrongly) reclaimed.
 * The returned function is safe to call twice.
 */
export function acquireLock(file: string, options: LockOptions = {}): () => void {
  const attempts = options.attempts ?? LOCK_ATTEMPTS
  const retryMs = options.retryMs ?? LOCK_RETRY_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS
  const now = options.now ?? Date.now

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) sleepSync(retryMs)
    let fd: number
    try {
      fd = openSync(file, 'wx', FILE_MODE)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        reclaimIfStale(file, staleMs, now)
        continue
      }
      throw error
    }
    let ino: number | undefined
    const token = randomBytes(8).toString('hex')
    try {
      ino = fstatSync(fd).ino
      // The body is for whoever debugs a stuck lock; holding the file is the
      // lock itself, so a failed write must not undo the acquisition.
      writeSync(fd, `${String(process.pid)}\n${token}\n`)
    } catch {
      // A lock with no body still locks (and is then reclaimed by age).
    } finally {
      closeSync(fd)
    }

    let released = false
    let heartbeat: NodeJS.Timeout | undefined
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        try {
          // Only ever touch our own file: a lock stolen after we were (wrongly)
          // judged stale keeps its owner's liveness, not ours.
          if (statSync(file).ino === ino) utimesSync(file, new Date(), new Date())
        } catch {
          // Gone or unreadable: the timer has nothing left to keep fresh.
        }
      }, heartbeatMs)
      // A lock must never be the reason a short-lived process stays alive.
      heartbeat.unref()
    }
    const stopHeartbeat = (): void => {
      if (heartbeat === undefined) return
      clearInterval(heartbeat)
      heartbeat = undefined
    }

    return () => {
      if (released) return
      released = true
      stopHeartbeat()
      try {
        const current = statSync(file)
        // Someone else's file is at the path now: theirs to release, not ours.
        if (ino !== undefined && current.ino !== ino) return
        const owner = readLockOwner(file)
        if (owner?.token !== undefined && owner.token !== token) return
        if (owner?.token === undefined && owner?.pid !== undefined && owner.pid !== process.pid) {
          return
        }
        unlinkSync(file)
      } catch {
        // ENOENT is the normal "already gone". Any other failure (a read-only
        // mount) is covered by the liveness rule, and throwing from a release
        // that runs in `finally` would mask the caller's own error.
      }
    }
  }
  throw new Error(
    `session: could not acquire ${file} after ${String(attempts)} attempts; ` +
      'another live writer holds it, or a lock with no readable pid is newer than the reclaim window',
  )
}

/**
 * Cut a half-written final line so the next append cannot merge with it. A
 * crash mid-write leaves a fragment without its newline; appending after that
 * fragment would produce one corrupt line instead of one lost one.
 */
export function dropTornTail(file: string): void {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (text === '' || text.endsWith('\n')) return
  const cut = text.lastIndexOf('\n') + 1
  const fd = openSync(file, 'r+')
  try {
    ftruncateSync(fd, Buffer.byteLength(text.slice(0, cut), 'utf8'))
    try {
      fchmodSync(fd, FILE_MODE)
    } catch {
      // Best effort; append enforces it again.
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
