import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ModuleManifestError, ModuleStore, parseManifest, serviceMode } from '../src/index.ts'
import type { ModuleManifest, ModuleServiceDeclaration } from '../src/types.ts'
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
    expect(serviceMode(parsed.services?.[0] as ModuleServiceDeclaration)).toBe('host')
  })

  test('an explicit worker mode is the default shape and needs no trust', () => {
    const parsed = parseManifest({
      ...manifest(),
      services: [{ id: 'llm', kind: 'llm', mode: 'worker' }],
    })
    expect(parsed.services).toEqual([{ id: 'llm', kind: 'llm', mode: 'worker' }])
    expect(serviceMode(parsed.services?.[0] as ModuleServiceDeclaration)).toBe('worker')
  })

  test('a declaration with neither mode nor trust is a worker', () => {
    const parsed = parseManifest({
      ...manifest(),
      services: [{ id: 'tools', kind: 'tools' }],
    })
    expect(serviceMode(parsed.services?.[0] as ModuleServiceDeclaration)).toBe('worker')
  })

  test('mode:host with trusted:true is a host service', () => {
    const parsed = parseManifest({
      ...manifest(),
      services: [{ id: 'llm', kind: 'llm', mode: 'host', trusted: true }],
    })
    expect(serviceMode(parsed.services?.[0] as ModuleServiceDeclaration)).toBe('host')
  })

  test('rejects mode:host without trusted:true', () => {
    const error = rejects({ services: [{ id: 'llm', kind: 'llm', mode: 'host' }] })
    expect(error.issues[0]?.path).toBe('services.0.mode')
    expect(error.issues[0]?.message).toMatch(/trusted/)
  })

  test('rejects mode:host with trusted:false', () => {
    const error = rejects({ services: [{ id: 'llm', kind: 'llm', mode: 'host', trusted: false }] })
    expect(error.issues[0]?.path).toBe('services.0.mode')
  })

  test('rejects mode:worker with trusted:true', () => {
    const error = rejects({ services: [{ id: 'llm', kind: 'llm', mode: 'worker', trusted: true }] })
    expect(error.issues.some((issue) => issue.path === 'services.0.trusted')).toBe(true)
    expect(error.issues[0]?.message).toMatch(/remove "trusted"/)
  })

  test('rejects an unknown mode', () => {
    const error = rejects({ services: [{ id: 'llm', kind: 'llm', mode: 'in-process' }] })
    expect(error.issues.some((issue) => issue.path === 'services.0.mode')).toBe(true)
  })

  test('accepts a service-only manifest with no nodes', () => {
    const parsed = parseManifest({
      ...manifest(),
      nodes: [],
      services: [{ id: 'main', kind: 'llm', mode: 'worker' }],
    })
    expect(parsed.nodes).toEqual([])
    expect(parsed.services).toHaveLength(1)
  })

  test('rejects duplicate service ids within one module', () => {
    const error = rejects({
      services: [
        { id: 'llm', kind: 'llm', mode: 'worker' },
        { id: 'llm', kind: 'tools', mode: 'worker' },
      ],
    })
    expect(error.issues.some((issue) => issue.path === 'services.1.id')).toBe(true)
  })

  test('rejects an unknown service kind', () => {
    const error = rejects({ services: [{ id: 'llm', kind: 'gpu', mode: 'worker' }] })
    expect(error.issues.some((issue) => issue.path === 'services.0.kind')).toBe(true)
  })

  test('rejects a non-boolean trusted', () => {
    const error = rejects({ services: [{ id: 'llm', kind: 'llm', trusted: 'yes' }] })
    expect(error.issues.some((issue) => issue.path === 'services.0.trusted')).toBe(true)
  })

  test('the same kind in two modules is not a manifest error', () => {
    const left = parseManifest({
      ...manifest(),
      id: 'com.example.left',
      nodes: [],
      services: [{ id: 'llm', kind: 'llm', mode: 'worker' }],
    })
    const right = parseManifest({
      ...manifest(),
      id: 'com.example.right',
      nodes: [],
      services: [{ id: 'llm', kind: 'llm', mode: 'host', trusted: true }],
    })
    expect(left.id).not.toBe(right.id)
    expect(left.services?.[0]?.kind).toBe(right.services?.[0]?.kind)
    expect(serviceMode(right.services?.[0] as ModuleServiceDeclaration)).toBe('host')
  })
})

describe('store grants cover services', () => {
  function setup(
    withServices: boolean,
    services: NonNullable<ModuleManifest['services']> = [
      { id: 'llm', kind: 'llm', trusted: true },
    ],
  ): { root: string; source: string; store: ModuleStore } {
    const root = temporary('z1-module-services-')
    const source = temporary('z1-module-services-src-')
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

  test('mode and trust survive a store round trip', () => {
    const services: NonNullable<ModuleManifest['services']> = [
      { id: 'llm', kind: 'llm', mode: 'worker' },
      { id: 'tools', kind: 'tools', mode: 'host', trusted: true },
    ]
    const { root, source, store } = setup(true, services)
    store.propose(source)
    store.approve('com.example.echo', '1.0.0')

    const reopened = new ModuleStore(root)
    const grant = reopened.grants()[0]?.services ?? []
    expect(grant).toEqual(services)
    expect(grant.map((declaration) => serviceMode(declaration))).toEqual(['worker', 'host'])
  })

  test('a legacy grant with trusted:true and no mode loads as a host service', () => {
    const { root, source, store } = setup(true)
    store.propose(source)
    store.approve('com.example.echo', '1.0.0')

    const statePath = join(root, 'state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      grants: { services: ModuleServiceDeclaration[] }[]
    }
    for (const grant of state.grants) {
      for (const service of grant.services) {
        // The pre-mode spelling, byte for byte.
        service.trusted = true
        delete service.mode
      }
    }
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)

    const reopened = new ModuleStore(root)
    const grant = reopened.grants()[0]?.services ?? []
    expect(grant).toEqual([{ id: 'llm', kind: 'llm', trusted: true }])
    expect(serviceMode(grant[0] as ModuleServiceDeclaration)).toBe('host')
  })

  test('a grant whose declaration breaks the mode rules is treated as corrupt', () => {
    const { root, source, store } = setup(true)
    store.propose(source)
    store.approve('com.example.echo', '1.0.0')

    const statePath = join(root, 'state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      grants: { services: ModuleServiceDeclaration[] }[]
    }
    for (const grant of state.grants) {
      // mode:'worker' with the legacy trusted:true is a contradiction.
      for (const service of grant.services) service.mode = 'worker'
    }
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)

    const reopened = new ModuleStore(root)
    expect(reopened.grants()).toEqual([])
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
