/**
 * The one error shape `tool.create` fails with, and the tap that reads it back
 * across the sdk boundary.
 *
 * z2q is loaded at run time from another checkout, so its `ToolCreatorError` is
 * never an `instanceof` test here: the class object belongs to a module this
 * package imports lazily and may not exist at all. The code and the issues are
 * therefore read **structurally**, the same way `@z1/subagent` reads its own
 * errors, and the result is re-thrown as this package's class so a host has one
 * type to match.
 *
 * @module @z1/tool-creator/errors
 */

import type { Json } from '@z1/node'

/**
 * Every code this package's errors carry.
 *
 * The first four are raised here. The rest are z2q's own `ToolCreator` flow
 * codes, forwarded unchanged: a host that branches on `review_failed` keeps
 * working without importing the sdk's types. A foreign code outside this list
 * becomes `tool_creator_failed` rather than a value no caller can switch on.
 */
export const TOOL_CREATOR_ERROR_CODES = [
  'invalid_request',
  'model_unavailable',
  'tool_creator_unavailable',
  'tool_creator_failed',
  'model_failed',
  'model_timeout',
  'model_aborted',
  'no_source',
  'review_failed',
  'build_failed',
  'smoke_failed',
  'install_failed',
] as const

export type ToolCreatorErrorCode = (typeof TOOL_CREATOR_ERROR_CODES)[number]

const KNOWN_CODES: ReadonlySet<string> = new Set(TOOL_CREATOR_ERROR_CODES)

/** True when `value` is a code this package can hand a caller. */
export function isToolCreatorErrorCode(value: unknown): value is ToolCreatorErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value)
}

export interface ToolCreatorErrorOptions {
  /**
   * Review issues, verbatim from the creator. They are already plain JSON
   * (`code`, `message`, `line`, …), so they survive the tool boundary.
   */
  readonly issues?: readonly Json[]
  readonly cause?: unknown
}

/**
 * A `tool.create` failure with a machine-readable reason.
 *
 * The code is part of the contract: `z1.tool.call` reports the message as
 * `{ error }`, and a host that holds the error itself branches on `code` and
 * reads `issues` instead of parsing prose. The message starts with the code so
 * the text-only path says the same thing.
 */
export class ToolCreatorError extends Error {
  readonly code: ToolCreatorErrorCode
  readonly issues?: readonly Json[]

  constructor(
    code: ToolCreatorErrorCode,
    message: string,
    options: ToolCreatorErrorOptions = {},
  ) {
    super(prefixed(code, message), options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ToolCreatorError'
    this.code = code
    if (options.issues !== undefined) this.issues = [...options.issues]
  }
}

/**
 * The sdk, or the model call it needs, is not there.
 *
 * Separate from {@link ToolCreatorError} only so a host can tell "the feature
 * is not enabled on this machine" from "the creator ran and failed"; both
 * carry `code: 'tool_creator_unavailable'` in the parent's shape.
 */
export class ToolCreatorUnavailableError extends ToolCreatorError {
  constructor(message: string, options: ToolCreatorErrorOptions = {}) {
    super('tool_creator_unavailable', message, options)
    this.name = 'ToolCreatorUnavailableError'
  }
}

/** The fields a coded throw is read for, wherever its class came from. */
export interface ToolCreatorErrorTap {
  readonly code: ToolCreatorErrorCode
  readonly message: string
  readonly issues?: readonly Json[]
}

/**
 * The code, message and issues of anything that looks like a creator error, or
 * `undefined` for an error with no code at all.
 *
 * Only `{ code }` is required: a foreign `ToolCreatorError`, a structured clone
 * of one that lost its prototype, and a plain object a test threw all tap the
 * same way. `issues` is kept when it is an array, because the creator's issue
 * objects are what the model needs to see on a retry.
 */
export function toolCreatorErrorTap(error: unknown): ToolCreatorErrorTap | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { code?: unknown; message?: unknown; issues?: unknown }
  if (typeof record.code !== 'string' || record.code.length === 0) return undefined
  const issues = Array.isArray(record.issues) ? (record.issues as readonly Json[]) : undefined
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : 'the creator failed without a message'
  return {
    code: isToolCreatorErrorCode(record.code) ? record.code : 'tool_creator_failed',
    message,
    ...(issues === undefined ? {} : { issues }),
  }
}

/**
 * `code: message`, applied once.
 *
 * `RunFailure`'s shape: the text a caller logs or reports says the same thing
 * as the `code` field, and re-throwing an already-prefixed message does not
 * double it.
 */
function prefixed(code: ToolCreatorErrorCode, message: string): string {
  const prefix = `${code}: `
  return message.startsWith(prefix) ? message : `${prefix}${message}`
}
