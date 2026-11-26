export const PACKAGE = '@z1/env-keys'

export {
  MIN_SECRET_LENGTH,
  SCAN_MAX_BYTES,
  SCAN_MAX_FILES,
  findLeaks,
  gitReport,
  parseValue,
  readEnvFile,
  readKeys,
  readSecrets,
  removeAssignment,
  scanWorkspace,
  statEnvFile,
  upsertAssignment,
  writeEnvFile,
} from './dotenv.ts'
export type {
  EnvFileState,
  EnvKeyEntry,
  EnvLeak,
  EnvRemoval,
  EnvSecret,
  EnvUpsert,
  GitState,
  ScanOutcome,
} from './dotenv.ts'
export { ENV_KEYS_ERROR_CODES, EnvKeysError } from './errors.ts'
export type { EnvKeysErrorCode } from './errors.ts'
export {
  ENV_FILE_NAME,
  ENV_KEYS_TOOL_NAME,
  MAX_ENV_NAME_LENGTH,
  MAX_ENV_VALUE_BYTES,
  createEnvKeysService,
  envKeysSchema,
} from './service.ts'
export type { EnvKeysLogLevel, EnvKeysServiceOptions } from './service.ts'
