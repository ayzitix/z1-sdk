import { describe, expect, test } from 'vitest'
import { checkLlm, checkTool } from '../src/capability.ts'
import { ModuleManifestError, parseManifest } from '../src/manifest.ts'

const BASE = {
  schemaVersion: 1,
  id: 'com.example.gates',
  version: '1.0.0',
  title: 'Gates',
  license: 'MIT',
  engines: { z1: '>=0.1.0' },
  entry: 'index.js',
  nodes: [],
}

function withCapabilities(capabilities: unknown): unknown {
  return { ...BASE, capabilities }
}

describe('checkLlm', () => {
  test('denies when the capability is absent or the list is empty', () => {
    expect(checkLlm(undefined, 'mock')).toEqual({
      ok: false,
      reason: 'no llm capability granted',
    })
    expect(checkLlm({}, 'mock').ok).toBe(false)
    expect(checkLlm({ llm: {} }, 'mock').ok).toBe(false)
    expect(checkLlm({ llm: { providers: [] } }, 'mock').ok).toBe(false)
  })

  test('`true` grants every provider', () => {
    expect(checkLlm({ llm: true }, 'anything')).toEqual({ ok: true })
    expect(checkLlm({ llm: true }, '')).toEqual({ ok: true })
  })

  test('a list grants exactly its providers, case-insensitively', () => {
    const capabilities = { llm: { providers: ['Mock', 'other'] } }
    expect(checkLlm(capabilities, 'mock')).toEqual({ ok: true })
    expect(checkLlm(capabilities, ' OTHER ')).toEqual({ ok: true })
    expect(checkLlm(capabilities, 'openai')).toEqual({
      ok: false,
      reason: 'model provider "openai" is outside the granted providers',
    })
    expect(checkLlm(capabilities, 'mu').ok).toBe(false)
  })
})

describe('checkTool', () => {
  test('denies when the capability is absent or the list is empty', () => {
    expect(checkTool(undefined, 'echo').ok).toBe(false)
    expect(checkTool({}, 'echo').ok).toBe(false)
    expect(checkTool({ tools: {} }, 'echo').ok).toBe(false)
    expect(checkTool({ tools: { names: [] } }, 'echo').ok).toBe(false)
  })

  test('`true` grants every tool', () => {
    expect(checkTool({ tools: true }, 'anything')).toEqual({ ok: true })
  })

  test('a list grants exactly its names', () => {
    const capabilities = { tools: { names: ['echo'] } }
    expect(checkTool(capabilities, 'echo')).toEqual({ ok: true })
    expect(checkTool(capabilities, 'shell')).toEqual({
      ok: false,
      reason: 'tool "shell" is outside the granted tools',
    })
    expect(checkTool(capabilities, 'ech').ok).toBe(false)
  })
})

describe('manifest llm/tools capabilities', () => {
  test('accepts `true` and provider/name lists', () => {
    const parsed = parseManifest(
      withCapabilities({ llm: { providers: ['mock'] }, tools: { names: ['echo'] } }),
    )
    expect(parsed.capabilities?.llm).toEqual({ providers: ['mock'] })
    expect(parsed.capabilities?.tools).toEqual({ names: ['echo'] })

    const all = parseManifest(withCapabilities({ llm: true, tools: true }))
    expect(all.capabilities?.llm).toBe(true)
    expect(all.capabilities?.tools).toBe(true)
  })

  test('rejects unknown keys inside llm and tools', () => {
    const llm = (): unknown => parseManifest(withCapabilities({ llm: { model: 'x' } }))
    expect(llm).toThrow(ModuleManifestError)
    expect(llm).toThrow(/capabilities\.llm/)

    const tools = (): unknown => parseManifest(withCapabilities({ tools: { allow: ['x'] } }))
    expect(tools).toThrow(ModuleManifestError)
    expect(tools).toThrow(/capabilities\.tools/)
  })

  test('rejects non-boolean, non-list grants', () => {
    expect(() => parseManifest(withCapabilities({ llm: 'mock' }))).toThrow(ModuleManifestError)
    expect(() => parseManifest(withCapabilities({ tools: ['echo'] }))).toThrow(
      ModuleManifestError,
    )
  })
})
