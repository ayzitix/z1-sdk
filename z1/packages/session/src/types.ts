/**
 * Types of the project-local chat transcript store.
 *
 * Messages are the authoritative record; the SQLite journal (`runs.db`) is
 * provenance only, reached through `SessionMeta.runs`. Nothing here is a node
 * or a `ctx` service: a store is plain synchronous filesystem work.
 *
 * @module @z1/session/types
 */

import type { ChatMessage } from '@z1/node'

/** The only on-disk layout this build understands. */
export const SESSION_SCHEMA_VERSION = 1

/**
 * `project` wrote into the repository, `fallback` could not and used the XDG
 * data dir instead, `override` was pointed somewhere by `Z1_SESSIONS_DIR`.
 */
export type SessionRootMode = 'project' | 'fallback' | 'override'

export interface SessionModel {
  provider: string
  model: string
}

/** Fork provenance: the ancestor session and the ordinal it was read up to. */
export interface SessionParent {
  id: string
  atOrdinal: number
}

export interface SessionMeta {
  schemaVersion: 1
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** Where the conversation happened. Metadata, never a key. */
  cwd: string
  repoRoot: string
  /** ANSI-256 colour of the session's hexagon; stable across restarts. */
  color?: number
  gitBranch?: string
  model: SessionModel
  contextWindow: number
  maxSteps: number
  toolPolicyRevision?: number
  /** Run ids this session produced. Provenance into the journal, nothing more. */
  runs: string[]
  parent?: SessionParent
  archived: boolean
  messageCount: number
  /**
   * Transcript generation, advanced by `clear`. A caller that read messages at
   * generation *N* passes *N* to `appendTurn`; once the transcript has been
   * cleared the store rejects that append instead of re-inserting turns the
   * user deleted. Missing in older files, and then it means `0`.
   */
  generation?: number
}

export interface Session {
  meta: SessionMeta
  /** Non-`system` messages, in transcript order. */
  messages: readonly ChatMessage[]
  /** The last line of `events.jsonl` was incomplete and was dropped. */
  tornTail: boolean
}

export interface SessionSummary {
  id: string
  name: string
  updatedAt: number
  messageCount: number
  /** `SessionMeta.generation`, normalised so a missing value reads as 0. */
  generation: number
  model: SessionModel
  cwd: string
  archived: boolean
  /** ANSI-256 colour of the session's hexagon, when one was stored. */
  color?: number
}

export interface NewSessionInput {
  name?: string
  cwd: string
  repoRoot?: string
  gitBranch?: string
  model: SessionModel
  contextWindow: number
  maxSteps: number
  toolPolicyRevision?: number
  /** ANSI-256 colour; the console picks one when it creates the session. */
  color?: number
}

export interface AppendTurnOptions {
  /** Links this turn to the journal run that produced it. */
  runId?: string
  /**
   * The `SessionMeta.generation` the caller's `messages` were read from. When
   * it does not match, the transcript was cleared since that read and the
   * append is rejected with {@link SessionClearedError}: re-`load` the session
   * and append again. Omitting it keeps the old behaviour (append whatever the
   * caller holds), which is what a fresh transcript-less writer needs.
   */
  generation?: number
}

/** The mutable half of {@link SessionMeta}; identity and birth stay fixed. */
export type SessionMetaPatch = Partial<Omit<SessionMeta, 'schemaVersion' | 'id' | 'createdAt'>>

export interface ListSessionsOptions {
  includeArchived?: boolean
}

export interface SessionStore {
  readonly root: string
  readonly mode: SessionRootMode
  /** Why `Z1_SESSIONS_DIR` was refused, when it was and `mode` is `fallback`. */
  readonly warning?: string
  list(options?: ListSessionsOptions): readonly SessionSummary[]
  /** `undefined` when the id is unknown; throws {@link SessionTooNewError} past v1. */
  load(id: string): Session | undefined
  create(input: NewSessionInput): Session
  appendTurn(id: string, messages: readonly ChatMessage[], options?: AppendTurnOptions): void
  /**
   * Empty this session's transcript and keep the session: same `id`, name,
   * colour, model, folder, `archived` flag and `runs` provenance, with
   * `messageCount: 0`. `events.jsonl` is truncated atomically (the old turns are
   * gone from disk, not shadowed by a snapshot) so the next `appendTurn` starts
   * at `ord 0`. `generation` is incremented in the same metadata write, which is
   * what makes a stale caller's append fail instead of resurrecting the cleared
   * turns. Throws `unknownSession(id)` for an unknown id and
   * {@link SessionCorruptError} when the events file is a symbolic link. An
   * already-empty session is a no-op, `updatedAt` *and* `generation` included:
   * nothing changed, so nothing is announced as changed.
   */
  clear(id: string): void
  setMeta(id: string, patch: SessionMetaPatch): void
  rename(id: string, name: string): void
  archive(id: string, archived: boolean): void
  /**
   * Moves the session directory to `.trash/<timestamp>-<id>`; the entry itself
   * is kept until it falls out of the trash retention window (`pruneTrash`,
   * applied on `remove` and on opening a store), so a mistaken delete stays
   * recoverable for a while.
   */
  remove(id: string): void
  latest(): SessionSummary | undefined
  setCurrent(id: string): void
}

export interface ResolveSessionRootOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Receives a human-readable reason when a rejected claim forced a fallback. */
  onWarning?: (message: string) => void
}

export interface ResolvedSessionRoot {
  root: string
  mode: SessionRootMode
  repoRoot?: string
  /** Set when `Z1_SESSIONS_DIR` was refused and the per-project store is used. */
  warning?: string
}

export interface CreateSessionStoreOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** Receives a human-readable reason when a rejected claim forced a fallback. */
  onWarning?: (message: string) => void
}

/**
 * A `meta.json` written by a newer z1. Reading it as if it were v1 would
 * silently drop fields, so the store refuses instead.
 */
/** `events.jsonl` or `meta.json` is structurally invalid. */
export class SessionCorruptError extends Error {
  readonly file: string
  readonly line: number | undefined

  constructor(file: string, message: string, line?: number) {
    super(`session: ${file}${line === undefined ? '' : `:${String(line)}`} ${message}`)
    this.name = 'SessionCorruptError'
    this.file = file
    this.line = line
  }
}

export class SessionTooNewError extends Error {
  readonly schemaVersion: number

  constructor(file: string, schemaVersion: number) {
    super(
      `session: ${file} has schemaVersion ${schemaVersion}; this build understands ${SESSION_SCHEMA_VERSION}`,
    )
    this.name = 'SessionTooNewError'
    this.schemaVersion = schemaVersion
  }
}

/**
 * The caller appended a transcript from before a `clear`: the session's
 * `generation` moved on, so its messages are not a prefix of anything on disk
 * and re-appending them would resurrect turns the user deleted.
 */
export class SessionClearedError extends Error {
  readonly id: string
  /** The generation now on disk, i.e. the one the caller must reload at. */
  readonly generation: number

  constructor(id: string, generation: number) {
    super(
      `session: ${id} transcript was cleared (now generation ${String(generation)}); ` +
        'reload the session before appending',
    )
    this.name = 'SessionClearedError'
    this.id = id
    this.generation = generation
  }
}
