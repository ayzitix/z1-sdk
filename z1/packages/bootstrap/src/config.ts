/**
 * Configuration for a `z1` process: where its journal, graphs and modules live,
 * whether runs reach the real providers, and which providers exist.
 *
 * Precedence is `overrides` > environment > `z1.config.json` > defaults, so the
 * same config file serves the CLI, the server and the tests.
 *
 * @module @z1/bootstrap/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import {
  DEFAULT_PROVIDERS,
  providersFromEnv,
  type ProviderConfig,
  type ProviderProtocol,
} from '@z1/provider'
import type { RecordLlmMode } from '@z1/runtime'

/** Where `ctx.fs` of a run reads and writes. */
export type FsMode = 'local' | 'memory'

export interface RuntimeConfig {
  cwd: string
  /**
   * Backend of the ambient filesystem service. `local` uses the real disk,
   * `memory` keeps the in-process mock used by tests. Defaults to `local`.
   */
  fsMode?: FsMode
  /** SQLite journal for runs and artifacts. */
  dbPath: string
  /** One JSON file per saved graph. */
  graphsPath: string
  /** Installed modules, proposals and the audit log. */
  modulesPath: string
  /** Static graph templates, one JSON file per template. */
  templatesPath: string
  /** Route model calls to the configured providers instead of the mock. */
  live: boolean
  /** Load active module declarations and start their workers on a run. */
  useModules: boolean
  /** Start services of active modules, in-process or in a worker (`Z1_SERVICE_MODULES`). */
  useServiceModules: boolean
  /** Give runs branch memory over the journal. */
  useMemory: boolean
  /**
   * How much model traffic is journaled: `full` stores request/response blobs,
   * `hashes` stores only the events and their hashes, `off` records nothing.
   * `Z1_RECORD_LLM`; defaults to `full`.
   */
  recordLlm: RecordLlmMode
  /**
   * Recorded model traffic to replay from (`--cassette`, `Z1_CASSETTE`). When set
   * it replaces the provider registry entirely: no network call is made.
   */
  cassette?: string
  providers: readonly ProviderConfig[]
  env: Record<string, string | undefined>
}

/** Default journal path, relative to `cwd`. */
export const DEFAULT_DB_PATH = '.z1/runs.db'
/** Default graph library, relative to `cwd`. */
export const DEFAULT_GRAPHS_PATH = '.z1/graphs'
/** Default module store, relative to the home directory. */
export const DEFAULT_MODULES_PATH = '~/.z1/modules'
/** Default static template library, relative to `cwd`. */
export const DEFAULT_TEMPLATES_PATH = '.z1/templates'

/** The config used when neither a file nor the environment says otherwise. */
export const DEFAULT_CONFIG = {
  fsMode: 'local' as FsMode,
  dbPath: DEFAULT_DB_PATH,
  graphsPath: DEFAULT_GRAPHS_PATH,
  modulesPath: DEFAULT_MODULES_PATH,
  templatesPath: DEFAULT_TEMPLATES_PATH,
  live: false,
  useModules: true,
  useServiceModules: true,
  useMemory: true,
  recordLlm: 'full' as RecordLlmMode,
} as const

const FILE_KEYS = [
  'fsMode',
  'dbPath',
  'graphsPath',
  'modulesPath',
  'templatesPath',
  'live',
  'useModules',
  'useServiceModules',
  'useMemory',
  'recordLlm',
  'cassette',
  'providers',
] as const

const PROVIDER_KEYS = ['id', 'protocol', 'envKey', 'baseURL', 'headers'] as const

interface RuntimeConfigFile {
  fsMode?: FsMode
  dbPath?: string
  graphsPath?: string
  modulesPath?: string
  templatesPath?: string
  live?: boolean
  useModules?: boolean
  useServiceModules?: boolean
  useMemory?: boolean
  recordLlm?: RecordLlmMode
  cassette?: string
  providers?: readonly ProviderConfig[]
}

export interface LoadRuntimeConfigOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Defaults to `<cwd>/z1.config.json`; a missing file is not an error. */
  file?: string
  /**
   * Trust the config file with security-sensitive keys (`providers` that
   * redefine a built-in endpoint, `modulesPath`). A file discovered in the
   * current directory is untrusted by default: a cloned repository must not be
   * able to point a real key at its own base URL or install its own modules.
   * `Z1_TRUST_CONFIG=1` is the environment equivalent.
   */
  trustFile?: boolean
  overrides?: Partial<RuntimeConfig>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProtocol(value: unknown): value is ProviderProtocol {
  return value === 'openai-completions'
}

function isFsMode(value: unknown): value is FsMode {
  return value === 'local' || value === 'memory'
}

