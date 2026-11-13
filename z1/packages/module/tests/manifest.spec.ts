import { describe, expect, test } from 'vitest'
import {
  ModuleManifestError,
  compareVersions,
  manifestDigest,
  parseManifest,
} from '../src/index.ts'
import type { ModuleManifest } from '../src/types.ts'
import { manifest } from './fixtures.ts'

function rejects(overrides: Record<string, unknown>): ModuleManifestError {
  try {
    parseManifest({ ...manifest(), ...overrides })
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleManifestError)
    return error as ModuleManifestError
  }
  throw new Error('expected parseManifest to throw')
}

describe('parseManifest', () => {
  test('parses a minimal manifest and applies no defaults to optionals', () => {
    const parsed = parseManifest(manifest())
    expect(parsed.id).toBe('com.example.echo')
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.description).toBeUndefined()
    expect(parsed.limits).toBeUndefined()
    expect(parsed.nodes[0]?.inputs[0]).toMatchObject({ kind: 'data', id: 'text' })
  })

  test('parses a full manifest and preserves declared capabilities', () => {
    const node = manifest().nodes[0]
    if (node === undefined) throw new Error('fixture node missing')
    const parsed = parseManifest({
      ...manifest(),
      description: 'Echo text',
      author: 'Example',
      limits: { timeoutMs: 5000, memoryMb: 128 },
      capabilities: {
        fs: { read: ['${moduleDir}/data/**'], write: ['${moduleDir}/out/**'] },
        net: { hosts: ['api.example.com'] },
        process: { spawn: ['ffmpeg'] },
        spend: { currency: 'USD', perCall: 0.01, perRun: 1 },
        secrets: ['API_KEY'],
      },
      nodes: [
        {
          ...node,
          inputs: [
            { kind: 'data', id: 'text', schema: { type: 'string' } },
            { kind: 'flow', id: 'go' },
          ],
        },
      ],
    })
    expect(parsed.capabilities?.fs?.read).toEqual(['${moduleDir}/data/**'])
    expect(parsed.capabilities?.spend?.perRun).toBe(1)
    expect(parsed.limits).toEqual({ timeoutMs: 5000, memoryMb: 128 })
    expect(parsed.nodes[0]?.inputs[1]).toEqual({ kind: 'flow', id: 'go' })
  })

  test('rejects the wrong schemaVersion', () => {
    expect(rejects({ schemaVersion: 2 }).issues[0]?.path).toBe('schemaVersion')
  })

  test('rejects malformed module ids', () => {
    for (const id of ['Echo', 'echo', 'com.Example', 'com..echo', 'com.example.']) {
      expect(() => parseManifest({ ...manifest(), id })).toThrow(ModuleManifestError)
    }
  })

  test('rejects non-strict versions', () => {
    for (const version of ['1.0', 'v1.0.0', '01.0.0', '1.0.0+build', '1.0.0.0']) {
      expect(() => parseManifest({ ...manifest(), version })).toThrow(ModuleManifestError)
    }
  })

  test('rejects empty title and license', () => {
    expect(rejects({ title: '   ' }).issues[0]?.path).toBe('title')
    expect(rejects({ license: '' }).issues[0]?.path).toBe('license')
  })

  test('rejects absolute and escaping entries', () => {
    for (const entry of ['/abs/index.js', '../index.js', 'data/../../index.js', 'index.ts', 'a\\b.js', 'a//b.js']) {
      expect(() => parseManifest({ ...manifest(), entry })).toThrow(ModuleManifestError)
    }
  })

  test('rejects duplicate node ids', () => {
    const node = manifest().nodes[0]
    if (node === undefined) throw new Error('fixture node missing')
    const error = rejects({ nodes: [node, { ...node }] })
    expect(error.issues.some((issue) => issue.path === 'nodes.1.id')).toBe(true)
  })

  test('rejects duplicate port ids per direction only', () => {
    const node = manifest().nodes[0]
    if (node === undefined) throw new Error('fixture node missing')
    const duplicateInputs = {
      ...node,
      inputs: [
        { kind: 'data', id: 'text' },
        { kind: 'flow', id: 'text' },
      ],
    }
    expect(() => parseManifest({ ...manifest(), nodes: [duplicateInputs] })).toThrow(
      ModuleManifestError,
    )

    const sameIdBothDirections = {
      ...node,
      inputs: [{ kind: 'data', id: 'text' }],
      outputs: [{ kind: 'data', id: 'text' }],
    }
    expect(parseManifest({ ...manifest(), nodes: [sameIdBothDirections] }).nodes).toHaveLength(1)
  })

  test('rejects an invalid data port mode and non-kebab node ids', () => {
    const node = manifest().nodes[0]
    if (node === undefined) throw new Error('fixture node missing')
    expect(() =>
      parseManifest({
        ...manifest(),
        nodes: [{ ...node, inputs: [{ kind: 'data', id: 'x', mode: 'batch' }] }],
      }),
    ).toThrow(ModuleManifestError)
    expect(() => parseManifest({ ...manifest(), nodes: [{ ...node, id: 'Echo Run' }] })).toThrow(
      ModuleManifestError,
    )
  })

  test('rejects unknown capability keys but allows empty arrays', () => {
    expect(rejects({ capabilities: { fs: { read: ['x'] }, shell: {} } }).issues[0]?.path).toBe(
      'capabilities',
    )
    const parsed = parseManifest({
      ...manifest(),
      capabilities: { fs: { read: [], write: [] }, net: { hosts: [] }, secrets: [] },
    })
    expect(parsed.capabilities?.fs?.read).toEqual([])
  })

  test('rejects non-positive limits', () => {
    expect(() => parseManifest({ ...manifest(), limits: { timeoutMs: 0 } })).toThrow(
      ModuleManifestError,
    )
    expect(() => parseManifest({ ...manifest(), limits: { memoryMb: -1 } })).toThrow(
      ModuleManifestError,
    )
  })
})

describe('manifestDigest', () => {
  test('is stable across key order and changes with content', () => {
    const parsed = parseManifest(manifest())
    const reordered = parseManifest(
      Object.fromEntries(Object.entries(manifest()).reverse()) as unknown,
    )
    expect(manifestDigest(parsed)).toMatch(/^[0-9a-f]{64}$/)
    expect(manifestDigest(reordered)).toBe(manifestDigest(parsed))

    const changed: ModuleManifest = { ...parsed, title: 'Other' }
    expect(manifestDigest(changed)).not.toBe(manifestDigest(parsed))
  })
})

describe('compareVersions', () => {
  test('orders core versions numerically', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
  })

  test('implements prerelease precedence', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.beta', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1)
  })

  test('rejects invalid versions', () => {
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(TypeError)
  })
})
