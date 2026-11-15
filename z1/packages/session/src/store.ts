/**
 * The synchronous session store.
 *
 * One directory per session under `<root>/sessions`, `meta.json` rewritten
 * atomically, `events.jsonl` appended and fsync'd. The transcript is the
 * authoritative record; the journal is only provenance (`meta.runs`).
 *
 * @module @z1/session/store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'

import type { ChatMessage } from '@z1/node'

import { appendLines, dropTornTail, sessionId, timestampStamp, writeFileAtomic } from './fsutil.ts'
import {
  EVENTS_FILE,
  LATEST_FILE,
  META_FILE,
  SESSIONS_DIR,
  TRASH_DIR,
  ensureSessionRoot,
  resolveSessionRoot,
} from './paths.ts'
import {
  SESSION_SCHEMA_VERSION,
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

function readMetaFile(file: string): SessionMeta | undefined {
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
  const name = str(raw['name'])
  const createdAt = num(raw['createdAt'])
  const updatedAt = num(raw['updatedAt'])
  const cwd = str(raw['cwd'])
  const repoRoot = str(raw['repoRoot'])
  const contextWindow = num(raw['contextWindow'])
  const maxSteps = num(raw['maxSteps'])
  const archived = raw['archived']
  const messageCount = num(raw['messageCount'])
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
    const atOrdinal = num(parent['atOrdinal'])
    if (parentId !== undefined && atOrdinal !== undefined) {
      meta.parent = { id: parentId, atOrdinal }
    }
  }
  return meta
}

function writeMetaFile(dir: string, meta: SessionMeta): void {
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
      throw new Error(`session: ${file}:${index + 1} is not valid JSON`)
    }
    if (!isRecord(raw) || raw['v'] !== 1) {
      throw new Error(`session: ${file}:${index + 1} is not a v1 event`)
    }
    const ord = num(raw['ord'])
    if (ord === undefined) throw new Error(`session: ${file}:${index + 1} has no ord`)
    nextOrd = Math.max(nextOrd, ord + 1)
    const type = raw['type']
    if (type === 'message') {
      const message = raw['message']
      if (!isMessage(message)) throw new Error(`session: ${file}:${index + 1} has no message`)
      messages.push(message)
    } else if (type === 'snapshot') {
      const snapshot = raw['messages']
      if (!Array.isArray(snapshot) || !snapshot.every(isMessage)) {
        throw new Error(`session: ${file}:${index + 1} has no messages array`)
      }
      messages.length = 0
      messages.push(...snapshot)
    } else {
      throw new Error(`session: ${file}:${index + 1} has unknown type ${JSON.stringify(type)}`)
    }
  }
  return { messages, tornTail, nextOrd }
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

  const sessionDir = (id: string): string => join(sessionsDir, assertSessionId(id))

  /** Metadata only: renaming must not re-read a multi-megabyte transcript. */
  const readMeta = (id: string): SessionMeta | undefined =>
    readMetaFile(join(sessionDir(id), META_FILE))

  const loadSession = (id: string): LoadedSession | undefined => {
    const dir = sessionDir(id)
    const meta = readMetaFile(join(dir, META_FILE))
    if (meta === undefined) return undefined
    const replay = replayEvents(join(dir, EVENTS_FILE))
    return { meta, messages: replay.messages, tornTail: replay.tornTail, nextOrd: replay.nextOrd }
  }

  const writeMeta = (id: string, meta: SessionMeta): void => {
    writeMetaFile(sessionDir(id), meta)
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
        meta = readMetaFile(join(sessionsDir, entry.name, META_FILE))
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
    const name = input.name?.trim()
    const meta: SessionMeta = {
      schemaVersion: 1,
      id,
      name: name !== undefined && name !== '' ? name : defaultName(createdAt),
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
   */
  const appendTurn = (
    id: string,
    messages: readonly ChatMessage[],
    turnOptions: AppendTurnOptions = {},
  ): void => {
    const loaded = loadSession(id)
    if (loaded === undefined) throw unknownSession(id)
    const incoming = messages.filter((message) => message.role !== 'system')
    const grows = startsWithMessages(incoming, loaded.messages)
    const delta = grows ? incoming.slice(loaded.messages.length) : []
    if (grows && delta.length === 0) return

    const now = Date.now()
    const lines = grows
      ? delta.map((message, index) =>
          JSON.stringify({ v: 1, ord: loaded.nextOrd + index, ts: now, type: 'message', message }),
        )
      : [JSON.stringify({ v: 1, ord: loaded.nextOrd, ts: now, type: 'snapshot', messages: incoming })]

    // Transcript first, meta second: a crash between them leaves the messages
    // complete and only `updatedAt`/`messageCount` stale, which is recoverable.
    const eventsFile = join(sessionDir(id), EVENTS_FILE)
    if (loaded.tornTail) dropTornTail(eventsFile)
    appendLines(eventsFile, lines)

    const meta: SessionMeta = { ...loaded.meta, updatedAt: now, messageCount: incoming.length }
    if (turnOptions.runId !== undefined && !meta.runs.includes(turnOptions.runId)) {
      meta.runs = [...meta.runs, turnOptions.runId]
    }
    writeMetaFile(sessionDir(id), meta)
  }

  const setMeta = (id: string, patch: SessionMetaPatch): void => {
    const meta = readMeta(id)
    if (meta === undefined) throw unknownSession(id)
    writeMeta(id, applyPatch(meta, patch))
  }

  const rename = (id: string, name: string): void => {
    const trimmed = name.trim()
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
      const meta = readMetaFile(join(sessionsDir, pointer.id, META_FILE))
      if (meta !== undefined) return summarize(meta)
    }
    return list({ includeArchived: true })[0]
  }

  const setCurrent = (id: string): void => {
    if (readMeta(id) === undefined) throw unknownSession(id)
    const pointer: LatestPointer = { id, updatedAt: Date.now() }
    writeFileAtomic(join(root, LATEST_FILE), `${JSON.stringify(pointer, null, 2)}\n`)
  }

  return {
    root,
    mode: resolved.mode,
    list,
    load,
    create,
    appendTurn,
    setMeta,
    rename,
    archive,
    remove,
    latest,
    setCurrent,
  }
}
