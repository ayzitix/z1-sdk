import type { RunEvent } from '@z1/runtime'

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'suspended'

export interface RunRecord {
  runId: string
  graphId: string
  graphDigest: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  parentRunId?: string
  forkSeq?: number
}

/** An event with the sequence number it was stored under for its own run. */
export interface SequencedEvent {
  seq: number
  event: RunEvent
}

/**
 * The journal surface read-only commands need. `read` replays the fork chain;
 * `ownedEvents` is the run's own rows only, which is what a fork point or a
 * per-run listing must use.
 */
export interface RunJournal {
  read(runId: string): readonly RunEvent[]
  ownedEvents(runId: string): readonly SequencedEvent[]
  getRun(runId: string): RunRecord | undefined
  listRuns(): readonly RunRecord[]
  fork(sourceRunId: string, atSeq: number, newRunId: string): RunRecord
  updateRun(runId: string, patch: Partial<Pick<RunRecord, 'status' | 'updatedAt'>>): void
}

export interface BlobRecord {
  hash: string
  mime: string
  bytes: Uint8Array
}

const RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'completed',
  'failed',
  'cancelled',
  'suspended',
]

/** Narrows a status stored as text; unknown values mean the file is corrupt. */
export function parseRunStatus(value: string): RunStatus {
  for (const status of RUN_STATUSES) {
    if (status === value) return status
  }
  throw new Error(`journal: unknown run status ${JSON.stringify(value)}`)
}
