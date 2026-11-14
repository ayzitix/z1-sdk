/**
 * `z1 eval` — run a suite of tasks and report objective numbers.
 *
 * Each case runs through the real CLI `run` path (same template builder, same
 * approval defaults, same journal), not a parallel implementation. That keeps a
 * measurement honest: if `z1 run` changes, the suite measures the change.
 *
 * Metrics come from the case's own journal: loop steps, tool calls and errors,
 * and token usage from the recorded model turns. Assertions are deliberately
 * mechanical (contains, regexp, file contents, command exit code); there is no
 * model-based judge.
 *
 * @module @z1/cli/eval
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { SqliteJournal } from '@z1/journal'

import type { CliIO } from './cli.ts'

/** A `run`-like function, injected to keep the CLI module graph acyclic. */
export type RunFn = (argv: readonly string[], io: CliIO) => Promise<number>

interface FileExpectation {
  path: string
  contains?: string
}

interface CommandExpectation {
  run: string
  exitCode?: number
  timeoutMs?: number
}

interface Expectations {
  outputContains?: readonly string[]
  outputMatches?: string
  files?: readonly FileExpectation[]
  command?: CommandExpectation
  maxSteps?: number
  maxToolErrors?: number
}

interface EvalCase {
  id: string
  message: string
  template: string
  fixture?: string
  model?: string
  system?: string
  expect: Expectations
}

interface CaseMetrics {
  status: string
  durationMs: number
  steps: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
}

interface CaseResult {
  id: string
  passed: boolean
  failures: string[]
  metrics?: CaseMetrics
  error?: string
  workspace: string
}

interface EvalOptions {
  file: string
  live: boolean
  cassette?: string
  json: boolean
  jobs: number
  maxSteps?: number
  workspace?: string
  keep: boolean
  noMemory: boolean
}

const MAP_CALL_PATH = /\/toolMap\/\d+\/mapCall$/

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
  return value as string[]
}

function readExpectations(raw: unknown, label: string): Expectations {
  if (!isRecord(raw)) throw new Error(`${label}.expect must be an object`)
  const expect: Expectations = {}
  if (raw['outputContains'] !== undefined) {
    expect.outputContains = stringArray(raw['outputContains'], `${label}.expect.outputContains`)
  }
  if (raw['outputMatches'] !== undefined) {
    if (typeof raw['outputMatches'] !== 'string') {
      throw new Error(`${label}.expect.outputMatches must be a string`)
    }
    // Fail at load time, not after paying for a run.
    try {
      new RegExp(raw['outputMatches'])
    } catch (error) {
      throw new Error(`${label}.expect.outputMatches is not a valid regexp: ${errorMessage(error)}`)
    }
    expect.outputMatches = raw['outputMatches']
  }
  if (raw['files'] !== undefined) {
    if (!Array.isArray(raw['files'])) throw new Error(`${label}.expect.files must be an array`)
    expect.files = raw['files'].map((entry, index) => {
      if (!isRecord(entry) || typeof entry['path'] !== 'string') {
        throw new Error(`${label}.expect.files[${String(index)}] must have a string "path"`)
      }
      const file: FileExpectation = { path: entry['path'] }
      if (entry['contains'] !== undefined) {
        if (typeof entry['contains'] !== 'string') {
          throw new Error(`${label}.expect.files[${String(index)}].contains must be a string`)
        }
        file.contains = entry['contains']
      }
      return file
    })
  }
  if (raw['command'] !== undefined) {
    if (!isRecord(raw['command']) || typeof raw['command']['run'] !== 'string') {
      throw new Error(`${label}.expect.command must have a string "run"`)
    }
    const command: CommandExpectation = { run: raw['command']['run'] }
    const exitCode = raw['command']['exitCode']
    if (exitCode !== undefined) {
      if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
        throw new Error(`${label}.expect.command.exitCode must be an integer`)
      }
      command.exitCode = exitCode
    }
    const timeoutMs = raw['command']['timeoutMs']
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`${label}.expect.command.timeoutMs must be a positive integer`)
      }
      command.timeoutMs = timeoutMs
    }
    expect.command = command
  }
  for (const key of ['maxSteps', 'maxToolErrors'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`${label}.expect.${key} must be a non-negative integer`)
    }
    expect[key] = value
  }

  const assertions =
    (expect.outputContains?.length ?? 0) > 0 ||
    expect.outputMatches !== undefined ||
    (expect.files?.length ?? 0) > 0 ||
    expect.command !== undefined ||
    expect.maxSteps !== undefined ||
    expect.maxToolErrors !== undefined
  if (!assertions) throw new Error(`${label}.expect must assert at least one thing`)
  return expect
}

