/**
 * Small, dependency-free guards for inbound params.
 *
 * They exist so the server can reject a malformed call with `-32602` before it
 * touches the engine. Each helper throws a {@link JsonRpcFault}, which the peer
 * turns into the matching error response without special-casing.
 *
 * @module @z1/protocol/params
 */

import { JSON_RPC_ERRORS } from './types.ts'
import { JsonRpcFault } from './transport.ts'

/**
 * Assert that params are a JSON object and carry every required key.
 *
 * @param value - the raw `params` member from the wire.
 * @param required - keys that must be present (their values are not checked).
 */
export function assertParams(
  value: unknown,
  required: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JsonRpcFault(JSON_RPC_ERRORS.invalidParams, 'params must be an object')
  }
  const params = value as Record<string, unknown>
  for (const key of required) {
    if (!(key in params) || params[key] === undefined) {
      throw new JsonRpcFault(JSON_RPC_ERRORS.invalidParams, `missing required param "${key}"`, {
        param: key,
      })
    }
  }
}

/** Assert that a params member is one of a fixed set of strings. */
export function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new JsonRpcFault(
      JSON_RPC_ERRORS.invalidParams,
      `param "${field}" must be one of: ${allowed.join(', ')}`,
      { param: field, allowed },
    )
  }
  return value as T
}

/** Assert that a params member is a number when present. */
export function assertOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JsonRpcFault(JSON_RPC_ERRORS.invalidParams, `param "${field}" must be a number`, {
      param: field,
    })
  }
  return value
}
