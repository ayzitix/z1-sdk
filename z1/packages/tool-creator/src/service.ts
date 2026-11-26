/**
 * The `tool.create` decorator.
 *
 * One tool sits next to the tools a run already has: the model asks for a tool
 * in plain language, and the answer is a reviewed, built, smoke-tested
 * **proposal** with a capability summary a person can approve. Installation is
 * never part of the tool — `z1 tool install <projectDir>` is the human step,
 * and keeping it out of the model's reach is the whole approval story.
 *
 * Everything the model sends is validated here by hand, in the shape the other
 * tool services refuse in (`tool-gate.ts`, `tool-composite.ts`): a structured
 * error naming the field, thrown before the port is touched, so a malformed call
 * can never start a model run that spends a budget on nothing.
 *
 * @module @z1/tool-creator/service
 */

import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import { ToolCreatorError, ToolCreatorUnavailableError, toolCreatorErrorTap } from './errors.ts'
import type { ToolCreatorErrorTap } from './errors.ts'
import { loadToolCreatorPort } from './port.ts'
import { toolInstallNext } from './types.ts'
import type { ToolCreationRequest, ToolCreatorPort, ToolGenerate, ToolProposalSummary } from './types.ts'

/** The one tool this decorator adds. */
export const TOOL_CREATE_NAME = 'tool.create'

/** The switch the bootstrap reads; `1` (or `true`) turns the decorator on. */
export const TOOL_CREATOR_ENV = 'Z1_TOOL_CREATOR'

/** The sdk's own cap, so a name it would refuse is refused here first. */
export const MAX_TOOL_CREATE_NAME_LENGTH = 64

/** The sdk's own cap on `purpose`. */
export const MAX_TOOL_CREATE_PURPOSE_LENGTH = 2000

/**
 * `tool.<slug>`: the prefix, then lowercase letters, digits and dashes.
 *
 * Stricter than the sdk's name pattern on purpose. The creator accepts a bare
 * phrase and normalises it, but a tool the model asks for is a *name* a person
 * will read in an approval prompt, and `nope` or a path-like `tool..x` must be
 * refused here rather than becoming a directory somewhere.
 */
const TOOL_NAME_PATTERN = /^tool\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** The levels every z1 service logger takes (`ModuleServiceLogLevel`). */
export type ToolCreatorLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** What the decorator needs from its host. */
export interface ToolCreatorServiceOptions {
  /** The tools the agent already has; every call not named `tool.create` goes here. */
  inner: ToolService
  /** The workspace a proposal's smoke test runs against. */
  workspace: string
  /** The port, or a promise for it. Absent → `tool.create` loads the sdk lazily. */
  port?: ToolCreatorPort | Promise<ToolCreatorPort>
  /** Injected by the host; the same hook `createToolCreator` takes. */
  generate?: ToolGenerate
  /**
   * Handed to the port's `install` by a host that installs explicitly. The
   * service never installs, so it never reads this.
   */
  approvedBy?: string
  log?: (level: ToolCreatorLogLevel, message: string, data?: Json) => void
}

/** Model-facing declaration of `tool.create`. Runtime validation is stricter. */
export const toolCreateSchema: ToolSchema = {
  name: TOOL_CREATE_NAME,
  description:
    'Create a z1 tool from a plain-language request. The z2q creator writes the source, reviews it, retries with the exact issues, builds the project and smoke-tests it, then returns a proposal: name, version, sha256, what it may touch, its risk class and the next step. The smoke test already ran the new tool once per example in this workspace with exactly the capabilities it declares, including any declared host and environment variable — nothing is installed, and a person installs the proposal with `z1 tool install <projectDir>` (the same CLI is `z1-tool` inside the z2q checkout) after reading the capability lines.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'purpose'],
    properties: {
      name: {
        type: 'string',
        maxLength: MAX_TOOL_CREATE_NAME_LENGTH,
        description:
          'The tool name: "tool." followed by a lowercase slug of letters, digits and dashes, for example "tool.find-todos".',
      },
      purpose: {
        type: 'string',
        maxLength: MAX_TOOL_CREATE_PURPOSE_LENGTH,
        description: 'One or two sentences: what the tool must do, and what it returns.',
      },
      examples: {
        type: 'array',
        items: {},
        description:
          'Optional sample inputs, one string or object each. The smoke test runs one call per entry.',
      },
    },
  },
}

/**
 * Is the decorator enabled for this process?
 *
 * On by default: `tool.create` is a system tool — it shows up in every listing
 * and is refused by `delete`, so the only way to remove it is at its source.
 * `Z1_TOOL_CREATOR` set to `0`, `false`, `off` or `no` (trimmed, any case) turns
 * it off; an unset, empty or unknown value leaves it on. The bootstrap reads its
 * resolved environment, not `process.env` directly, so a test or a host that
 * supplies `env` decides for itself.
 */
export function toolCreatorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[TOOL_CREATOR_ENV]?.trim().toLowerCase()
  if (value === undefined || value === '') return true
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no'
}

/**
 * Wrap a tool service with `tool.create`.
 *
 * `list()` appends the schema to the inner inventory in the inner order, and
 * `call()` routes every other name to `inner` untouched — same arguments, same
 * result, same throw. Without a port the tool loads the sdk lazily on the first
 * call and answers with a `tool_creator_unavailable` error naming
 * `Z1_TOOL_SDK_PATH` when it is not there.
 */