function readCase(raw: unknown, label: string, baseDir: string): EvalCase {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`)
  const id = raw['id']
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${label}.id must be a string`)
  const message = raw['message']
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error(`${label}.message must be a non-empty string`)
  }
  const template = raw['template'] ?? 'agent.loop'
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error(`${label}.template must be a string`)
  }
  const spec: EvalCase = {
    id,
    message,
    template,
    expect: readExpectations(raw['expect'], label),
  }
  const fixture = raw['fixture']
  if (fixture !== undefined) {
    if (typeof fixture !== 'string' || fixture.length === 0) {
      throw new Error(`${label}.fixture must be a string`)
    }
    const resolved = isAbsolute(fixture) ? fixture : resolve(baseDir, fixture)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`${label}.fixture "${fixture}" is not a directory`)
    }
    assertNoSymlinks(resolved)
    spec.fixture = resolved
  }
  if (raw['model'] !== undefined) {
    if (typeof raw['model'] !== 'string') throw new Error(`${label}.model must be a string`)
    spec.model = raw['model']
  }
  if (raw['system'] !== undefined) {
    if (typeof raw['system'] !== 'string') throw new Error(`${label}.system must be a string`)
    spec.system = raw['system']
  }
  return spec
}

/** A JSON file may hold one case, an array, or `{ "cases": [...] }`. */
export function loadCases(path: string): readonly EvalCase[] {
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => join(path, name))
    : [path]
  if (files.length === 0) throw new Error(`"${path}" contains no *.json case files`)

  const cases: EvalCase[] = []
  for (const file of files) {
    const label = basename(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    } catch (error) {
      throw new Error(`"${file}" is not valid JSON: ${errorMessage(error)}`)
    }
    const baseDir = dirname(resolve(file))
    if (Array.isArray(parsed)) {
      parsed.forEach((entry, index) => cases.push(readCase(entry, `${label}[${String(index)}]`, baseDir)))
      continue
    }
    if (isRecord(parsed) && Array.isArray(parsed['cases'])) {
      parsed['cases'].forEach((entry, index) =>
        cases.push(readCase(entry, `${label}.cases[${String(index)}]`, baseDir)),
      )
      continue
    }
    cases.push(readCase(parsed, label, baseDir))
  }

  const seen = new Set<string>()
  for (const item of cases) {
    if (seen.has(item.id)) throw new Error(`duplicate case id "${item.id}"`)
    seen.add(item.id)
  }
  return cases
}

function metricsOf(journal: SqliteJournal, runId: string): CaseMetrics {
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  let inputTokens = 0
  let outputTokens = 0

  for (const event of journal.read(runId)) {
    // One `llm.request` is one model turn, whatever the node is called. A path
    // suffix (`*/chat`) only works for the builtin node and silently reports 0
    // for a provider node. The compaction summary is an internal turn: its
    // tokens are real cost, but it is not a step of the task.
    if (event.type === 'llm.request' && !/\/ctxSummary$/.test(event.path)) steps += 1
    if (event.type === 'node.completed' && MAP_CALL_PATH.test(event.path)) {
      toolCalls += 1
      const outputs = event.outputs as Record<string, unknown>
      if (outputs['isError'] === true) toolErrors += 1
    }
    if (event.type === 'llm.response') {
      inputTokens += event.usage?.inputTokens ?? 0
      outputTokens += event.usage?.outputTokens ?? 0
    }
  }
  return { status: '', durationMs: 0, steps, toolCalls, toolErrors, inputTokens, outputTokens }
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width)
}

