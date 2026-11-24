import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ChatMessage } from '@z1/node'
import { afterEach, expect, test, vi } from 'vitest'

import type { SessionStore } from '../src/index.ts'

/**
 * A replace that fails on Windows for a moment is the normal case (a reader or
 * a scanner still holds the target open), and it cannot be provoked on demand
 * from a test: the retry loop is synchronous, so nothing on this thread can
 * release the handle between two attempts. The failure is injected at
 * `renameSync` instead, which is the only thing the loop reacts to.
 */
const rename = vi.hoisted(() => ({ calls: 0, failures: 0, code: 'EPERM' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      rename.calls += 1
      if (rename.calls <= rename.failures) {
        const error = new Error(`${rename.code}: injected failure, rename`) as NodeJS.ErrnoException
        error.code = rename.code
        throw error
      }
      actual.renameSync(from, to)
    },
  }
})

// Imported after the mock is installed: these are the modules under test, and a
// rename they perform has to be the injected one.
const { writeFileAtomic } = await import('../src/fsutil.ts')
const { createSessionStore } = await import('../src/index.ts')

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'z1-atomic-'))
  created.push(dir)
  return dir
}

function prepare(): { dir: string; file: string } {
  const dir = tempDir()
  const file = join(dir, 'meta.json')
  writeFileSync(file, 'old', 'utf8')
  rename.calls = 0
  return { dir, file }
}

test('a transient EPERM is retried until the replace succeeds', () => {
  const { dir, file } = prepare()
  rename.failures = 2
  rename.code = 'EPERM'

  writeFileAtomic(file, 'new')

  expect(rename.calls).toBe(3)
  expect(readFileSync(file, 'utf8')).toBe('new')
  // A write that eventually succeeded leaves no temp file behind.
  expect(readdirSync(dir)).toEqual(['meta.json'])
})

test('a replace that keeps failing is reported as could-not-acquire', () => {
  const { dir, file } = prepare()
  rename.failures = Number.POSITIVE_INFINITY
  rename.code = 'EPERM'

  expect(() => writeFileAtomic(file, 'new')).toThrow(/could not acquire .*meta\.json for an atomic write/)
  expect(rename.calls).toBe(3)
  // The failed writer keeps the old content and cleans up after itself.
  expect(readFileSync(file, 'utf8')).toBe('old')
  expect(readdirSync(dir)).toEqual(['meta.json'])
})

test('a code that is not retryable fails on the first attempt', () => {
  const { file } = prepare()
  rename.failures = Number.POSITIVE_INFINITY
  rename.code = 'EISDIR'

  expect(() => writeFileAtomic(file, 'new')).toThrow(/could not acquire/)
  expect(rename.calls).toBe(1)
})

/** A store with one session that has a transcript, ready to be removed. */
function sessionWithTranscript(): { store: SessionStore; id: string } {
  rename.failures = 0
  rename.calls = 0
  const cwd = tempDir()
  const store = createSessionStore({ cwd, env: {} })
  const session = store.create({
    cwd,
    model: { provider: 'river', model: 'deepseek-ai/test' },
    contextWindow: 131_072,
    maxSteps: 64,
  })
  store.appendTurn(session.meta.id, [{ role: 'user', content: 'gone soon' } as ChatMessage])
  return { store, id: session.meta.id }
}

test('a transient EPERM on the trash move is retried', () => {
  const { store, id } = sessionWithTranscript()
  rename.calls = 0
  rename.failures = 2
  rename.code = 'EPERM'

  store.remove(id)

  expect(rename.calls).toBe(3)
  expect(existsSync(join(store.root, 'sessions', id))).toBe(false)
  const trash = readdirSync(join(store.root, '.trash'))
  expect(trash).toHaveLength(1)
  expect(trash[0]).toMatch(new RegExp(`-${id}$`))
})

test('a trash move that keeps failing leaves the session in sessions/', () => {
  const { store, id } = sessionWithTranscript()
  const dir = join(store.root, 'sessions', id)
  rename.calls = 0
  rename.failures = Number.POSITIVE_INFINITY
  rename.code = 'EPERM'

  expect(() => store.remove(id)).toThrow(
    new RegExp(`could not move ${id} to the trash after 3 attempts`),
  )
  expect(rename.calls).toBe(3)
  // Nothing moved, so there is nothing to roll back: the session is complete
  // where it was, with no lock and no temp litter, and it still reads back.
  expect(readdirSync(dir).sort()).toEqual(['events.jsonl', 'meta.json'])
  expect(readdirSync(join(store.root, '.trash'))).toEqual([])
  expect(store.load(id)?.messages).toEqual([{ role: 'user', content: 'gone soon' }])
})
