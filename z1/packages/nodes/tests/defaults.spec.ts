import { expect, test } from 'vitest'

import { configJsonSchema } from '@z1/node'

import { builtinNodes, createBuiltinRegistry } from '../src/index.ts'

test('every builtin declares a defaultConfig that its own schema accepts', () => {
  for (const definition of builtinNodes) {
    const parsed = definition.config.safeParse(definition.defaultConfig ?? {})
    const issues = parsed.success ? '' : JSON.stringify(parsed.error.issues)
    expect(parsed.success, `${definition.id}: ${issues}`).toBe(true)
  }
})

test('the palette default is a plain JSON value', () => {
  for (const definition of builtinNodes) {
    const json = JSON.stringify(definition.defaultConfig ?? {})
    expect(JSON.parse(json) as unknown).toEqual(definition.defaultConfig ?? {})
  }
})

test('the descriptor inputs the canvas needs are derived for real builtins', () => {
  const registry = createBuiltinRegistry()
  const constant = registry.get('z1.core.const')
  const model = registry.get('z1.llm.model')
  if (constant === undefined || model === undefined) throw new Error('builtins missing')

  expect(constant.defaultConfig).toEqual({ value: null })
  expect(configJsonSchema(constant)['properties']).toEqual({ value: {} })
  expect(model.defaultConfig).toEqual({ provider: 'mock', model: 'mock-1' })
  expect(configJsonSchema(model)['required']).toEqual(['provider', 'model'])
})
