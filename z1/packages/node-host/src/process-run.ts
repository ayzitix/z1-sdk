/**
 * Brokered process execution for module code.
 *
 * The command is always spawned directly (`shell: false`) with an argv array, so
 * nothing in `args` is ever interpreted by a shell.
 *
 * stdout and stderr are collected as one tagged stream, so the interleaving the
 * process produced survives into {@link ProcessRunResult.segments}; the flat
 * `stdout`/`stderr` strings are only a convenience for callers that do not care
 * about order.
 *
 * The child is spawned `detached` and owned by its own process group, so a
 * timeout signals the group (SIGTERM, a short grace, then SIGKILL) and
 * grandchildren do not survive the call. Output is capped across both streams:
 * past the cap the extra bytes are drained and discarded, the child keeps
 * running, and the result reports `outputLimit` rather than pretending the cap
 * was a kill.
 *
 * Non-UTF-8 or NUL-bearing output is reported as `binary` per segment instead of
 * decoding to U+FFFD soup.
 *
 * The environment is not inherited wholesale: {@link baseProcessEnv} copies a
 * documented allowlist and overlays the request's own keys.
 *
 * @module @z1/node-host/process-run
 */

import { spawn } from 'node:child_process'

import type { ProcessRunOutputSegment, ProcessRunResult } from './protocol.ts'

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const MAX_PROCESS_TIMEOUT_MS = 300_000
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 1024 * 1024
export const MAX_PROCESS_MAX_OUTPUT_BYTES = 5 * 1024 * 1024

/** How long a timed-out group gets after SIGTERM before SIGKILL. */
export const PROCESS_KILL_GRACE_MS = 1_000

/** Exact variables copied from the host environment. */
export const PROCESS_ENV_ALLOWED_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
]

/** Prefixes copied from the host environment (locales). */
export const PROCESS_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_']

/** Suffixes copied from the host environment (HTTP_PROXY, NO_PROXY, http_proxy, ...). */
export const PROCESS_ENV_ALLOWED_SUFFIXES: readonly string[] = ['_PROXY']

export interface RunProcessOptions {
  cwd: string
  /** Overrides merged on top of {@link baseProcessEnv}. */
  env: Record<string, string>
  timeoutMs: number
  /** Shared stdout+stderr byte budget. */
  maxOutputBytes: number
  /** Everything written to the child's stdin, which is then closed. */
  stdin?: string
}

/** True when `key` is on the inherited-environment allowlist. */
export function isInheritedProcessEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    PROCESS_ENV_ALLOWED_KEYS.includes(upper) ||
    PROCESS_ENV_ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    PROCESS_ENV_ALLOWED_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  )
}

/**
 * Build the child environment: an allowlist from the host process plus
 * `overrides` (which may add any key, but cannot remove an inherited one).
 *
 * Secrets in the rest of the host environment are deliberately not passed on.
 */
export function baseProcessEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || !isInheritedProcessEnvKey(key)) continue
    const upper = key.toUpperCase()
    // Windows spells the variable `Path`; canonicalise the exact allowlist
    // keys so the child always receives `PATH`. Proxy and locale spellings are
    // preserved because the allowlist deliberately carries both cases.
    env[PROCESS_ENV_ALLOWED_KEYS.includes(upper) ? upper : key] = value
  }
  env['PATH'] = env['PATH'] ?? ''
  for (const key of Object.keys(overrides)) {
    if (key.length === 0 || key.includes('=') || key.includes('\0')) {
      throw new Error(`invalid environment variable name "${key}"`)
    }
  }
  return Object.assign(env, overrides)
}

/** Clamp a numeric option into `[minimum, maximum]`, truncating fractions. */
export function clampProcessOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

/** Strict UTF-8 decoder; a throw means the bytes are not text. */
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Bytes to drop from the tail so a capped buffer ends on a code-point boundary.
 *
 * Only the final segment can be cut mid-character, and the result is 0..3, so
 * the cost is bounded.
 */
export function incompleteUtf8Tail(bytes: Buffer): number {
  const limit = Math.min(3, bytes.length)
  for (let drop = 1; drop <= limit; drop += 1) {
    const byte = bytes[bytes.length - drop]
    if (byte === undefined) return 0
    if ((byte & 0b1100_0000) === 0b1000_0000) continue // continuation byte
    if ((byte & 0b1000_0000) === 0) return drop === 1 ? 0 : drop
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
    return drop === need ? 0 : drop
  }
  return 0
}

/** Decode one finished stream run, flagging NUL bytes and invalid UTF-8. */
function decodeRun(bytes: Buffer): { text: string; binary: boolean } {
  if (bytes.includes(0)) return { text: '', binary: true }
  try {
    return { text: UTF8.decode(bytes), binary: false }
  } catch {
    return { text: '', binary: true }
  }
}

