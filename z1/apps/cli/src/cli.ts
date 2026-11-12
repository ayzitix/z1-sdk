import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import {
  graphDigest,
  parseGraph,
  validateGraphTree,
  type GraphDocument,
  type ValidationIssue,
} from '@z1/graph'
import { SqliteJournal } from '@z1/journal'
import { createBuiltinRegistry } from '@z1/nodes'
import { createOpenAiLlmService } from '@z1/provider-openai'
import {
  createMockRuntimeServices,
  runGraph,
  type LlmService,
  type MockApprovalBehavior,
  type RunEvent,
  type RunResult,
} from '@z1/runtime'
import type { ChatDelta, ChatRequest, ChatResult, Json } from '@z1/node'

/** Everything the CLI is allowed to touch outside the graph itself. */
export interface CliIO {
  stdout(s: string): void
  stderr(s: string): void
  isTTY: boolean
  /** Credential source; the bin passes `process.env`, tests pass a stub. */
  env?: Record<string, string | undefined>
}

const USAGE = [
  'usage: z1 <command> [options]',
  '',
  'commands:',
  '  list',
  '  validate <graph.json>',
  '  run <graph.json> [--input <json>] [--input-file <path>] [--json] [--trace]',
  '      [--approve auto|ask|deny] [--db <path>] [--suspend] [--resume <runId>] [--live]',
  '  tree [--db <path>] [--json]',
  '  fork <runId> --at <nodePath|seq> [--db <path>] [--json]',
  '',
].join('\n')

type ApproveMode = 'auto' | 'ask' | 'deny'

/** A problem with how the command was invoked, not with the graph. */
class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usage(io: CliIO): number {
  io.stderr(USAGE)
  return 2
}

function issueLine(issue: ValidationIssue): string {
  return `${issue.code}: ${issue.message}`
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readTextFile(path)
  } catch (error) {
    throw new UsageError(errorMessage(error))
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new UsageError(`"${path}" is not valid JSON: ${errorMessage(error)}`)
  }
}

/**
 * The workspace script runs the CLI from `z1/`, while the documented commands
 * pass repo-root relative paths (`z1/examples/...`). Trying the working
 * directory and then its ancestors makes both spellings work without a second
 * path argument.
 *
 * On failure the error names `path` as the user wrote it, never the
 * ancestor-climbed candidate that happened to be tried last.
 */
async function readTextFile(path: string): Promise<string> {
  if (isAbsolute(path)) return await readFile(path, 'utf8')

  let directory = process.cwd()
  let lastError: unknown
  while (true) {
    try {
      return await readFile(join(directory, path), 'utf8')
    } catch (error) {
      lastError = error
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  throw new Error(`cannot read "${path}": ${errorMessage(lastError)}`)
}

function parseJsonText(text: string, label: string): Json {
  try {
    return JSON.parse(text) as Json
  } catch (error) {
    throw new UsageError(`${label} is not valid JSON: ${errorMessage(error)}`)
  }
}

async function loadGraph(path: string): Promise<GraphDocument> {
  return parseGraph(await readJsonFile(path))
}

/** Reads one line from stdin without an output stream: the prompt goes to io. */
async function askLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin })
  try {
    return await rl.question('')
  } finally {
    rl.close()
  }
}

function approvalBehavior(mode: ApproveMode, io: CliIO): MockApprovalBehavior {
  switch (mode) {
    case 'auto':
      return 'allowed-once'
    case 'deny':
      return 'rejected'
    case 'ask':
      return async (request) => {
        // Reading stdin without a terminal would block a scripted run forever.
        if (!io.isTTY) {
          io.stderr('approval required but stdin is not a terminal; rejected\n')
          return 'rejected'
        }
        const target = request.target === undefined ? '' : ` ${request.target}`
        io.stderr(`approve ${request.action}${target}? [y/N] `)
        let answer: string
        try {
          answer = await askLine()
        } catch {
          return 'cancelled'
        }
        return /^y(es)?$/i.test(answer.trim()) ? 'allowed-once' : 'rejected'
      }
  }
}

type LiveProvider = 'river' | 'openai'

interface ProviderEnv {
  apiKey: string
  baseUrl: string
  defaultBaseUrl: string
}

