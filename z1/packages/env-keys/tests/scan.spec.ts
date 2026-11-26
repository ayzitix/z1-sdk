/**
 * `scan`: which workspace files already contain a value from `.env`.
 *
 * The value never appears in the answer, so every test that finds a leak also
 * serialises the whole result and asserts the value is absent from it. The walk
 * is capped rather than timed, so `truncated` is a fact about the workspace the
 * test built, not about how fast the machine is.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { Json } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import { ENV_KEYS_TOOL_NAME, SCAN_MAX_FILES, createEnvKeysService } from '../src/index.ts'
import {
  asArray,
  asRecord,
  fakeInner,
  removeDirectory,
  temporaryDirectory,
  writeWorkspaceFile,
} from './helpers.ts'

const VALUE = 'sk-live-0123456789abcdef'
const SHORT = 'abc123'

let root: string

beforeAll(async () => {
  root = await temporaryDirectory('scan')
})

afterAll(async () => {
  await removeDirectory(root)
})

/** A service over a directory that is already populated. */
function serviceOver(workspace: string): ToolService {
  return createEnvKeysService({ inner: fakeInner(['read']), workspace })
}

async function scan(tools: ToolService, args: Record<string, Json> = {}): Promise<Record<string, Json>> {
  return asRecord(await tools.call(ENV_KEYS_TOOL_NAME, { action: 'scan', ...args }))
}

/** The `leaks` array of a scan answer, entry by entry. */
function leaksOf(result: Record<string, Json>): readonly Record<string, Json>[] {
  return asArray(result['leaks']).map((entry) => asRecord(entry))
}

describe('scan', () => {
  test('names the file and line of a pasted value, and never the value', async () => {
    const dir = join(root, 'leak')
    await writeWorkspaceFile(dir, '.env', `API_KEY=${VALUE}\n`)
    await writeWorkspaceFile(dir, 'src/config.ts', ['export const a = 1', '', `const key = '${VALUE}'`, ''].join('\n'))
    await writeWorkspaceFile(dir, 'README.md', 'nothing secret here\n')

    const result = await scan(serviceOver(dir))

    expect(result).toEqual({
      file: '.env',
      keys: 1,
      leaks: [{ name: 'API_KEY', path: 'src/config.ts', line: 3 }],
      truncated: false,
    })
    expect(JSON.stringify(result)).not.toContain(VALUE)
  })

  test('the value living in .env itself is not a leak', async () => {
    const dir = join(root, 'own-file')
    await writeWorkspaceFile(dir, '.env', `API_KEY=${VALUE}\n`)

    expect(leaksOf(await scan(serviceOver(dir)))).toEqual([])
  })

  test('a value shorter than 8 characters is not searched for', async () => {
    const dir = join(root, 'short')
    await writeWorkspaceFile(dir, '.env', `PIN=${SHORT}\nAPI_KEY=${VALUE}\n`)
    await writeWorkspaceFile(dir, 'src/a.ts', `const pin = '${SHORT}'\nconst key = '${VALUE}'\n`)

    const result = await scan(serviceOver(dir))

    expect(result['keys']).toBe(1)
    expect(leaksOf(result)).toEqual([{ name: 'API_KEY', path: 'src/a.ts', line: 2 }])
  })

  test('a glob narrows the walk, and a path the glob excludes is not reported', async () => {
    const dir = join(root, 'glob')
    await writeWorkspaceFile(dir, '.env', `API_KEY=${VALUE}\n`)
    await writeWorkspaceFile(dir, 'src/a.ts', `const key = '${VALUE}'\n`)
    await writeWorkspaceFile(dir, 'docs/b.md', `key: ${VALUE}\n`)

    expect(leaksOf(await scan(serviceOver(dir), { glob: 'src/**' }))).toEqual([
      { name: 'API_KEY', path: 'src/a.ts', line: 1 },
    ])
    expect(leaksOf(await scan(serviceOver(dir), { glob: '**/*.md' }))).toEqual([
      { name: 'API_KEY', path: 'docs/b.md', line: 1 },
    ])
  })

  test('node_modules and .git are not walked into', async () => {
    const dir = join(root, 'skipped')
    await writeWorkspaceFile(dir, '.env', `API_KEY=${VALUE}\n`)
    await writeWorkspaceFile(dir, 'node_modules/pkg/index.js', `const key = '${VALUE}'\n`)
    await writeWorkspaceFile(dir, '.git/objects/blob', `const key = '${VALUE}'\n`)

    expect(leaksOf(await scan(serviceOver(dir)))).toEqual([])
  })

  test('a file that is not text is skipped rather than searched', async () => {
    const dir = join(root, 'binary')
    await writeWorkspaceFile(dir, '.env', `API_KEY=${VALUE}\n`)
    await writeFile(join(dir, 'image.png'), `\u0000\u0000${VALUE}\u0000`, 'utf8')

    expect(leaksOf(await scan(serviceOver(dir)))).toEqual([])
  })

  test('truncated is set when the walk reaches the file cap', async () => {
    const dir = join(root, 'truncated')
    await writeWorkspaceFile(dir, '.env', `API_KEY=${VALUE}\n`)
    // One more matching file than the cap, so the walk has to stop short. The
    // cap is a count rather than a deadline, which is what makes this cheap and
    // the answer the same on every machine.
    const overflow = SCAN_MAX_FILES + 1
    for (let start = 0; start < overflow; start += 200) {
      const batch: Promise<string>[] = []
      for (let index = start; index < Math.min(start + 200, overflow); index += 1) {
        batch.push(
          writeWorkspaceFile(dir, `many/f${String(index).padStart(5, '0')}.txt`, 'plain\n'),
        )
      }
      await Promise.all(batch)
    }

    expect(await scan(serviceOver(dir), { glob: '**/*.txt' })).toEqual({
      file: '.env',
      keys: 1,
      leaks: [],
      truncated: true,
    })
    // Building the tree is a couple of thousand file creations, and this file
    // shares the machine with the rest of the suite; the cap under test is a
    // count, so the test's own budget is the only timing involved.
  }, 20_000)

  test('a workspace without a .env scans nothing and finds nothing', async () => {
    const dir = join(root, 'no-file')
    await writeWorkspaceFile(dir, 'src/a.ts', 'nothing to find\n')

    expect(await scan(serviceOver(dir))).toEqual({
      file: '.env',
      keys: 0,
      leaks: [],
      truncated: false,
    })
  })
})
