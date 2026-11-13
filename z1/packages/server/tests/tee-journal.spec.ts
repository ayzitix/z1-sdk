import { SqliteJournal } from '@z1/journal'
import type { RunEvent } from '@z1/runtime'
import { afterEach, expect, test, vi } from 'vitest'

import { TeeJournal } from '../src/tee-journal.ts'

const journals: SqliteJournal[] = []

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
})

function makeJournal(runId: string): SqliteJournal {
  const journal = new SqliteJournal(':memory:')
  journals.push(journal)
  const now = Date.now()
  journal.createRun({
    runId,
    graphId: 'graph',
    graphDigest: 'digest',
    status: 'running',
    createdAt: now,
    updatedAt: now,
  })
  return journal
}

test('200 appends read the journal once and report contiguous seqs', () => {
  const runId = 'run_long'
  const journal = makeJournal(runId)
  const read = vi.spyOn(journal, 'read')
  const seen: number[] = []
  const tee = new TeeJournal(journal, (_runId, seq) => {
    seen.push(seq)
  })

  for (let index = 1; index <= 200; index += 1) {
    const event: RunEvent = {
      type: 'node.started',
      runId,
      nodeId: 'step',
      path: `step-${index}`,
      attempt: 1,
      at: Date.now(),
    }
    tee.append(event)
    expect(tee.nextSeq(runId)).toBe(index + 1)
  }

  // The lazy seed is the only `read`: every later seq comes from the map.
  expect(read).toHaveBeenCalledTimes(1)
  expect(seen).toEqual(Array.from({ length: 200 }, (_value, index) => index + 1))
  expect(tee.read(runId)).toHaveLength(200)
})
