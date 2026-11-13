/**
 * Brokered process execution for module code.
 *
 * The command is always spawned directly (`shell: false`) with an argv array, so
 * nothing in `args` is ever interpreted by a shell. Output is capped across
 * stdout and stderr together; hitting the cap kills the child.
 *
 * @module @z1/node-host/process-run
 */

import { spawn } from 'node:child_process'
import type { ProcessRunResult } from './protocol.ts'

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const MAX_PROCESS_TIMEOUT_MS = 300_000
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 1024 * 1024
export const MAX_PROCESS_MAX_OUTPUT_BYTES = 5 * 1024 * 1024

export interface RunProcessOptions {
  cwd: string
  /** Minimal environment; callers pass `{ PATH }` plus request-specific keys. */
  env: Record<string, string>
  timeoutMs: number
  /** Shared stdout+stderr byte budget. */
  maxOutputBytes: number
}

/** Clamp a numeric option into `[minimum, maximum]`, truncating fractions. */
export function clampProcessOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

/**
 * Spawn `command` with `args`, collect up to the byte budget, and resolve with
 * the exit status. Spawn failures (e.g. `ENOENT`) reject.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessRunResult> {
  return new Promise<ProcessRunResult>((resolve, reject) => {
    const started = Date.now()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let totalBytes = 0
    let truncated = false
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const settle = (outcome: ProcessRunResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      reject(error)
    }

    /** Copy at most the remaining shared budget, then kill on overflow. */
    const collect = (chunk: Buffer, target: Buffer[]): void => {
      if (truncated || settled) return
      const remaining = options.maxOutputBytes - totalBytes
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          target.push(chunk.subarray(0, remaining))
          totalBytes += remaining
        }
        truncated = true
        child.kill('SIGKILL')
        return
      }
      if (chunk.byteLength > 0) {
        target.push(chunk)
        totalBytes += chunk.byteLength
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      collect(chunk, stdoutChunks)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      collect(chunk, stderrChunks)
    })

    child.on('error', (error: Error) => {
      fail(
        new Error(
          `process.run could not spawn "${command}": ${
            error.message.length > 0 ? error.message : String(error)
          }`,
        ),
      )
    })

    timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs)
    // The child keeps the event loop alive; the timer must not outlive it.
    timer.unref?.()

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      settle({
        code,
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated,
        durationMs: Date.now() - started,
      })
    })
  })
}
