/**
 * The one error shape an `env.keys` call fails with.
 *
 * Two codes, because there are only two things that can go wrong here and they
 * mean different things to a caller: the arguments were wrong (`invalid_arguments`
 * — nothing was read or written) or the file could not be read or written
 * (`io_failed` — the filesystem said no). Nothing is forwarded from another
 * module, so unlike `@z1/tool-creator` and `@z1/installed-tools` this package
 * needs no structural tap: there is no foreign class to read across a boundary.
 *
 * @module @z1/env-keys/errors
 */

/** Every code an {@link EnvKeysError} carries. */
export const ENV_KEYS_ERROR_CODES = ['invalid_arguments', 'io_failed'] as const

export type EnvKeysErrorCode = (typeof ENV_KEYS_ERROR_CODES)[number]

/**
 * A refused or failed `env.keys` call.
 *
 * The message is `"<code>: <detail>"`, so the text-only path (`{ error }` in a
 * tool result) says the same thing as the `code` field a host branches on.
 * Detail never carries a value from `.env`: every message here is built from a
 * key *name*, a path and a reason.
 */
export class EnvKeysError extends Error {
  readonly code: EnvKeysErrorCode

  constructor(code: EnvKeysErrorCode, detail: string, options: { cause?: unknown } = {}) {
    super(prefixed(code, detail), options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EnvKeysError'
    this.code = code
  }
}

/** `code: detail`, applied once: a re-raised message must not say it twice. */
function prefixed(code: EnvKeysErrorCode, detail: string): string {
  const prefix = `${code}: `
  return detail.startsWith(prefix) ? detail : `${prefix}${detail}`
}
