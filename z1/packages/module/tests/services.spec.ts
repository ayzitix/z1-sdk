import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ModuleManifestError, ModuleStore, parseManifest } from '../src/index.ts'
import type { ModuleManifest } from '../src/types.ts'
import { manifest, writeModule } from './fixtures.ts'

const created: string[] = []

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

function rejects(overrides: Record<string, unknown>): ModuleManifestError {
  try {
    parseManifest({ ...manifest(), ...overrides })
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleManifestError)
    return error as ModuleManifestError
  }
  throw new Error('expected parseManifest to throw')
}

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('service declarations', () => {
  test('parses a trusted service and preserves it', () => {
    const parsed = parseManifest({
      ...manifest(),
      services: [{ id: 'llm', kind: 'llm', trusted: true }],
    })
    expect(parsed.services).toEqual([{ id: 'llm', kind: 'llm', trusted: true }])
  })

  test('accepts a service-only manifest with no nodes', () => {
    const parsed = parseManifest({
      ...manifest(),
      nodes: [],
      services: [{ id: 'main', kind: 'llm', trusted: true }],
    })
    expect(parsed.nodes).toEqual([])
    expect(parsed.services).toHaveLength(1)
  })

  test('rejects duplicate service ids within one module', () => {
    const error = rejects({
      services: [
        { id: 'llm', kind: 'llm', trusted: true },
        { id: 'llm', kind: 'tools', trusted: true },
      ],
    })
    expect(error.issues.some((issue) => issue.path === 'services.1.id')).toBe(true)
  })

  test('rejects an unknown service kind', () => {
    const error = rejects({ services: [{ id: 'llm', kind: 'gpu', trusted: true }] })
    expect(error.issues.some((issue) => issue.path === 'services.0.kind')).toBe(true)
  })

  test('rejects trusted:false', () => {
    const error = rejects({ services: [{ id: 'llm', kind: 'llm', trusted: false }] })
    expect(error.issues.some((issue) => issue.path === 'services.0.trusted')).toBe(true)
  })

  test('the same kind in two modules is not a manifest error', () => {
    const left = parseManifest({
      ...manifest(),
      id: 'com.example.left',
      nodes: [],
      services: [{ id: 'llm', kind: 'llm', trusted: true }],
    })
    const right = parseManifest({
      ...manifest(),
      id: 'com.example.right',
      nodes: [],
      services: [{ id: 'llm', kind: 'llm', trusted: true }],
    })
    expect(left.id).not.toBe(right.id)
    expect(left.services?.[0]?.kind).toBe(right.services?.[0]?.kind)
  })
})

describe('store grants cover services', () => {
  function setup(withServices: boolean): { root: string; source: string; store: ModuleStore } {
    const root = temporary('z1-module-services-')
    const source = temporary('z1-module-services-src-')
    const services: NonNullable<ModuleManifest['services']> = withServices
      ? [{ id: 'llm', kind: 'llm', trusted: true }]
      : []
    writeModule(source, {
      manifest: manifest(withServices ? { nodes: [], services } : {}),
    })
    return { root, source, store: new ModuleStore(root) }
  }

  test('approve stores the declared services on the grant and in the audit', () => {
    const { store, source } = setup(true)
    store.propose(source)
    const installed = store.approve('com.example.echo', '1.0.0')

    expect(installed.grant.services).toEqual([{ id: 'llm', kind: 'llm', trusted: true }])
    expect(store.grants()[0]?.services).toEqual(installed.grant.services)
    const approve = store.audit().find((entry) => entry.type === 'approve')
    expect(approve?.detail?.['services']).toEqual(installed.grant.services)
    const install = store.audit().find((entry) => entry.type === 'install')
    expect(install?.detail?.['services']).toEqual(installed.grant.services)
  })

  test('a grant written before services existed loads as an empty list', () => {
    const { root, source, store } = setup(false)
    store.propose(source)
    store.approve('com.example.echo', '1.0.0')

    const statePath = join(root, 'state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      grants: Record<string, unknown>[]
    }
    for (const grant of state.grants) delete grant['services']
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)

    const reopened = new ModuleStore(root)
    expect(reopened.grants()[0]?.services).toEqual([])
    expect(reopened.list()[0]?.grant.services).toEqual([])
  })
})