function renderTable(results: readonly CaseResult[]): string {
  const header = `${pad('case', 28)} ${pad('status', 7)} ${pad('steps', 5)} ${pad('tools', 5)} ${pad('err', 3)} ${pad('tokens', 7)} ${pad('time', 7)}`
  const lines = [header]
  for (const result of results) {
    const m = result.metrics
    lines.push(
      `${pad(result.id.slice(0, 27), 28)} ${pad(result.passed ? 'pass' : 'fail', 7)} ${pad(m?.steps ?? '-', 5)} ${pad(m?.toolCalls ?? '-', 5)} ${pad(m?.toolErrors ?? '-', 3)} ${pad((m?.inputTokens ?? 0) + (m?.outputTokens ?? 0), 7)} ${pad(m === undefined ? '-' : `${(m.durationMs / 1000).toFixed(1)}s`, 7)}`,
    )
    for (const failure of result.failures) lines.push(`  ✗ ${failure}`)
    if (result.error !== undefined) lines.push(`  ! ${result.error}`)
  }

  const passed = results.filter((result) => result.passed).length
  const steps = results
    .map((result) => result.metrics?.steps)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)
  const median = steps.length === 0 ? 0 : (steps[Math.floor(steps.length / 2)] ?? 0)
  const tokens = results.reduce(
    (total, result) =>
      total + (result.metrics?.inputTokens ?? 0) + (result.metrics?.outputTokens ?? 0),
    0,
  )
  lines.push(
    '',
    `summary  passed ${String(passed)}/${String(results.length)} · passRate ${String(Math.round((passed / Math.max(1, results.length)) * 100))}% · medianSteps ${String(median)} · tokens ${String(tokens)}`,
  )
  return `${lines.join('\n')}\n`
}

/**
 * A copied fixture must not contain a live link: `cp` keeps a symlink as a
 * link, and a builtin `fs` node would then read outside the case workspace.
 */
function assertNoSymlinks(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`fixture contains a symlink, which a case must not follow: ${path}`)
    }
    if (entry.isDirectory()) assertNoSymlinks(path)
  }
}

/** Copy the fixture (if any) into a fresh directory for this case. */
function prepareWorkspace(parent: string, spec: EvalCase): string {
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, `${spec.id.replace(/[^a-zA-Z0-9._-]+/g, '-')}-`))
  if (spec.fixture !== undefined) cpSync(spec.fixture, directory, { recursive: true })
  return directory
}

