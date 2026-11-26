/**
 * The `env.keys` decorator: one always-on tool over `<workspace>/.env`.
 *
 * Keys reach a tool through `ctx.env.NAME`, resolved from this file by the z2q
 * runtime, and nothing in z1 managed it: a person hand-edited `.env`, and
 * nothing answered whether that file was ignored, whether it was committed, or
 * whether a key had already been pasted into a source file. This tool answers
 * those questions and performs the two writes, always present in a run, because
 * a tool the model must have is not a per-workspace install it can lack.
 *
 * The contract is a single `action` enum and one rule that shapes every result:
 * **a value never leaves this service**. `list` reports a name and a length,
 * `check` reports booleans and a mode, `scan` reports `path:line`, `set` reports
 * that it wrote and how long the value was. The one place a value is visible is
 * the call itself — the model typed it — and the description says so.
 *
 * Arguments are validated here by hand, in the shape the other tool services
 * refuse in (`tool-gate.ts`, `tool-composite.ts`): a structured error naming
 * the field, thrown before the filesystem is touched.
 *
 * @module @z1/env-keys/service
 */

import { relative, resolve, sep } from 'node:path'

import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import {
  gitReport,
  readEnvFile,
  readKeys,
  readSecrets,
  removeAssignment,
  scanWorkspace,
  statEnvFile,
  upsertAssignment,
  writeEnvFile,
} from './dotenv.ts'
import { EnvKeysError } from './errors.ts'

/** The one tool this decorator adds. */
export const ENV_KEYS_TOOL_NAME = 'env.keys'

/** The file the tool manages, relative to the workspace. */
export const ENV_FILE_NAME = '.env'

/**
 * The most a value may be, in bytes.
 *
 * A `.env` value is a credential or a setting, not a payload, and the whole file
 * is read back into memory on every call. 8 KiB is the same ceiling the schema
 * advertises; the check here is in bytes because that is what the file costs.
 */
export const MAX_ENV_VALUE_BYTES = 8 * 1024

/**
 * The most a variable name may be.
 *
 * Nothing in dotenv limits a name, but a transcript is not the place to learn
 * that a model can send 40 KiB of letters: the same cap the schema advertises is
 * enforced here.
 */
export const MAX_ENV_NAME_LENGTH = 128

/** The levels every z1 service logger takes (`ModuleServiceLogLevel`). */
export type EnvKeysLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** What the decorator needs from its host. */
export interface EnvKeysServiceOptions {
  /** The tools the run already has; every call not named `env.keys` goes here. */
  inner: ToolService
  /** The workspace whose `.env` this tool manages, absolute or resolvable. */
  workspace: string
  /** File name inside the workspace. Default `.env`. */
  file?: string
  log?: (level: EnvKeysLogLevel, message: string, data?: Json) => void
}

/** The actions the tool takes. Anything else is `invalid_arguments`. */
const ACTIONS = ['list', 'set', 'unset', 'check', 'scan'] as const

type EnvKeysAction = (typeof ACTIONS)[number]

/**
 * What a variable name may look like.
 *
 * The same pattern `dotenv`, a shell and every `.env` reader agree on: a name
 * that fails it cannot be exported, so writing it would produce a line the file
 * itself cannot honour.
 */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Model-facing declaration of `env.keys`. Runtime validation is stricter. */
export const envKeysSchema: ToolSchema = {
  name: ENV_KEYS_TOOL_NAME,
  description:
    'Manage the keys in this workspace\'s .env file. It never returns a value: every action reports names, lengths, counts, booleans and path:line only. "list" reports each key name and the length of its value. "set" writes one key — the file is created when absent, the existing assignment is replaced in place, and every other line and comment is kept byte-identical. "unset" removes one key and leaves the rest of the file untouched. "check" reports whether the file exists, whether git ignores it, whether git tracks it, and its octal mode on platforms that have one. "scan" searches the workspace for the values found in .env (8 characters or longer) and names any file that contains one as path:line, so a key pasted into a source file is found without the value being repeated. Passing "value" to "set" writes it into .env and the value appears in this call.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description:
          'What to do: "list" the key names, "set" one key, "unset" one key, "check" the file\'s standing in git and its mode, or "scan" the workspace for a leaked value.',
      },
      name: {
        type: 'string',
        maxLength: MAX_ENV_NAME_LENGTH,
        description:
          'The variable name for "set" and "unset": letters, digits and underscores, not starting with a digit, for example "OPENAI_API_KEY".',
      },
      value: {
        type: 'string',
        maxLength: MAX_ENV_VALUE_BYTES,
        description:
          'The value for "set": non-empty, at most 8 KiB of UTF-8, and no line break. It is written to .env and appears in this call, so never repeat it in your reply.',
      },
      glob: {
        type: 'string',
        description:
          'For "scan" only: which workspace files to search, relative to the workspace root. Default "**/*".',
      },
    },
  },
}

