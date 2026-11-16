/**
 * The synchronous session store.
 *
 * One directory per session under `<root>/sessions`, `meta.json` rewritten
 * atomically, `events.jsonl` appended and fsync'd. The transcript is the
 * authoritative record; the journal is only provenance (`meta.runs`).
 *
 * @module @z1/session/store
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'

import type { ChatMessage } from '@z1/node'

import { appendLines, dropTornTail, acquireLock, sessionId, timestampStamp, writeFileAtomic } from './fsutil.ts'
import {
  EVENTS_FILE,
  LATEST_FILE,
  LOCK_FILE,
  META_FILE,
  SESSIONS_DIR,
  TRASH_DIR,
  ensureSessionRoot,
  resolveSessionRoot,
} from './paths.ts'
import {
  SESSION_SCHEMA_VERSION,
  SessionClearedError,
  SessionCorruptError,
  SessionTooNewError,
  type AppendTurnOptions,
  type CreateSessionStoreOptions,
  type ListSessionsOptions,
  type NewSessionInput,
  type Session,
  type SessionMeta,
  type SessionMetaPatch,
  type SessionStore,
  type SessionSummary,
} from './types.ts'

/** No index in M1, so a listing is a directory scan; bound it. */
const MAX_LISTED = 500

/** Anything that is not exactly an id this store could have written. */
const ID_PATTERN = /^s_[0-9A-Za-zT-]{8,64}$/

const DIR_MODE = 0o700
const NAME_MAX = 120

type Json = unknown

function assertSessionId(id: string): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.includes('..')) {
    throw new Error(`session: invalid session id ${JSON.stringify(id)}`)
  }
  return id
}

function unknownSession(id: string): Error {
  return new Error(`session: unknown session ${id}`)
}

function isRecord(value: Json): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: Json): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: Json): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function integer(value: Json): number | undefined {
  const parsed = num(value)
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** One rule-set for values written by `create`/`appendTurn`/`setMeta` and read back. */
function validateMeta(meta: SessionMeta): string | undefined {
  if (meta.schemaVersion !== SESSION_SCHEMA_VERSION) return 'unsupported schemaVersion'
  if (!ID_PATTERN.test(meta.id) || meta.id.includes('..')) return 'invalid id'
  const name = meta.name.trim()
  if (name.length === 0 || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(meta.name)) {
    return 'invalid name'
  }
  for (const [field, value] of [
    ['createdAt', meta.createdAt],
    ['updatedAt', meta.updatedAt],
    ['messageCount', meta.messageCount],
    ['contextWindow', meta.contextWindow],
    ['maxSteps', meta.maxSteps],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) return `invalid ${field}`
  }
  if (meta.contextWindow < 1 || meta.maxSteps < 1) return 'invalid limits'
  if (meta.cwd.trim() === '' || meta.repoRoot.trim() === '') return 'invalid path'
  if (meta.model.provider.trim() === '' || meta.model.model.trim() === '') return 'invalid model'
  if (meta.generation !== undefined && (!Number.isInteger(meta.generation) || meta.generation < 0)) {
    return 'invalid generation'
  }
  if (!meta.runs.every((run) => typeof run === 'string')) return 'invalid runs'
  if (meta.color !== undefined && (!Number.isInteger(meta.color) || meta.color < 0 || meta.color > 255)) {
    return 'invalid color'
  }
  if (meta.parent !== undefined) {
    if (meta.parent.id.trim() === '' || !Number.isInteger(meta.parent.atOrdinal) || meta.parent.atOrdinal < 0) {
      return 'invalid parent'
    }
  }
  return undefined
}

function normalizeName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim()
}

/** JSON round-trip is the storage canonical form; compare/write that form. */
function canonicalMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(JSON.stringify(message)) as ChatMessage
}

/** Structural equality; key order must not decide between delta and snapshot. */
export function deepEqual(left: Json, right: Json): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
  }
  return false
}