async function runCase(
  spec: EvalCase,
  options: EvalOptions,
  run: RunFn,
  io: CliIO,
): Promise<CaseResult> {
  const workspace = prepareWorkspace(options.workspace ?? tmpdir(), spec)
  const dbPath = join(workspace, '.z1-eval', 'runs.db')
  mkdirSync(dirname(dbPath), { recursive: true })

  const args = [
    'run',
    '--template',
    spec.template,
    '--message',
    spec.message,
    '--json',
    '--db',
    dbPath,
    '--cwd',
    workspace,
  ]
  if (spec.model !== undefined) args.push('--model', spec.model)
  if (spec.system !== undefined) args.push('--system', spec.system)
  if (options.live) args.push('--live')
  if (options.cassette !== undefined) args.push('--cassette', options.cassette)
  if (options.maxSteps !== undefined) args.push('--max-steps', String(options.maxSteps))
  if (options.noMemory) args.push('--no-memory')

  let stdout = ''
  let stderr = ''
  const env = { ...(io.env ?? process.env) }
  // Metrics come from `llm.request` / `llm.response`; `hashes` keeps them
  // without writing a blob per turn. A caller-set mode still wins.
  if (env['Z1_RECORD_LLM'] === undefined) env['Z1_RECORD_LLM'] = 'hashes'
  const captured: CliIO = {
    stdout: (chunk) => {
      stdout += chunk
    },
    stderr: (chunk) => {
      stderr += chunk
    },
    isTTY: false,
    env,
    cwd: workspace,
  }

  const startedAt = Date.now()
  const code = await run(args, captured)
  const durationMs = Date.now() - startedAt

  const result: CaseResult = { id: spec.id, passed: true, failures: [], workspace }
  try {
    // The last line that parses as the run result, not the last line that
    // starts with `{`: a diagnostic object printed later must not hide it.
    const parsedRun = stdout
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith('{'))
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return undefined
        }
      })
      .find((value) => isRecord(value) && typeof value['runId'] === 'string')
    if (!isRecord(parsedRun)) {
      result.error = `run produced no JSON result (exit ${String(code)}): ${stderr.trim().split('\n').pop() ?? ''}`
      result.passed = false
      return result
    }
    const parsed = parsedRun as { runId?: unknown; status?: unknown; outputs?: unknown }
    const runId = typeof parsed.runId === 'string' ? parsed.runId : undefined
    if (runId === undefined) {
      result.error = 'run JSON has no runId'
      result.passed = false
      return result
    }

    if (parsed.status !== 'completed') {
      const detail = stderr.trim().split('\n').filter((entry) => entry.length > 0).pop()
      result.failures.push(`status ${String(parsed.status)}${detail === undefined ? '' : `: ${detail}`}`)
    }

    const journal = new SqliteJournal(dbPath)
    let metrics: CaseMetrics
    try {
      metrics = metricsOf(journal, runId)
    } finally {
      journal.close()
    }
    metrics.status = String(parsed.status)
    metrics.durationMs = durationMs
    result.metrics = metrics

    const outputs = isRecord(parsed.outputs) ? parsed.outputs : {}
    const output = typeof outputs['output'] === 'string' ? outputs['output'] : JSON.stringify(outputs)

    for (const needle of spec.expect.outputContains ?? []) {
      if (!output.includes(needle)) {
        result.failures.push(`outputContains ${JSON.stringify(needle)} — got ${JSON.stringify(output.slice(0, 200))}`)
      }
    }
    if (spec.expect.outputMatches !== undefined) {
      if (!new RegExp(spec.expect.outputMatches).test(output)) {
        result.failures.push(`outputMatches /${spec.expect.outputMatches}/ — got ${JSON.stringify(output.slice(0, 200))}`)
      }
    }
    for (const file of spec.expect.files ?? []) {
      const path = isAbsolute(file.path) ? file.path : join(workspace, file.path)
      if (!existsSync(path)) {
        result.failures.push(`file ${file.path} does not exist`)
        continue
      }
      if (file.contains !== undefined) {
        const text = readFileSync(path, 'utf8')
        if (!text.includes(file.contains)) {
          result.failures.push(`file ${file.path} does not contain ${JSON.stringify(file.contains)}`)
        }
      }
    }
    if (spec.expect.command !== undefined) {
      const expected = spec.expect.command.exitCode ?? 0
      const execution = spawnSync(spec.expect.command.run, {
        cwd: workspace,
        shell: true,
        encoding: 'utf8',
        timeout: spec.expect.command.timeoutMs ?? 120_000,
        env: { ...process.env, ...(io.env ?? {}) },
      })
      if (execution.status !== expected) {
        const detail = `${execution.stdout ?? ''}${execution.stderr ?? ''}`
          .trim()
          .split('\n')
          .slice(-3)
          .join(' | ')
        result.failures.push(
          `command ${JSON.stringify(spec.expect.command.run)} exited ${String(execution.status)} (expected ${String(expected)})${detail.length === 0 ? '' : `: ${detail}`}`,
        )
      }
    }
    if (spec.expect.maxSteps !== undefined && metrics.steps > spec.expect.maxSteps) {
      result.failures.push(`steps ${String(metrics.steps)} > maxSteps ${String(spec.expect.maxSteps)}`)
    }
    if (
      spec.expect.maxToolErrors !== undefined &&
      metrics.toolErrors > spec.expect.maxToolErrors
    ) {
      result.failures.push(
        `toolErrors ${String(metrics.toolErrors)} > maxToolErrors ${String(spec.expect.maxToolErrors)}`,
      )
    }
  } catch (error) {
    result.error = errorMessage(error)
  }

  result.passed = result.failures.length === 0 && result.error === undefined
  if (result.passed && !options.keep) {
    // A passing case leaves nothing worth reading; a failing one keeps its
    // workspace so the journal and files can be inspected.
    rmSync(workspace, { recursive: true, force: true })
  }
  return result
}

