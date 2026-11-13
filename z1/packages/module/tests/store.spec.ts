import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { ModuleStore } from '../src/index.ts'
import { manifest, writeModule } from './fixtures.ts'

const created: string[] = []
const id = 'com.example.echo'

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

function setup(): { root: string; source: string; store: ModuleStore } {
  const root = temporary('z1-module-store-')
  const source = temporary('z1-module-source-')
  writeModule(source)
  return { root, source, store: new ModuleStore(root) }
}

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ModuleStore proposals', () => {
  test('copies a proposal, hashes it and records the audit entry', () => {
    const { store, source } = setup()
    const proposed = store.propose(source)

    expect(proposed.manifest.id).toBe(id)
    expect(proposed.integrity).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(proposed.directory, 'index.js'))).toBe(true)
    expect(existsSync(join(proposed.directory, 'manifest.json'))).toBe(true)
    expect(store.proposals()).toHaveLength(1)
    expect(store.proposals()[0]?.directory).toBe(proposed.directory)
    expect(store.audit().map((entry) => entry.type)).toEqual(['propose'])
  })

  test('is idempotent for identical content', () => {
    const { store, source } = setup()
    const first = store.propose(source)
    const second = store.propose(source)
    expect(second.integrity).toBe(first.integrity)
    expect(store.proposals()).toHaveLength(1)
    expect(store.audit()).toHaveLength(1)
  })

  test('refuses a second integrity for the same proposal version', () => {
    const { store, source } = setup()
    store.propose(source)
    writeFileSync(join(source, 'index.js'), 'export default { changed: true }\n')
    expect(() => store.propose(source)).toThrow(/integrity/)
  })
})

describe('ModuleStore install and grants', () => {
  test('approve installs and persists a grant from the manifest', () => {
    const { store, source, root } = setup()
    const proposed = store.propose(source)
    const installed = store.approve(id, '1.0.0')

    expect(installed.directory).toBe(join(root, 'modules', id, '1.0.0'))
    expect(installed.grant.integrity).toBe(proposed.integrity)
    expect(installed.grant.capabilities).toEqual(manifest().capabilities)
    expect(installed.grant.futureVersions).toBe(false)
    expect(installed.active).toBe(false)
    expect(store.grants()).toHaveLength(1)
    expect(store.get(id)?.integrity).toBe(proposed.integrity)
    expect(store.audit().map((entry) => entry.type)).toEqual(['propose', 'install', 'approve'])
  })

  test('install is idempotent and does not duplicate audit entries', () => {
    const { store, source } = setup()
    store.propose(source)
    store.install(id, '1.0.0', { capabilities: {}, futureVersions: false })
    store.install(id, '1.0.0', { capabilities: {}, futureVersions: false })

    expect(store.list()).toHaveLength(1)
    expect(store.audit().filter((entry) => entry.type === 'install')).toHaveLength(1)
  })

  test('refuses to reuse an installed version with a different integrity', () => {
    const { store, source } = setup()
    store.propose(source)
    const installed = store.install(id, '1.0.0', { capabilities: {}, futureVersions: false })

    const file = join(installed.directory, 'installed.json')
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    record['integrity'] = 'f'.repeat(64)
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)

    expect(() => store.install(id, '1.0.0', { capabilities: {}, futureVersions: false })).toThrow(
      /different integrity/,
    )
  })

  test('refuses a grant that covers a different integrity', () => {
    const { store, source } = setup()
    const proposed = store.propose(source)
    store.approve(id, '1.0.0')
    writeFileSync(join(proposed.directory, 'index.js'), 'export default { tampered: true }\n')

    expect(() => store.approve(id, '1.0.0')).toThrow(/integrity/)
  })

  test('approve can grant future versions and keeps the flag on re-approval', () => {
    const { store, source } = setup()
    store.propose(source)
    store.approve(id, '1.0.0', { futureVersions: true })
    expect(store.grants()[0]?.futureVersions).toBe(true)

    store.approve(id, '1.0.0')
    expect(store.grants()[0]?.futureVersions).toBe(true)
    expect(store.list()).toHaveLength(1)
    expect(store.audit().filter((entry) => entry.type === 'approve')).toHaveLength(1)
  })
})

describe('ModuleStore activation, rollback and persistence', () => {
  test('activates the latest version by default and rolls back to the previous one', () => {
    const { store, source } = setup()
    store.propose(source)
    store.approve(id, '1.0.0')

    writeModule(source, { manifest: manifest({ version: '1.1.0' }) })
    store.propose(source)
    store.approve(id, '1.1.0')

    expect(store.activate(id).manifest.version).toBe('1.1.0')
    expect(store.get(id)?.active).toBe(true)
    expect(store.rollback(id)?.manifest.version).toBe('1.0.0')
    expect(store.rollback(id)).toBeUndefined()
    expect(store.activate(id, '1.0.0').manifest.version).toBe('1.0.0')
    expect(() => store.activate(id, '9.9.9')).toThrow(/not installed/)
  })

  test('state and audit survive reopening and leave no temporary files', () => {
    const { store, root, source } = setup()
    store.propose(source)
    store.approve(id, '1.0.0')
    store.activate(id, '1.0.0')
    store.recordDenied(id, '1.0.0', 'user declined')

    const reopened = new ModuleStore(root)
    expect(reopened.get(id)?.active).toBe(true)
    expect(reopened.get(id)?.manifest.version).toBe('1.0.0')
    expect(reopened.grants()).toHaveLength(1)
    expect(reopened.audit().at(-1)?.type).toBe('deny')
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(existsSync(join(root, 'state.json'))).toBe(true)
  })

  test('records a capability denial on the same chain', () => {
    const { store, source } = setup()
    store.propose(source)
    store.recordCapabilityDenied(id, '1.0.0', { capability: 'net', host: 'evil.test' })
    const audit = store.audit()
    expect(audit.at(-1)?.type).toBe('capability.denied')
    expect(audit.at(-1)?.prev).toBe(audit[audit.length - 2]?.hash)
  })
})

describe('ESM package scope', () => {
  test('adds package.json to a plain payload before hashing, then installs it', async () => {
    const { store, source } = setup()
    expect(existsSync(join(source, 'package.json'))).toBe(false)

    const proposed = store.propose(source)
    expect(JSON.parse(readFileSync(join(proposed.directory, 'package.json'), 'utf8'))).toEqual({
      type: 'module',
    })
    // The synthetic file is part of the identity, so re-proposing is stable.
    expect(store.propose(source).integrity).toBe(proposed.integrity)

    const installed = store.approve(id, '1.0.0')
    expect(installed.integrity).toBe(proposed.integrity)
    expect(JSON.parse(readFileSync(join(installed.directory, 'package.json'), 'utf8'))).toEqual({
      type: 'module',
    })

    // The entry now imports as an ES module from an arbitrary install root.
    const entry = await import(pathToFileURL(join(installed.directory, 'index.js')).href)
    expect(entry.default).toEqual({})
  })

  test('keeps an authored package.json untouched', () => {
    const { store, source } = setup()
    const authored = '{"type":"module","sideEffects":false}\n'
    writeFileSync(join(source, 'package.json'), authored)

    const proposed = store.propose(source)
    expect(readFileSync(join(proposed.directory, 'package.json'), 'utf8')).toBe(authored)
    const installed = store.approve(id, '1.0.0')
    expect(readFileSync(join(installed.directory, 'package.json'), 'utf8')).toBe(authored)
  })
})