/** Accept only the two known backends; a typo must not silently hit the disk. */
function readFsMode(value: unknown, label: string): FsMode {
  if (!isFsMode(value)) throw new Error(`${label} must be "local" or "memory"`)
  return value
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function readProvider(value: unknown, label: string): ProviderConfig {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (!(PROVIDER_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${label} has unknown key "${key}"; expected ${PROVIDER_KEYS.join(', ')}`,
      )
    }
  }

  const config: ProviderConfig = {
    id: requiredText(value['id'], `${label}.id`),
    envKey: requiredText(value['envKey'], `${label}.envKey`),
    baseURL: requiredText(value['baseURL'], `${label}.baseURL`),
  }

  const protocol = value['protocol']
  if (protocol !== undefined) {
    if (!isProtocol(protocol)) {
      throw new Error(`${label}.protocol must be "openai-completions"`)
    }
    config.protocol = protocol
  }

  const headers = value['headers']
  if (headers !== undefined) {
    if (!isRecord(headers) || Object.values(headers).some((entry) => typeof entry !== 'string')) {
      throw new Error(`${label}.headers must be an object of string values`)
    }
    const copy: Record<string, string> = {}
    for (const [name, entry] of Object.entries(headers)) copy[name] = entry as string
    config.headers = copy
  }

  return config
}

function readConfigFile(file: string): RuntimeConfigFile {
  if (!existsSync(file)) return {}

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`"${file}" is not valid JSON: ${errorMessage(error)}`)
  }
  if (!isRecord(raw)) throw new Error(`"${file}" must be a JSON object`)

  for (const key of Object.keys(raw)) {
    if (!(FILE_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `"${file}" has unknown key "${key}"; expected ${FILE_KEYS.join(', ')}`,
      )
    }
  }

  const config: RuntimeConfigFile = {}
  for (const key of ['dbPath', 'graphsPath', 'modulesPath', 'templatesPath', 'cassette'] as const) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || value === '') {
        throw new Error(`"${file}": ${key} must be a non-empty string`)
      }
      config[key] = value
    }
  }
  for (const key of ['live', 'useModules', 'useServiceModules', 'useMemory'] as const) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== 'boolean') {
        throw new Error(`"${file}": ${key} must be a boolean`)
      }
      config[key] = value
    }
  }

  const fsMode = raw['fsMode']
  if (fsMode !== undefined) config.fsMode = readFsMode(fsMode, `"${file}": fsMode`)

  const recordLlm = raw['recordLlm']
  if (recordLlm !== undefined) {
    config.recordLlm = readRecordLlm(recordLlm, `"${file}": recordLlm`)
  }

  const providers = raw['providers']
  if (providers !== undefined) {
    if (!Array.isArray(providers)) {
      throw new Error(`"${file}": providers must be an array`)
    }
    config.providers = providers.map((entry, index) =>
      readProvider(entry, `"${file}": providers[${String(index)}]`),
    )
    // Merging would silently keep the last one; a duplicate id is a typo the
    // author needs told about.
    const seen = new Set<string>()
    for (const provider of config.providers) {
      if (seen.has(provider.id)) {
        throw new Error(`"${file}" lists provider "${provider.id}" more than once`)
      }
      seen.add(provider.id)
    }
  }

  return config
}

/** `~/x` and `~` expand to the home directory; everything relative joins `cwd`. */
function expandPath(value: string, cwd: string): string {
  if (value === ':memory:') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(homedir(), value.slice(2))
  }
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function cloneProvider(config: ProviderConfig): ProviderConfig {
  const copy: ProviderConfig = {
    id: config.id,
    envKey: config.envKey,
    baseURL: config.baseURL,
  }
  if (config.protocol !== undefined) copy.protocol = config.protocol
  if (config.headers !== undefined) copy.headers = { ...config.headers }
  return copy
}

/** Config-file providers replace a default with the same id and append the rest. */
function mergeProviders(
  base: readonly ProviderConfig[],
  extra: readonly ProviderConfig[],
): ProviderConfig[] {
  const merged = base.map(cloneProvider)
  for (const config of extra) {
    const index = merged.findIndex((candidate) => candidate.id === config.id)
    if (index >= 0) merged[index] = cloneProvider(config)
    else merged.push(cloneProvider(config))
  }
  return merged
}

/** `1`/`0` only: the strict form, kept for `Z1_LIVE`. */
function envBoolean(name: string, env: Record<string, string | undefined>): boolean | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  if (raw === '1') return true
  if (raw === '0') return false
  throw new Error(`${name} must be 1 or 0, got "${raw}"`)
}

/** `1`/`0` plus the words `true`/`false`, for the newer feature switches. */
function envFlag(name: string, env: Record<string, string | undefined>): boolean | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  const lowered = raw.toLowerCase()
  if (lowered === '1' || lowered === 'true') return true
  if (lowered === '0' || lowered === 'false') return false
  throw new Error(`${name} must be 1, 0, true or false, got "${raw}"`)
}

/** Only the three recording modes; a typo must not silently record nothing. */
function readRecordLlm(value: unknown, label: string): RecordLlmMode {
  if (value === 'full' || value === 'hashes' || value === 'off') return value
  throw new Error(`${label} must be "full", "hashes" or "off"`)
}

/** `Z1_RECORD_LLM`, same three values as the file key. */
function envRecordLlm(
  name: string,
  env: Record<string, string | undefined>,
): RecordLlmMode | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  return readRecordLlm(raw.toLowerCase(), name)
}

/** `local` or `memory`; anything else is a configuration error. */
function envFsMode(
  name: string,
  env: Record<string, string | undefined>,
): FsMode | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  return readFsMode(raw.toLowerCase(), name)
}

/**
 * Providers a project config may contribute without being trusted.
 *
 * Adding a provider is harmless: it carries its own `envKey`, so it can only
 * read a variable the user set for it. Redefining a built-in provider is not —
 * a repository could point `openai` at its own host and receive the real key —
 * so an untrusted entry must match the built-in exactly.
 */
function vettedFileProviders(
  providers: readonly ProviderConfig[],
  file: string,
): ProviderConfig[] {
  const kept: ProviderConfig[] = []
  for (const provider of providers) {
    const builtin = DEFAULT_PROVIDERS.find((candidate) => candidate.id === provider.id)
    if (builtin === undefined) {
      kept.push(cloneProvider(provider))
      continue
    }
    const same =
      (provider.protocol ?? 'openai-completions') ===
        (builtin.protocol ?? 'openai-completions') &&
      provider.envKey === builtin.envKey &&
      provider.baseURL === builtin.baseURL &&
      JSON.stringify(provider.headers ?? {}) === JSON.stringify(builtin.headers ?? {})
    if (!same) {
      throw new Error(
        `"${file}" redefines the built-in provider "${provider.id}" (${provider.baseURL}); pass Z1_TRUST_CONFIG=1 to trust this directory`,
      )
    }
  }
  return kept
}

/**
 * Resolve one process config. Never mutates the file or the environment; a
 * caller that supplies `overrides` keeps whatever it explicitly names.
 */
export function loadRuntimeConfig(options: LoadRuntimeConfigOptions = {}): RuntimeConfig {
  const overrides = options.overrides ?? {}
  const env = options.env ?? overrides.env ?? process.env
  const cwd = resolve(overrides.cwd ?? options.cwd ?? process.cwd())
  const file = options.file ?? resolve(cwd, 'z1.config.json')
  const fromFile = readConfigFile(file)
  const trustFile =
    options.trustFile === true || envFlag('Z1_TRUST_CONFIG', env) === true

  const fileProviders = trustFile
    ? (fromFile.providers ?? [])
    : vettedFileProviders(fromFile.providers ?? [], file)
  const providers =
    overrides.providers !== undefined
      ? overrides.providers.map(cloneProvider)
      : mergeProviders(providersFromEnv(env), fileProviders)

  const dbPath = overrides.dbPath ?? env['Z1_DB'] ?? fromFile.dbPath ?? DEFAULT_CONFIG.dbPath
  const graphsPath =
    overrides.graphsPath ?? env['Z1_GRAPHS_DIR'] ?? fromFile.graphsPath ?? DEFAULT_CONFIG.graphsPath
  if (!trustFile && fromFile.modulesPath !== undefined) {
    // The module store is executable code: a repository must not choose it.
    throw new Error(
      `"${file}" sets modulesPath, which is executable code; pass Z1_TRUST_CONFIG=1 to trust this directory or use --modules-dir`,
    )
  }
  const modulesPath =
    overrides.modulesPath ??
    env['Z1_MODULES_DIR'] ??
    fromFile.modulesPath ??
    DEFAULT_CONFIG.modulesPath
  const templatesPath =
    overrides.templatesPath ??
    env['Z1_TEMPLATES_DIR'] ??
    fromFile.templatesPath ??
    DEFAULT_CONFIG.templatesPath
  const cassette = overrides.cassette ?? env['Z1_CASSETTE'] ?? fromFile.cassette
  const live =
    overrides.live ?? envBoolean('Z1_LIVE', env) ?? fromFile.live ?? DEFAULT_CONFIG.live

  return {
    cwd,
    fsMode:
      overrides.fsMode ?? envFsMode('Z1_FS', env) ?? fromFile.fsMode ?? DEFAULT_CONFIG.fsMode,
    dbPath: expandPath(dbPath, cwd),
    graphsPath: expandPath(graphsPath, cwd),
    modulesPath: expandPath(modulesPath, cwd),
    templatesPath: expandPath(templatesPath, cwd),
    ...(cassette === undefined || cassette === '' ? {} : { cassette: expandPath(cassette, cwd) }),
    live,
    useModules:
      overrides.useModules ??
      envFlag('Z1_USE_MODULES', env) ??
      fromFile.useModules ??
      DEFAULT_CONFIG.useModules,
    useServiceModules:
      overrides.useServiceModules ??
      envFlag('Z1_SERVICE_MODULES', env) ??
      fromFile.useServiceModules ??
      DEFAULT_CONFIG.useServiceModules,
    useMemory:
      overrides.useMemory ??
      envFlag('Z1_USE_MEMORY', env) ??
      fromFile.useMemory ??
      DEFAULT_CONFIG.useMemory,
    recordLlm:
      overrides.recordLlm ??
      envRecordLlm('Z1_RECORD_LLM', env) ??
      fromFile.recordLlm ??
      DEFAULT_CONFIG.recordLlm,
    ...(cassette === undefined ? {} : { cassette }),
    providers,
    env: { ...env },
  }
}