async function runPool(
  cases: readonly EvalCase[],
  jobs: number,
  task: (spec: EvalCase) => Promise<CaseResult>,
): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array<CaseResult>(cases.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(jobs, cases.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      const spec = cases[index]
      if (spec === undefined) return
      results[index] = await task(spec)
    }
  })
  await Promise.all(workers)
  return results
}

function positiveInt(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

export async function evalCommand(args: readonly string[], io: CliIO, run: RunFn): Promise<number> {
  const { parseArgs } = await import('node:util')
  let values: {
    live?: boolean
    cassette?: string
    json?: boolean
    jobs?: string
    'max-steps'?: string
    workspace?: string
    keep?: boolean
    'no-memory'?: boolean
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        live: { type: 'boolean' },
        cassette: { type: 'string' },
        json: { type: 'boolean' },
        jobs: { type: 'string' },
        'max-steps': { type: 'string' },
        workspace: { type: 'string' },
        keep: { type: 'boolean' },
        'no-memory': { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = [...parsed.positionals]
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 2
  }

  const file = positionals[0]
  if (file === undefined || positionals.length > 1) {
    io.stderr('usage: z1 eval <case.json|dir> [--live] [--cassette <file>] [--json] [--jobs N]\n')
    return 2
  }

  let options: EvalOptions
  try {
    options = {
      file,
      live: values.live === true,
      json: values.json === true,
      jobs: values.jobs === undefined ? 1 : positiveInt(values.jobs, '--jobs'),
      keep: values.keep === true,
      noMemory: values['no-memory'] === true,
      ...(values.cassette === undefined ? {} : { cassette: resolve(values.cassette) }),
      ...(values['max-steps'] === undefined
        ? {}
        : { maxSteps: positiveInt(values['max-steps'], '--max-steps') }),
      ...(values.workspace === undefined ? {} : { workspace: resolve(values.workspace) }),
    }
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 2
  }

  let cases: readonly EvalCase[]
  try {
    cases = loadCases(file)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 2
  }

  const results = await runPool(cases, options.jobs, (spec) => runCase(spec, options, run, io))
  const passed = results.filter((result) => result.passed).length

  if (options.json) {
    const steps = results
      .map((result) => result.metrics?.steps)
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right)
    io.stdout(
      `${JSON.stringify({
        cases: results,
        summary: {
          passed,
          failed: results.length - passed,
          passRate: results.length === 0 ? 0 : passed / results.length,
          medianSteps: steps.length === 0 ? 0 : (steps[Math.floor(steps.length / 2)] ?? 0),
          totalTokens: results.reduce(
            (total, result) =>
              total + (result.metrics?.inputTokens ?? 0) + (result.metrics?.outputTokens ?? 0),
            0,
          ),
        },
      })}\n`,
    )
  } else {
    io.stdout(renderTable(results))
  }
  return passed === results.length ? 0 : 1
}
