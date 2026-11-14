/**
 * Long-running child processes owned by the host.
 *
 * A worker cannot spawn a child (Node's permission model forbids it) and the
 * existing `process.run` capability is request/response: it waits, kills on
 * timeout and returns only at the end. A dev server needs the opposite — start
 * now, keep running, read what it printed later — so the host owns the child and
 * exposes it as a task.
 *
 * Output is a single combined stream with a byte cursor, like opencode's shell
 * service: a poll returns everything after the cursor, and a task that outgrows
 * the buffer keeps its tail and reports that the head was dropped.
 *
 * @module @z1/node-host/process-tasks
 */

import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'

import type {
  BackgroundTaskPollRequest,
  BackgroundTaskSnapshot,
  BackgroundTaskStartRequest,
  BackgroundTaskStatus,
} from './protocol.ts'

/** Retained output per task. Older bytes are dropped, never the process. */
export const DEFAULT_TASK_OUTPUT_BYTES = 256 * 1024
/** How long a killed task group may take before SIGKILL. */
const KILL_GRACE_MS = 2_000

interface TaskRecord {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  readonly child: ChildProcess
  readonly startedAt: number
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  endedAt: number | null
  buffer: string
  /** Total bytes ever written by the task. */
  written: number
  /** Bytes dropped from the front because the buffer overflowed. */
  dropped: number
  killTimer: NodeJS.Timeout | undefined
}

export class ProcessTaskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProcessTaskError'
  }
}

function randomId(): string {
  return `bg_${randomBytes(4).toString('hex')}`
}

/**
 * Start, poll and kill background tasks for one worker.
 *
 * Owned by `ModuleWorker`: a task lives as long as the worker, survives a run,
 * and dies when the worker is disposed (which `runtime.close()` does).
 */
export class ProcessTasks {
  readonly #tasks = new Map<string, TaskRecord>()
  readonly #maxBytes: number

  constructor(options: { maxOutputBytes?: number } = {}) {
    this.#maxBytes = options.maxOutputBytes ?? DEFAULT_TASK_OUTPUT_BYTES
  }

  start(request: BackgroundTaskStartRequest): BackgroundTaskSnapshot {
    if (request.command.trim().length === 0) {
      throw new ProcessTaskError('process.start requires a command')
    }
    const args = [...(request.args ?? [])]
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '' }
    for (const [key, value] of Object.entries(request.env ?? {})) env[key] = value

    const child = spawn(request.command, args, {
      cwd: request.cwd,
      env,
      shell: false,
      // Own process group: a dev server's children die with one group signal.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const record: TaskRecord = {
      id: randomId(),
      command: request.command,
      args,
      child,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      signal: null,
      endedAt: null,
      buffer: '',
      written: 0,
      dropped: 0,
      killTimer: undefined,
    }
    this.#tasks.set(record.id, record)

    const append = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (text.length === 0) return
      record.written += text.length
      record.buffer += text
      const overflow = record.buffer.length - this.#maxBytes
      if (overflow > 0) {
        record.buffer = record.buffer.slice(overflow)
        record.dropped += overflow
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => append(chunk))
    child.stderr?.on('data', (chunk: Buffer) => append(chunk))
    child.on('exit', (code, signal) => {
      record.status = record.status === 'killed' ? 'killed' : 'exited'
      record.exitCode = code
      record.signal = signal
      record.endedAt = Date.now()
      if (record.killTimer !== undefined) {
        clearTimeout(record.killTimer)
        record.killTimer = undefined
      }
    })
    child.on('error', (error) => {
      // A spawn failure (ENOENT) never emits `exit`; surface it as an exit.
      append(Buffer.from(`${error.message}\n`))
      record.status = 'exited'
      record.exitCode = 127
      record.endedAt = Date.now()
    })

    return this.#snapshot(record, 0)
  }

  poll(request: BackgroundTaskPollRequest): BackgroundTaskSnapshot {
    const record = this.#require(request.id)
    const requested = Math.max(0, Math.floor(request.cursor ?? 0))
    return this.#snapshot(record, requested, request.limit)
  }

  kill(request: { id: string; signal?: NodeJS.Signals }): BackgroundTaskSnapshot {
    const record = this.#require(request.id)
    if (record.status === 'running') {
      record.status = 'killed'
      this.#signal(record, request.signal ?? 'SIGTERM')
      // A process that ignores SIGTERM must not outlive the session.
      record.killTimer = setTimeout(() => {
        if (record.status === 'killed' && record.endedAt === null) {
          this.#signal(record, 'SIGKILL')
        }
      }, KILL_GRACE_MS)
      record.killTimer.unref?.()
    }
    return this.#snapshot(record, record.written)
  }

  list(): readonly BackgroundTaskSnapshot[] {
    return [...this.#tasks.values()].map((record) => this.#snapshot(record, record.written))
  }

  /** Kill every group; called when the worker is disposed. */
  dispose(): void {
    for (const record of this.#tasks.values()) {
      if (record.status === 'running') {
        record.status = 'killed'
        this.#signal(record, 'SIGTERM')
      }
      if (record.killTimer !== undefined) clearTimeout(record.killTimer)
    }
    // SIGKILL is async by nature; a second pass on the next tick catches a
    // group that ignored SIGTERM without keeping the process alive.
    for (const record of this.#tasks.values()) {
      if (record.endedAt === null) this.#signal(record, 'SIGKILL')
    }
    this.#tasks.clear()
  }

  #require(id: string): TaskRecord {
    const record = this.#tasks.get(id)
    if (record === undefined) throw new ProcessTaskError(`unknown background task "${id}"`)
    return record
  }

  /** Signal the whole process group, falling back to the direct child. */
  #signal(record: TaskRecord, signal: NodeJS.Signals): void {
    const pid = record.child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        record.child.kill(signal)
      } catch {
        // Already gone.
      }
    }
  }

  #snapshot(record: TaskRecord, cursor: number, limit?: number): BackgroundTaskSnapshot {
    const from = Math.max(0, cursor)
    const startOffset = Math.max(0, from - record.dropped)
    // A cursor before the retained buffer cannot be served exactly.
    const truncated = from < record.dropped
    let output = record.buffer.slice(Math.min(startOffset, record.buffer.length))
    if (limit !== undefined && output.length > limit) output = output.slice(-limit)
    return {
      id: record.id,
      ...(record.child.pid === undefined ? {} : { pid: record.child.pid }),
      command: record.command,
      args: [...record.args],
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      cursor: record.written,
      size: record.written,
      output,
      truncated,
    }
  }
}
