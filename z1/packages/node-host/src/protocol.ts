import type { DeclaredPort } from '@z1/module'

/**
 * Wire protocol between {@link ModuleWorker} and its child bootstrap.
 *
 * Messages are plain structured-clone values: an object with a discriminant
 * `t`, never a newline-delimited frame. Both sides treat everything they
 * receive as untrusted data and validate it with guards before use.
 */

export type WorkerLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Exported node descriptor reported in the `ready` handshake. */
export interface WorkerNodeInfo {
  id: string
  version: string
  title: string
  category: string
  inputs: DeclaredPort[]
  outputs: DeclaredPort[]
}

/** Exported service descriptor reported in the `ready` handshake. */
export interface WorkerServiceInfo {
  id: string
}

/** One directory entry returned by the brokered `fs.list`. */
export interface FsListEntry {
  name: string
  /** Absolute path of the entry (`dir + "/" + name`). */
  path: string
  /** Directory entries report `symlink` without following the link. */
  type: 'file' | 'dir' | 'symlink'
  /** Byte size of a regular file; absent for directories and symlinks. */
  size?: number
}

/** Result of the brokered `fs.list` (single level, no recursion). */
export interface FsListResult {
  /** Absolute path of the listed directory. */
  path: string
  entries: FsListEntry[]
}

/** Request accepted by the brokered `process.run` (never a shell string). */
export interface ProcessRunRequest {
  command: string
  args?: string[]
  /** Must be inside the granted `fs.read` patterns; defaults to the module dir. */
  cwd?: string
  /** Defaults to 30_000 ms, clamped to 300_000 ms. */
  timeoutMs?: number
  /** Shared stdout+stderr cap; defaults to 1 MiB, clamped to 5 MiB. */
  maxOutputBytes?: number
  /** Added to the minimal `{ PATH }` environment. */
  env?: Record<string, string>
}

/** Outcome of the brokered `process.run`. */
export interface ProcessRunResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** True when stdout+stderr hit `maxOutputBytes` and the child was killed. */
  truncated: boolean
  durationMs: number
}

export type WorkerToHost =
  | { t: 'ready'; nodes: WorkerNodeInfo[]; services: WorkerServiceInfo[] }
  | { t: 'fatal'; message: string }
  | {
      t: 'log'
      id: number
      nodeId: string
      level: WorkerLogLevel
      message: string
      data?: unknown
    }
  | { t: 'stream'; id: number; nodeId: string; port: string; chunk: unknown }
  | { t: 'call'; id: number; callId: number; method: string; args: unknown }
  | { t: 'delta'; callId: number; delta: unknown }
  | { t: 'result'; id: number; outputs: unknown }
  | { t: 'error'; id: number; message: string; stack?: string }
  | { t: 'service-result'; id: number; value: unknown }
  | { t: 'service-error'; id: number; message: string; stack?: string }
  | { t: 'service-delta'; id: number; delta: unknown }
  | { t: 'disposed' }

export type HostToWorker =
  | {
      t: 'execute'
      id: number
      nodeId: string
      config: unknown
      inputs: Record<string, unknown>
      seed: unknown
    }
  | { t: 'cancel'; reason: string }
  | { t: 'delta'; callId: number; delta: unknown }
  | { t: 'call-result'; callId: number; ok: true; value: unknown }
  | { t: 'call-result'; callId: number; ok: false; error: string }
  | {
      t: 'service-call'
      id: number
      serviceId: string
      method: string
      args: unknown
      /** Run-scoped identity for approvals and cancellation. */
      context: { runId: string }
    }
  | { t: 'service-cancel'; id: number }
  /** Ask the child to dispose its service instances before it is killed. */
  | { t: 'dispose' }
