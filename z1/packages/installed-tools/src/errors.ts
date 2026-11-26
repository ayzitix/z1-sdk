/**
 * The one error shape an installed-tool call fails with, and the tap that reads
 * a z2q failure across the dynamic-import boundary.
 *
 * z2q is loaded at run time from a sibling checkout, so its `ToolRuntimeError`
 * (19 sandbox codes) and `ToolCreatorError` (17 install codes) are never
 * `instanceof` tests here: the class objects belong to a module this package
 * imports lazily and may not exist at all. The code and detail are therefore
 * read **structurally**, the same way `@z1/tool-creator` reads its own errors,
 * and the result is re-thrown as this package's class so a host has one type to
 * match and no z2q type ever reaches this package's public surface.
 *
 * @module @z1/installed-tools/errors
 */

/**
 * The codes this package raises itself.
 *
 * Every other code an {@link InstalledToolError} carries is z2q's, forwarded
 * verbatim rather than mirrored here: the two vocabularies add up to 36 codes
 * today and each of them is already the string `installTool` and the sandbox
 * put in the error, so a list in this file could only ever drift.
 */
export const INSTALLED_TOOL_ERROR_CODES = ['tool_failed', 'tool_unavailable'] as const

/** A code this package raises: the checkout is missing, or nothing explained it. */
export type InstalledToolErrorCode = (typeof INSTALLED_TOOL_ERROR_CODES)[number]

/** What a coded throw is read for, wherever its class came from. */
export interface InstalledToolErrorTap {
  /** z2q's code, or `tool_failed` when the throw had none. */
  readonly code: string
  /** The detail without the `code: ` it may already carry. */
  readonly message: string
}

/**
 * A failed installed-tool call.
 *
 * The message is `"<tool> failed: <code>: <detail>"` and nothing like it is
 * thrown at a model: `z1.tool.call` reports the text as `{ error }`, the run
 * keeps going, and a host that holds the error itself branches on `code`
 * instead of parsing prose. Errors raised by this package alone — the missing
 * checkout — carry no `tool` and read `"<code>: <detail>"`.
 */
export class InstalledToolError extends Error {
  /** z2q's code when z2q refused, else one of {@link INSTALLED_TOOL_ERROR_CODES}. */
  readonly code: string
  /** The tool the failure is about; absent when the failure is the checkout's. */
  readonly tool?: string

  constructor(
    code: string,
    detail: string,
    options: { tool?: string; cause?: unknown } = {},
  ) {
    super(
      options.tool === undefined ? `${code}: ${detail}` : `${options.tool} failed: ${code}: ${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'InstalledToolError'
    this.code = code
    if (options.tool !== undefined) this.tool = options.tool
  }
}

/**
 * The code and detail of anything that looks like a z2q failure, or `undefined`
 * for a throw with no code at all.
 *
 * Only `{ code }` is required, so a foreign `ToolRuntimeError`, a structured
 * clone of one that lost its prototype, and a plain object a test threw all tap
 * the same way. The second argument is what makes a re-raise read once: z2q
 * messages are the detail only, but a message that already says `"<code>: …"`
 * must not say it twice.
 */
export function installedToolErrorTap(error: unknown): InstalledToolErrorTap | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { code?: unknown; message?: unknown }
  if (typeof record.code !== 'string' || record.code.length === 0) return undefined
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : 'the tool failed without a message'
  return { code: record.code, message: withoutPrefix(record.code, message) }
}

/** `code: message`, applied once. */
function withoutPrefix(code: string, message: string): string {
  const prefix = `${code}: `
  return message.startsWith(prefix) ? message.slice(prefix.length) : message
}
