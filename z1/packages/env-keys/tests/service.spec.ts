/**
 * `env.keys` through the tool boundary: what each action answers, and what it
 * refuses before it touches anything.
 *
 * Every assertion here is about a *result*, because that is what reaches the
 * model and the transcript. One rule runs through all of them: a value never
 * appears in a result or in a log line, so several tests serialise the whole
 * answer and assert the value is absent from it.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { Json } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import { ENV_KEYS_TOOL_NAME, MAX_ENV_VALUE_BYTES, createEnvKeysService } from '../src/index.ts'
import { asArray, asRecord, fakeInner, removeDirectory, temporaryDirectory } from './helpers.ts'

const VALUE = 'sk-live-0123456789abcdef'

let root: string

beforeAll(async () => {
  root = await temporaryDirectory('service')
})

afterAll(async () => {
  await removeDirectory(root)
})

/** One service over its own directory, so tests cannot see each other's file. */
async function workspace(
  label: string,
  options: { text?: string } = {},
): Promise<{ dir: string; tools: ToolService; logs: string[] }> {
  const dir = join(root, label)
  await mkdir(dir, { recursive: true })
  if (options.text !== undefined) await writeFile(join(dir, '.env'), options.text, 'utf8')

  const logs: string[] = []
  const inner = fakeInner(['read'])
  const tools = createEnvKeysService({
    inner,
    workspace: dir,
    log: (level, message) => {
      logs.push(`${level}: ${message}`)
    },
  })
  return { dir, tools, logs }
}

/** Call the one action this service owns and read the answer as an object. */
async function call(tools: ToolService, args: Record<string, Json>): Promise<Record<string, Json>> {
  return asRecord(await tools.call(ENV_KEYS_TOOL_NAME, args))
}

/** The `keys` array of a `list` answer, entry by entry. */
function keysOf(result: Record<string, Json>): readonly Record<string, Json>[] {
  return asArray(result['keys']).map((entry) => asRecord(entry))
}

describe('list', () => {
  test('a missing file answers exists: false and no keys, without throwing', async () => {
    const { tools } = await workspace('list-missing')

    expect(await call(tools, { action: 'list' })).toEqual({
      file: '.env',
      exists: false,
      keys: [],
      count: 0,
    })
  })

  test('reports names and lengths, and the value appears nowhere in the answer', async () => {
    const { tools } = await workspace('list-real', {
      text: ['# keys', `API_KEY=${VALUE}`, 'PORT=3000', ''].join('\n'),
    })

    const result = await call(tools, { action: 'list' })

    expect(result).toEqual({
      file: '.env',
      exists: true,
      keys: [
        { name: 'API_KEY', length: VALUE.length, inEnvironment: false },
        { name: 'PORT', length: 4, inEnvironment: false },
      ],
      count: 2,
    })
    expect(JSON.stringify(result)).not.toContain(VALUE)
  })

  test('marks a name that the host process also has', async () => {
    const name = 'Z1_ENV_KEYS_TEST_LIVE'
    process.env[name] = 'host-value'
    try {
      const { tools } = await workspace('list-live', { text: `${name}=from-file\n` })

      expect(keysOf(await call(tools, { action: 'list' }))).toEqual([
        { name, length: 'from-file'.length, inEnvironment: true },
      ])
    } finally {
      delete process.env[name]
    }
  })
})

