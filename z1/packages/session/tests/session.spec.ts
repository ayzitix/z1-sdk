import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ChatMessage } from '@z1/node'
import { afterEach, describe, expect, test } from 'vitest'

import {
  PACKAGE,
  SessionTooNewError,
  createSessionStore,
  resolveSessionRoot,
  type SessionStore,
} from '../src/index.ts'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix = 'z1-session-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function open(cwd: string, env: Record<string, string | undefined> = {}): SessionStore {
  return createSessionStore({ cwd, env })
}

function newSession(store: SessionStore, cwd: string, name?: string) {
  return store.create({
    ...(name === undefined ? {} : { name }),
    cwd,
    model: { provider: 'river', model: 'deepseek-ai/test' },
    contextWindow: 131_072,
    maxSteps: 64,
  })
}

function user(text: string): ChatMessage {
  return { role: 'user', content: text }
}

function assistant(text: string): ChatMessage {
  return { role: 'assistant', content: text }
}

function system(text: string): ChatMessage {
  return { role: 'system', content: text }
}

function eventLines(store: SessionStore, id: string): string[] {
  const text = readFileSync(join(store.root, 'sessions', id, 'events.jsonl'), 'utf8')
  return text.split('\n').filter((line) => line !== '')
}

function lastEvent(store: SessionStore, id: string): Record<string, unknown> {
  const lines = eventLines(store, id)
  const line = lines[lines.length - 1]
  if (line === undefined) throw new Error('no events')
  return JSON.parse(line) as Record<string, unknown>
}

describe('package', () => {
  test('exports its name', () => {
    expect(PACKAGE).toBe('@z1/session')
  })
})

describe('transcript', () => {
  test('create, append three turns, load equals the non-system transcript', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const session = newSession(store, cwd, 'fix flaky auth test')
    expect(session.meta.name).toBe('fix flaky auth test')
    expect(session.messages).toEqual([])
    expect(store.mode).toBe('project')
    expect(store.root).toBe(join(cwd, 'z1'))

    const toolCall = { id: 'call_1', name: 'fs.read', arguments: { path: 'a.ts', lines: [1, 2] } }
    store.appendTurn(session.meta.id, [system('be brief'), user('read a.ts')], { runId: 'run_a' })
    store.appendTurn(session.meta.id, [
      system('be brief'),
      user('read a.ts'),
      { role: 'assistant', content: '', toolCalls: [toolCall] },
    ])
    store.appendTurn(session.meta.id, [
      system('be brief'),
      user('read a.ts'),
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', content: 'export const a = 1', toolCallId: 'call_1' },
      assistant('a is 1'),
    ])

    const loaded = store.load(session.meta.id)
    expect(loaded).toBeDefined()
    expect(loaded?.messages).toEqual([
      { role: 'user', content: 'read a.ts' },
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', content: 'export const a = 1', toolCallId: 'call_1' },
      { role: 'assistant', content: 'a is 1' },
    ])
    expect(loaded?.tornTail).toBe(false)
    expect(loaded?.meta.messageCount).toBe(4)
    expect(loaded?.meta.runs).toEqual(['run_a'])
    expect(loaded?.meta.model).toEqual({ provider: 'river', model: 'deepseek-ai/test' })

    // toolCalls/toolCallId survive byte-for-byte, unlike `historyJson`.
    const second = loaded?.messages[1]
    expect(JSON.stringify(second?.toolCalls)).toBe(JSON.stringify([toolCall]))
    expect(loaded?.messages[2]?.toolCallId).toBe('call_1')
    const kinds = eventLines(store, session.meta.id).map(
      (line) => (JSON.parse(line) as { type: string }).type,
    )
    expect(kinds).toEqual(['message', 'message', 'message', 'message'])
  })

  test('a prefix append writes only the delta; a rewrite writes a snapshot', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const session = newSession(store, cwd)

    store.appendTurn(session.meta.id, [user('one'), assistant('1')])
    const first = eventLines(store, session.meta.id)
    expect(first).toHaveLength(2)
    const firstBytes = statSync(join(store.root, 'sessions', session.meta.id, 'events.jsonl')).size

    store.appendTurn(session.meta.id, [user('one'), assistant('1'), user('two')])
    const second = eventLines(store, session.meta.id)
    expect(second).toHaveLength(3)
    const secondBytes = statSync(join(store.root, 'sessions', session.meta.id, 'events.jsonl')).size
    expect(secondBytes - firstBytes).toBe(Buffer.byteLength(`${second[2]}\n`))
    expect(lastEvent(store, session.meta.id)['type']).toBe('message')

    // Same-length but different first message: not a prefix, so snapshot.
    const rewritten = [user('ONE'), assistant('1'), user('two')]
    store.appendTurn(session.meta.id, rewritten)
    expect(lastEvent(store, session.meta.id)['type']).toBe('snapshot')
    expect(store.load(session.meta.id)?.messages).toEqual(rewritten)

    // A shorter transcript is also a rewrite.
    store.appendTurn(session.meta.id, [user('ONE')])
    expect(lastEvent(store, session.meta.id)['type']).toBe('snapshot')
    expect(store.load(session.meta.id)?.messages).toEqual([user('ONE')])
    expect(store.load(session.meta.id)?.meta.messageCount).toBe(1)
  })

  test('an empty delta is a no-op', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const session = newSession(store, cwd)
    store.appendTurn(session.meta.id, [user('one')])
    const before = statSync(join(store.root, 'sessions', session.meta.id, 'events.jsonl')).size
    const metaBefore = store.load(session.meta.id)?.meta.updatedAt

    store.appendTurn(session.meta.id, [system('ignored'), user('one')], { runId: 'run_late' })

    const after = statSync(join(store.root, 'sessions', session.meta.id, 'events.jsonl')).size
    expect(after).toBe(before)
    expect(store.load(session.meta.id)?.meta.updatedAt).toBe(metaBefore)
    expect(store.load(session.meta.id)?.meta.runs).toEqual([])
  })

  test('a truncated final line is dropped and reported', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const session = newSession(store, cwd)
    store.appendTurn(session.meta.id, [user('one'), assistant('1')])
    store.appendTurn(session.meta.id, [user('one'), assistant('1'), user('two'), assistant('2')])

    const file = join(store.root, 'sessions', session.meta.id, 'events.jsonl')
    appendFileSync(file, '{"v":1,"ord":9,"ts":1,')

    const loaded = store.load(session.meta.id)
    expect(loaded?.messages).toHaveLength(4)
    expect(loaded?.tornTail).toBe(true)

    // The fragment is cut before the next append, so the turn after a crash is
    // readable instead of being glued onto half a line.
    store.appendTurn(session.meta.id, [...loaded!.messages, user('three')])
    const healed = store.load(session.meta.id)
    expect(healed?.tornTail).toBe(false)
    expect(healed?.messages.at(-1)).toEqual(user('three'))
    expect(healed?.messages).toHaveLength(5)
  })
})

