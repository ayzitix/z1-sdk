/**
 * The three filesystem primitives the store needs: an atomic rename for small
 * state, an fsync'd line append for the transcript, and the session id.
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
