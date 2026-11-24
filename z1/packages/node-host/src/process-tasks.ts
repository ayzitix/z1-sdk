/**
 * Long-running child processes owned by the host.
 *
 * A worker cannot spawn a child (Node's permission model forbids it) and the
 * existing `process.run` capability is request/response: it waits, kills on
 * timeout and returns only at the end. A dev server needs the opposite — start
 * now, keep running, read what it printed later — so the host owns the child and
 * exposes it as a task.
 *
 * Output is a single combined stream with a character cursor: `written` counts
 * UTF-16 code units (what a JS string index and the JSON wire format use), a
 * poll returns the *head* of the range at `cursor` up to `limit`, and the next
 * cursor only advances over characters actually returned. A task that outgrows
 * the buffer keeps its tail and reports how many characters the head lost.
 * Byte-invalid output is replaced by a `<binary N bytes>` marker, never by
 * mangled text.
 *
 * `status` becomes `exited`/`killed` only once the child's stdout and stderr are
 * drained, so a poller that stops on the terminal status has the complete
 * output; the text stays readable afterwards.
 *
 * @module @z1/node-host/process-tasks
 */

import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

import type {
  BackgroundTaskPollRequest,
  BackgroundTaskSnapshot,
  BackgroundTaskStartRequest,
  BackgroundTaskStatus,
} from './protocol.ts'

/** Retained output per task, in characters. Older text is dropped, never the process. */
export const DEFAULT_TASK_OUTPUT_CHARS = 256 * 1024
/** How long a killed task group may take before SIGKILL. */
export const KILL_GRACE_MS = 2_000

/**
 * How long a task may stay non-terminal after its leader exited while a
 * descendant still holds the inherited stdout/stderr open.
 *
 * The terminal status is normally published on `close`, i.e. once every byte
 * has been drained; this only bounds the pathological case so a task cannot
 * report `running` for ever.
 */
const EXIT_DRAIN_GRACE_MS = 1_000

/**
 * Signals a caller may send. `kill` still goes through the group, so this also
 * bounds what a module can do to a child it owns.
 */
export const ALLOWED_SIGNALS: readonly NodeJS.Signals[] = [
  'SIGTERM',
  'SIGKILL',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
]

/**
 * Environment a task inherits. Everything else (`AWS_SECRET_ACCESS_KEY`, an
 * agent's tokens) stays out of a spawned dev server; `request.env` is merged
 * over this map.
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
]

const LC_ENTRY = /^LC_[A-Z]+$/

/** The inherited half of a task environment, restricted to `ENV_ALLOWLIST`. */
export function inheritedEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!ENV_ALLOWLIST.includes(key) && !LC_ENTRY.test(key)) continue
    env[key] = value
  }
  return env
}

interface TaskRecord {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  /** Canonical directory the child was spawned in; never its full environment. */
  readonly cwd: string | undefined
  readonly child: ChildProcess
  readonly startedAt: number
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  endedAt: number | null
  /** Last signal this host sent, so a kill is never reported as a natural exit. */
  killSignal: NodeJS.Signals | null
  /** Retained output tail, decoded as text. */
  buffer: string
  /** Total characters ever written by the task (absolute end cursor). */
  written: number
  /** Characters dropped from the front because the buffer overflowed. */
  dropped: number
  killTimer: NodeJS.Timeout | undefined
  /** Resolves once the child is gone (exit or spawn error). */
  readonly exited: Promise<void>
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

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === 'string' && (ALLOWED_SIGNALS as readonly string[]).includes(value)
}

/**
 * Decode one pipe chunk.
 *
 * `StringDecoder` keeps a torn multi-byte sequence for the next chunk, so a
 * 4-byte emoji split across two `data` events is still one character. A chunk
 * that is mostly invalid UTF-8, or contains NUL, is binary: it becomes a marker
 * instead of replacement characters the model could mistake for output.
 */