describe('management', () => {
  test('archive, list, --all, latest, setCurrent, rename', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const older = newSession(store, cwd, 'older')
    const newer = newSession(store, cwd, 'newer')
    store.appendTurn(newer.meta.id, [user('hello')])
    // Pin the ordering instead of racing the clock of two creates in one ms.
    store.setMeta(older.meta.id, { updatedAt: 1_000 })
    store.setMeta(newer.meta.id, { updatedAt: 2_000 })

    expect(store.list().map((entry) => entry.id)).toEqual([newer.meta.id, older.meta.id])
    expect(store.list().map((entry) => entry.messageCount)).toEqual([1, 0])
    // Nothing has been set current yet, so "latest" is the newest file.
    expect(store.latest()?.id).toBe(store.list()[0]?.id)
    expect(store.latest()?.id).toBe(newer.meta.id)

    store.archive(older.meta.id, true)
    expect(store.list().map((entry) => entry.id)).toEqual([newer.meta.id])
    expect(store.list({ includeArchived: true })).toHaveLength(2)
    expect(store.load(older.meta.id)?.meta.archived).toBe(true)
    store.archive(older.meta.id, false)
    expect(store.list({ includeArchived: true }).find((entry) => entry.id === older.meta.id)?.archived).toBe(
      false,
    )

    // Archiving bumped `older`, so the pointerless fallback follows updatedAt.
    expect(store.latest()?.id).toBe(older.meta.id)
    store.setCurrent(newer.meta.id)
    expect(store.latest()?.id).toBe(newer.meta.id)
    store.setCurrent(older.meta.id)
    expect(JSON.parse(readFileSync(join(store.root, 'latest.json'), 'utf8'))).toMatchObject({
      id: older.meta.id,
    })
    expect(store.latest()?.id).toBe(older.meta.id)

    store.rename(older.meta.id, '  renamed  ')
    expect(store.latest()?.name).toBe('renamed')
    expect(() => store.rename(older.meta.id, '   ')).toThrow(/must not be empty/)

    // Unknown ids are rejected, present-but-unknown returns undefined.
    expect(store.load('s_20260101T000000-abcdef')).toBeUndefined()
    expect(() => store.rename('s_20260101T000000-abcdef', 'x')).toThrow(/unknown session/)
  })

  test('remove moves the directory into .trash', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const session = newSession(store, cwd)
    store.appendTurn(session.meta.id, [user('gone soon')])

    store.remove(session.meta.id)
    expect(store.load(session.meta.id)).toBeUndefined()
    expect(existsSync(join(store.root, 'sessions', session.meta.id))).toBe(false)

    const trash = readdirSync(join(store.root, '.trash'))
    expect(trash).toHaveLength(1)
    expect(trash[0]).toMatch(new RegExp(`^[0-9]{8}T[0-9]{6}-${session.meta.id}$`))
    const trashed = join(store.root, '.trash', trash[0] ?? '')
    expect(existsSync(join(trashed, 'meta.json'))).toBe(true)
    expect(existsSync(join(trashed, 'events.jsonl'))).toBe(true)
    expect(() => store.remove(session.meta.id)).toThrow(/unknown session/)
  })

  test('a newer schemaVersion throws instead of being read as v1', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const session = newSession(store, cwd)
    const sibling = newSession(store, cwd, 'sibling')

    const file = join(store.root, 'sessions', session.meta.id, 'meta.json')
    const meta = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...meta, schemaVersion: 2 }), 'utf8')

    expect(() => store.load(session.meta.id)).toThrow(SessionTooNewError)
    try {
      store.load(session.meta.id)
    } catch (error) {
      expect((error as SessionTooNewError).schemaVersion).toBe(2)
      expect((error as Error).name).toBe('SessionTooNewError')
    }
    // Listing skips it rather than inventing a v1 subset.
    expect(store.list().map((entry) => entry.id)).toEqual([sibling.meta.id])
  })

  test('rejects ids that would escape the sessions directory', () => {
    const cwd = tempDir()
    const store = open(cwd)
    for (const id of ['../../etc/passwd', '..', 's_bad/id', '', 's_short', 'x_20260101T000000-abcdef']) {
      expect(() => store.load(id)).toThrow(/invalid session id/)
    }
    expect(() => store.setMeta('../escape', { name: 'x' })).toThrow(/invalid session id/)
    expect(() => store.remove('../../tmp')).toThrow(/invalid session id/)
    expect(() => store.setCurrent('sessions/../..')).toThrow(/invalid session id/)
  })

  test('meta.json is never left half-written', () => {
    const cwd = tempDir()
    const store = open(cwd)
    const session = newSession(store, cwd)
    store.appendTurn(session.meta.id, [user('one'), assistant('1')])
    store.setMeta(session.meta.id, { contextWindow: 4096, archived: false })

    const dir = join(store.root, 'sessions', session.meta.id)
    const raw = readFileSync(join(dir, 'meta.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['contextWindow']).toBe(4096)
    expect(parsed['schemaVersion']).toBe(1)
    expect(parsed['id']).toBe(session.meta.id)
    // No temp files and no partial JSON survive a write.
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])

    store.setMeta(session.meta.id, { updatedAt: 42 })
    expect((JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { updatedAt: number }).updatedAt).toBe(
      42,
    )
    // Updated by default when the patch does not say.
    store.setMeta(session.meta.id, { name: 'bumped' })
    const bumped = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { updatedAt: number }
    expect(bumped.updatedAt).toBeGreaterThan(42)
  })

  test('the root carries its own gitignore and marker, with private modes', () => {
    const cwd = tempDir()
    const store = open(cwd)
    expect(readFileSync(join(store.root, '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n')
    expect(readFileSync(join(store.root, '.z1-sessions'), 'utf8')).toBe('schemaVersion=1\n')

    const session = newSession(store, cwd)
    store.appendTurn(session.meta.id, [user('secret')])
    const mode = (path: string): number => statSync(path).mode & 0o777
    expect(mode(join(store.root, 'sessions', session.meta.id))).toBe(0o700)
    expect(mode(store.root)).toBe(0o700)
    expect(mode(join(store.root, 'sessions', session.meta.id, 'meta.json'))).toBe(0o600)
    expect(mode(join(store.root, 'sessions', session.meta.id, 'events.jsonl'))).toBe(0o600)
  })
})

