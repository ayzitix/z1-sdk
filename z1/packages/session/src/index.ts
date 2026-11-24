/**
 * Project-local chat transcripts.
 *
 * A session is a directory of plain files under the repository (`z1/`), not a
 * row in a database: the transcript stays greppable, diffable and survives a
 * rotated or moved journal. Messages are the record; the SQLite journal is
 * provenance only, reached through `SessionMeta.runs`.
 *
 * @module @z1/session
 */

export const PACKAGE = '@z1/session'

export {
  SESSION_SCHEMA_VERSION,
  SessionClearedError,
  SessionCorruptError,
  SessionTooNewError,
  type AppendTurnOptions,
  type CreateSessionStoreOptions,
  type ListSessionsOptions,
  type NewSessionInput,
  type ResolvedSessionRoot,
  type ResolveSessionRootOptions,
  type Session,
  type SessionMeta,
  type SessionMetaPatch,
  type SessionModel,
  type SessionParent,
  type SessionRootMode,
  type SessionStore,
  type SessionSummary,
} from './types.ts'
export { createSessionStore } from './store.ts'
export {
  findRepoRoot,
  pruneTrash,
  resolveSessionRoot,
  TRASH_KEEP,
  TRASH_KEEP_MS,
  type PruneTrashOptions,
} from './paths.ts'
