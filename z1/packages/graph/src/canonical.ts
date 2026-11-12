/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` object
 * members omitted (arrays use `null`, as JSON does). Used for cache keys and
 * graph digests, so it must never depend on insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'

  const type = typeof value
  if (type === 'string' || type === 'boolean') return JSON.stringify(value) ?? 'null'
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError('canonicalJson: non-finite numbers are not valid JSON')
    }
    return JSON.stringify(value) ?? 'null'
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : canonicalJson(item)))
    return `[${items.join(',')}]`
  }

  if (type === 'object') {
    const record = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) continue
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`)
    }
    return `{${parts.join(',')}}`
  }

  throw new TypeError(`canonicalJson: unsupported value of type ${type}`)
}