function readMetaFile(file: string, expectedId?: string): SessionMeta | undefined {
  if (isSymlink(file)) {
    throw new SessionCorruptError(file, 'metadata file is a symbolic link')
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let raw: Json
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const version = num(raw['schemaVersion'])
  if (version === undefined) return undefined
  if (version > SESSION_SCHEMA_VERSION) throw new SessionTooNewError(file, version)
  if (version !== SESSION_SCHEMA_VERSION) return undefined

  const id = str(raw['id'])
  if (expectedId !== undefined && id !== expectedId) return undefined
  const name = str(raw['name'])
  const createdAt = integer(raw['createdAt'])
  const updatedAt = integer(raw['updatedAt'])
  const cwd = str(raw['cwd'])
  const repoRoot = str(raw['repoRoot'])
  const contextWindow = integer(raw['contextWindow'])
  const maxSteps = integer(raw['maxSteps'])
  const archived = raw['archived']
  const messageCount = integer(raw['messageCount'])
  const modelRaw = raw['model']
  const runsRaw = raw['runs']
  if (
    id === undefined ||
    name === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    cwd === undefined ||
    repoRoot === undefined ||
    contextWindow === undefined ||
    maxSteps === undefined ||
    typeof archived !== 'boolean' ||
    messageCount === undefined ||
    !isRecord(modelRaw) ||
    !Array.isArray(runsRaw)
  ) {
    return undefined
  }
  const provider = str(modelRaw['provider'])
  const model = str(modelRaw['model'])
  if (provider === undefined || model === undefined) return undefined
  if (!runsRaw.every((entry): entry is string => typeof entry === 'string')) return undefined
  if (name.trim().length === 0 || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    return undefined
  }

  const meta: SessionMeta = {
    schemaVersion: 1,
    id,
    name,
    createdAt,
    updatedAt,
    cwd,
    repoRoot,
    model: { provider, model },
    contextWindow,
    maxSteps,
    runs: [...runsRaw],
    archived,
    messageCount,
  }
  const gitBranch = str(raw['gitBranch'])
  if (gitBranch !== undefined) meta.gitBranch = gitBranch
  const toolPolicyRevision = num(raw['toolPolicyRevision'])
  if (toolPolicyRevision !== undefined) meta.toolPolicyRevision = toolPolicyRevision
  const color = num(raw['color'])
  if (color !== undefined && Number.isInteger(color) && color >= 0 && color <= 255) {
    meta.color = color
  }
  const parent = raw['parent']
  if (isRecord(parent)) {
    const parentId = str(parent['id'])
    const atOrdinal = integer(parent['atOrdinal'])
    if (parentId !== undefined && atOrdinal !== undefined) {
      meta.parent = { id: parentId, atOrdinal }
    }
  }
  // Absent means 0 (a file written before the guard existed). Present but not a
  // non-negative integer is corrupt, not silently zero: that would be a guard
  // that fails open.
  const generationRaw = raw['generation']
  if (generationRaw !== undefined) {
    const generation = integer(generationRaw)
    if (generation === undefined || generation < 0) return undefined
    meta.generation = generation
  }
  return validateMeta(meta) === undefined ? meta : undefined
}

function writeMetaFile(dir: string, meta: SessionMeta): void {
  const problem = validateMeta(meta)
  if (problem !== undefined) throw new Error(`session: refusing to write invalid metadata (${problem})`)
  // `JSON.stringify` drops an absent `generation`, so a v1 file that never
  // needed one stays byte-identical after an unrelated `setMeta`.
  writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
}

interface Replay {
  messages: ChatMessage[]
  tornTail: boolean
  nextOrd: number
}

function isMessage(value: Json): value is ChatMessage {
  if (!isRecord(value)) return false
  const role = value['role']
  return (
    (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') &&
    typeof value['content'] === 'string'
  )
}

/**
 * Fold `events.jsonl` into the transcript.
 *
 * Appends are one line each; a rewrite (compaction, edit, truncation) is a
 * `snapshot` line that replaces everything before it. A trailing line without
 * its newline never finished being written and is dropped, not fatal.
 */
function replayEvents(file: string): Replay {
  if (isSymlink(file)) throw new SessionCorruptError(file, 'events file is a symbolic link')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { messages: [], tornTail: false, nextOrd: 0 }
    }
    throw error
  }
  const messages: ChatMessage[] = []
  let tornTail = false
  let nextOrd = 0
  if (text === '') return { messages, tornTail, nextOrd }

  const lines = text.split('\n')
  // A complete file ends with '\n', so the last element is an empty string.
  // Anything else is a half-written final line.
  if (lines[lines.length - 1] === '') {
    lines.pop()
  } else {
    lines.pop()
    tornTail = true
  }

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    let raw: Json
    try {
      raw = JSON.parse(line)
    } catch {
      throw new SessionCorruptError(file, 'is not valid JSON', index + 1)
    }
    if (!isRecord(raw) || raw['v'] !== 1) {
      throw new SessionCorruptError(file, 'is not a v1 event', index + 1)
    }
    const ord = integer(raw['ord'])
    if (ord === undefined) throw new SessionCorruptError(file, 'has no integer ord', index + 1)
    if (ord !== nextOrd) {
      throw new SessionCorruptError(file, `expected ord ${String(nextOrd)}, found ${String(ord)}`, index + 1)
    }
    nextOrd = ord + 1
    const type = raw['type']
    if (type === 'message') {
      const message = raw['message']
      if (!isMessage(message)) throw new SessionCorruptError(file, 'has no message', index + 1)
      // The log is a transcript of non-system turns; a hand-edited system line
      // must not make the message count disagree with the store contract.
      if (message.role !== 'system') messages.push(message)
    } else if (type === 'snapshot') {
      const snapshot = raw['messages']
      if (!Array.isArray(snapshot) || !snapshot.every(isMessage)) {
        throw new SessionCorruptError(file, 'has no messages array', index + 1)
      }
      messages.length = 0
      messages.push(...snapshot.filter((message) => message.role !== 'system'))
    } else {
      throw new SessionCorruptError(file, `has unknown type ${JSON.stringify(type)}`, index + 1)
    }
  }
  return { messages, tornTail, nextOrd }
}

