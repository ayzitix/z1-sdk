/**
 * Unit tests for the brokered `process.run` primitives that the capability
 * fixture cannot reach: ordered output segments and child stdin.
 *
 * `process.run` returns one flat string per stream, which cannot say whether a
 * line came before or after the other stream; `segments` keeps the order the
 * process actually wrote in.
 */

import { expect, test } from 'vitest'

import { runProcess } from '../src/process-run.ts'

function baseOptions(extra: Partial<Parameters<typeof runProcess>[2]> = {}) {
  return {
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '' },
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    ...extra,
  }
}

test('segments keep the order the process wrote stdout and stderr in', async () => {
  // The writes are spread over time so the kernel delivers each one as its own
  // chunk: adjacent chunks of one stream are merged into a single segment.
  const script = [
    "process.stdout.write('one')",
    "setTimeout(() => process.stderr.write('two'), 60)",
    "setTimeout(() => process.stdout.write('three'), 120)",
  ].join(';')

  const result = await runProcess(process.execPath, ['-e', script], baseOptions())

  expect(result.code).toBe(0)
  expect(result.segments.map((segment) => segment.stream)).toEqual([
    'stdout',
    'stderr',
    'stdout',
  ])
  expect(result.segments.map((segment) => segment.text)).toEqual(['one', 'two', 'three'])
  expect(result.segments.map((segment) => segment.bytes)).toEqual([3, 3, 5])
  expect(result.segments.every((segment) => segment.binary === false)).toBe(true)
  // The flat strings are only a convenience view of the same bytes.
  expect(result.stdout).toBe('onethree')
  expect(result.stderr).toBe('two')
})

test('stdin is written to the child and then closed', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    baseOptions({ stdin: 'hello from the host\n' }),
  )

  expect(result.code).toBe(0)
  expect(result.stdout).toBe('hello from the host\n')
  expect(result.timedOut).toBe(false)
  expect(result.outputLimit).toBe(false)
})
