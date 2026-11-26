/**
 * `check`: the file's standing in git, and its mode.
 *
 * git is the only honest source for "ignored" and "tracked", so the tests make a
 * real repository in `tmpdir()` and ask it. The one non-obvious answer is pinned
 * on purpose: once git tracks a file, an ignore rule no longer applies to it, so
 * `tracked: true` and `gitignored: true` cannot both be true for the same file.
 */

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { Json } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import { ENV_KEYS_TOOL_NAME, createEnvKeysService } from '../src/index.ts'
import { asRecord, fakeInner, removeDirectory, temporaryDirectory } from './helpers.ts'

const run = promisify(execFile)

let root: string

beforeAll(async () => {
  root = await temporaryDirectory('check')
})

afterAll(async () => {
  await removeDirectory(root)
})

/** git in one directory; a failure is the caller's, so it throws. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, windowsHide: true })
  return stdout
}

function serviceOver(workspace: string): ToolService {
  return createEnvKeysService({ inner: fakeInner(['read']), workspace })
}

async function check(tools: ToolService): Promise<Record<string, Json>> {
  return asRecord(await tools.call(ENV_KEYS_TOOL_NAME, { action: 'check' }))
}

describe('check', () => {
  test('outside a repository both answers are false, and a missing file is not an error', async () => {
    const dir = join(root, 'plain')
    await mkdir(dir, { recursive: true })

    expect(await check(serviceOver(dir))).toEqual({
      file: '.env',
      exists: false,
      gitignored: false,
      tracked: false,
      mode: null,
    })
  })

  test('a .gitignore that covers the file makes it gitignored', async () => {
    const dir = join(root, 'ignored')
    await mkdir(dir, { recursive: true })
    await git(dir, ['init', '-q', '.'])
    await writeFile(join(dir, '.env'), 'A=1\n', 'utf8')
    await writeFile(join(dir, '.gitignore'), '.env\n', 'utf8')

    expect(await check(serviceOver(dir))).toMatchObject({
      exists: true,
      gitignored: true,
      tracked: false,
    })
  })

  test('adding the file makes it tracked, and git stops calling it ignored', async () => {
    const dir = join(root, 'tracked')
    await mkdir(dir, { recursive: true })
    await git(dir, ['init', '-q', '.'])
    await writeFile(join(dir, '.env'), 'A=1\n', 'utf8')
    await writeFile(join(dir, '.gitignore'), '.env\n', 'utf8')
    await git(dir, ['add', '-f', '.env'])

    // The ignore rule is still in the file and git still says the path is not
    // ignored: a tracked file is not ignored. Reporting otherwise would tell a
    // person their committed key is safe.
    expect(await check(serviceOver(dir))).toMatchObject({
      exists: true,
      gitignored: false,
      tracked: true,
    })
  })

  test('a nested file is asked about by its path relative to the workspace', async () => {
    const dir = join(root, 'nested')
    await mkdir(join(dir, 'config'), { recursive: true })
    await git(dir, ['init', '-q', '.'])
    await writeFile(join(dir, 'config', '.env'), 'A=1\n', 'utf8')
    await writeFile(join(dir, 'config', '.gitignore'), '.env\n', 'utf8')

    const tools = createEnvKeysService({
      inner: fakeInner(['read']),
      workspace: dir,
      file: 'config/.env',
    })

    expect(await check(tools)).toMatchObject({
      file: 'config/.env',
      exists: true,
      gitignored: true,
      tracked: false,
    })
  })

  test('reports the mode a POSIX host actually has, and null where there are no mode bits', async () => {
    const dir = join(root, 'mode')
    await mkdir(dir, { recursive: true })
    const tools = serviceOver(dir)
    await tools.call(ENV_KEYS_TOOL_NAME, { action: 'set', name: 'A', value: 'value-1234' })

    const mode = (await check(tools))['mode']

    if (process.platform === 'win32') {
      // Windows has no POSIX bits; `chmod` there only toggles read-only, so an
      // octal string would be an invented fact.
      expect(mode).toBeNull()
    } else {
      expect(mode).toBe('600')
    }
  })
})
