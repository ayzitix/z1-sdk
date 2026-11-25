import { describe, expect, test } from 'vitest'

import {
  TOOL_CREATE_NAME,
  TOOL_CREATOR_ENV,
  createToolCreatorService,
  toolCreatorEnabled,
} from '../src/index.ts'
import { fakeInner } from './fakes.ts'

/**
 * The bootstrap's guarded line, mirrored in a test.
 *
 * `packages/bootstrap/src/runtime.ts` finalises a run's tool service like this:
 *
 * ```ts
 * tools: toolCreatorEnabled(config.env)
 *   ? createToolCreatorService({ inner: runTools, workspace: config.cwd, log: serviceLog })
 *   : runTools,
 * ```
 *
 * These tests pin both halves of that branch — off means the very same
 * instance, on means one extra tool — without building a runtime. This package
 * cannot import `@z1/bootstrap` (that reference would be a cycle with the
 * bootstrap's reference to this package), and the wiring itself is one line in
 * one file, so the branch is what is worth pinning.
 */
describe('the Z1_TOOL_CREATOR switch', () => {
  test('is off when unset or set to anything but 1/true', () => {
    expect(toolCreatorEnabled({})).toBe(false)
    expect(toolCreatorEnabled({ [TOOL_CREATOR_ENV]: '0' })).toBe(false)
    expect(toolCreatorEnabled({ [TOOL_CREATOR_ENV]: 'yes' })).toBe(false)
    expect(toolCreatorEnabled({ [TOOL_CREATOR_ENV]: '   ' })).toBe(false)
  })

  test('is on for "1" and "true", in any case', () => {
    expect(toolCreatorEnabled({ [TOOL_CREATOR_ENV]: '1' })).toBe(true)
    expect(toolCreatorEnabled({ [TOOL_CREATOR_ENV]: ' TRUE ' })).toBe(true)
  })

  test('off hands the run the tool service it already had', () => {
    const inner = fakeInner(['read'])
    const tools = toolCreatorEnabled({})
      ? createToolCreatorService({ inner, workspace: '/work' })
      : inner

    expect(tools).toBe(inner)
  })

  test('on puts tool.create beside the tools the run already had', async () => {
    const inner = fakeInner(['read'])
    const tools = toolCreatorEnabled({ [TOOL_CREATOR_ENV]: '1' })
      ? createToolCreatorService({ inner, workspace: '/work' })
      : inner

    expect(tools).not.toBe(inner)
    expect((await tools.list()).map((schema) => schema.name)).toEqual(['read', TOOL_CREATE_NAME])
  })
})
