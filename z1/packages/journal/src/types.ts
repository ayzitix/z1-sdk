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
