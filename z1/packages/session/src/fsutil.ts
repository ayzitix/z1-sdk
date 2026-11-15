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
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

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
  renameSync(temporary, file)
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
  /** A lock file older than this was left by a crash, not by a holder. Default 10 s. */
  staleMs?: number
  /** Clock, injectable for tests. Default `Date.now`. */
  now?: () => number
}

const LOCK_ATTEMPTS = 50
const LOCK_RETRY_MS = 20
const LOCK_STALE_MS = 10_000

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
 * Remove a lock nobody is holding any more. Two observations are required: the
 * first decides that the lock is old, the second proves it is still the *same*
 * old file. A holder that released and re-created it in between has a different
 * mtime/inode and is left alone — we never delete a lock we did not see stale.
 */
function reclaimIfStale(file: string, staleMs: number, now: () => number): void {
  const observed = lockStamp(file)
  if (observed === undefined) return
  // A clock that moved backwards leaves a future mtime; that is not staleness.
  if (now() - observed.mtimeMs <= staleMs) return
  const confirmed = lockStamp(file)
  if (confirmed === undefined) return
  if (confirmed.mtimeMs !== observed.mtimeMs || confirmed.ino !== observed.ino) return
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
 * processes cannot both create the lock. The returned function releases it and
 * is safe to call twice. A lock left behind by a crash is reclaimed once its
 * mtime is older than `staleMs`, which is why no PID check (and no platform
 * specific `flock`) is needed.
 */
export function acquireLock(file: string, options: LockOptions = {}): () => void {
  const attempts = options.attempts ?? LOCK_ATTEMPTS
  const retryMs = options.retryMs ?? LOCK_RETRY_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
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
    try {
      // The body is for whoever debugs a stuck lock; holding the file is the
      // lock itself, so a failed write must not undo the acquisition.
      writeSync(fd, `${String(process.pid)}\n`)
    } catch {
      // A lock with no body still locks.
    } finally {
      closeSync(fd)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        unlinkSync(file)
      } catch {
        // ENOENT is the normal "already gone". Any other failure (a read-only
        // mount) is covered by the stale rule, and throwing from a release that
        // runs in `finally` would mask the caller's own error.
      }
    }
  }
  throw new Error(
    `session: could not acquire ${file} after ${String(attempts)} attempts; ` +
      'another writer holds it, or a stale lock is newer than the reclaim window',
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