const PROVIDER_ENV: Record<LiveProvider, ProviderEnv> = {
  river: {
    apiKey: 'RIVER_API_KEY',
    baseUrl: 'RIVER_BASE_URL',
    defaultBaseUrl: 'https://api.river.ai/v1',
  },
  openai: {
    apiKey: 'OPENAI_API_KEY',
    baseUrl: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
}

function isLiveProvider(value: string): value is LiveProvider {
  return value === 'river' || value === 'openai'
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

function isJsonObject(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Model nodes that `--live` must route to a real provider. Nested graphs live
 * in node config (`graph` / `body`), so the walk is structural rather than
 * typed: a body is only a GraphDocument after validation, which ran already.
 */
function liveModelNodes(graph: GraphDocument): { provider: LiveProvider; nodeId: string }[] {
  const found: { provider: LiveProvider; nodeId: string }[] = []
  const visit = (value: Json): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isJsonObject(value)) return
    if (value['type'] === 'z1.llm.model') {
      const config = value['config']
      const nodeId = value['id']
      if (isJsonObject(config) && typeof nodeId === 'string') {
        const provider = config['provider']
        if (typeof provider === 'string' && isLiveProvider(provider)) {
          found.push({ provider, nodeId })
        }
      }
    }
    for (const item of Object.values(value)) visit(item)
  }
  // GraphDocument has optional fields, so it is not structurally a Json value.
  visit(graph as unknown as Json)
  return found
}

/** A missing credential is reported before the run exists, not from a node. */
function missingLiveCredential(
  graph: GraphDocument,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const { provider, nodeId } of liveModelNodes(graph)) {
    const { apiKey } = PROVIDER_ENV[provider]
    if (!hasText(env[apiKey])) {
      return `missing ${apiKey} for provider "${provider}" (node "${nodeId}")\n`
    }
  }
  return undefined
}

function resolveBaseUrl(provider: LiveProvider, env: Record<string, string | undefined>): string {
  const spec = PROVIDER_ENV[provider]
  // One shared override wins so a whole run can be pointed at a gateway.
  for (const candidate of [env['Z1_OPENAI_BASE_URL'], env[spec.baseUrl]]) {
    if (hasText(candidate)) return candidate
  }
  return spec.defaultBaseUrl
}

/**
 * Routes each chat request by `model.provider`: river/openai go to the
 * OpenAI-compatible client, everything else keeps the deterministic mock.
 * The real client is built on the first request for that provider so a
 * mock-only graph never needs a credential.
 */
class LiveLlmRouter implements LlmService {
  readonly #mock: LlmService
  readonly #env: Record<string, string | undefined>
  readonly #live = new Map<LiveProvider, LlmService>()

  constructor(mock: LlmService, env: Record<string, string | undefined>) {
    this.#mock = mock
    this.#env = env
  }

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult> {
    const provider = request.model.provider
    if (!isLiveProvider(provider)) return await this.#mock.chat(request, onDelta)
    return await this.#service(provider).chat(request, onDelta)
  }

  #service(provider: LiveProvider): LlmService {
    const existing = this.#live.get(provider)
    if (existing !== undefined) return existing
    const spec = PROVIDER_ENV[provider]
    const apiKey = this.#env[spec.apiKey]
    if (!hasText(apiKey)) throw new Error(`missing ${spec.apiKey} for provider "${provider}"`)
    const created = createOpenAiLlmService({
      apiKey,
      baseURL: resolveBaseUrl(provider, this.#env),
    })
    this.#live.set(provider, created)
    return created
  }
}

function exitCodeFor(status: RunResult['status']): number {
  switch (status) {
    case 'completed':
      return 0
    case 'failed':
      return 1
    case 'cancelled':
      return 3
    case 'suspended':
      // Reserved by SPEC §8 for the M1 journal-backed resume flow.
      return 4
  }
}

function listCommand(args: readonly string[], io: CliIO): number {
  try {
    parseArgs({ args: [...args], options: {}, allowPositionals: false, strict: true })
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return usage(io)
  }

  for (const node of createBuiltinRegistry().list()) {
    io.stdout(`${node.id}  ${node.version}  ${node.category}  ${node.title}\n`)
  }
  return 0
}

async function validateCommand(args: readonly string[], io: CliIO): Promise<number> {
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {},
      allowPositionals: true,
      strict: true,
    })
    positionals = [...parsed.positionals]
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return usage(io)
  }

  const path = positionals[0]
  if (path === undefined || positionals.length > 1) return usage(io)

  let graph: GraphDocument
  try {
    graph = await loadGraph(path)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 2
  }

  const issues = validateGraphTree(graph, createBuiltinRegistry())
  if (issues.length === 0) {
    io.stdout(`ok: ${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges\n`)
    return 0
  }
  for (const issue of issues) io.stderr(`${issueLine(issue)}\n`)
  return 2
}

