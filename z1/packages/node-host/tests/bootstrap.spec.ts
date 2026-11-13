import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { bootstrapPackageRoot, resolveWorkerBootstrap } from '../src/index.ts'

/**
 * The bootstrap must never be TypeScript when a build exists: plain Node
 * type-stripping changes module resolution, and the spawned worker then fails
 * to import ES module entries.
 *
 * These fixtures mirror the package layout (`src/host.ts` + `lib/worker.js`)
 * so the assertion is deterministic and does not depend on this repo's build.
 */
const roots: string[] = []

async function layout(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'z1-bootstrap-'))
  roots.push(root)
  for (const relative of files) {
    const path = join(root, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '// fixture\n')
  }
  return root
}

function hostUrl(root: string, relative = 'src/host.ts'): string {
  return pathToFileURL(join(root, relative)).href
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('resolveWorkerBootstrap', () => {
  test('prefers the package lib build when src/worker.js is absent', async () => {
    const root = await layout(['src/host.ts', 'lib/worker.js'])
    // src/worker.ts exists in a real checkout; it must still lose to lib.
    await writeFile(join(root, 'src/worker.ts'), '// fixture\n')
    expect(resolveWorkerBootstrap(hostUrl(root))).toBe(join(root, 'lib/worker.js'))
  })

  test('prefers a sibling worker.js when the host is already built', async () => {
    const root = await layout(['lib/host.js', 'lib/worker.js', 'src/worker.ts'])
    expect(resolveWorkerBootstrap(hostUrl(root, 'lib/host.js'))).toBe(
      join(root, 'lib/worker.js'),
    )
  })

  test('falls back to src/worker.ts only when no build exists', async () => {
    const root = await layout(['src/host.ts', 'src/worker.ts'])
    expect(resolveWorkerBootstrap(hostUrl(root))).toBe(join(root, 'src/worker.ts'))
  })

  test('throws a build-first error when nothing is found', async () => {
    const root = await layout(['src/host.ts'])
    expect(() => resolveWorkerBootstrap(hostUrl(root))).toThrow(/build @z1\/node-host first/)
  })

  test('this package resolves its own built bootstrap from src', () => {
    const libWorker = fileURLToPath(new URL('../lib/worker.js', import.meta.url))
    const resolve = (): string =>
      resolveWorkerBootstrap(pathToFileURL(fileURLToPath(new URL('../src/host.ts', import.meta.url))))
    if (!existsSync(libWorker)) {
      expect(resolve).toThrow(/build @z1\/node-host first/)
      return
    }
    expect(resolve()).toBe(libWorker)
  })
})

describe('bootstrapPackageRoot', () => {
  test('finds the package.json above lib/ or src/', async () => {
    const root = await layout(['package.json', 'lib/worker.js', 'src/worker.ts'])
    expect(bootstrapPackageRoot(join(root, 'lib/worker.js'))).toBe(root)
    expect(bootstrapPackageRoot(join(root, 'src/worker.ts'))).toBe(root)
  })
})