/**
 * Wrap a tool service with `env.keys`.
 *
 * `list()` appends the schema to the inner inventory in the inner order, and
 * `call()` routes every other name to `inner` untouched — same arguments, same
 * result, same throw. There is no switch and no availability check: the service
 * is composed whenever a run has a workspace, which is every run, because the
 * user asked for a tool that cannot be forgotten. A host that must not manage a
 * `.env` does not start a run in a workspace.
 */
export function createEnvKeysService(options: EnvKeysServiceOptions): ToolService {
  const { inner, log } = options
  const workspace = resolve(options.workspace)
  const file = resolve(workspace, options.file ?? ENV_FILE_NAME)
  // Every result names the file the same way: relative to the workspace, which
  // is how the model and the person reading the run both see it. An absolute
  // host path in a transcript says more about the machine than it needs to.
  const shown = relative(workspace, file).split(sep).join('/') || file
  let warnedCollision = false

  /** `list`: the key names, their value lengths, and which are also in the host env. */
  const list = async (): Promise<Json> => {
    const text = await readEnvFile(file)
    const keys = text === undefined ? [] : readKeys(text)
    log?.('debug', `env.keys: listed ${shown} (${String(keys.length)} keys)`)
    return {
      file: shown,
      exists: text !== undefined,
      keys: keys.map((key) => ({
        name: key.name,
        length: key.length,
        inEnvironment: Object.hasOwn(process.env, key.name),
      })),
      count: keys.length,
    }
  }

  /** `set`: one assignment written atomically, with the value never echoed. */
  const set = async (request: EnvAssignment): Promise<Json> => {
    const text = await readEnvFile(file)
    const next = upsertAssignment(text ?? '', request.name, request.value)
    await writeEnvFile(file, next.text)
    log?.(
      'info',
      `env.keys: ${next.replaced ? 'replaced' : 'added'} "${request.name}" in ${shown} (${String(request.value.length)} characters)`,
    )
    return { file: shown, name: request.name, replaced: next.replaced, length: request.value.length }
  }

  /** `unset`: the assignment goes, the file's other bytes do not. */
  const unset = async (name: string): Promise<Json> => {
    const text = await readEnvFile(file)
    if (text === undefined) {
      log?.('info', `env.keys: "${name}" is not in ${shown}; the file does not exist`)
      return { file: shown, name, removed: false }
    }
    const next = removeAssignment(text, name)
    // Not rewriting an unchanged file keeps its mtime, and a no-op that touches
    // nothing is easier to trust than one that rewrites identical bytes.
    if (next.removed) await writeEnvFile(file, next.text)
    log?.(
      'info',
      next.removed
        ? `env.keys: removed "${name}" from ${shown}`
        : `env.keys: "${name}" is not in ${shown}`,
    )
    return { file: shown, name, removed: next.removed }
  }

  /** `check`: existence and mode from the filesystem, the git half from git. */
  const check = async (): Promise<Json> => {
    const state = await statEnvFile(file)
    const git = await gitReport(file, workspace)
    log?.(
      'debug',
      `env.keys: checked ${shown} (exists ${String(state.exists)}, ignored ${String(git.gitignored)}, tracked ${String(git.tracked)})`,
    )
    return {
      file: shown,
      exists: state.exists,
      gitignored: git.gitignored,
      tracked: git.tracked,
      mode: state.mode,
    }
  }

  /** `scan`: which workspace files already contain a value from `.env`. */
  const scan = async (glob: string): Promise<Json> => {
    const text = await readEnvFile(file)
    const secrets = text === undefined ? [] : readSecrets(text)
    const outcome = await scanWorkspace(workspace, glob, secrets, file)
    log?.(
      outcome.leaks.length === 0 ? 'info' : 'warn',
      outcome.leaks.length === 0
        ? `env.keys: scanned the ${String(secrets.length)} key(s) of ${shown} in "${glob}"; no leak found`
        : `env.keys: scanned the ${String(secrets.length)} key(s) of ${shown} in "${glob}"; ${String(outcome.leaks.length)} leak(s): ${outcome.leaks.map((leak) => `${leak.path}:${String(leak.line)}`).join(', ')}`,
    )
    return {
      file: shown,
      keys: secrets.length,
      leaks: outcome.leaks.map((leak) => ({ name: leak.name, path: leak.path, line: leak.line })),
      truncated: outcome.truncated,
    }
  }

  return {
    async list(): Promise<readonly ToolSchema[]> {
      const current = await inner.list()
      if (!warnedCollision && current.some((schema) => schema.name === ENV_KEYS_TOOL_NAME)) {
        warnedCollision = true
        log?.(
          'warn',
          `env.keys: the wrapped service already advertises "${ENV_KEYS_TOOL_NAME}"; this tool answers that name`,
        )
      }
      return [...current, envKeysSchema]
    },

    async call(name: string, args: Json): Promise<Json> {
      if (name !== ENV_KEYS_TOOL_NAME) return await inner.call(name, args)

      // Validation first and outside the try: a refused argument must never be
      // reported as an I/O failure, and the filesystem must not be touched.
      const request = parseRequest(args)
      try {
        switch (request.action) {
          case 'list':
            return await list()
          case 'set':
            return await set(request)
          case 'unset':
            return await unset(request.name)
          case 'check':
            return await check()
          case 'scan':
            return await scan(request.glob)
        }
      } catch (error) {
        const failed =
          error instanceof EnvKeysError
            ? error
            : new EnvKeysError('io_failed', `${request.action} failed: ${messageOf(error)}`, {
                cause: error,
              })
        log?.('error', `env.keys: ${failed.message}`)
        throw failed
      }
    },
  }
}