async function runCommand(args: readonly string[], io: CliIO): Promise<number> {
  let values: {
    input?: string
    'input-file'?: string
    json?: boolean
    trace?: boolean
    approve?: string
    db?: string
    suspend?: boolean
    resume?: string
    live?: boolean
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        input: { type: 'string' },
        'input-file': { type: 'string' },
        json: { type: 'boolean' },
        trace: { type: 'boolean' },
        approve: { type: 'string' },
        db: { type: 'string' },
        suspend: { type: 'boolean' },
        resume: { type: 'string' },
        live: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = [...parsed.positionals]
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return usage(io)
  }

  const path = positionals[0]
  if (path === undefined || positionals.length > 1) return usage(io)

  const approve = values.approve ?? 'auto'
  if (approve !== 'auto' && approve !== 'ask' && approve !== 'deny') {
    io.stderr(`invalid --approve "${approve}"; expected auto, ask or deny\n`)
    return usage(io)
  }

  if (values.input !== undefined && values['input-file'] !== undefined) {
    io.stderr('--input and --input-file are mutually exclusive\n')
    return usage(io)
  }

  let input: Json = null
  let graph: GraphDocument
  try {
    if (values.input !== undefined) input = parseJsonText(values.input, '--input')
    if (values['input-file'] !== undefined) {
      input = parseJsonText(
        await readTextFile(values['input-file']),
        `--input-file "${values['input-file']}"`,
      )
    }
    graph = await loadGraph(path)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 2
  }

  const registry = createBuiltinRegistry()
  const issues = validateGraphTree(graph, registry)
  if (issues.length > 0) {
    for (const issue of issues) io.stderr(`${issueLine(issue)}\n`)
    return 2
  }

  const env = io.env ?? process.env
  if (values.live === true) {
    const missing = missingLiveCredential(graph, env)
    if (missing !== undefined) {
      io.stderr(missing)
      return 1
    }
  }

  const dbPath = values.db ?? '.z1/runs.db'
  let journal: SqliteJournal
  try {
    journal = new SqliteJournal(dbPath)
  } catch (error) {
    io.stderr(`cannot open journal "${dbPath}": ${errorMessage(error)}\n`)
    return 1
  }

  const resume = values.resume
  const runId = resume ?? `run_${randomUUID()}`

  try {
    const now = Date.now()
    if (resume !== undefined) {
      if (journal.getRun(runId) === undefined) {
        io.stderr(`unknown run "${runId}"\n`)
        return 1
      }
      journal.updateRun(runId, { status: 'running', updatedAt: now })
    } else {
      journal.createRun({
        runId,
        graphId: graph.id,
        graphDigest: graphDigest(graph),
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
    }

    const services = createMockRuntimeServices({ approval: approvalBehavior(approve, io) })
    if (values.live === true) services.llm = new LiveLlmRouter(services.llm, env)
    if (values.trace === true) {
      services.onEvent = (event: RunEvent) => io.stderr(`${JSON.stringify(event)}\n`)
    }

    let result: RunResult
    try {
      result = await runGraph({
        graph,
        registry,
        services,
        input,
        journal,
        runId,
        ...(resume !== undefined ? { resume: true } : {}),
        ...(values.suspend === true ? { suspendOnApproval: true } : {}),
      })
    } catch (error) {
      journal.updateRun(runId, { status: 'failed', updatedAt: Date.now() })
      io.stderr(`run failed: ${errorMessage(error)}\n`)
      return 1
    }

    journal.updateRun(runId, { status: result.status, updatedAt: Date.now() })

    if (values.json === true) {
      io.stdout(
        `${JSON.stringify({
          runId: result.runId,
          status: result.status,
          outputs: result.outputs,
          ...(result.pendingApproval !== undefined
            ? { pendingApproval: result.pendingApproval }
            : {}),
        })}\n`,
      )
    } else {
      io.stdout(`status: ${result.status}\n`)
      // Partial outputs of a failed run are internal: replaying them as a result
      // would look like the graph produced them on purpose.
      if (result.status !== 'failed') {
        for (const [name, value] of Object.entries(result.outputs)) {
          io.stdout(`${name} = ${JSON.stringify(value)}\n`)
        }
      }
      if (result.status === 'suspended') io.stdout(`run: ${result.runId}\n`)
    }

    if (result.status === 'suspended' && result.pendingApproval !== undefined) {
      const request = result.pendingApproval.request
      const target = request.target === undefined ? '' : ` ${request.target}`
      io.stderr(`pending approval: ${request.action}${target}\n`)
    }

    if (result.status === 'failed' && result.error !== undefined) {
      io.stderr(`error: ${result.error}\n`)
    }
    return exitCodeFor(result.status)
  } catch (error) {
    io.stderr(`run failed: ${errorMessage(error)}\n`)
    return 1
  } finally {
    journal.close()
  }
}

async function treeCommand(args: readonly string[], io: CliIO): Promise<number> {
  let values: { db?: string; json?: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { db: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = [...parsed.positionals]
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return usage(io)
  }
  if (positionals.length > 0) return usage(io)

  const dbPath = values.db ?? '.z1/runs.db'
  let journal: SqliteJournal
  try {
    journal = new SqliteJournal(dbPath)
  } catch (error) {
    io.stderr(`cannot open journal "${dbPath}": ${errorMessage(error)}\n`)
    return 1
  }

  try {
    const runs = journal.listRuns()
    if (values.json === true) {
      io.stdout(`${JSON.stringify(runs)}\n`)
      return 0
    }
    for (const run of runs) {
      const digest = run.graphDigest.slice(0, 12)
      const created = new Date(run.createdAt).toISOString()
      const lineage =
        run.parentRunId === undefined
          ? ''
          : `  <- ${run.parentRunId}@${String(run.forkSeq ?? 0)}`
      io.stdout(
        `${run.runId}  ${run.status}  ${run.graphId}  ${digest}  ${created}${lineage}\n`,
      )
    }
    return 0
  } finally {
    journal.close()
  }
}

function isNodeStartedEvent(value: unknown): value is { type: 'node.started'; path: string } {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record['type'] === 'node.started' && typeof record['path'] === 'string'
}

/**
 * Sequence number of a `node.started` event inside the run's own numbering.
 * `SqliteJournal.read` merges the fork chain and drops sequence numbers, so a
 * read-only connection is used to find the exact index `fork` needs.
 */
function nodeStartedSeq(dbPath: string, runId: string, path: string): number | undefined {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    throw new Error(`cannot read events from "${dbPath}": ${errorMessage(error)}`)
  }
  try {
    const rows = db.prepare('SELECT seq, data FROM events WHERE run_id = ? ORDER BY seq').all(runId)
    for (const row of rows) {
      const seq = row['seq']
      const data = row['data']
      if (typeof seq !== 'number' || typeof data !== 'string') continue
      const event: unknown = JSON.parse(data)
      if (isNodeStartedEvent(event) && event.path === path) return seq
    }
    return undefined
  } finally {
    db.close()
  }
}

async function forkCommand(args: readonly string[], io: CliIO): Promise<number> {
  let values: { at?: string; db?: string; json?: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        at: { type: 'string' },
        db: { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = [...parsed.positionals]
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return usage(io)
  }

  const sourceId = positionals[0]
  if (sourceId === undefined || positionals.length > 1) return usage(io)
  const at = values.at
  if (at === undefined) {
    io.stderr('--at <nodePath|seq> is required\n')
    return usage(io)
  }

  const dbPath = values.db ?? '.z1/runs.db'
  let journal: SqliteJournal
  try {
    journal = new SqliteJournal(dbPath)
  } catch (error) {
    io.stderr(`cannot open journal "${dbPath}": ${errorMessage(error)}\n`)
    return 1
  }

  try {
    if (journal.getRun(sourceId) === undefined) {
      io.stderr(`unknown run "${sourceId}"\n`)
      return 1
    }

    let atSeq: number
    if (/^\d+$/.test(at)) {
      atSeq = Number(at)
    } else {
      let seq: number | undefined
      try {
        seq = nodeStartedSeq(dbPath, sourceId, at)
      } catch (error) {
        io.stderr(`${errorMessage(error)}\n`)
        return 1
      }
      if (seq === undefined) {
        io.stderr(`no node.started event with path "${at}" in run "${sourceId}"\n`)
        return 1
      }
      // The forking run must re-execute the node, so fork before it started.
      atSeq = seq - 1
    }

    const newId = `run_${randomUUID()}`
    journal.fork(sourceId, atSeq, newId)
    if (values.json === true) {
      io.stdout(`${JSON.stringify({ runId: newId, parentRunId: sourceId, forkSeq: atSeq })}\n`)
    } else {
      io.stdout(`${newId}\n`)
    }
    return 0
  } catch (error) {
    io.stderr(`cannot fork "${sourceId}": ${errorMessage(error)}\n`)
    return 1
  } finally {
    journal.close()
  }
}

/** Entry point shared by the bin and the tests; never exits the process. */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined) return usage(io)

  switch (command) {
    case 'list':
      return listCommand(rest, io)
    case 'validate':
      return await validateCommand(rest, io)
    case 'run':
      return await runCommand(rest, io)
    case 'tree':
      return await treeCommand(rest, io)
    case 'fork':
      return await forkCommand(rest, io)
    default:
      io.stderr(`unknown command "${command}"\n`)
      return usage(io)
  }
}