/** A missing file has nothing to lose; anything else is a real stat result. */
function isFileEmpty(file: string): boolean {
  try {
    return statSync(file).size === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

/**
 * Identity of a file's current contents, cheap enough to take around a read.
 * `writeFileAtomic` renames a fresh temp file into place, so a replace and a
 * truncate both change the inode as well as the size.
 */
interface FileStamp {
  size: number
  ino: number
  mtimeMs: number
}

function stampOf(file: string): FileStamp | undefined {
  try {
    const stats = statSync(file)
    return { size: stats.size, ino: stats.ino, mtimeMs: stats.mtimeMs }
  } catch {
    return undefined
  }
}

function sameStamp(left: FileStamp | undefined, right: FileStamp | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.size === right.size && left.ino === right.ino && left.mtimeMs === right.mtimeMs
}

function startsWithMessages(candidate: readonly ChatMessage[], prefix: readonly ChatMessage[]): boolean {
  if (candidate.length < prefix.length) return false
  return prefix.every((message, index) => deepEqual(message, candidate[index]))
}

function defaultName(createdAt: number): string {
  return `Session ${new Date(createdAt).toISOString().slice(0, 16).replace('T', ' ')}`
}

function summarize(meta: SessionMeta): SessionSummary {
  return {
    id: meta.id,
    name: meta.name,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    generation: meta.generation ?? 0,
    model: meta.model,
    cwd: meta.cwd,
    archived: meta.archived,
    ...(meta.color === undefined ? {} : { color: meta.color }),
  }
}

function applyPatch(meta: SessionMeta, patch: SessionMetaPatch): SessionMeta {
  const next: SessionMeta = { ...meta }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.cwd !== undefined) next.cwd = patch.cwd
  if (patch.repoRoot !== undefined) next.repoRoot = patch.repoRoot
  if (patch.gitBranch !== undefined) next.gitBranch = patch.gitBranch
  if (patch.model !== undefined) next.model = { provider: patch.model.provider, model: patch.model.model }
  if (patch.contextWindow !== undefined) next.contextWindow = patch.contextWindow
  if (patch.maxSteps !== undefined) next.maxSteps = patch.maxSteps
  if (patch.toolPolicyRevision !== undefined) next.toolPolicyRevision = patch.toolPolicyRevision
  if (patch.color !== undefined) next.color = patch.color
  if (patch.runs !== undefined) next.runs = [...patch.runs]
  if (patch.parent !== undefined) next.parent = { id: patch.parent.id, atOrdinal: patch.parent.atOrdinal }
  if (patch.archived !== undefined) next.archived = patch.archived
  if (patch.messageCount !== undefined) next.messageCount = patch.messageCount
  // `clear` is the only intended writer of `generation`; a patch may carry one
  // (it is a plain field of `SessionMeta`) and is written as given, under the
  // same lock, so the on-disk value always matches what a reader validated.
  if (patch.generation !== undefined) next.generation = patch.generation
  next.updatedAt = patch.updatedAt ?? Date.now()
  return next
}

interface LoadedSession {
  meta: SessionMeta
  messages: ChatMessage[]
  tornTail: boolean
  nextOrd: number
}

interface LatestPointer {
  id: string
  updatedAt: number
}

export function createSessionStore(options: CreateSessionStoreOptions): SessionStore {
  const resolved = resolveSessionRoot(options)
  const root = resolved.root
  const sessionsDir = join(root, SESSIONS_DIR)
  const defaultRepoRoot = resolved.repoRoot ?? resolve(options.cwd)

  const sessionDir = (id: string): string => {
    const dir = join(sessionsDir, assertSessionId(id))
    if (isSymlink(dir)) {
      throw new SessionCorruptError(dir, 'session directory is a symbolic link')
    }
    return dir
  }

  /** Metadata only: renaming must not re-read a multi-megabyte transcript. */
  const readMeta = (id: string): SessionMeta | undefined =>
    readMetaFile(join(sessionDir(id), META_FILE), id)

  /**
   * Run `run` with the session's lock held. Every writer of `events.jsonl` or
   * `meta.json` goes through here, so an append can no longer load a transcript
   * that `clear` truncates before the write lands — the bug that left a log
   * whose first line was `ord 1` and made every later read throw. Reads
   * (`load`, `list`, `latest`) stay lock-free: they cannot corrupt anything and
   * a reader must not wait a second for a writer.
   */
  const withSessionLock = <T,>(id: string, run: (dir: string) => T): T => {
    const dir = sessionDir(id)
    // `acquireLock` would fail with ENOENT here; the contract is a named error.
    if (!existsSync(dir)) throw unknownSession(id)
    const release = acquireLock(join(dir, LOCK_FILE))
    try {
      return run(dir)
    } finally {
      release()
    }
  }

  /**
   * Repair a `messageCount` left stale by a crash between the events append and
   * the meta write.
   *
   * This runs under the session lock, and it re-reads `meta.json` there, so it
   * can only ever patch the *current* file: a rename/archive/`runs` entry that
   * landed between this reader's first read and its repair survives. It also
   * only writes while `events.jsonl` is still the file that was replayed —
   * under the lock that is stable, so the count cannot describe a transcript
   * that has since changed. Returns the fresh metadata when it read one.
   *
   * Waiting for the lock is bounded and short: a read must not block on a
   * writer, and the in-memory correction is enough for this caller either way.
   */
  const repairMessageCount = (
    dir: string,
    id: string,
    before: FileStamp | undefined,
    count: number,
  ): SessionMeta | undefined => {
    let release: (() => void) | undefined
    try {
      release = acquireLock(join(dir, LOCK_FILE), { attempts: 10, retryMs: 10 })
    } catch {
      return undefined
    }
    try {
      const eventsFile = join(dir, EVENTS_FILE)
      // A writer that won the lock before us has already written a meta that
      // matches the transcript on disk; our replay is not authoritative.
      if (!sameStamp(before, stampOf(eventsFile))) return undefined
      const fresh = readMetaFile(join(dir, META_FILE), id)
      if (fresh === undefined) return undefined
      if (fresh.messageCount === count) return fresh
      // Merge exactly one field. Everything else stays whatever is on disk now.
      writeMetaFile(dir, { ...fresh, messageCount: count })
      return { ...fresh, messageCount: count }
    } catch {
      // A read-only file is still readable with the count corrected in memory.
      return undefined
    } finally {
      release()
    }
  }

  /**
   * Replay a session. `lockHeld` says the caller already owns the session lock
   * (every writer does): taking it again would deadlock, and a writer rewrites
   * `meta.json` itself, so there is nothing to repair from inside one.
   */
  const loadSession = (id: string, lockHeld = false): LoadedSession | undefined => {
    const dir = sessionDir(id)
    let meta = readMetaFile(join(dir, META_FILE), id)
    if (meta === undefined) return undefined
    const eventsFile = join(dir, EVENTS_FILE)
    const before = stampOf(eventsFile)
    const replay = replayEvents(eventsFile)
    if (meta.messageCount !== replay.messages.length) {
      // A crash after the events append but before the meta write leaves the
      // transcript complete and the count stale. Repair on the next read so a
      // caller never sees a self-inconsistent Session; a read-only file is
      // still readable with the count corrected in memory.
      meta = { ...meta, messageCount: replay.messages.length }
      // Only repair a transcript that did not move under us. A `clear` that
      // landed during the replay would otherwise have its fresh `generation`
      // and zero count overwritten by this stale copy, which is exactly the
      // state the generation guard exists to prevent.
      if (!lockHeld && sameStamp(before, stampOf(eventsFile))) {
        meta = repairMessageCount(dir, id, before, replay.messages.length) ?? meta
      }
    }
    return { meta, messages: replay.messages, tornTail: replay.tornTail, nextOrd: replay.nextOrd }
  }

  const load = (id: string): Session | undefined => {
    const loaded = loadSession(id)
    if (loaded === undefined) return undefined
    return { meta: loaded.meta, messages: loaded.messages, tornTail: loaded.tornTail }
  }

  const list = (listOptions: ListSessionsOptions = {}): readonly SessionSummary[] => {
    let entries: Dirent[]
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: SessionSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      let meta: SessionMeta | undefined
      try {
        // A session from a newer z1 is skipped: showing a guessed-at subset
        // would be silently wrong data.
        meta = readMetaFile(join(sessionsDir, entry.name, META_FILE), entry.name)
      } catch {
        meta = undefined
      }
      if (meta === undefined) continue
      if (meta.archived && listOptions.includeArchived !== true) continue
      out.push(summarize(meta))
    }
    out.sort((left, right) =>
      right.updatedAt === left.updatedAt
        ? right.id.localeCompare(left.id)
        : right.updatedAt - left.updatedAt,
    )
    return out.slice(0, MAX_LISTED)
  }

  const create = (input: NewSessionInput): Session => {
    ensureSessionRoot(root)
    const now = new Date()
    const createdAt = now.getTime()
    let id = sessionId(now)
    for (let attempt = 0; attempt < 8 && existsSync(join(sessionsDir, id)); attempt += 1) {
      id = sessionId(new Date())
    }
    const dir = join(sessionsDir, id)
    if (existsSync(dir)) throw new Error(`session: id ${id} already exists`)
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    const requested = input.name === undefined ? '' : normalizeName(input.name)
    const name = requested !== '' ? requested : defaultName(createdAt)
    const meta: SessionMeta = {
      schemaVersion: 1,
      id,
      name,
      createdAt,
      updatedAt: createdAt,
      cwd: resolve(input.cwd),
      repoRoot: resolve(input.repoRoot ?? defaultRepoRoot),
      model: { provider: input.model.provider, model: input.model.model },
      contextWindow: input.contextWindow,
      maxSteps: input.maxSteps,
      runs: [],
      archived: false,
      messageCount: 0,
    }
    const gitBranch = input.gitBranch?.trim()
    if (gitBranch !== undefined && gitBranch !== '') meta.gitBranch = gitBranch
    if (input.toolPolicyRevision !== undefined) meta.toolPolicyRevision = input.toolPolicyRevision
    if (input.color !== undefined && Number.isInteger(input.color) && input.color >= 0 && input.color <= 255) {
      meta.color = input.color
    }
    writeMetaFile(dir, meta)
    return { meta, messages: [], tornTail: false }
  }

  /**
   * Append a turn. The caller passes the *whole* transcript it now holds: if
   * the current one is a prefix, only the new tail is written; otherwise the
   * transcript was rewritten and one `snapshot` line carries it.
   *
   * The whole load-append-decide sequence runs under the session lock, so a
   * `clear` can only land entirely before or entirely after it; there is no
   * window in which `ord` is computed against a transcript that has since been
   * truncated. `options.generation` adds the second half of the guard for a
   * caller whose read happened outside this call.
   */
  const appendTurn = (
    id: string,
    messages: readonly ChatMessage[],
    turnOptions: AppendTurnOptions = {},
  ): void => {
    withSessionLock(id, (dir) => {
      const loaded = loadSession(id, true)
      if (loaded === undefined) throw unknownSession(id)
      // The generation is only meaningful as "what the caller read": an absent
      // value keeps the old, unguarded behaviour a fresh writer relies on.
      const generation = loaded.meta.generation ?? 0
      if (turnOptions.generation !== undefined && turnOptions.generation !== generation) {
        throw new SessionClearedError(id, generation)
      }
      // The log stores JSON; compare the same canonical shape or a field such as
      // `toolCallId: undefined` (dropped on write) would defeat the prefix test
      // forever and turn every turn into a full snapshot.
      const incoming = messages
        .filter((message) => message.role !== 'system')
        .map(canonicalMessage)
      const grows = startsWithMessages(incoming, loaded.messages)
      const delta = grows ? incoming.slice(loaded.messages.length) : []
      const runId = turnOptions.runId
      const metaNeedsWrite =
        !grows ||
        delta.length > 0 ||
        loaded.tornTail ||
        loaded.meta.messageCount !== incoming.length ||
        (runId !== undefined && !loaded.meta.runs.includes(runId))
      if (grows && delta.length === 0 && !metaNeedsWrite) return

      const now = Date.now()
      const eventsFile = join(dir, EVENTS_FILE)
      // An old/copied tree can be world-readable; tighten it before appending.
      try {
        chmodSync(root, DIR_MODE)
        chmodSync(dir, DIR_MODE)
      } catch {
        // Best effort; the transcript itself is chmod'ed by appendLines.
      }
      if (loaded.tornTail) dropTornTail(eventsFile)
      if (grows) {
        if (delta.length > 0) {
          appendLines(
            eventsFile,
            delta.map((message, index) =>
              JSON.stringify({ v: 1, ord: loaded.nextOrd + index, ts: now, type: 'message', message }),
            ),
          )
        }
      } else {
        appendLines(eventsFile, [
          JSON.stringify({ v: 1, ord: loaded.nextOrd, ts: now, type: 'snapshot', messages: incoming }),
        ])
      }

      // Transcript first, meta second: a crash between them leaves the messages
      // complete and only `updatedAt`/`messageCount` stale. The next load repairs
      // the count; a late `runId` is still written even when there is no delta.
      const meta: SessionMeta = {
        ...loaded.meta,
        updatedAt: metaNeedsWrite ? now : loaded.meta.updatedAt,
        messageCount: incoming.length,
      }
      if (runId !== undefined && !meta.runs.includes(runId)) {
        meta.runs = [...meta.runs, runId]
      }
      if (metaNeedsWrite) writeMetaFile(dir, meta)
    })
  }

  /**
   * Empty the transcript of `id` in place: same session directory, same id,
   * name, colour, model, folder, archived flag and `runs` provenance — only the
   * messages go. `events.jsonl` is replaced atomically by an empty file, so the
   * old turns are unlinked from disk instead of merely being hidden behind a
   * trailing `snapshot`. The next append starts again at `ord 0`.
   *
   * `generation` advances in the same metadata write as `messageCount: 0`. It is
   * the only thing that can tell a client holding a pre-clear message array that
   * its array is no longer the transcript: an empty log is a prefix of every
   * array, so a prefix test alone would happily re-append everything the user
   * had just deleted.
   *
   * A session that is already empty is left byte-for-byte untouched, including
   * its `updatedAt` and its `generation`: `/clear` on a fresh conversation must
   * not reorder the session list, and nothing changed there for a stale client
   * to be wrong about.
   */
  const clear = (id: string): void => {
    withSessionLock(id, (dir) => {
      const meta = readMetaFile(join(dir, META_FILE), id)
      if (meta === undefined) throw unknownSession(id)
      const eventsFile = join(dir, EVENTS_FILE)
      // Same refusal as `replayEvents`: writing empty bytes through a link would
      // truncate a file this store does not own.
      if (isSymlink(eventsFile)) {
        throw new SessionCorruptError(eventsFile, 'events file is a symbolic link')
      }
      // Trust the file, not the count: a stale `messageCount` must not leave old
      // turns behind. An absent file already reads back as zero messages.
      if (meta.messageCount === 0 && isFileEmpty(eventsFile)) return
      const now = Date.now()
      // Transcript first, meta second, as in `appendTurn`: a crash in between
      // leaves an empty log with a stale count, which the next load repairs.
      // `writeFileAtomic` creates its temp file 0600, so the emptied transcript
      // keeps the private mode the append path enforces.
      writeFileAtomic(eventsFile, '')
      writeMetaFile(dir, {
        ...meta,
        messageCount: 0,
        updatedAt: now,
        generation: (meta.generation ?? 0) + 1,
      })
    })
  }

  /** Rename/archive land here, so a patch cannot interleave with an append. */
  const setMeta = (id: string, patch: SessionMetaPatch): void => {
    withSessionLock(id, (dir) => {
      const meta = readMetaFile(join(dir, META_FILE), id)
      if (meta === undefined) throw unknownSession(id)
      writeMetaFile(dir, applyPatch(meta, patch))
    })
  }

  const rename = (id: string, name: string): void => {
    const trimmed = normalizeName(name)
    if (trimmed === '') throw new Error('session: a session name must not be empty')
    setMeta(id, { name: trimmed })
  }

  const archive = (id: string, archived: boolean): void => {
    setMeta(id, { archived })
  }

  const remove = (id: string): void => {
    const dir = sessionDir(id)
    if (!existsSync(dir)) throw unknownSession(id)
    const trash = join(root, TRASH_DIR)
    mkdirSync(trash, { recursive: true, mode: DIR_MODE })
    const base = `${timestampStamp(new Date())}-${id}`
    let target = join(trash, base)
    for (let suffix = 1; existsSync(target); suffix += 1) target = join(trash, `${base}-${suffix}`)
    renameSync(dir, target)
    // A live or stale `.lock` travels with the directory; it must not follow the
    // session into `.trash` and it must never make `remove` fail.
    try {
      unlinkSync(join(target, LOCK_FILE))
    } catch {
      // Absent, or already released by its holder.
    }
    try {
      const pointer = JSON.parse(readFileSync(join(root, LATEST_FILE), 'utf8')) as unknown
      if (isRecord(pointer) && pointer['id'] === id) unlinkSync(join(root, LATEST_FILE))
    } catch {
      // No pointer, or another process already replaced it.
    }
  }

  const readPointer = (): LatestPointer | undefined => {
    let raw: Json
    try {
      raw = JSON.parse(readFileSync(join(root, LATEST_FILE), 'utf8'))
    } catch {
      return undefined
    }
    if (!isRecord(raw)) return undefined
    const id = str(raw['id'])
    const updatedAt = num(raw['updatedAt'])
    if (id === undefined || updatedAt === undefined || !ID_PATTERN.test(id)) return undefined
    return { id, updatedAt }
  }

  const latest = (): SessionSummary | undefined => {
    const pointer = readPointer()
    if (pointer !== undefined) {
      try {
        const meta = readMetaFile(join(sessionsDir, pointer.id, META_FILE), pointer.id)
        if (meta !== undefined && !meta.archived) return summarize(meta)
      } catch {
        // A newer/corrupt/symlinked pointed session must not make boot fail;
        // fall through to the newest readable active session.
      }
    }
    return list({ includeArchived: false })[0] ?? list({ includeArchived: true })[0]
  }

  const setCurrent = (id: string): void => {
    if (readMeta(id) === undefined) throw unknownSession(id)
    const pointer: LatestPointer = { id, updatedAt: Date.now() }
    writeFileAtomic(join(root, LATEST_FILE), `${JSON.stringify(pointer, null, 2)}\n`)
  }

  return {
    root,
    mode: resolved.mode,
    ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
    list,
    load,
    create,
    appendTurn,
    clear,
    setMeta,
    rename,
    archive,
    remove,
    latest,
    setCurrent,
  }
}
