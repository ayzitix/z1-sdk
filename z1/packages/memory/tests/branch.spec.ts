import { describe, expect, test } from 'vitest'
import { SqliteJournal, type RunRecord } from '@z1/journal'
import type { Json } from '@z1/node'
import type { RunEvent } from '@z1/runtime'
import { BranchMemory } from '../src/index.ts'

function runRecord(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    graphId: 'g',
    graphDigest: 'd',
    status: 'completed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function completed(
  runId: string,
  path: string,
  outputs: Record<string, Json>,
  at = 1,
): RunEvent {
  return {
    type: 'node.completed',
    runId,
    nodeId: path.split('/').pop() ?? path,
    path,
    attempt: 1,
    durationMs: 1,
    at,
    outputs,
  }
}

/** Root with two completed steps, then two branches forked from it. */
function tree(): { journal: SqliteJournal; memory: BranchMemory } {
  const journal = new SqliteJournal(':memory:')
  journal.createRun(runRecord('root'))
  journal.append(completed('root', 'plan', { text: 'make a plan' }, 2))
  journal.append(completed('root', 'chat', { text: 'root answer' }, 3))
  journal.fork('root', 2, 'childA')
  journal.fork('root', 2, 'childB')
  return { journal, memory: new BranchMemory(journal) }
}

describe('BranchMemory ancestry and siblings', () => {
  test('walks root first and lists only the other children of the same parent', () => {
    const { memory } = tree()

    expect(memory.ancestry('childA').map((record) => record.runId)).toEqual(['root', 'childA'])
    expect(memory.ancestry('root').map((record) => record.runId)).toEqual(['root'])
    expect(memory.siblings('childA').map((record) => record.runId)).toEqual(['childB'])
    expect(memory.siblings('childB').map((record) => record.runId)).toEqual(['childA'])
    expect(memory.siblings('root')).toEqual([])
    expect(memory.ancestry('missing')).toEqual([])
  })

  test('stops on a parent cycle instead of looping forever', () => {
    const journal = new SqliteJournal(':memory:')
    journal.createRun(runRecord('a', { parentRunId: 'b' }))
    journal.createRun(runRecord('b', { parentRunId: 'a' }))
    const memory = new BranchMemory(journal)

    expect(memory.ancestry('a').map((record) => record.runId)).toEqual(['b', 'a'])
  })
})

describe('BranchMemory nodes', () => {
  test('dedupes repeated paths, last execution wins, and honors the limit', () => {
    const journal = new SqliteJournal(':memory:')
    journal.createRun(runRecord('run'))
    // A resumed run re-executes the same path: only the last execution counts.
    journal.append(completed('run', 'loop/1/chat', { n: 1 }, 2))
    journal.append(completed('run', 'loop/1/chat', { n: 2 }, 3))
    journal.append(completed('run', 'loop/1/chat', { n: 3 }, 4))
    const memory = new BranchMemory(journal)

    const nodes = memory.nodes('run')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ path: 'loop/1/chat', type: 'chat', outputs: { n: 3 } })

    journal.append(completed('run', 'done', { text: 'finish' }, 5))
    const after = new BranchMemory(journal)
    expect(after.recent('run', 1).map((node) => node.path)).toEqual(['done'])
    expect(after.recent('run').map((node) => node.path)).toEqual(['loop/1/chat', 'done'])
  })

  test('recent keeps one entry per loop iteration path', () => {
    const journal = new SqliteJournal(':memory:')
    journal.createRun(runRecord('run'))
    // Labeled subgraph paths are unique per iteration, so every iteration stays
    // visible in the recent context instead of collapsing onto one entry.
    journal.append(completed('run', 'loop/0/chat', { n: 0 }, 2))
    journal.append(completed('run', 'loop/1/chat', { n: 1 }, 3))
    journal.append(completed('run', 'loop/2/chat', { n: 2 }, 4))
    const memory = new BranchMemory(journal)

    expect(memory.recent('run').map((node) => node.path)).toEqual([
      'loop/0/chat',
      'loop/1/chat',
      'loop/2/chat',
    ])
    expect(memory.recent('run', 2).map((node) => node.path)).toEqual([
      'loop/1/chat',
      'loop/2/chat',
    ])
  })
})

describe('BranchMemory buildContext', () => {
  test('renders ancestor, sibling and recent sections with a system message', async () => {
    const { memory } = tree()

    const envelope = await memory.buildContext({ runId: 'childA' })

    expect(envelope.text).toContain('## Ancestors')
    expect(envelope.text).toContain('root')
    expect(envelope.text).toContain('root answer')
    expect(envelope.text).toContain('## Sibling branches')
    expect(envelope.text).toContain('childB')
    expect(envelope.text).toContain('## Recent steps')
    expect(envelope.messages).toHaveLength(1)
    expect(envelope.messages[0]?.role).toBe('system')
    expect(envelope.messages[0]?.content).toContain('Context from the branch tree:')
    expect(envelope.spine.length).toBeGreaterThan(0)
    expect(envelope.siblings.length).toBe(1)
  })

  test('an unknown run produces an empty envelope', async () => {
    const { memory } = tree()

    expect(await memory.buildContext({ runId: 'nope' })).toEqual({
      text: '',
      messages: [],
      spine: [],
      siblings: [],
      recent: [],
    })
  })

  test('a budget drops the oldest entries first', async () => {
    const journal = new SqliteJournal(':memory:')
    journal.createRun(runRecord('run'))
    for (let index = 1; index <= 4; index += 1) {
      journal.append(completed('run', `step${String(index)}`, { text: 'x'.repeat(40) }, index))
    }
    const memory = new BranchMemory(journal)
    const full = await memory.buildContext({ runId: 'run', budgetChars: 100_000 })
    const squeezed = await memory.buildContext({ runId: 'run', budgetChars: 220 })

    expect(full.text.length).toBeLessThan(100_000)
    expect(squeezed.text.length).toBeLessThanOrEqual(220)
    expect(squeezed.text.length).toBeLessThan(full.text.length)
    expect(squeezed.text).toContain('step4')
    expect(squeezed.text).not.toContain('step1')
    expect(squeezed.recent).toHaveLength(4)
  })

  test('summaries appear after writeSummary', async () => {
    const { memory } = tree()

    await memory.writeSummary({
      runId: 'root',
      text: 'The plan was approved.',
      sources: ['docs/plan.md'],
    })

    const envelope = await memory.buildContext({ runId: 'root' })
    expect(envelope.text).toContain('## Summaries')
    expect(envelope.text).toContain('The plan was approved.')
    expect(envelope.text).toContain('docs/plan.md')
    expect(memory.summaries('root')).toEqual([
      { text: 'The plan was approved.', sources: ['docs/plan.md'] },
    ])
  })
})