function decodeChunk(decoder: StringDecoder, chunk: Buffer): string {
  if (chunk.includes(0)) {
    decoder.end()
    return `<binary ${String(chunk.length)} bytes>`
  }
  const text = decoder.write(chunk)
  if (text.length === 0) return ''
  let bad = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0xfffd) bad += 1
  }
  if (bad > 4 && bad * 8 > text.length) return `<binary ${String(chunk.length)} bytes>`
  return text
}

/**
 * Start, poll and kill background tasks for one worker.
 *
 * Owned by `ModuleWorker`: a task lives as long as the worker, survives a run,
 * and dies when the worker is disposed (which `runtime.close()` does).
 */
export class ProcessTasks {
  readonly #tasks = new Map<string, TaskRecord>()
  readonly #maxChars: number

  constructor(options: { maxOutputChars?: number; maxOutputBytes?: number } = {}) {
    // `maxOutputBytes` is the pre-rename option; both are characters now.
    this.#maxChars = options.maxOutputChars ?? options.maxOutputBytes ?? DEFAULT_TASK_OUTPUT_CHARS
  }

  start(request: BackgroundTaskStartRequest): BackgroundTaskSnapshot {
    if (request.command.trim().length === 0) {
      throw new ProcessTaskError('process.start requires a command')
    }
    const args = [...(request.args ?? [])]
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new ProcessTaskError('process.start args must be an array of strings')
      }
    }
    const env = inheritedEnvironment()
    for (const [key, value] of Object.entries(request.env ?? {})) env[key] = value

    let child: ChildProcess
    try {
      child = spawn(request.command, args, {
        cwd: request.cwd,
        env,
        shell: false,
        // Own process group: a dev server's children die with one group signal.
        detached: true,
        // Same reason as `process.run`: without it Windows opens a console
        // window for the child. A background process is supposed to be unseen.
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new ProcessTaskError(
        `cannot spawn "${request.command}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    let finish: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      finish = resolve
    })

    const record: TaskRecord = {
      id: randomId(),
      command: request.command,
      args,
      cwd: request.cwd,
      child,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      signal: null,
      endedAt: null,
      killSignal: null,
      buffer: '',
      written: 0,
      dropped: 0,
      killTimer: undefined,
      exited,
    }
    this.#tasks.set(record.id, record)

    const decoders = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    }
    const append = (text: string): void => {
      if (text.length === 0) return
      record.written += text.length
      record.buffer += text
      const overflow = record.buffer.length - this.#maxChars
      if (overflow > 0) {
        // Never cut a surrogate pair in half: a lone half is unprintable and
        // makes the cursor land between two halves of one character.
        let cut = overflow
        if (cut < record.buffer.length && isLowSurrogate(record.buffer.charCodeAt(cut))) cut += 1
        record.buffer = record.buffer.slice(cut)
        record.dropped += cut
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => append(decodeChunk(decoders.stdout, chunk)))
    child.stderr?.on('data', (chunk: Buffer) => append(decodeChunk(decoders.stderr, chunk)))

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let drainTimer: NodeJS.Timeout | undefined

    /**
     * Publish the terminal state, once.
     *
     * `status`/`endedAt` are the signal a poller stops on, so they may only
     * appear after the output is complete: the last bytes a dying process
     * writes are still in flight when the leader is reaped, and land between
     * `exit` and `close`. Publishing on `exit` let a poller read `exited` with
     * an empty buffer and lose them.
     */
    const terminate = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (record.endedAt !== null) return
      if (drainTimer !== undefined) {
        clearTimeout(drainTimer)
        drainTimer = undefined
      }
      // Flush a torn multi-byte sequence now that no more bytes can arrive.
      const out = decoders.stdout.end()
      if (out.length > 0) append(out)
      const err = decoders.stderr.end()
      if (err.length > 0) append(err)
      record.exitCode = code
      record.signal = signal
      record.endedAt = Date.now()
      record.status = record.killSignal === null ? 'exited' : 'killed'
      if (record.killTimer !== undefined) {
        clearTimeout(record.killTimer)
        record.killTimer = undefined
      }
      finish()
    }

    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      // The leader is gone; whatever is still in its group is an orphan and no
      // longer reachable from any tool, so reap it now. This also closes the
      // pipes a descendant inherited, which is what lets `close` fire.
      this.#signalGroup(record, 'SIGKILL')
      // A descendant that escaped the group can hold stdout open indefinitely.
      // The task must not stay non-terminal for ever, so after a bounded grace
      // publish what has been drained; the normal path publishes on `close`.
      drainTimer = setTimeout(() => {
        terminate(exitInfo?.code ?? null, exitInfo?.signal ?? null)
      }, EXIT_DRAIN_GRACE_MS)
      drainTimer.unref?.()
    })
    child.on('close', (code, signal) => {
      terminate(code ?? exitInfo?.code ?? null, signal ?? exitInfo?.signal ?? null)
    })
    child.on('error', (error) => {
      // A spawn failure (ENOENT) never emits `exit`; surface it as an exit.
      append(`${error.message}\n`)
      terminate(record.exitCode ?? 127, null)
    })

    return this.#snapshot(record, 0)
  }

  poll(request: BackgroundTaskPollRequest): BackgroundTaskSnapshot {
    const record = this.#require(request.id)
    const requested = request.cursor ?? 0
    if (!Number.isInteger(requested) || requested < 0) {
      throw new ProcessTaskError('cursor must be a non-negative integer')
    }
    if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1)) {
      throw new ProcessTaskError('limit must be a positive integer')
    }
    return this.#snapshot(record, requested, request.limit)
  }

  /**
   * Send a signal to the whole group.
   *
   * Escalation is allowed for as long as the process has not exited, whatever
   * the status says: `stopping` means "signal sent", not "dead".
   *
   * A kill is not a read: the snapshot starts at the beginning of the retained
   * output instead of jumping to the end, so the line a dying process printed
   * (usually its error) is still reachable with a follow-up
   * `poll({ cursor: killed.cursor })`.
   */
  kill(request: { id: string; signal?: NodeJS.Signals }): BackgroundTaskSnapshot {
    const record = this.#require(request.id)
    const signal = request.signal ?? 'SIGTERM'
    if (!isSignal(signal)) {
      throw new ProcessTaskError(
        `unsupported signal "${String(signal)}"; use one of ${ALLOWED_SIGNALS.join(', ')}`,
      )
    }
    if (record.endedAt !== null) {
      // Already gone: report the exit, do not pretend a signal changed it.
      return this.#killSnapshot(record)
    }
    record.killSignal = signal
    record.status = 'stopping'
    this.#signalGroup(record, signal)
    if (record.killTimer !== undefined) {
      clearTimeout(record.killTimer)
      record.killTimer = undefined
    }
    if (signal !== 'SIGKILL') {
      // A process that ignores the polite signal must not outlive the session.
      record.killTimer = setTimeout(() => {
        if (record.endedAt !== null) return
        record.killSignal = 'SIGKILL'
        this.#signalGroup(record, 'SIGKILL')
      }, KILL_GRACE_MS)
      record.killTimer.unref?.()
    }
    return this.#killSnapshot(record)
  }

  list(): readonly BackgroundTaskSnapshot[] {
    return [...this.#tasks.values()].map((record) => this.#snapshot(record, record.written))
  }

  /**
   * Kill every group; called when the worker is disposed.
   *
   * SIGTERM first, then a bounded grace (2 s) for a clean shutdown, then
   * SIGKILL to whatever is left. The wait is on each child's exit promise, not
   * a synchronous loop, so the host stays responsive while it happens.
   */
  async dispose(graceMs: number = KILL_GRACE_MS): Promise<void> {
    const records = [...this.#tasks.values()]
    this.#tasks.clear()
    for (const record of records) {
      if (record.killTimer !== undefined) {
        clearTimeout(record.killTimer)
        record.killTimer = undefined
      }
      if (record.endedAt !== null) continue
      record.killSignal = 'SIGTERM'
      record.status = 'stopping'
      this.#signalGroup(record, 'SIGTERM')
    }
    if (records.length > 0) {
      await Promise.race([Promise.all(records.map((record) => record.exited)), delay(graceMs)])
      for (const record of records) {
        if (record.endedAt === null) this.#signalGroup(record, 'SIGKILL')
      }
      await Promise.race([Promise.all(records.map((record) => record.exited)), delay(100)])
    }
  }

  /**
   * Snapshot returned by `kill`.
   *
   * The cursor stays at the caller's starting point (0, since a kill carries no
   * cursor of its own) rather than the end of the range it just returned, and
   * `more` is set while there is output there, so a caller that follows the
   * cursor protocol reads what the task printed before it died instead of
   * silently skipping it. The output itself is included too, so a caller that
   * never re-polls still gets it.
   */
  #killSnapshot(record: TaskRecord): BackgroundTaskSnapshot {
    const snapshot = this.#snapshot(record, 0)
    return { ...snapshot, cursor: 0, more: snapshot.more || snapshot.output.length > 0 }
  }

  #require(id: string): TaskRecord {
    const record = this.#tasks.get(id)
    if (record === undefined) throw new ProcessTaskError(`unknown background task "${id}"`)
    return record
  }

  /**
   * Signal the whole process group, falling back to the direct child.
   *
   * `detached: true` makes the child a group leader, so `-pid` reaches
   * grandchildren too; on platforms without group signals the fallback still
   * reaches the child itself.
   */
  #signalGroup(record: TaskRecord, signal: NodeJS.Signals): void {
    const pid = record.child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // No group (already reaped) or no negative-pid support: try the child.
    }
    try {
      record.child.kill(signal)
    } catch {
      // Already gone.
    }
  }

  #snapshot(record: TaskRecord, cursor: number, limit?: number): BackgroundTaskSnapshot {
    const from = Math.max(0, Math.floor(cursor))
    // A cursor before the retained buffer cannot be served exactly.
    const truncated = from < record.dropped
    let start = Math.max(0, from - record.dropped)
    if (start > record.buffer.length) start = record.buffer.length
    // Never start inside a surrogate pair: step back onto its high half, which
    // re-sends one character instead of a lone surrogate.
    if (start > 0 && start < record.buffer.length && isLowSurrogate(record.buffer.charCodeAt(start))) {
      start -= 1
    }
    let end = record.buffer.length
    if (limit !== undefined) {
      end = Math.min(start + Math.max(1, Math.floor(limit)), record.buffer.length)
      // Never end between the halves of one character: a lone surrogate is not
      // printable, and the cursor steps back onto the pair instead.
      if (end < record.buffer.length && isLowSurrogate(record.buffer.charCodeAt(end))) end -= 1
      if (end === start && start < record.buffer.length) {
        // The cap landed inside one surrogate pair; return the whole character
        // so a cursor-based reader still makes progress.
        const point = record.buffer.codePointAt(start) ?? 0
        end = Math.min(start + (point > 0xffff ? 2 : 1), record.buffer.length)
      }
      if (end < start) end = start
    }
    const nextCursor = record.dropped + end
    return {
      id: record.id,
      ...(record.child.pid === undefined ? {} : { pid: record.child.pid }),
      command: record.command,
      args: [...record.args],
      ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      killSignal: record.killSignal,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      cursor: nextCursor,
      size: record.written,
      // True while unread characters remain after `cursor`.
      more: nextCursor < record.written,
      droppedChars: record.dropped,
      output: record.buffer.slice(start, end),
      truncated,
    }
  }
}

/** True when `text` starts or ends with half of a surrogate pair. */
export function hasLoneSurrogate(text: string): boolean {
  if (text.length === 0) return false
  const first = text.charCodeAt(0)
  const last = text.charCodeAt(text.length - 1)
  if (isLowSurrogate(first)) return true
  if (isHighSurrogate(last)) return true
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(text)
}
