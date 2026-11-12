export type RunFailureCode =
  | 'INVALID_GRAPH'
  | 'DEADLOCK'
  | 'APPROVAL_REJECTED'
  | 'AUTONOMY_DENIED'
  | 'NODE_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_OUTPUT'
  | 'RESUME_MISMATCH'

/**
 * A run or node failure with a machine-readable reason. The code is part of the
 * public contract because the CLI maps it to exit codes and `RunResult.error`
 * embeds it so a caller never has to match on prose.
 */
export class RunFailure extends Error {
  readonly code: RunFailureCode

  constructor(code: RunFailureCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'RunFailure'
    this.code = code
  }
}
