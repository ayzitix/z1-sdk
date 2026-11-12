import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'

import type { RunEvent } from '@z1/runtime'

import { SqliteJournal, type RunRecord } from '../src/index.ts'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'z1-journal-'))
  created.push(dir)
  return dir
}

function run(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    graphId: 'graph.a',
    graphDigest: 'digest.a',
    status: 'running',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function started(runId: string, at: number): RunEvent {
  return { type: 'run.started', runId, graphId: 'graph.a', at }
}

function node(runId: string, n: number): RunEvent {
  return { type: 'node.completed', runId, nodeId: `n${n}`, path: '', attempt: 1, durationMs: 1, at: n }
}

function seqOf(events: readonly RunEvent[], predicate: (event: RunEvent) => boolean): number[] {
  return events.filter(predicate).map((event) => ('at' in event ? event.at : -1))
}

test('create, get and list newest first', () => {
  const journal = new SqliteJournal(':memory:')
  journal.createRun(run('r1', { createdAt: 1, updatedAt: 1 }))
  journal.createRun(run('r2', { createdAt: 3, updatedAt: 3 }))
  journal.createRun(run('r3', { createdAt: 2, updatedAt: 2 }))

  expect(journal.getRun('r1')).toEqual(run('r1', { createdAt: 1, updatedAt: 1 }))
  expect(journal.getRun('missing')).toBeUndefined()
  expect(journal.listRuns().map((record) => record.runId)).toEqual(['r2', 'r3', 'r1'])
  journal.close()
})

test('append numbers events per run and read returns them in order', () => {
  const journal = new SqliteJournal(':memory:')
  journal.createRun(run('r1'))
  const events: RunEvent[] = [started('r1', 10), node('r1', 11), node('r1', 12)]
  for (const event of events) journal.append(event)

  expect(journal.read('r1')).toEqual(events)
  expect(journal.getRun('r1')?.updatedAt).toBeGreaterThanOrEqual(1_000)
  // Empty or unknown runs read as an empty list rather than throwing.
  expect(journal.read('nobody')).toEqual([])
  journal.close()
})

test('events survive close and reopen', () => {
  const file = join(tempDir(), 'nested', 'deep', 'runs.db')
  const first = new SqliteJournal(file)
  first.createRun(run('r1'))
  first.append(started('r1', 1))
  first.append(node('r1', 2))
  first.close()
  // Idempotent close: the second call must not throw.
  first.close()

  const second = new SqliteJournal(file)
  expect(second.getRun('r1')?.status).toBe('running')
  expect(seqOf(second.read('r1'), () => true)).toEqual([1, 2])
  second.append(node('r1', 3))
  expect(second.read('r1')).toHaveLength(3)
  second.close()
})

test('two runs keep independent sequences', () => {
  const journal = new SqliteJournal(':memory:')
  journal.createRun(run('a'))
  journal.createRun(run('b'))
  journal.append(node('a', 1))
  journal.append(node('b', 1))
  journal.append(node('a', 2))

  expect(seqOf(journal.read('a'), () => true)).toEqual([1, 2])
  expect(seqOf(journal.read('b'), () => true)).toEqual([1])
  journal.close()
})

test('fork replays the parent prefix, including nested forks', () => {
  const journal = new SqliteJournal(':memory:')
  journal.createRun(run('parent'))
  for (let n = 1; n <= 5; n += 1) journal.append(node('parent', n))

  const child = journal.fork('parent', 3, 'child')
  expect(child.parentRunId).toBe('parent')
  expect(child.forkSeq).toBe(3)
  expect(child.status).toBe('running')
  expect(child.graphId).toBe('graph.a')
  expect(child.graphDigest).toBe('digest.a')

  journal.append(node('child', 100))
  expect(seqOf(journal.read('child'), () => true)).toEqual([1, 2, 3, 100])
  // The source run is untouched by the fork.
  expect(seqOf(journal.read('parent'), () => true)).toEqual([1, 2, 3, 4, 5])

  const grandchild = journal.fork('child', 1, 'grandchild')
  expect(grandchild.parentRunId).toBe('child')
  journal.append(node('grandchild', 200))
  expect(seqOf(journal.read('grandchild'), () => true)).toEqual([1, 2, 3, 100, 200])

  expect(() => journal.fork('missing', 1, 'x')).toThrow(/unknown run/)
  expect(() => journal.fork('parent', -1, 'x')).toThrow(/non-negative/)
  expect(() => journal.fork('parent', 1, 'child')).toThrow(/already exists/)
  journal.close()
})

test('a corrupt parent cycle is refused instead of looping', () => {
  const journal = new SqliteJournal(':memory:')
  journal.createRun(run('a', { parentRunId: 'b', forkSeq: 1 }))
  journal.createRun(run('b', { parentRunId: 'a', forkSeq: 1 }))
  expect(() => journal.read('a')).toThrow(/cycle/)
  journal.close()
})

test('blobs roundtrip, are idempotent and unknown hashes are undefined', () => {
  const journal = new SqliteJournal(':memory:')
  const bytes = new Uint8Array([1, 2, 3, 250])
  const hash = journal.putBlob(bytes, 'application/octet-stream')

  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  expect(journal.putBlob(bytes, 'text/plain')).toBe(hash)
  const stored = journal.getBlob(hash)
  expect(stored?.mime).toBe('application/octet-stream')
  expect(Array.from(stored?.bytes ?? [])).toEqual([1, 2, 3, 250])
  expect(stored?.hash).toBe(hash)
  expect(journal.getBlob('00'.repeat(32))).toBeUndefined()
  journal.close()
})

test('updateRun patches status and timestamp; duplicate create throws', () => {
  const journal = new SqliteJournal(':memory:')
  journal.createRun(run('r1'))
  journal.updateRun('r1', { status: 'completed', updatedAt: 2_000 })

  const updated = journal.getRun('r1')
  expect(updated?.status).toBe('completed')
  expect(updated?.updatedAt).toBe(2_000)
  expect(updated?.createdAt).toBe(1_000)

  expect(() => journal.createRun(run('r1'))).toThrow(/already exists/)
  expect(() => journal.updateRun('missing', { status: 'failed' })).toThrow(/unknown run/)
  journal.close()
})

test('unusable database paths fail with a clear message', () => {
  const dir = tempDir()
  const file = join(dir, 'blocker')
  writeFileSync(file, 'not a directory')
  expect(() => new SqliteJournal(join(file, 'runs.db'))).toThrow(/journal: cannot open database/)
})

test('close is idempotent and further use is reported', () => {
  const journal = new SqliteJournal(':memory:')
  journal.createRun(run('r1'))
  journal.close()
  expect(() => journal.close()).not.toThrow()
  expect(() => journal.getRun('r1')).toThrow(/closed/)
})