describe('root resolution', () => {
  test('Z1_SESSIONS_DIR overrides and expands ~', () => {
    const cwd = tempDir()
    const custom = join(cwd, 'custom-root')
    const resolved = resolveSessionRoot({ cwd, env: { Z1_SESSIONS_DIR: custom } })
    expect(resolved.mode).toBe('override')
    expect(resolved.root).toBe(custom)
    expect(existsSync(join(custom, '.z1-sessions'))).toBe(true)

    const home = tempDir('z1-home-')
    const tilde = resolveSessionRoot({ cwd, env: { Z1_SESSIONS_DIR: '~/sessions', HOME: home } })
    expect(tilde.root).toBe(join(home, 'sessions'))
    expect(tilde.mode).toBe('override')
    expect(resolveSessionRoot({ cwd, env: {} }).mode).toBe('project')
  })

  test('a repository uses <repo>/z1 and excludes it from git', () => {
    const repo = tempDir('z1-repo-')
    mkdirSync(join(repo, '.git', 'info'), { recursive: true })
    const nested = join(repo, 'src', 'deep')
    mkdirSync(nested, { recursive: true })

    const resolved = resolveSessionRoot({ cwd: nested, env: {} })
    expect(resolved.mode).toBe('project')
    expect(resolved.repoRoot).toBe(repo)
    expect(resolved.root).toBe(join(repo, 'z1'))
    expect(existsSync(join(repo, 'z1', 'sessions'))).toBe(true)

    // A plain `.git` dir is not a working git repo, so no exclude entry is
    // expected here; nothing may throw either.
    expect(existsSync(join(repo, '.git', 'info', 'exclude'))).toBe(false)

    // A worktree keeps `.git` as a file; it is still the repo root.
    const worktree = tempDir('z1-worktree-')
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n', 'utf8')
    expect(resolveSessionRoot({ cwd: worktree, env: {} }).mode).toBe('project')
    expect(resolveSessionRoot({ cwd: worktree, env: {} }).root).toBe(join(worktree, 'z1'))
  })

  test('a real repository gets z1/ in .git/info/exclude', () => {
    const repo = tempDir('z1-git-')
    execFileSync('git', ['init', '--quiet', repo], { stdio: 'ignore' })
    const resolved = resolveSessionRoot({ cwd: repo, env: {} })
    expect(resolved.mode).toBe('project')
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/z1/')

    // Idempotent: resolving again does not duplicate the pattern.
    resolveSessionRoot({ cwd: repo, env: {} })
    const lines = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
      .split('\n')
      .filter((line) => line === '/z1/')
    expect(lines).toHaveLength(1)
  })

  test('an in-repo override is excluded from git too', () => {
    const repo = tempDir('z1-git-override-')
    execFileSync('git', ['init', '--quiet', repo], { stdio: 'ignore' })
    const custom = join(repo, 'sessions-custom')
    const resolved = resolveSessionRoot({ cwd: repo, env: { Z1_SESSIONS_DIR: custom } })
    expect(resolved.mode).toBe('override')
    expect(existsSync(join(custom, 'sessions'))).toBe(true)
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/sessions-custom/',
    )
  })

  test('a pre-existing non-session z1/ falls back outside the project', () => {
    const repo = tempDir('z1-collision-')
    const home = tempDir('z1-home-')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'z1', 'packages'), { recursive: true })
    writeFileSync(join(repo, 'z1', 'package.json'), '{"name":"z1-workspace"}', 'utf8')

    const resolved = resolveSessionRoot({ cwd: repo, env: { HOME: home } })
    const key = `${repo.split('/').pop() ?? ''}-${createHash('sha1').update(resolve(repo)).digest('hex').slice(0, 8)}`
    expect(resolved.mode).toBe('fallback')
    expect(resolved.root).toBe(join(home, '.local', 'share', 'z1', 'projects', key, 'z1'))
    expect(existsSync(join(resolved.root, '.z1-sessions'))).toBe(true)
    expect(existsSync(join(resolved.root, 'sessions'))).toBe(true)
    // The source tree is untouched.
    expect(readdirSync(join(repo, 'z1')).sort()).toEqual(['package.json', 'packages'])

    // A file squatting on the name is the same story.
    const other = tempDir('z1-file-')
    mkdirSync(join(other, '.git'), { recursive: true })
    writeFileSync(join(other, 'z1'), 'not a directory', 'utf8')
    const fallback = resolveSessionRoot({ cwd: other, env: { HOME: home } })
    expect(fallback.mode).toBe('fallback')
    expect(fallback.root.startsWith(join(home, '.local', 'share', 'z1', 'projects'))).toBe(true)
  })

  test('an existing session root is reused, not re-created', () => {
    const cwd = tempDir()
    const first = open(cwd)
    const session = newSession(first, cwd)
    const second = open(cwd)
    expect(second.root).toBe(first.root)
    expect(second.list().map((entry) => entry.id)).toEqual([session.meta.id])
    expect(readdirSync(join(cwd, 'z1', 'sessions'))).toHaveLength(1)
  })

  test('the store recreates a deleted root', () => {
    const cwd = tempDir()
    const store = open(cwd)
    rmSync(store.root, { recursive: true, force: true })
    const session = newSession(store, cwd)
    expect(existsSync(join(store.root, 'sessions', session.meta.id, 'meta.json'))).toBe(true)
  })
})
