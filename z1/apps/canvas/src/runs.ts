/**
 * Pure run-history helpers: per-node run state, timelines and fork ancestry.
 *
 * Paths are hierarchical (`loop/0/chat`), so the node map is keyed by the full
 * path while the canvas needs one entry per graph node: the exact id wins, else
 * the deepest/last descendant. Nothing here touches React or the network.
 *
 * @module canvas/runs
 */

import type { RunListResult, SequencedEvent } from '@z1/protocol'

import type { NodeRunStatus, RunEvent } from './graph.ts'

/** One journal row, as `run.list` returns it. */
export type RunRecord = RunListResult[number]

/** The last known state of one execution path in the current run. */
export interface NodeRunState {
  status: NodeRunStatus
  startedAt?: number
  durationMs?: number
  outputs?: Record<string, unknown>
  error?: string
  cached?: boolean
  /** Replayed from the journal rather than an in-run cache hit. */
  resumed?: boolean
  promptHash?: string
  tokens?: number
}

/** One line of the live run timeline, capped by `RUN_TIMELINE_LIMIT`. */
export interface RunTimelineEntry {
  seq: number
  type: string
  path?: string
  at: number
  durationMs?: number
}

export const RUN_TIMELINE_LIMIT = 2000

/** The node map plus the timeline entry one event produced. */
export interface NodeRunUpdate {
  nodeRun: Record<string, NodeRunState>
  timeline: RunTimelineEntry
}

export interface RunNodeState {
  nodeRun: Record<string, NodeRunState>
  timeline: RunTimelineEntry[]
}

/** Append a timeline line, keeping only the newest `RUN_TIMELINE_LIMIT`. */
export function appendTimeline(
  timeline: readonly RunTimelineEntry[],
  entry: RunTimelineEntry,
): RunTimelineEntry[] {
  return [...timeline, entry].slice(-RUN_TIMELINE_LIMIT)
}

/**
 * Fold one node event into the per-path map.
 *
 * `run.started` is handled by the caller because it clears both the map and the
 * timeline; every other event that touches a node returns an update. Events
 * that only stream or ask for approval leave the map alone (`null`).
 */
export function applyNodeEvent(
  nodeRun: Record<string, NodeRunState>,
  seq: number,
  event: RunEvent,
): NodeRunUpdate | null {
  switch (event.type) {
    case 'node.started':
      return {
        nodeRun: {
          ...nodeRun,
          [event.path]: { status: 'running', startedAt: event.at },
        },
        timeline: { seq, type: event.type, path: event.path, at: event.at },
      }
    case 'node.completed': {
      const previous = nodeRun[event.path]
      const entry: NodeRunState = {
        status: 'completed',
        durationMs: event.durationMs,
        outputs: event.outputs,
      }
      if (previous?.startedAt !== undefined) entry.startedAt = previous.startedAt
      const hash = event.outputs['hash']
      if (typeof hash === 'string') entry.promptHash = hash
      const tokens = event.outputs['tokens']
      if (typeof tokens === 'number') entry.tokens = tokens
      return {
        nodeRun: { ...nodeRun, [event.path]: entry },
        timeline: {
          seq,
          type: event.type,
          path: event.path,
          at: event.at,
          durationMs: event.durationMs,
        },
      }
    }
    case 'node.cached': {
      const entry: NodeRunState = { ...(nodeRun[event.path] ?? { status: 'cached' }) }
      entry.status = 'cached'
      entry.cached = true
      if (event.reason === 'resume') entry.resumed = true
      return {
        nodeRun: { ...nodeRun, [event.path]: entry },
        timeline: { seq, type: event.type, path: event.path, at: event.at },
      }
    }
    case 'node.failed': {
      const entry: NodeRunState = { ...(nodeRun[event.path] ?? { status: 'failed' }) }
      entry.status = 'failed'
      entry.error = event.error
      return {
        nodeRun: { ...nodeRun, [event.path]: entry },
        timeline: { seq, type: event.type, path: event.path, at: event.at },
      }
    }
    default:
      return null
  }
}

