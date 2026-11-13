import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { directoryIntegrity } from '../src/index.ts'
import { manifest, writeModule } from './fixtures.ts'

const created: string[] = []

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'z1-module-integrity-'))
  created.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('directoryIntegrity', () => {
  test('is deterministic and 64 hex characters', () => {
    const directory = temporary()
    writeModule(directory)
    const first = directoryIntegrity(directory, manifest())
    const second = directoryIntegrity(directory, manifest())
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toBe(first)
  })

  test('changes when a payload file changes', () => {
    const directory = temporary()
    writeModule(directory)
    const before = directoryIntegrity(directory, manifest())
    writeFileSync(join(directory, 'index.js'), 'export default { changed: true }\n')
    expect(directoryIntegrity(directory, manifest())).not.toBe(before)
  })

  test('changes when only the manifest changes', () => {
    const directory = temporary()
    writeModule(directory)
    const before = directoryIntegrity(directory, manifest())
    writeModule(directory, { manifest: manifest({ title: 'Echo 2' }) })
    expect(directoryIntegrity(directory, manifest({ title: 'Echo 2' }))).not.toBe(before)
  })

  test('ignores node_modules, .git and *.log', () => {
    const clean = temporary()
    const noisy = temporary()
    writeModule(clean)
    writeModule(noisy)

    mkdirSync(join(noisy, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(noisy, 'node_modules', 'pkg', 'index.js'), 'x')
    mkdirSync(join(noisy, '.git'), { recursive: true })
    writeFileSync(join(noisy, '.git', 'HEAD'), 'ref')
    writeFileSync(join(noisy, 'debug.log'), 'noise')

    expect(directoryIntegrity(noisy, manifest())).toBe(directoryIntegrity(clean, manifest()))
  })
})
