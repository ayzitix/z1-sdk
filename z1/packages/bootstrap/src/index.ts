export const PACKAGE = '@z1/bootstrap'

export {
  DEFAULT_CONFIG,
  DEFAULT_DB_PATH,
  DEFAULT_GRAPHS_PATH,
  DEFAULT_MODULES_PATH,
  loadRuntimeConfig,
} from './config.ts'
export type { LoadRuntimeConfigOptions, RuntimeConfig } from './config.ts'
export { builtinRegistry, createRuntime } from './runtime.ts'
export type { RunHandle, RunOverrides, Runtime } from './runtime.ts'