/** Rebuild the node map and timeline of a stored run from its journal. */
export function nodeRunsFromEvents(events: readonly SequencedEvent[]): RunNodeState {
  let nodeRun: Record<string, NodeRunState> = {}
  let timeline: RunTimelineEntry[] = []
  for (const entry of events) {
    if (entry.event.type === 'run.started') {
      nodeRun = {}
      timeline = []
      continue
    }
    const update = applyNodeEvent(nodeRun, entry.seq, entry.event)
    if (update === null) continue
    nodeRun = update.nodeRun
    timeline = appendTimeline(timeline, update.timeline)
  }
  return { nodeRun, timeline }
}

/**
 * The run state a graph node should show.
 *
 * An exact path always wins. Otherwise the deepest matching descendant is
 * returned, and among equal depths the last one inserted (the newest loop
 * iteration). A loop node therefore shows its latest child's state.
 */
export function nodeRunFor(
  nodeRun: Readonly<Record<string, NodeRunState>>,
  nodeId: string,
): NodeRunState | null {
  const exact = nodeRun[nodeId]
  if (exact !== undefined) return exact
  const prefix = `${nodeId}/`
  let best: NodeRunState | null = null
  let bestDepth = -1
  for (const [path, entry] of Object.entries(nodeRun)) {
    if (!path.startsWith(prefix)) continue
    const depth = path.split('/').length
    if (depth >= bestDepth) {
      best = entry
      bestDepth = depth
    }
  }
  return best
}

/** One row of the run tree: depth from the parent chain and the fork label. */
export interface RunTreeRow {
  record: RunRecord
  depth: number
  parentLabel: string | null
}

/** Short form of a run id, for a table cell that must stay one line. */
export function shortRunId(runId: string): string {
  return runId.length <= 12 ? runId : `${runId.slice(0, 11)}…`
}

/** `parent@forkSeq`, or null for a root run. */
export function runParentLabel(record: RunRecord): string | null {
  if (record.parentRunId === undefined) return null
  const seq = record.forkSeq === undefined ? '?' : String(record.forkSeq)
  return `${shortRunId(record.parentRunId)}@${seq}`
}

/**
 * Flatten the run list into parent-before-child order.
 *
 * Roots are newest first; siblings follow their fork point, then creation
 * order. A record whose parent is missing from the list (an old or pruned run)
 * is treated as a root instead of disappearing.
 */
export function buildRunTree(runs: readonly RunRecord[]): RunTreeRow[] {
  const byId = new Map<string, RunRecord>()
  for (const record of runs) byId.set(record.runId, record)
  const roots: RunRecord[] = []
  const children = new Map<string, RunRecord[]>()
  for (const record of runs) {
    const parent = record.parentRunId === undefined ? undefined : byId.get(record.parentRunId)
    if (parent === undefined) {
      roots.push(record)
      continue
    }
    const siblings = children.get(parent.runId)
    if (siblings === undefined) children.set(parent.runId, [record])
    else siblings.push(record)
  }
  roots.sort((a, b) => b.createdAt - a.createdAt)
  for (const siblings of children.values()) {
    siblings.sort((a, b) => (a.forkSeq ?? 0) - (b.forkSeq ?? 0) || a.createdAt - b.createdAt)
  }
  const rows: RunTreeRow[] = []
  const visited = new Set<string>()
  const walk = (record: RunRecord, depth: number): void => {
    if (visited.has(record.runId)) return
    visited.add(record.runId)
    rows.push({ record, depth, parentLabel: runParentLabel(record) })
    for (const child of children.get(record.runId) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  // A parent cycle never reaches a root; still show those records once.
  for (const record of runs) walk(record, 0)
  return rows
}

/** `120 ms` below one second, `1.2 s` above it. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** The last `run.completed` outputs of a stored run. */
export function outputsFromEvents(events: readonly SequencedEvent[]): Record<string, unknown> {
  let outputs: Record<string, unknown> = {}
  for (const entry of events) {
    if (entry.event.type === 'run.completed') outputs = entry.event.outputs
  }
  return outputs
}
