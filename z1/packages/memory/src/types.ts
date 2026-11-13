import type { RunRecord } from '@z1/journal'
import type { Json, MemoryEnvelope, MemoryService } from '@z1/node'
import type { RunEvent } from '@z1/runtime'

/**
 * The slice of a journal memory needs: run records for the tree, plus the
 * events of one run for its completed steps. `SqliteJournal` satisfies it.
 */
export interface MemoryJournal {
  read(runId: string): readonly RunEvent[]
  getRun(runId: string): RunRecord | undefined
  listRuns(): readonly RunRecord[]
}

export interface BranchMemoryOptions {
  /** Hard cap on the rendered envelope text. Defaults to 4000. */
  budgetChars?: number
  /** How many recent steps of the current run to include. Defaults to 8. */
  recentNodes?: number
}

/** One completed step: the journaled node id, its path and its outputs. */
export interface MemoryNode {
  path: string
  /**
   * The node id recorded on `node.completed`. The event carries no definition
   * type, so the id is the only stable label available to a reader.
   */
  type: string
  outputs: Record<string, Json>
  at: number
}

export interface MemorySummary {
  text: string
  sources: string[]
}

export type { MemoryEnvelope, MemoryService }
