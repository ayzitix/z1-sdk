/**
 * Stable JSON for hashing. Object keys are sorted recursively, arrays keep
 * their order, and `undefined` members are dropped the way JSON.stringify
 * drops them. Values JSON cannot represent (functions, symbols, bigint,
 * non-finite numbers) are rejected instead of silently hashing "null".
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson cannot encode a non-finite number')
      }
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new TypeError(`canonicalJson cannot encode a ${typeof value}`)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${members.join(',')}}`
}