interface PendingSegment {
  stream: 'stdout' | 'stderr'
  parts: Buffer[]
  bytes: number
}

/**
 * Spawn `command` with `args`, collect up to the byte budget, and resolve with
 * the exit status. Spawn failures (e.g. `ENOENT`) reject with an actionable
 * message.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessRunResult> {
  return new Promise<ProcessRunResult>((resolve, reject) => {
    const started = Date.now()
    const pending: PendingSegment[] = []
    const maxOutputBytes = options.maxOutputBytes
    let keptBytes = 0
    let outputLimit = false
    let timedOut = false
    let closed = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // Own process group: a timeout can signal the whole tree, and the group
      // is swept for orphans once the leader exits.
      detached: true,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })

    /** Signal the child's process group, falling back to the child alone. */
    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, signal)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        // ESRCH: the group is already gone; nothing to signal.
        if (code === 'ESRCH') return
      }
      try {
        child.kill(signal)
      } catch {
        // The child may have exited between the group attempt and this call.
      }
    }

    const settle = (outcome: ProcessRunResult): void => {
      if (settled) return
      settled = true
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      resolve(outcome)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      reject(error)
    }

    /** Keep at most the remaining shared budget; drain (and drop) past it. */
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled || outputLimit) return
      const remaining = maxOutputBytes - keptBytes
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          append(stream, chunk.subarray(0, remaining))
          keptBytes += remaining
        }
        // The child keeps running so its real status survives; the rest of its
        // output is read and discarded rather than silently killing it.
        outputLimit = true
        return
      }
      append(stream, chunk)
      keptBytes += chunk.byteLength
    }

    /** Merge adjacent chunks of the same stream, preserving overall order. */
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (chunk.byteLength === 0) return
      const last = pending[pending.length - 1]
      if (last !== undefined && last.stream === stream) {
        last.parts.push(chunk)
        last.bytes += chunk.byteLength
        return
      }
      pending.push({ stream, parts: [chunk], bytes: chunk.byteLength })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      collect('stdout', chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      collect('stderr', chunk)
    })

    if (options.stdin !== undefined) {
      // A child that exits without reading closes the pipe under us; EPIPE is
      // expected, not a run failure.
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.stdin)
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      const pathValue = options.env['PATH'] ?? ''
      let detail = error.message.length > 0 ? error.message : String(error)
      if (error.code === 'ENOENT') {
        const spaced = /\s/.test(command)
          ? ` "${command}" contains a space, but a command is one executable name, not a shell line — pass arguments in "args".`
          : ''
        detail =
          `ENOENT — no executable named "${command}" was found on PATH (${pathValue || 'empty'}).` +
          spaced +
          ` Check the name with \`which ${command}\`, or pass an absolute path.`
      }
      fail(new Error(`process.run could not spawn "${command}": ${detail}`))
    })

    timer = setTimeout(() => {
      timedOut = true
      // Ask the group to stop, then insist: a child that traps SIGTERM must not
      // be able to outlive the timeout.
      signalGroup('SIGTERM')
      graceTimer = setTimeout(() => {
        if (!closed) signalGroup('SIGKILL')
      }, PROCESS_KILL_GRACE_MS)
      graceTimer.unref?.()
    }, options.timeoutMs)
    // The child keeps the event loop alive; the timer must not outlive it.
    timer.unref?.()

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const segments: ProcessRunOutputSegment[] = []
      for (let index = 0; index < pending.length; index += 1) {
        const segment = pending[index]
        if (segment === undefined) continue
        let bytes = segment.parts.length === 1 ? (segment.parts[0] as Buffer) : Buffer.concat(segment.parts, segment.bytes)
        // Only the last segment can be clipped mid-character by the cap.
        if (outputLimit && index === pending.length - 1) {
          const drop = incompleteUtf8Tail(bytes)
          if (drop > 0) bytes = bytes.subarray(0, bytes.length - drop)
        }
        const decoded = decodeRun(bytes)
        segments.push({
          stream: segment.stream,
          text: decoded.text,
          bytes: bytes.byteLength,
          binary: decoded.binary,
        })
      }
      const join = (stream: 'stdout' | 'stderr'): string =>
        segments
          .filter((segment) => segment.stream === stream)
          .map((segment) => segment.text)
          .join('')
      // Sweep the group: a grandchild left behind by the leader must not keep
      // running after the call returns (best effort; ESRCH is ignored).
      signalGroup('SIGKILL')
      settle({
        code,
        signal: signal ?? null,
        stdout: join('stdout'),
        stderr: join('stderr'),
        truncated: outputLimit,
        timedOut,
        outputLimit,
        maxOutputBytes,
        segments,
        durationMs: Date.now() - started,
      })
    })
  })
}
