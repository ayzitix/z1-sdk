import type { NodeDefinition } from './types.ts'

/**
 * In-memory node catalogue keyed by `id` + `version`.
 *
 * Ambiguity is an error rather than "first match wins": the executor must never
 * silently run a different version than the graph author asked for.
 */
export class NodeRegistry {
  readonly #byId = new Map<string, Map<string, NodeDefinition>>()

  register(definition: NodeDefinition): void {
    let versions = this.#byId.get(definition.id)
    if (versions === undefined) {
      versions = new Map()
      this.#byId.set(definition.id, versions)
    }
    if (versions.has(definition.version)) {
      throw new Error(`node "${definition.id}"@${definition.version} is already registered`)
    }
    versions.set(definition.version, definition)
  }

  get(id: string, version?: string): NodeDefinition | undefined {
    const versions = this.#byId.get(id)
    if (versions === undefined) return undefined
    if (version !== undefined) return versions.get(version)

    const first = versions.values().next()
    if (first.done === true) return undefined
    // More than one version means the caller must pin one; guessing would make
    // runs non-reproducible.
    if (versions.size > 1) {
      throw new Error(
        `node "${id}" has ${versions.size} versions (${[...versions.keys()].join(', ')}); specify a version`,
      )
    }
    return first.value
  }

  /** With no version: true if any version is registered. With a version: exact match. */
  has(id: string, version?: string): boolean {
    const versions = this.#byId.get(id)
    if (versions === undefined) return false
    if (version !== undefined) return versions.has(version)
    return versions.size > 0
  }

  /** All registered definitions in insertion order, across every version. */
  list(): readonly NodeDefinition[] {
    const all: NodeDefinition[] = []
    for (const versions of this.#byId.values()) all.push(...versions.values())
    return all
  }
}
