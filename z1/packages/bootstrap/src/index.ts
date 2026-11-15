export const PACKAGE = '@z1/bootstrap'

export {
  DEFAULT_CONFIG,
  DEFAULT_DB_PATH,
  DEFAULT_GRAPHS_PATH,
  DEFAULT_MODULES_PATH,
  DEFAULT_TEMPLATES_PATH,
  loadRuntimeConfig,
} from './config.ts'
export type { LoadRuntimeConfigOptions, FsMode, RuntimeConfig } from './config.ts'
export { createLocalFsService } from './fs-local.ts'
export { createTemplateRegistry } from './templates.ts'
export {
  PACKAGE as SESSION_PACKAGE,
  SESSION_SCHEMA_VERSION,
  SessionClearedError,
  SessionTooNewError,
  createSessionStore,
  findRepoRoot,
  resolveSessionRoot,
} from '@z1/session'
export type {
  AppendTurnOptions,
  CreateSessionStoreOptions,
  ListSessionsOptions,
  NewSessionInput,
  ResolvedSessionRoot,
  ResolveSessionRootOptions,
  Session,
  SessionMeta,
  SessionMetaPatch,
  SessionModel,
  SessionParent,
  SessionRootMode,
  SessionStore,
  SessionSummary,
} from '@z1/session'
export { CassetteExportError, exportCassette, loadCassette } from './cassette.ts'
export { builtinRegistry, createRuntime } from './runtime.ts'
export type { RunHandle, RunOverrides, Runtime } from './runtime.ts'