/** `set` is the only action that carries a value. */
interface EnvAssignment {
  readonly name: string
  readonly value: string
}

type EnvKeysRequest =
  | { readonly action: 'list' }
  | ({ readonly action: 'set' } & EnvAssignment)
  | { readonly action: 'unset'; readonly name: string }
  | { readonly action: 'check' }
  | { readonly action: 'scan'; readonly glob: string }

/**
 * Validate an `env.keys` call.
 *
 * The schema the model saw is an advertisement; this is the boundary. Every
 * refusal names the field and keeps the filesystem untouched, and a value is
 * never quoted back in a message — a refusal must not become the second copy of
 * a secret in the transcript.
 */
function parseRequest(args: Json): EnvKeysRequest {
  if (!isRecord(args)) {
    throw invalid(`env.keys takes an object with "action": ${ACTIONS.join(', ')}`)
  }
  const action = args['action']
  if (typeof action !== 'string' || !isAction(action)) {
    throw invalid(
      `"action" must be one of ${ACTIONS.join(', ')}, got ${described(action)}`,
    )
  }

  switch (action) {
    case 'list':
    case 'check':
      return { action }
    case 'unset':
      return { action, name: nameOf(args) }
    case 'set':
      return { action, name: nameOf(args), value: valueOf(args) }
    case 'scan': {
      const raw = args['glob']
      if (raw === undefined) return { action, glob: '**/*' }
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw invalid('"glob" must be a non-empty pattern such as "**/*" or "src/**/*.ts"')
      }
      return { action, glob: raw.trim() }
    }
  }
}

/** The `name` argument, refused unless a `.env` reader could honour it. */
function nameOf(args: Record<string, Json>): string {
  const raw = args['name']
  if (typeof raw !== 'string') {
    throw invalid('"name" must be a string such as "OPENAI_API_KEY"')
  }
  const name = raw.trim()
  if (name.length > MAX_ENV_NAME_LENGTH) {
    throw invalid(
      `"name" must be at most ${String(MAX_ENV_NAME_LENGTH)} characters, got ${String(name.length)}`,
    )
  }
  if (!NAME_PATTERN.test(name)) {
    throw invalid(
      `"name" must match ${String(NAME_PATTERN)} — letters, digits and underscores, not starting with a digit — so a .env reader can use it`,
    )
  }
  return name
}

/**
 * The `value` argument.
 *
 * Checked before the write, because each refusal here is a file the tool would
 * otherwise have to write and every reader would then have to mis-parse: an
 * empty value is indistinguishable from unset, and a line break would end the
 * assignment early and let the rest of the string become a second line — a way
 * to write arbitrary content into the file through a value.
 */
function valueOf(args: Record<string, Json>): string {
  const raw = args['value']
  if (typeof raw !== 'string') {
    throw invalid('"value" must be a string')
  }
  if (raw === '') {
    throw invalid('"value" must not be empty; use "unset" to remove a key')
  }
  if (raw.includes('\n') || raw.includes('\r')) {
    throw invalid('"value" must not contain a line break')
  }
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > MAX_ENV_VALUE_BYTES) {
    throw invalid(
      `"value" must be at most ${String(MAX_ENV_VALUE_BYTES)} bytes of UTF-8, got ${String(bytes)}`,
    )
  }
  return raw
}

function isAction(value: string): value is EnvKeysAction {
  return (ACTIONS as readonly string[]).includes(value)
}

function invalid(message: string): EnvKeysError {
  return new EnvKeysError('invalid_arguments', message)
}

/** The received value, named but never echoed when it could be a secret. */
function described(value: Json | undefined): string {
  if (value === undefined) return 'nothing'
  return typeof value === 'string' ? JSON.stringify(value) : typeof value
}

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
