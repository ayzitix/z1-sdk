import type { RunRecord } from '@z1/journal'
import type { RunEvent } from '@z1/runtime'
import type { MemoryContextRequest, MemoryEnvelope, MemoryService } from '@z1/node'

import type {
  BranchMemoryOptions,
  MemoryJournal,
  MemoryNode,
  MemorySummary,
} from './types.ts'

/** A fork chain deeper than this is corrupted data, not a real tree. */
const MAX_ANCESTRY = 64

/** JSON outputs past this length are elided in the rendered envelope. */
const OUTPUT_SNIPPET = 200

const DEFAULT_BUDGET_CHARS = 4000
const DEFAULT_RECENT_NODES = 8
const ANCESTOR_NODES = 3

type Section = 'ancestors' | 'siblings' | 'recent' | 'summaries'

interface Entry {
  section: Section
  line: string
}

const SECTION_ORDER: readonly { section: Section; title: string }[] = [
  { section: 'ancestors', title: 'Ancestors' },
  { section: 'siblings', title: 'Sibling branches' },
  { section: 'recent', title: 'Recent steps' },
  { section: 'summaries', title: 'Summaries' },
]

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function snippet(outputs: Record<string, unknown>): string {
  return truncate(JSON.stringify(outputs), OUTPUT_SNIPPET)
}

/** Fold completed steps into one entry per path, last execution winning. */
function collect(events: readonly RunEvent[]): MemoryNode[] {
  const latest = new Map<string, MemoryNode>()
  for (const event of events) {
    if (event.type !== 'node.completed') continue
    // Delete first so re-entry moves the path to the end of the iteration
    // order: a loop body repeats paths, and only its last execution counts.
    latest.delete(event.path)
    latest.set(event.path, {
      path: event.path,
      type: event.nodeId,
      outputs: event.outputs,
      at: event.at,
    })
  }
  return [...latest.values()]
}

function render(entries: readonly Entry[]): string {
  const parts: string[] = []
  for (const { section, title } of SECTION_ORDER) {
    const lines = entries
      .filter((entry) => entry.section === section)
      .map((entry) => `- ${entry.line}`)
    if (lines.length === 0) continue
    parts.push(`## ${title}\n${lines.join('\n')}`)
  }
  return parts.join('\n\n')
}

/**
 * Memory assembled from the persistent run tree: the ancestor spine, the
 * sibling branches forked from the same parent, and this run's recent steps.
 *
 * Summaries written through `writeSummary` live only in this instance, keyed by
 * run id. They are deliberately not persisted: a summary is derived context, and
 * the journal stays the single source of truth for what a run actually did.
 */
export class BranchMemory implements MemoryService {
  readonly #journal: MemoryJournal
  readonly #budgetChars: number
  readonly #recentNodes: number
  readonly #summaries = new Map<string, MemorySummary[]>()

  constructor(journal: MemoryJournal, options: BranchMemoryOptions = {}) {
    this.#journal = journal
    this.#budgetChars = options.budgetChars ?? DEFAULT_BUDGET_CHARS
    this.#recentNodes = options.recentNodes ?? DEFAULT_RECENT_NODES
  }

  /** Root first; `[]` when the run is unknown. A cycle stops the walk. */
  ancestry(runId: string): RunRecord[] {
    const chain: RunRecord[] = []
    const seen = new Set<string>()
    let cursor = this.#journal.getRun(runId)
    while (cursor !== undefined) {
      if (seen.has(cursor.runId) || chain.length >= MAX_ANCESTRY) break
      seen.add(cursor.runId)
      chain.unshift(cursor)
      const parent = cursor.parentRunId
      cursor = parent === undefined ? undefined : this.#journal.getRun(parent)
    }
    return chain
  }

  /** Other children of the same parent; empty for a root or an unknown run. */
  siblings(runId: string): RunRecord[] {
    const run = this.#journal.getRun(runId)
    if (run === undefined || run.parentRunId === undefined) return []
    const parentRunId = run.parentRunId
    return this.#journal
      .listRuns()
      .filter((record) => record.runId !== runId && record.parentRunId === parentRunId)
  }

  /** Completed steps of the run's lineage, deduped by path (last wins). */
  nodes(runId: string): MemoryNode[] {
    return collect(this.#journal.read(runId))
  }

  /**
   * Completed steps of this run only, with inherited ancestor steps excluded.
   *
   * Context assembly already lists ancestors separately, so using the merged
   * `nodes()` here would repeat every ancestor step in "recent" and spend the
   * budget twice.
   */
  ownNodes(runId: string): MemoryNode[] {
    const owned = this.#journal.ownedEvents?.(runId)
    if (owned === undefined) return collect(this.#journal.read(runId))
    return collect(owned.map((entry) => entry.event))
  }

  recent(runId: string, limit = this.#recentNodes): MemoryNode[] {
    if (limit <= 0) return []
    return this.ownNodes(runId).slice(-limit)
  }

  async buildContext(request: MemoryContextRequest): Promise<MemoryEnvelope> {
    const budget = Math.max(0, request.budgetChars ?? this.#budgetChars)
    const recentLimit = Math.max(0, request.recentNodes ?? this.#recentNodes)
    const run = this.#journal.getRun(request.runId)
    if (run === undefined) {
      return { text: '', messages: [], spine: [], siblings: [], recent: [] }
    }

    const ancestors = this.ancestry(run.runId).slice(0, -1)
    const spine = ancestors.map((ancestor) => {
      const steps = this.ownNodes(ancestor.runId).slice(-ANCESTOR_NODES)
      return steps
        .map((step) => `${ancestor.runId} ${step.type} ${step.path}: ${snippet(step.outputs)}`)
        .join('\n')
    })
    const siblings = this.siblings(run.runId).map(
      (sibling) =>
        `↳ ${sibling.runId} (forked at ${String(sibling.forkSeq ?? 0)}, ${sibling.status}): ${
          this.ownNodes(sibling.runId).length
        } nodes`,
    )
    const recent = this.recent(run.runId, recentLimit).map((step) => ({
      path: step.path,
      type: step.type,
      summary: snippet(step.outputs),
    }))

    const entries: Entry[] = [
      ...spine.flatMap((block) =>
        block.split('\n').map((line): Entry => ({ section: 'ancestors', line })),
      ),
      ...siblings.map((line): Entry => ({ section: 'siblings', line })),
      ...recent.map((step): Entry => ({
        section: 'recent',
        line: `${step.type} ${step.path}: ${step.summary}`,
      })),
      ...(this.#summaries.get(run.runId) ?? []).map((summary): Entry => ({
        section: 'summaries',
        line: summary.sources.length === 0 ? summary.text : `${summary.text} (${summary.sources.join(', ')})`,
      })),
    ]

    // Oldest first, so dropping from the front keeps the freshest context.
    let text = render(entries)
    while (text.length > budget && entries.length > 0) {
      entries.shift()
      text = render(entries)
    }
    if (text.length > budget) text = ''

    return {
      text,
      messages:
        text === ''
          ? []
          : [{ role: 'system', content: `Context from the branch tree:\n${text}` }],
      spine,
      siblings,
      recent,
    }
  }

  async writeSummary(input: {
    runId: string
    path?: string
    text: string
    sources?: string[]
  }): Promise<void> {
    const list = this.#summaries.get(input.runId)
    const summary: MemorySummary = { text: input.text, sources: input.sources ?? [] }
    if (list === undefined) this.#summaries.set(input.runId, [summary])
    else list.push(summary)
  }

  summaries(runId: string): MemorySummary[] {
    return [...(this.#summaries.get(runId) ?? [])]
  }
}
