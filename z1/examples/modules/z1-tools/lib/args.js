/**
 * Small argument validators shared by every tool.
 *
 * Tools receive raw JSON from a model, so every field is checked here and a
 * bad value throws an `Error` whose message names the tool and the field.
 *
 * @module z1-tools/args
 */

export function fail(message) {
  throw new Error(message)
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `null` and `undefined` mean "no arguments"; anything else must be an object. */
export function readArgs(raw, tool) {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) fail(`${tool} expects an object of arguments`)
  return raw
}

export function stringArg(raw, key, tool) {
  const value = raw[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${tool}.${key} must be a non-empty string`)
  }
  return value
}

export function optionalString(raw, key, tool) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${tool}.${key} must be a non-empty string`)
  }
  return value
}

export function optionalBoolean(raw, key, tool) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(`${tool}.${key} must be a boolean`)
  return value
}

export function optionalInteger(raw, key, tool, minimum, maximum) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) fail(`${tool}.${key} must be an integer`)
  if (value < minimum) fail(`${tool}.${key} must be at least ${minimum}`)
  if (maximum !== undefined && value > maximum) {
    fail(`${tool}.${key} must be at most ${maximum}`)
  }
  return value
}

export function positiveInteger(raw, key, tool, maximum) {
  return optionalInteger(raw, key, tool, 1, maximum)
}
