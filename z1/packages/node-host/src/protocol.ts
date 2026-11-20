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

/**
 * Result of the brokered `fs.stat`.
 *
 * The type is read with `lstat`, so a symlink reports `symlink` even when its
 * target is a file or a directory; `size` and `mtimeMs` then describe the link
 * itself, never the target.
 */
export interface FsStatResult {
  /** Absolute path of the inspected entry. */
  path: string
  type: 'file' | 'dir' | 'symlink'
  /** Byte size as reported by `lstat`; a directory reports the platform's own value. */
  size: number
  /** Modification time in milliseconds since the epoch. */
  mtimeMs: number
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
  /** Written to the child's stdin, which is then closed. Absent means no stdin. */
  stdin?: string
  /** Merged on top of the inherited allowlist (PATH, HOME, LANG, LC_*, TMPDIR, TZ, *_PROXY). */
  env?: Record<string, string>
}

/**
 * One run of output from a single stream.
 *
 * Segments preserve the order the process wrote in, so callers can render
 * interleaved stdout/stderr correctly instead of concatenating the streams.
 */
export interface ProcessRunOutputSegment {
  stream: 'stdout' | 'stderr'
  /** Decoded text; empty when the segment is binary. */
  text: string
  /** Bytes in the segment (after the output cap clipped the final segment). */
  bytes: number
  /** True when the segment holds NUL bytes or invalid UTF-8. */
  binary: boolean
}

/** Outcome of the brokered `process.run`. */
export interface ProcessRunResult {
  code: number | null
  signal: string | null
  /** All stdout text, in its own order (use `segments` for interleaving). */
  stdout: string
  stderr: string
  /** True when stdout+stderr hit `maxOutputBytes` (same as `outputLimit`). */
  truncated: boolean
  /** True when the tool's own timeout signalled the process group. */
  timedOut: boolean
  /** True when output exceeded the cap and the excess was discarded. */
  outputLimit: boolean
  /** Cap that applied to this run. */
  maxOutputBytes: number
  /** Output in the order it was written, one entry per contiguous stream run. */
  segments: ProcessRunOutputSegment[]
  durationMs: number
}

/**
 * Task lifecycle.
 *
 * `stopping` means a signal was sent, not that the process is dead. `exited`
 * and `killed` are only published once the child's stdout and stderr are
 * drained, so a poller that stops on them has the complete output.
 */
export type BackgroundTaskStatus = 'running' | 'stopping' | 'exited' | 'killed'

/** `process.start`: a child the host keeps running across capability calls. */
export interface BackgroundTaskStartRequest {
  command: string
  args?: string[]
  /** Must be inside the granted `fs.read` patterns; defaults to the module dir. */
  cwd?: string
  /** Merged on top of the inherited allowlist (PATH, HOME, LANG, LC_*, TMPDIR, TZ, *_PROXY). */
  env?: Record<string, string>
}

/** `process.poll`: the head of the output at `cursor`. */
export interface BackgroundTaskPollRequest {
  id: string
  /** Character offset returned by a previous call; defaults to 0. */
  cursor?: number
  /** Cap on the characters returned, keeping the head of the range. */
  limit?: number
}

export interface BackgroundTaskSnapshot {
  id: string
  pid?: number
  command: string
  args: string[]
  /** Directory the child was spawned in, when the caller asked for one. */
  cwd?: string
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  /** Last signal sent by `process.kill`; null when never killed. */
  killSignal: string | null
  startedAt: number
  endedAt: number | null
  /** Next cursor: advanced only over characters actually returned. */
  cursor: number
  /** Total characters ever written. */
  size: number
  /**
   * True while unread characters remain after `cursor`.
   *
   * A `process.kill` snapshot reports the cursor the caller was at (0, since
   * the request carries none) rather than the end of the output it returns, and
   * sets `more` whenever that output is non-empty, so nothing written before
   * the task died is skipped.
   */
  more: boolean
  /** Characters lost from the head of the output by the ring buffer. */
  droppedChars: number
  output: string
  /** True when the requested cursor predates the retained buffer. */
  truncated: boolean
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
  /**
   * Acknowledgement that a cancelled execution unwound: the node returned or
   * threw with its signal already aborted and reported nothing. The host arms
   * a kill timer on cancel; this message disarms it, so one cancelled
   * execution never becomes the whole child's death.
   */
  | { t: 'cancelled'; id: number }
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
  | { t: 'cancel'; id: number; reason: string }
  | { t: 'cancel-all'; reason: string }
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
