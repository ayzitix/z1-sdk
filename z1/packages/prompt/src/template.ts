import type { PromptVars } from './types.ts'

/** Keys that belong to the prototype chain, never to a vars record. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/

/**
 * Only well-formed placeholders are substituted. A malformed one (`{{a b}}`)
 * stays literal so prompt bodies can still contain braces, matching the
 * `z1.core.template` node.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_$.-]+)\s*\}\}/g

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolves a dotted path against the vars record. Arrays accept numeric
 * segments only; objects are read through own properties only, so a template
 * can never reach `__proto__`-style internals.
 */
function lookup(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return undefined
      current = current[Number(segment)]
      continue
    }
    if (!isRecord(current)) return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * Strings render as themselves, structures as JSON (stable enough for prompts),
 * and absent or null values as an empty string so a missing var leaves no
 * `undefined` in the prompt.
 */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    // Circular structures would otherwise throw during prompt assembly.
    return ''
  }
}

export function renderTemplate(body: string, vars: PromptVars): string {
  return body.replace(PLACEHOLDER, (_match: string, path: string) => stringify(lookup(vars, path)))
}
