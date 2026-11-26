import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  INSTALLED_TOOLS_ENV,
  createInstalledToolService,
  installedToolsEnabled,
} from '../src/index.ts'
import { HAS_SIBLING, SIBLING_SDK, fakeInner, installFixture, recorder } from './fakes.ts'

/**
 * The bootstrap's guarded lines, mirrored in a test.
 *
 * `packages/bootstrap/src/runtime.ts` finalises a run's tool service like this:
 *
 * ```ts
 * const withInstalledTools = installedToolsEnabled(config.env)
 *   ? createInstalledToolService({ inner: runTools, workspace: config.cwd, log: serviceLog })
 *   : runTools
 * const tools = toolCreatorEnabled(config.env)
 *   ? createToolCreatorService({ inner: withInstalledTools, … })
 *   : withInstalledTools
 * ```
 *
 * These tests pin both halves of the installed-tools branch — off means the
 * very same instance, on means one more tool — without building a runtime. This
 * package cannot import `@z1/bootstrap` (that reference would be a cycle with
 * the bootstrap's reference to this package), and the wiring itself is two
 * lines in one file, so the branch is what is worth pinning. The order matters:
 * installed tools sit *under* `tool.create`, so the creator sees them and the
 * outermost name the model asks for is still `tool.create`.
 */
describe('the Z1_INSTALLED_TOOLS switch', () => {
  let scratch: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'z1-installed-tools-wiring-'))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  test('is on by default and stays on for anything but an explicit falsey value', () => {
    expect(installedToolsEnabled({})).toBe(true)
    expect(installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: '1' })).toBe(true)
    expect(installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: ' TRUE ' })).toBe(true)
    expect(installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: '   ' })).toBe(true)
    expect(installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: 'whatever' })).toBe(true)
  })

  test('is off for 0, false, off and no, in any case', () => {
    expect(installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: '0' })).toBe(false)
    expect(installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: ' OFF ' })).toBe(false)
    expect(installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: 'false' })).toBe(false)
    expect(installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: 'No' })).toBe(false)
  })

  test('off hands the run the tool service it already had', () => {
    const inner = fakeInner(['read'])
    const tools = installedToolsEnabled({ [INSTALLED_TOOLS_ENV]: '0' })
      ? createInstalledToolService({ inner, workspace: '/work' })
      : inner

    expect(tools).toBe(inner)
  })

  test('on with nothing installed keeps the inventory and says nothing', async () => {
    const inner = fakeInner(['read'])
    const log = recorder()
    const tools = installedToolsEnabled({})
      ? createInstalledToolService({ inner, workspace: join(scratch, 'empty'), log: log.log })
      : inner

    expect(tools).not.toBe(inner)
    expect((await tools.list()).map((schema) => schema.name)).toEqual(['read'])
    expect(log.lines).toEqual([])
  })

  test.skipIf(!HAS_SIBLING)('on puts an installed tool beside the tools the run had', async () => {
    const workspace = join(scratch, 'installed')
    await installFixture({ toolsDir: join(workspace, '.z2q', 'tools'), name: 'tool.wired' })
    const inner = fakeInner(['read'])
    const tools = installedToolsEnabled({})
      ? createInstalledToolService({ inner, workspace, sdkPath: SIBLING_SDK })
      : inner

    expect((await tools.list()).map((schema) => schema.name)).toEqual(['read', 'tool.wired'])
  })
})
