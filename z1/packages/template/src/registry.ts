/**
 * In-memory template registry. Templates are addressed by `id` and, when a
 * caller needs a specific one, by `id@version`.
 *
 * @module @z1/template/registry
 */

import type { GraphDocument } from '@z1/graph'

import type { GraphTemplate, TemplateContext, TemplateMeta } from './types.ts'

function keyOf(id: string, version: string): string {
  return `${id}@${version}`
}

/** `1.2.3` with an optional pre-release/build suffix, nothing looser. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * `agent.loop@1.0.0` is one spec, but ids may contain `@` too, so the split
 * happens at the last `@` and only when what follows is a version.
 */
export function splitTemplateSpec(spec: string): { id: string; version?: string } {
  const at = spec.lastIndexOf('@')
  if (at <= 0 || at === spec.length - 1) return { id: spec }
  const suffix = spec.slice(at + 1)
  if (!SEMVER.test(suffix)) return { id: spec }
  return { id: spec.slice(0, at), version: suffix }
}

/** Numeric comparison per dot-separated part, so `1.10.0` beats `1.9.0`. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? '0'
    const r = right[index] ?? '0'
    const ln = Number(l)
    const rn = Number(r)
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln < rn ? -1 : 1
    } else if (l !== r) {
      return l < r ? -1 : 1
    }
  }
  return 0
}

function metaOf(template: GraphTemplate): TemplateMeta {
  return {
    id: template.id,
    version: template.version,
    title: template.title,
    ...(template.description === undefined ? {} : { description: template.description }),
  }
}

export class TemplateRegistry {
  private readonly templates = new Map<string, GraphTemplate>()

  register(template: GraphTemplate): void {
    const key = keyOf(template.id, template.version)
    if (this.templates.has(key)) {
      throw new Error(`template "${key}" is already registered`)
    }
    this.templates.set(key, template)
  }

  /**
   * Without a version, the highest registered version of `id` wins; templates
   * never silently shadow a newer one because a file happened to load last.
   * `id` may also be a full `id@version` spec.
   */
  get(id: string, version?: string): GraphTemplate | undefined {
    const spec = splitTemplateSpec(id)
    const wanted = version ?? spec.version
    if (wanted !== undefined) return this.templates.get(keyOf(spec.id, wanted))

    let found: GraphTemplate | undefined
    for (const candidate of this.templates.values()) {
      if (candidate.id !== spec.id) continue
      if (found === undefined || compareVersions(candidate.version, found.version) > 0) {
        found = candidate
      }
    }
    return found
  }

  list(): readonly TemplateMeta[] {
    return [...this.templates.values()]
      .sort((a, b) => (a.id === b.id ? compareVersions(a.version, b.version) : a.id < b.id ? -1 : 1))
      .map(metaOf)
  }

  /**
   * A static template is data, so every build hands out a fresh copy: a run
   * must never mutate the registered graph for the next one.
   */
  build(id: string, context: TemplateContext = {}): GraphDocument {
    const template = this.get(id)
    if (template === undefined) throw new Error(`unknown template "${id}"`)

    if (template.kind === 'static') {
      if (template.graph === undefined) {
        throw new Error(`static template "${keyOf(template.id, template.version)}" has no graph`)
      }
      return structuredClone(template.graph)
    }

    if (template.build === undefined) {
      throw new Error(`builder template "${keyOf(template.id, template.version)}" has no build()`)
    }
    return template.build(context)
  }
}