export function createToolCreatorService(options: ToolCreatorServiceOptions): ToolService {
  const { inner, workspace, generate, log } = options
  const injected = options.port
  let loading: Promise<ToolCreatorPort> | undefined
  let warnedCollision = false

  /**
   * The port, loaded at most once per service.
   *
   * A failed load is not cached: a person who sets `Z1_TOOL_SDK_PATH` after the
   * first refusal must be able to try again without a new process.
   */
  async function resolvePort(): Promise<ToolCreatorPort> {
    if (injected !== undefined) return await injected
    loading ??= loadToolCreatorPort({
      workspace,
      ...(generate === undefined ? {} : { generate }),
    })
    try {
      return await loading
    } catch (error) {
      loading = undefined
      throw error
    }
  }

  return {
    async list(): Promise<readonly ToolSchema[]> {
      const current = await inner.list()
      if (!warnedCollision && current.some((schema) => schema.name === TOOL_CREATE_NAME)) {
        warnedCollision = true
        log?.(
          'warn',
          `tool create: the wrapped service already advertises "${TOOL_CREATE_NAME}"; the creator's tool answers that name`,
        )
      }
      return [...current, toolCreateSchema]
    },

    async call(name: string, args: Json): Promise<Json> {
      if (name !== TOOL_CREATE_NAME) return await inner.call(name, args)

      const request = parseRequest(args)

      let port: ToolCreatorPort
      try {
        port = await resolvePort()
      } catch (error) {
        const tapped = tapOrFail(error)
        log?.('warn', `tool create: unavailable: ${tapped.message}`)
        throw raised(tapped, error)
      }

      let summary: ToolProposalSummary
      try {
        summary = await port.propose(request, { workspace })
      } catch (error) {
        const tapped = tapOrFail(error)
        log?.('error', `tool create: "${request.name}" failed: ${tapped.message}`)
        throw raised(tapped, error)
      }

      log?.(
        'info',
        `tool create: proposal "${summary.name}" ${summary.version} at ${summary.projectDir} (attempts ${String(summary.attempts)}, risk ${summary.capabilities.risk})`,
      )
      return proposalJson(summary)
    },
  }
}

/**
 * Validate a `tool.create` call.
 *
 * The schema the model saw is an advertisement; this is the boundary. Every
 * refusal names the field and keeps the port untouched.
 */
function parseRequest(args: Json): ToolCreationRequest {
  if (!isRecord(args)) {
    throw invalid('tool.create takes an object with "name" and "purpose"')
  }
  const rawName = args['name']
  if (typeof rawName !== 'string') {
    throw invalid('"name" must be a string shaped like "tool.<slug>"')
  }
  const name = rawName.trim()
  if (!TOOL_NAME_PATTERN.test(name) || name.length > MAX_TOOL_CREATE_NAME_LENGTH) {
    throw invalid(
      `"name" must be "tool.<slug>" — lowercase letters, digits and dashes after "tool.", at most ${String(MAX_TOOL_CREATE_NAME_LENGTH)} characters — got ${JSON.stringify(rawName)}`,
    )
  }

  const rawPurpose = args['purpose']
  if (typeof rawPurpose !== 'string') {
    throw invalid('"purpose" must be a string of one or two sentences')
  }
  const purpose = rawPurpose.trim()
  if (purpose.length === 0) {
    throw invalid('"purpose" must say what the tool has to do')
  }
  if (purpose.length > MAX_TOOL_CREATE_PURPOSE_LENGTH) {
    throw invalid(
      `"purpose" must be at most ${String(MAX_TOOL_CREATE_PURPOSE_LENGTH)} characters, got ${String(purpose.length)}`,
    )
  }

  const rawExamples = args['examples']
  if (rawExamples === undefined) return { name, purpose }
  if (!Array.isArray(rawExamples)) {
    throw invalid('"examples" must be an array of sample inputs')
  }
  for (const [index, example] of rawExamples.entries()) {
    if (!isJsonValue(example)) {
      throw invalid(`"examples[${String(index)}]" must be a JSON value`)
    }
  }
  return { name, purpose, examples: [...rawExamples] }
}

/** The summary as the JSON a tool result carries, with `next` always the command. */
function proposalJson(summary: ToolProposalSummary): Json {
  return {
    name: summary.name,
    version: summary.version,
    sha256: summary.sha256,
    projectDir: summary.projectDir,
    attempts: summary.attempts,
    history: summary.history.map((attempt) => [...attempt]),
    smoke: {
      ok: summary.smoke.ok,
      runs: summary.smoke.runs.map((run) => ({
        ok: run.ok,
        denied: run.denied,
        ...(run.code === undefined ? {} : { code: run.code }),
      })),
    },
    capabilities: { lines: [...summary.capabilities.lines], risk: summary.capabilities.risk },
    next: toolInstallNext(summary.projectDir),
  }
}

/** Read a coded throw, or report it as an unexplained failure with its text. */
function tapOrFail(error: unknown): ToolCreatorErrorTap {
  const tapped = toolCreatorErrorTap(error)
  if (tapped !== undefined) return tapped
  return {
    code: 'tool_creator_failed',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** Re-raise a tap as this package's error, keeping the code, the issues and the cause. */
function raised(tapped: ToolCreatorErrorTap, cause: unknown): ToolCreatorError {
  const errorOptions = {
    ...(tapped.issues === undefined ? {} : { issues: tapped.issues }),
    cause,
  }
  return tapped.code === 'tool_creator_unavailable'
    ? new ToolCreatorUnavailableError(tapped.message, errorOptions)
    : new ToolCreatorError(tapped.code, tapped.message, errorOptions)
}

function invalid(message: string): ToolCreatorError {
  return new ToolCreatorError('invalid_request', message)
}

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is Json {
  if (value === null) return true
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return true
    case 'object':
      return Array.isArray(value)
        ? value.every(isJsonValue)
        : Object.values(value).every(isJsonValue)
    default:
      return false
  }
}
