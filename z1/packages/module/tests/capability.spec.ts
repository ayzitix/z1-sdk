import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  checkFs,
  checkNet,
  matchPath,
  resolveCapabilityPath,
} from '../src/index.ts'
import type { ModuleCapabilities } from '../src/types.ts'

describe('matchPath', () => {
  test('* stays inside one path segment', () => {
    expect(matchPath('*.js', 'a.js')).toBe(true)
    expect(matchPath('*.js', 'dir/a.js')).toBe(false)
    expect(matchPath('data/*.json', 'data/a.json')).toBe(true)
    expect(matchPath('data/*.json', 'data/nested/a.json')).toBe(false)
  })

  test('** crosses segments and may collapse to empty', () => {
    expect(matchPath('**/*.js', 'a.js')).toBe(true)
    expect(matchPath('**/*.js', 'a/b/c.js')).toBe(true)
    expect(matchPath('a/**/b', 'a/b')).toBe(true)
    expect(matchPath('a/**/b', 'a/x/y/b')).toBe(true)
    expect(matchPath('a/**', 'a/b/c')).toBe(true)
    expect(matchPath('a/**', 'a')).toBe(false)
    expect(matchPath('**', 'anything/at/all')).toBe(true)
  })

  test('? matches exactly one non-separator character', () => {
    expect(matchPath('file?.txt', 'file1.txt')).toBe(true)
    expect(matchPath('file?.txt', 'file12.txt')).toBe(false)
    expect(matchPath('a/?/c', 'a//c')).toBe(false)
  })

  test('escapes regex metacharacters', () => {
    expect(matchPath('a.b', 'a.b')).toBe(true)
    expect(matchPath('a.b', 'axb')).toBe(false)
    expect(matchPath('a+b', 'a+b')).toBe(true)
  })
})

describe('resolveCapabilityPath', () => {
  test('replaces every moduleDir placeholder', () => {
    expect(resolveCapabilityPath('${moduleDir}/data/**', '/opt/mod')).toBe('/opt/mod/data/**')
    expect(resolveCapabilityPath('${moduleDir}/${moduleDir}', '/m')).toBe('/m//m')
  })
})

describe('checkFs', () => {
  const moduleDir = join('/tmp', 'z1-capability-module')
  const capabilities: ModuleCapabilities = {
    fs: {
      read: ['${moduleDir}/data/**'],
      write: ['${moduleDir}/out/*.json'],
    },
  }

  test('allows matching reads and writes', () => {
    expect(checkFs(capabilities, 'read', join(moduleDir, 'data', 'a.txt'), moduleDir)).toEqual({
      ok: true,
    })
    expect(checkFs(capabilities, 'write', 'out/result.json', moduleDir)).toEqual({ ok: true })
  })

  test('denies outside the granted patterns and wrong direction', () => {
    expect(checkFs(capabilities, 'read', join(moduleDir, 'secret.txt'), moduleDir).ok).toBe(false)
    expect(checkFs(capabilities, 'write', join(moduleDir, 'data', 'a.txt'), moduleDir).ok).toBe(false)
    expect(checkFs(capabilities, 'write', join(moduleDir, 'out', 'nested', 'a.json'), moduleDir).ok).toBe(
      false,
    )
  })

  test('denies by default and rejects parent segments', () => {
    expect(checkFs(undefined, 'read', 'data/a.txt', moduleDir).ok).toBe(false)
    expect(checkFs({ fs: { read: [] } }, 'read', 'data/a.txt', moduleDir).ok).toBe(false)
    expect(checkFs(capabilities, 'read', 'data/../secret.txt', moduleDir).ok).toBe(false)

    const escapingPattern: ModuleCapabilities = { fs: { read: ['${moduleDir}/data/../secret'] } }
    expect(checkFs(escapingPattern, 'read', join(moduleDir, 'secret'), moduleDir).ok).toBe(false)
  })
})

describe('checkNet', () => {
  test('allows exact and wildcard hosts, case-insensitively', () => {
    const capabilities: ModuleCapabilities = {
      net: { hosts: ['api.example.com', '*.internal.test'] },
    }
    expect(checkNet(capabilities, 'api.example.com')).toEqual({ ok: true })
    expect(checkNet(capabilities, 'API.EXAMPLE.COM.')).toEqual({ ok: true })
    expect(checkNet(capabilities, 'worker.internal.test')).toEqual({ ok: true })
  })

  test('denies by default and non-matching hosts', () => {
    expect(checkNet(undefined, 'api.example.com').ok).toBe(false)
    expect(checkNet({ net: { hosts: [] } }, 'api.example.com').ok).toBe(false)
    expect(checkNet({ net: { hosts: ['api.example.com'] } }, 'evil.test').ok).toBe(false)
    expect(checkNet({ net: { hosts: ['api.example.com'] } }, 'api.example.com.evil.test').ok).toBe(
      false,
    )
  })
})
