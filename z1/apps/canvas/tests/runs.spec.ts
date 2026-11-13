import type { RunListResult, SequencedEvent } from '@z1/protocol'
import { describe, expect, it } from 'vitest'

import {
  buildRunTree,
  formatDuration,
  nodeRunFor,
  outputsFromEvents,
  runParentLabel,
  shortRunId,
  type NodeRunState,
} from '../src/runs.ts'

function record(
  runId: string,
  createdAt: number,
  parentRunId?: string,
  forkSeq?: number,
): RunListResult[number] {
  const base: RunListResult[number] = {
    runId,
    graphId: 'g',
    graphDigest: 'd',
    status: 'completed',
    createdAt,
    updatedAt: createdAt,
  }
  if (parentRunId === undefined) return base
  return forkSeq === undefined ? { ...base, parentRunId } : { ...base, parentRunId, forkSeq }
}

describe('buildRunTree', () => {
  const runs: RunListResult = [
    record('run_root', 100),
    record('run_sibling', 150),
    record('run_child', 200, 'run_root', 3),
    record('run_grandchild', 300, 'run_child', 1),
    record('run_orphan', 400, 'run_missing', 9),
  ]

  it('orders roots newest first and children after their parent', () => {
    const rows = buildRunTree(runs)
    expect(rows.map((row) => [row.record.runId, row.depth])).toEqual([
      ['run_orphan', 0],
      ['run_sibling', 0],
      ['run_root', 0],
      ['run_child', 1],
      ['run_grandchild', 2],
    ])
  })

  it('labels a fork with its parent and fork sequence', () => {
    const rows = buildRunTree(runs)
    expect(rows.find((row) => row.record.runId === 'run_child')?.parentLabel).toBe('run_root@3')
    expect(rows.find((row) => row.record.runId === 'run_grandchild')?.parentLabel).toBe(
      'run_child@1',
    )
    expect(rows.find((row) => row.record.runId === 'run_root')?.parentLabel).toBeNull()
    expect(rows.find((row) => row.record.runId === 'run_orphan')?.parentLabel).toBe(
      'run_missing@9',
    )
  })

  it('keeps siblings in fork order and never drops a cycle member', () => {
    const cyclic: RunListResult = [
      record('run_a', 1, 'run_b', 1),
      record('run_b', 2, 'run_a', 1),
    ]
    const rows = buildRunTree(cyclic)
    expect(rows.map((row) => row.record.runId).sort()).toEqual(['run_a', 'run_b'])
  })
})

describe('nodeRunFor', () => {
  const nodeRun: Record<string, NodeRunState> = {
    'chat': { status: 'completed', durationMs: 10 },
    'loop/0/chat': { status: 'completed', durationMs: 20 },
    'loop/1/chat': { status: 'running' },
    'other': { status: 'failed', error: 'x' },
  }

  it('prefers an exact path', () => {
    expect(nodeRunFor(nodeRun, 'chat')?.durationMs).toBe(10)
    expect(nodeRunFor(nodeRun, 'other')?.error).toBe('x')
  })

  it('returns the last nested entry for a parent node', () => {
    expect(nodeRunFor(nodeRun, 'loop')?.status).toBe('running')
    expect(nodeRunFor(nodeRun, 'missing')).toBeNull()
  })
})

describe('format helpers', () => {
  it('formats milliseconds and seconds', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(999)).toBe('999 ms')
    expect(formatDuration(1200)).toBe('1.2 s')
  })

  it('shortens ids that do not fit a row', () => {
    expect(shortRunId('run_short')).toBe('run_short')
    expect(shortRunId('run_0123456789abcdef')).toBe('run_0123456…')
  })

  it('takes outputs from the last run.completed event', () => {
    const events: SequencedEvent[] = [
      {
        seq: 1,
        event: { type: 'run.completed', runId: 'r', outputs: { text: 'first' }, at: 1 },
      },
      { seq: 2, event: { type: 'run.failed', runId: 'r', error: 'x', at: 2 } },
      {
        seq: 3,
        event: { type: 'run.completed', runId: 'r', outputs: { text: 'last' }, at: 3 },
      },
    ]
    expect(outputsFromEvents(events)).toEqual({ text: 'last' })
    expect(outputsFromEvents([])).toEqual({})
  })

  it('labels a parent without a fork sequence as unknown', () => {
    expect(runParentLabel(record('run_x', 1, 'run_parent'))).toBe('run_parent@?')
  })
})