describe('set', () => {
  test('creates the file when it is absent', async () => {
    const { dir, tools } = await workspace('set-create')

    const result = await call(tools, { action: 'set', name: 'API_KEY', value: VALUE })

    expect(result).toEqual({ file: '.env', name: 'API_KEY', replaced: false, length: VALUE.length })
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(`API_KEY=${VALUE}\n`)
    // The write goes through a temp sibling; a leftover one would be a copy of
    // the value in a file nobody looks at again.
    expect((await readdir(dir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  test('replaces in place and keeps the comments around it', async () => {
    const before = ['# hand-edited', '', 'API_KEY=old', '# keep me', 'PORT=3000', ''].join('\n')
    const { dir, tools } = await workspace('set-replace', { text: before })

    const result = await call(tools, { action: 'set', name: 'API_KEY', value: VALUE })

    expect(result['replaced']).toBe(true)
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(
      ['# hand-edited', '', `API_KEY=${VALUE}`, '# keep me', 'PORT=3000', ''].join('\n'),
    )
  })

  test('appends a key the file does not have', async () => {
    const { dir, tools } = await workspace('set-append', { text: 'PORT=3000\n' })

    await call(tools, { action: 'set', name: 'API_KEY', value: VALUE })

    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(`PORT=3000\nAPI_KEY=${VALUE}\n`)
  })

  test('two sets of the same name leave one line', async () => {
    const { dir, tools } = await workspace('set-twice')

    await call(tools, { action: 'set', name: 'API_KEY', value: 'first-value' })
    await call(tools, { action: 'set', name: 'API_KEY', value: 'second-value' })

    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('API_KEY=second-value\n')
  })

  test('a value with a `#` or `=` is written verbatim and read back at its length', async () => {
    const value = 'a=b#c'
    const { dir, tools } = await workspace('set-roundtrip')

    await call(tools, { action: 'set', name: 'API_KEY', value })

    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(`API_KEY=${value}\n`)
    expect(keysOf(await call(tools, { action: 'list' }))[0]).toEqual({
      name: 'API_KEY',
      length: value.length,
      inEnvironment: false,
    })
  })

  test('never logs the value', async () => {
    const { tools, logs } = await workspace('set-logs')

    await call(tools, { action: 'set', name: 'API_KEY', value: VALUE })

    expect(logs.join('\n')).toContain('API_KEY')
    expect(logs.join('\n')).not.toContain(VALUE)
  })
})

describe('unset', () => {
  test('removes only its line', async () => {
    const { dir, tools } = await workspace('unset', {
      text: ['# keys', `API_KEY=${VALUE}`, 'PORT=3000', ''].join('\n'),
    })

    expect(await call(tools, { action: 'unset', name: 'API_KEY' })).toEqual({
      file: '.env',
      name: 'API_KEY',
      removed: true,
    })
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(['# keys', 'PORT=3000', ''].join('\n'))
  })

  test('reports removed: false for a name the file does not have', async () => {
    const { dir, tools } = await workspace('unset-missing-name', { text: 'PORT=3000\n' })

    expect(await call(tools, { action: 'unset', name: 'API_KEY' })).toEqual({
      file: '.env',
      name: 'API_KEY',
      removed: false,
    })
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('PORT=3000\n')
  })

  test('does not create a file that was never there', async () => {
    const { dir, tools } = await workspace('unset-missing-file')

    expect((await call(tools, { action: 'unset', name: 'API_KEY' }))['removed']).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('refusals', () => {
  test('a name that no .env reader could honour is refused', async () => {
    const { dir, tools } = await workspace('refuse-name')

    await expect(call(tools, { action: 'set', name: '1BAD', value: 'x' })).rejects.toThrow(
      /invalid_arguments: "name"/,
    )
    await expect(call(tools, { action: 'unset', name: 'A-B' })).rejects.toThrow(
      /invalid_arguments: "name"/,
    )
    expect(await readdir(dir)).toEqual([])
  })

  test('an empty value is refused, with the action to use instead', async () => {
    const { tools } = await workspace('refuse-empty')

    await expect(call(tools, { action: 'set', name: 'A', value: '' })).rejects.toThrow(
      /use "unset"/,
    )
  })

  test('a value with a line break is refused: it would end the assignment early', async () => {
    const { dir, tools } = await workspace('refuse-newline')

    await expect(call(tools, { action: 'set', name: 'A', value: 'one\ntwo' })).rejects.toThrow(
      /line break/,
    )
    await expect(call(tools, { action: 'set', name: 'A', value: 'one\r\ntwo' })).rejects.toThrow(
      /line break/,
    )
    expect(await readdir(dir)).toEqual([])
  })

  test('a value over 8 KiB is refused, and exactly 8 KiB is accepted', async () => {
    const { tools } = await workspace('refuse-big')

    await expect(
      call(tools, { action: 'set', name: 'A', value: 'x'.repeat(MAX_ENV_VALUE_BYTES + 1) }),
    ).rejects.toThrow(/at most 8192 bytes/)
    expect(
      (await call(tools, { action: 'set', name: 'A', value: 'x'.repeat(MAX_ENV_VALUE_BYTES) }))[
        'length'
      ],
    ).toBe(MAX_ENV_VALUE_BYTES)
  })

  test('an unknown action is invalid_arguments and names the ones that exist', async () => {
    const { tools } = await workspace('refuse-action')

    await expect(call(tools, { action: 'erase' })).rejects.toThrow(
      /invalid_arguments: "action" must be one of list, set, unset, check, scan/,
    )
    await expect(call(tools, {})).rejects.toThrow(/invalid_arguments/)
    await expect(call(tools, { action: 4 })).rejects.toThrow(/invalid_arguments/)
  })

  test('a glob that is not a pattern is refused', async () => {
    const { tools } = await workspace('refuse-glob')

    await expect(call(tools, { action: 'scan', glob: '   ' })).rejects.toThrow(/"glob"/)
  })
})
