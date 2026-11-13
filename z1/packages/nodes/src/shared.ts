import { z } from 'zod'
import type { Json, PortSpec } from '@z1/node'

/** Every built-in ships at this version until a breaking change forces a bump. */
export const NODE_VERSION = '1.0.0'

/**
 * Recursive JSON schema. Node ports carry wire values only, so anything that is
 * not JSON (functions, dates) must be rejected at the boundary rather than
 * silently reaching the journal or the cache.
 */
export const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
) as z.ZodType<Json>

export function dataPort(
  id: string,
  schema: z.ZodType = z.unknown(),
  required = true,
  waitFor: 'all' | 'any' = 'all',
): PortSpec {
  return { kind: 'data', id, schema, required, waitFor }
}

export function flowPort(id: string): PortSpec {
  return { kind: 'flow', id }
}

export function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Non-root nodes receive their connected data inputs as a port-id keyed record,
 * while roots receive the raw run input. Nodes only ever read named ports.
 */
export function inputValues(input: Json): Record<string, Json> {
  return isRecord(input) ? input : {}
}

/**
 * Interfaces such as `ChatMessage` are plain JSON at runtime but lack the index
 * signature `Json` requires, so the wire boundary asserts their shape once.
 */
export function asJson(value: unknown): Json {
  return value as Json
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
