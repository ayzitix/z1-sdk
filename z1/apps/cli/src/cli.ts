import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  builtinRegistry,
  createRuntime,
  createTemplateRegistry,
  exportCassette,
  loadRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
} from '@z1/bootstrap'
import {
  graphDigest,
  parseGraph,
  validateGraphTree,
  type GraphDocument,
  type ValidationIssue,
} from '@z1/graph'
import {
  ModuleStore,
  serviceMode,
  type ModuleCapabilities,
  type ModuleServiceDeclaration,
} from '@z1/module'
import { formatCassette } from '@z1/runtime'
import { evalCommand } from './eval.ts'
import type { ModelInfo } from '@z1/node'
import type { SequencedEvent } from '@z1/journal'
import {
  MOCK_PROVIDER,
  resolveApiKey,
  type ProviderRegistry,
} from '@z1/provider'
import { startServer, type Z1Server } from '@z1/server'
import {
  runGraph,
  type ApprovalService,
  type MockApprovalBehavior,
  type RunEvent,
  type RunResult,
} from '@z1/runtime'
import type { Json, ModelHandle } from '@z1/node'
import type { TemplateContext } from '@z1/template'

/** Everything the CLI is allowed to touch outside the graph itself. */
export interface CliIO {
  stdout(s: string): void
  stderr(s: string): void
  isTTY: boolean
  /** Credential source; the bin passes `process.env`, tests pass a stub. */
  env?: Record<string, string | undefined>
  /**
   * Project directory the command treats as its workspace, i.e. the directory
   * the caller invoked the CLI from. Defaults to `process.cwd()`.
   *
   * The bin supplies it because `pnpm` runs a workspace script with the
   * package root as `process.cwd()`, so the caller's directory only survives
   * as `INIT_CWD`. Tests set it directly to stay independent of how they run.
   */
  cwd?: string
}

const USAGE = [
  'usage: z1 <command> [options]',
  '',
  'commands:',
  '  list',
  '  validate <graph.json>',
  '  run <graph.json> [--input <json> | --message <text>] [--input-file <path>] [--json] [--trace]',
  '      [--approve auto|ask|deny] [--module-approve auto|ask|deny] [--db <path>]',
  '      [--suspend] [--resume <runId>] [--live] [--cassette <file>]',
  '      [--modules-dir <path>] [--no-modules] [--no-service-modules] [--no-memory]',
  '      [--cwd <path>]',
  '  run --template <id> [--model <provider/model>] [--provider <id>] [--role <id>]',
  '      [--max-steps <n>] [--system <text>] [--budget-tokens <n>] [--json] [--db <path>]',
  '  template list [--templates-dir <path>] [--json]',
  '  tree [--db <path>] [--json]',
  '  cassette export <runId> [-o <file>] [--db <path>]',
  '  models [provider] [--json] [--db <path>]',
  '      discover models live from the provider (GET {baseURL}/models); nothing is stored',
  '  eval <case.json|dir> [--live] [--cassette <file>] [--json] [--jobs N] [--max-steps N]',
  '      [--workspace <dir>] [--keep] [--no-memory]',
  '  memory context <runId> [--db <path>] [--json]',
  '  fork <runId> --at <nodePath|seq> [--db <path>] [--json]',
  '  serve [--host <host>] [--port <port>] [--db <path>] [--token <token>] [--live] [--json]',
  '      [--modules-dir <path>] [--templates-dir <path>] [--no-service-modules]',
  '  studio [--host <host>] [--port <port>] [--db <path>] [--graphs-dir <path>]',
  '      [--modules-dir <path>] [--templates-dir <path>] [--token <token>] [--live] [--no-open]',
  '      [--no-service-modules] [--json]',
  '  module list [--modules-dir <path>] [--json]',
  '  module propose <dir> [--modules-dir <path>] [--json]',
  '  module approve <id>[@<version>] [--future] [--modules-dir <path>] [--json]',
  '  module rollback <id> [--modules-dir <path>] [--json]',
  '  module audit [--modules-dir <path>] [--json]',
  '',
].join('\n')

type ApproveMode = 'auto' | 'ask' | 'deny'

function isApproveMode(value: string): value is ApproveMode {
  return value === 'auto' || value === 'ask' || value === 'deny'
}

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

/**
 * The project directory a command roots its runtime config in: the caller's
 * directory, not the package root `pnpm` runs the script from. `--cwd` wins
 * over the inherited value, so a scripted run can name its workspace outright.
 */
function projectDirectory(io: CliIO, flag?: string): string {
  if (flag !== undefined) return resolve(flag)
  return io.cwd ?? process.cwd()
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

/**
 * Resolve a module directory the way graph paths resolve: relative to the
 * working directory, then its ancestors. The `z1` script runs from `z1/` while
 * the documented commands pass repo-root relative paths.
 */
function resolveExistingDirectory(path: string): string {
  if (isAbsolute(path)) return path
  let directory = process.cwd()
  while (true) {
    const candidate = join(directory, path)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return path
    directory = parent
  }
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

/**
 * Module code asks for approval through its own policy. `--approve` describes
 * node autonomy, so a graph-wide `auto` must not silently grant module code the
 * right to act; `--module-approve` defaults to asking.
 */
function moduleApprovalService(mode: ApproveMode, io: CliIO): ApprovalService {
  const behavior = approvalBehavior(mode, io)
  return {
    async request(request) {
      if (typeof behavior === 'function') {
        return await behavior(request, { runId: 'module', nodeId: 'module' })
      }
      return behavior
    },
  }
}

function isJsonObject(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}

/** The provider a model node's config names, if it names one at all. */
function nodeProvider(
  type: Json | undefined,
  config: Record<string, Json>,
): string | undefined {
  if (type === 'z1.llm.model') {
    const provider = config['provider']
    return typeof provider === 'string' ? provider : undefined
  }
  if (type === 'z1.llm.chat') {
    const model = config['model']
    if (!isJsonObject(model)) return undefined
    const provider = model['provider']
    return typeof provider === 'string' ? provider : undefined
  }
  return undefined
}

/**
 * Model nodes that `--live` must route to a real provider. Nested graphs live
 * in node config (`graph` / `body`), so the walk is structural rather than
 * typed: a body is only a GraphDocument after validation, which ran already.
 */
function liveModelNodes(graph: GraphDocument): { provider: string; nodeId: string }[] {
  const found: { provider: string; nodeId: string }[] = []
  const visit = (value: Json): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isJsonObject(value)) return
    const config = value['config']
    const nodeId = value['id']
    if (isJsonObject(config) && typeof nodeId === 'string') {
      const provider = nodeProvider(value['type'], config)
      if (provider !== undefined && provider !== MOCK_PROVIDER) {
        found.push({ provider, nodeId })
      }
    }
    for (const item of Object.values(value)) visit(item)
  }
  // GraphDocument has optional fields, so it is not structurally a Json value.
  visit(graph as unknown as Json)
  return found
}

/** A missing or unknown provider is reported before the run exists, not from a node. */
function missingLiveCredential(
  graph: GraphDocument,
  providers: ProviderRegistry,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const { provider, nodeId } of liveModelNodes(graph)) {
    const config = providers.configs().find((candidate) => candidate.id === provider)
    if (!providers.has(provider) || config === undefined) {
      return `unknown provider "${provider}" (node "${nodeId}"); add it to Z1_PROVIDERS or set --live off\n`
    }
    if (resolveApiKey(config, env) === undefined) {
      return `missing ${config.envKey} for provider "${provider}" (node "${nodeId}")\n`
    }
  }
  return undefined
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

  for (const node of builtinRegistry().list()) {
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

  const issues = validateGraphTree(graph, builtinRegistry())
  if (issues.length === 0) {
    io.stdout(`ok: ${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges\n`)
    return 0
  }
  for (const issue of issues) io.stderr(`${issueLine(issue)}\n`)
  return 2
}

const MODULE_COMMANDS = ['list', 'propose', 'approve', 'rollback', 'audit'] as const

interface ModuleCommandValues {
  json?: boolean
  future?: boolean
  'modules-dir'?: string
}

/**
 * Module commands resolve their store through the same config as `run`, so
 * `--modules-dir`, `Z1_MODULES_DIR`, `z1.config.json` and the built-in default
 * have exactly one definition (in `@z1/bootstrap`), not a second copy here.
 */
function openModuleStore(values: ModuleCommandValues, io: CliIO): ModuleStore | undefined {
  let directory: string
  try {
    directory = loadRuntimeConfig({
      cwd: projectDirectory(io),
      env: io.env ?? process.env,
      overrides:
        values['modules-dir'] === undefined ? {} : { modulesPath: values['modules-dir'] },
    }).modulesPath
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return undefined
  }
  try {
    return new ModuleStore(directory)
  } catch (error) {
    io.stderr(`cannot open module store "${directory}": ${errorMessage(error)}\n`)
    return undefined
  }
}

/** How many declared patterns one capability line shows before eliding. */
const CAPABILITY_PATTERNS_SHOWN = 3
/** Longest single declaration printed before it is cut with an ellipsis. */
const CAPABILITY_PATTERN_WIDTH = 48

/**
 * An approval prompt is the user's only chance to see what they are granting,
 * so a count (`fs.read[1]`) is useless: print the declarations themselves,
 * briefly truncated. `${moduleDir}` is kept as written because that is the
 * portable spelling the manifest author chose.
 */
function declarationList(values: readonly string[]): string {
  const shown = values
    .slice(0, CAPABILITY_PATTERNS_SHOWN)
    .map((value) =>
      value.length <= CAPABILITY_PATTERN_WIDTH
        ? value
        : `${value.slice(0, CAPABILITY_PATTERN_WIDTH - 1)}…`,
    )
  const hidden = values.length - shown.length
  return hidden > 0 ? `${shown.join(', ')} (+${String(hidden)} more)` : shown.join(', ')
}

function spendSummary(spend: NonNullable<ModuleCapabilities['spend']>): string {
  const amounts: string[] = []
  if (spend.perCall !== undefined) amounts.push(`${spend.currency} ${String(spend.perCall)}/call`)
  if (spend.perRun !== undefined) amounts.push(`${spend.currency} ${String(spend.perRun)}/run`)
  return amounts.length === 0 ? spend.currency : amounts.join(', ')
}

/** Human-readable capability grant, also used by `module list`. */
function capabilitySummary(capabilities: ModuleCapabilities | undefined): string {
  const parts: string[] = []
  const read = capabilities?.fs?.read ?? []
  const write = capabilities?.fs?.write ?? []
  if (read.length > 0) parts.push(`fs.read: ${declarationList(read)}`)
  if (write.length > 0) parts.push(`fs.write: ${declarationList(write)}`)
  const hosts = capabilities?.net?.hosts ?? []
  if (hosts.length > 0) parts.push(`net: ${declarationList(hosts)}`)
  const spawn = capabilities?.process?.spawn ?? []
  if (spawn.length > 0) parts.push(`process: ${declarationList(spawn)}`)
  if (capabilities?.spend !== undefined) parts.push(`spend: ${spendSummary(capabilities.spend)}`)
  const secrets = capabilities?.secrets ?? []
  if (secrets.length > 0) parts.push(`secrets: ${declarationList(secrets)}`)
  return parts.length > 0 ? parts.join('  ') : 'none'
}

/** `services: llm(worker), tools(host)`; absent when the module declares none. */
function serviceSummary(services: readonly ModuleServiceDeclaration[] | undefined): string {
  return (services ?? []).map((service) => `${service.kind}(${serviceMode(service)})`).join(', ')
}

function splitModuleSpec(spec: string): { moduleId: string; version?: string } {
  const separator = spec.lastIndexOf('@')
  if (separator > 0 && separator < spec.length - 1) {
    return { moduleId: spec.slice(0, separator), version: spec.slice(separator + 1) }
  }
  return { moduleId: spec }
}

async function moduleCommand(args: readonly string[], io: CliIO): Promise<number> {
  const [subcommand, ...rest] = args
  switch (subcommand) {
    case 'list':
      return moduleListCommand(rest, io)
    case 'propose':
      return await moduleProposeCommand(rest, io)
    case 'approve':
      return moduleApproveCommand(rest, io)
    case 'rollback':
      return moduleRollbackCommand(rest, io)
    case 'audit':
      return moduleAuditCommand(rest, io)
    case undefined:
      io.stderr(`module requires one of: ${MODULE_COMMANDS.join(', ')}\n`)
      return usage(io)
    default:
      io.stderr(`unknown module subcommand "${subcommand}"\n`)
      return usage(io)
  }
}

function parseModuleArgs(
  args: readonly string[],
  io: CliIO,
): { values: ModuleCommandValues; positionals: string[] } | undefined {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        json: { type: 'boolean' },
        future: { type: 'boolean' },
        'modules-dir': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    return { values: parsed.values, positionals: [...parsed.positionals] }
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    usage(io)
    return undefined
  }
}

function moduleListCommand(args: readonly string[], io: CliIO): number {
  const parsed = parseModuleArgs(args, io)
  if (parsed === undefined) return 2
  if (parsed.positionals.length > 0) return usage(io)

  const store = openModuleStore(parsed.values, io)
  if (store === undefined) return 1

  let modules: ReturnType<ModuleStore['list']>
  try {
    modules = store.list()
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }

  if (parsed.values.json === true) {
    io.stdout(
      `${JSON.stringify(
        modules.map((module) => ({
          id: module.manifest.id,
          version: module.manifest.version,
          active: module.active,
          integrity: module.integrity,
          directory: module.directory,
          // The grant is the authority: the manifest is only a request.
          capabilities: module.grant.capabilities,
          services: module.grant.services,
        })),
      )}\n`,
    )
    return 0
  }

  if (modules.length === 0) {
    io.stdout('no modules installed\n')
    return 0
  }
  for (const module of modules) {
    const state = module.active ? 'active' : 'inactive'
    const services = serviceSummary(module.grant.services)
    const servicePart = services === '' ? '' : `  services: ${services}`
    io.stdout(
      `${module.manifest.id}@${module.manifest.version}  ${state}  ${module.integrity.slice(0, 12)}  ${capabilitySummary(module.grant.capabilities)}${servicePart}\n`,
    )
  }
  return 0
}

async function moduleProposeCommand(args: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseModuleArgs(args, io)
  if (parsed === undefined) return 2
  const directory = parsed.positionals[0]
  if (directory === undefined || parsed.positionals.length > 1) return usage(io)

  const store = openModuleStore(parsed.values, io)
  if (store === undefined) return 1

  let proposed: ReturnType<ModuleStore['propose']>
  try {
    proposed = store.propose(resolveExistingDirectory(directory))
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }

  if (parsed.values.json === true) {
    io.stdout(`${JSON.stringify(proposed)}\n`)
    return 0
  }

  const { manifest } = proposed
  const moduleSpec = `${manifest.id}@${manifest.version}`
  io.stdout(`proposed ${moduleSpec}\n`)
  io.stdout(`title: ${manifest.title}\n`)
  io.stdout(`nodes: ${manifest.nodes.map((node) => `${node.id}@${node.version}`).join(', ')}\n`)
  const services = serviceSummary(manifest.services)
  if (services !== '') io.stdout(`services: ${services}\n`)
  io.stdout(`capabilities: ${capabilitySummary(manifest.capabilities)}\n`)
  io.stdout(`integrity: ${proposed.integrity}\n`)
  io.stdout(`directory: ${proposed.directory}\n`)
  io.stdout(`next: z1 module approve ${moduleSpec}\n`)
  return 0
}

function moduleApproveCommand(args: readonly string[], io: CliIO): number {
  const parsed = parseModuleArgs(args, io)
  if (parsed === undefined) return 2
  const spec = parsed.positionals[0]
  if (spec === undefined || parsed.positionals.length > 1) return usage(io)

  const store = openModuleStore(parsed.values, io)
  if (store === undefined) return 1

  const { moduleId, version } = splitModuleSpec(spec)
  let proposals: ReturnType<ModuleStore['proposals']>
  try {
    proposals = store.proposals()
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }

  const matching = proposals.filter((proposal) => proposal.manifest.id === moduleId)
  const proposal =
    version === undefined
      ? matching[matching.length - 1]
      : matching.find((candidate) => candidate.manifest.version === version)
  if (proposal === undefined) {
    io.stderr(
      version === undefined
        ? `module "${moduleId}" has no proposal\n`
        : `module "${moduleId}"@${version} has no proposal\n`,
    )
    return 1
  }

  const chosen = proposal.manifest.version
  const futureVersions = parsed.values.future === true
  let installed: ReturnType<ModuleStore['approve']>
  try {
    installed = store.approve(moduleId, chosen, { futureVersions })
    // Approving makes the version the one `run` loads; the store itself keeps
    // activation explicit so a silent install cannot change a run.
    installed = store.activate(moduleId, chosen)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }

  if (parsed.values.json === true) {
    io.stdout(
      `${JSON.stringify({
        moduleId,
        version: chosen,
        integrity: installed.integrity,
        capabilities: installed.grant.capabilities,
        services: installed.grant.services,
        futureVersions,
        active: installed.active,
        directory: installed.directory,
      })}\n`,
    )
    return 0
  }

  io.stdout(`approved ${moduleId}@${chosen}\n`)
  io.stdout(`grant: ${capabilitySummary(installed.grant.capabilities)}\n`)
  const services = serviceSummary(installed.grant.services)
  if (services !== '') io.stdout(`services: ${services}\n`)
  io.stdout(`integrity: ${installed.integrity}\n`)
  io.stdout(`installed: ${installed.directory}\n`)
  return 0
}

function moduleRollbackCommand(args: readonly string[], io: CliIO): number {
  const parsed = parseModuleArgs(args, io)
  if (parsed === undefined) return 2
  const moduleId = parsed.positionals[0]
  if (moduleId === undefined || parsed.positionals.length > 1) return usage(io)

  const store = openModuleStore(parsed.values, io)
  if (store === undefined) return 1

  let rolledBack: ReturnType<ModuleStore['rollback']>
  try {
    rolledBack = store.rollback(moduleId)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }
  if (rolledBack === undefined) {
    io.stderr(`no earlier version of "${moduleId}" to roll back to\n`)
    return 1
  }

  if (parsed.values.json === true) {
    io.stdout(
      `${JSON.stringify({
        moduleId,
        version: rolledBack.manifest.version,
        integrity: rolledBack.integrity,
        directory: rolledBack.directory,
      })}\n`,
    )
    return 0
  }
  io.stdout(`rolled back ${moduleId} to ${rolledBack.manifest.version}\n`)
  return 0
}

function moduleAuditCommand(args: readonly string[], io: CliIO): number {
  const parsed = parseModuleArgs(args, io)
  if (parsed === undefined) return 2
  if (parsed.positionals.length > 0) return usage(io)

  const store = openModuleStore(parsed.values, io)
  if (store === undefined) return 1

  let entries: ReturnType<ModuleStore['audit']>
  try {
    entries = store.audit()
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }

  if (parsed.values.json === true) {
    io.stdout(`${JSON.stringify(entries)}\n`)
    return 0
  }
  for (const entry of entries) {
    const detail = entry.detail === undefined ? '' : JSON.stringify(entry.detail)
    io.stdout(
      `${String(entry.seq)}  ${entry.type}  ${entry.moduleId}@${entry.version}  ${detail}\n`,
    )
  }
  return 0
}

/** Graph nodes approve through the service `--approve` configures. */
function nodeApprovalService(behavior: MockApprovalBehavior): ApprovalService {
  return {
    async request(request, context) {
      if (typeof behavior === 'function') return await behavior(request, context)
      return behavior
    },
  }
}

/** `parseArgs` hands back strings, so a numeric flag is validated as a string. */
function positiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`${flag} must be a positive integer, got "${value}"`)
  }
  return Number(value)
}

/**
 * `--model provider/model` splits on the first `/`, `--provider <id>` names the
 * provider alone, and either may omit the provider (then `mock`). With neither
 * flag the template keeps its own default model.
 */
function templateModel(values: { model?: string; provider?: string }): ModelHandle | undefined {
  if (values.model === undefined && values.provider === undefined) return undefined

  let provider = values.provider
  if (provider === '') throw new UsageError('--provider must not be empty')

  let model = 'mock-1'
  const spec = values.model
  if (spec !== undefined) {
    const slash = spec.indexOf('/')
    if (slash >= 0) {
      const named = spec.slice(0, slash)
      model = spec.slice(slash + 1)
      if (named === '' || model === '') {
        throw new UsageError(`invalid --model "${spec}"; expected <provider>/<model>`)
      }
      provider ??= named
    } else {
      if (spec === '') throw new UsageError('--model must not be empty')
      model = spec
    }
  }

  return { provider: provider ?? 'mock', model }
}

function templateListCommand(args: readonly string[], io: CliIO): number {
  let values: { json?: boolean; 'templates-dir'?: string }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { json: { type: 'boolean' }, 'templates-dir': { type: 'string' } },
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

  let config: RuntimeConfig
  try {
    config = loadRuntimeConfig({
      cwd: projectDirectory(io),
      env: io.env ?? process.env,
      overrides:
        values['templates-dir'] === undefined
          ? {}
          : { templatesPath: values['templates-dir'] },
    })
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }

  let templates
  try {
    templates = createTemplateRegistry(config).list()
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }

  if (values.json === true) {
    io.stdout(`${JSON.stringify(templates)}\n`)
    return 0
  }
  if (templates.length === 0) {
    io.stdout('no templates\n')
    return 0
  }
  for (const template of templates) {
    io.stdout(`${template.id}@${template.version}  ${template.title}\n`)
  }
  return 0
}

function templateCommand(args: readonly string[], io: CliIO): number {
  const [subcommand, ...rest] = args
  if (subcommand === 'list') return templateListCommand(rest, io)
  io.stderr(`template requires: list\n`)
  return usage(io)
}

async function runCommand(args: readonly string[], io: CliIO): Promise<number> {
  let values: {
    input?: string
    message?: string
    'input-file'?: string
    json?: boolean
    trace?: boolean
    approve?: string
    'module-approve'?: string
    db?: string
    suspend?: boolean
    resume?: string
    live?: boolean
    'modules-dir'?: string
    'no-modules'?: boolean
    'no-service-modules'?: boolean
    'no-memory'?: boolean
    template?: string
    model?: string
    provider?: string
    role?: string
    'max-steps'?: string
    system?: string
    'budget-tokens'?: string
    'templates-dir'?: string
    cwd?: string
    cassette?: string
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        input: { type: 'string' },
        message: { type: 'string' },
        'input-file': { type: 'string' },
        json: { type: 'boolean' },
        trace: { type: 'boolean' },
        approve: { type: 'string' },
        'module-approve': { type: 'string' },
        db: { type: 'string' },
        suspend: { type: 'boolean' },
        resume: { type: 'string' },
        live: { type: 'boolean' },
        'modules-dir': { type: 'string' },
        'no-modules': { type: 'boolean' },
        'no-service-modules': { type: 'boolean' },
        'no-memory': { type: 'boolean' },
        template: { type: 'string' },
        model: { type: 'string' },
        provider: { type: 'string' },
        role: { type: 'string' },
        'max-steps': { type: 'string' },
        system: { type: 'string' },
        'budget-tokens': { type: 'string' },
        'templates-dir': { type: 'string' },
        cwd: { type: 'string' },
        cassette: { type: 'string' },
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

  const templateId = values.template
  const path = positionals[0]
  if (positionals.length > 1) return usage(io)
  if (templateId !== undefined) {
    if (path !== undefined) {
      io.stderr('a graph file and --template are mutually exclusive\n')
      return 2
    }
  } else if (path === undefined) {
    return usage(io)
  }

  const approve = values.approve ?? 'auto'
  if (!isApproveMode(approve)) {
    io.stderr(`invalid --approve "${approve}"; expected auto, ask or deny\n`)
    return usage(io)
  }

  const moduleApprove = values['module-approve'] ?? 'ask'
  if (!isApproveMode(moduleApprove)) {
    io.stderr(
      `invalid --module-approve "${moduleApprove}"; expected auto, ask or deny\n`,
    )
    return usage(io)
  }

  if (values.cwd === '') {
    io.stderr('--cwd must not be empty\n')
    return usage(io)
  }

  if (
    values.message !== undefined &&
    (values.input !== undefined || values['input-file'] !== undefined)
  ) {
    io.stderr('--message and --input/--input-file are mutually exclusive\n')
    return usage(io)
  }

  if (values.input !== undefined && values['input-file'] !== undefined) {
    io.stderr('--input and --input-file are mutually exclusive\n')
    return usage(io)
  }

  // These flags describe the graph a template builds; with a graph file they
  // would be silently ignored, which reads as "the flag did not work".
  if (templateId === undefined) {
    const templateOnly = [
      'model',
      'provider',
      'role',
      'max-steps',
      'system',
      'budget-tokens',
    ] as const
    const used = templateOnly.filter((name) => values[name] !== undefined)
    if (used.length > 0) {
      io.stderr(
        `${used.map((name) => `--${name}`).join(', ')} requires --template\n`,
      )
      return usage(io)
    }
  }

  let model: ModelHandle | undefined
  let maxSteps: number | undefined
  let budgetTokens: number | undefined
  try {
    if (values['max-steps'] !== undefined) {
      maxSteps = positiveInt(values['max-steps'], '--max-steps')
    }
    if (values['budget-tokens'] !== undefined) {
      budgetTokens = positiveInt(values['budget-tokens'], '--budget-tokens')
    }
    if (templateId !== undefined) model = templateModel(values)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return usage(io)
  }

  // `undefined` means "the caller supplied no input": a resumed run must then
  // reuse the seed recorded in its own journal, which a `null` would hide.
  let input: Json | undefined
  let graph: GraphDocument | undefined
  try {
    if (values.message !== undefined) {
      // Plain text, never parsed: `--message '{"a":1}'` is the string itself.
      input = values.message
    }
    if (values.input !== undefined) input = parseJsonText(values.input, '--input')
    if (values['input-file'] !== undefined) {
      input = parseJsonText(
        await readTextFile(values['input-file']),
        `--input-file "${values['input-file']}"`,
      )
    }
    if (path !== undefined) graph = await loadGraph(path)
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 2
  }

  const env = io.env ?? process.env

  let config: RuntimeConfig
  try {
    config = loadRuntimeConfig({
      cwd: projectDirectory(io, values.cwd),
      env,
      overrides: {
        ...(values.db === undefined ? {} : { dbPath: values.db }),
        ...(values['modules-dir'] === undefined ? {} : { modulesPath: values['modules-dir'] }),
        ...(values['templates-dir'] === undefined
          ? {}
          : { templatesPath: values['templates-dir'] }),
        ...(values.live === undefined ? {} : { live: values.live }),
        ...(values['no-modules'] === true ? { useModules: false } : {}),
        ...(values['no-service-modules'] === true ? { useServiceModules: false } : {}),
        ...(values['no-memory'] === true ? { useMemory: false } : {}),
        ...(values.cassette === undefined ? {} : { cassette: resolve(values.cassette) }),
      },
    })
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return 1
  }

  if (
    model !== undefined &&
    model.provider !== MOCK_PROVIDER &&
    !config.live &&
    config.cassette === undefined
  ) {
    // Routing to a named provider is what `--live` turns on. Without it the
    // run uses the deterministic mock, so say so instead of pretending.
    io.stderr(
      `model "${model.provider}/${model.model}" ignored without --live; using mock\n`,
    )
  }

  let runtime: Runtime
  try {
    runtime = await createRuntime(config)
  } catch (error) {
    io.stderr(`cannot start runtime: ${errorMessage(error)}\n`)
    return 1
  }

  try {
    if (graph === undefined) {
      if (templateId === undefined) {
        io.stderr('a graph file or --template is required\n')
        return usage(io)
      }
      const context: TemplateContext = {
        ...(model === undefined ? {} : { model }),
        ...(values.role === undefined ? {} : { role: values.role }),
        ...(maxSteps === undefined ? {} : { maxSteps }),
        ...(values.system === undefined ? {} : { system: values.system }),
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
      }
      try {
        graph = runtime.templates.build(templateId, context)
      } catch (error) {
        io.stderr(`${errorMessage(error)}\n`)
        return 1
      }
    }

    const issues = validateGraphTree(graph, runtime.registry)
    if (issues.length > 0) {
      for (const issue of issues) io.stderr(`${issueLine(issue)}\n`)
      return 2
    }

    if (config.live && config.cassette === undefined) {
      const missing = missingLiveCredential(graph, runtime.providers, config.env)
      if (missing !== undefined) {
        io.stderr(missing)
        return 1
      }
    }

    const journal = runtime.journal
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

      let handle
      try {
        handle = await runtime.beginRun({
          runId,
          approval: nodeApprovalService(approvalBehavior(approve, io)),
          // Module code asks under its own policy: `--approve auto` describes
          // node autonomy and must not silently grant it.
          moduleApproval: moduleApprovalService(moduleApprove, io),
          // `--no-modules` and `--no-service-modules` are per-run decisions:
          // the same process may serve a later run that wants modules.
          ...(values['no-modules'] === true || values['no-service-modules'] === true
            ? { useServiceModules: false }
            : {}),
          ...(values.trace === true
            ? { onEvent: (event: RunEvent) => io.stderr(`${JSON.stringify(event)}\n`) }
            : {}),
        })
      } catch (error) {
        journal.updateRun(runId, { status: 'failed', updatedAt: Date.now() })
        io.stderr(`cannot load modules: ${errorMessage(error)}\n`)
        return 1
      }

      let result: RunResult
      try {
        result = await runGraph({
          graph,
          registry: handle.registry,
          services: handle.services,
          ...(input === undefined ? {} : { input }),
          journal,
          runId,
          ...(resume !== undefined ? { resume: true } : {}),
          ...(values.suspend === true ? { suspendOnApproval: true } : {}),
        })
      } catch (error) {
        journal.updateRun(runId, { status: 'failed', updatedAt: Date.now() })
        io.stderr(`run failed: ${errorMessage(error)}\n`)
        return 1
      } finally {
        await handle.dispose()
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
        // A resume refusal is already a self-describing `RESUME_MISMATCH: …`
        // line; printing it unadorned keeps it copy-pasteable for the user.
        io.stderr(
          result.error.startsWith('RESUME_MISMATCH')
            ? `${result.error}\n`
            : `error: ${result.error}\n`,
        )
      }
      return exitCodeFor(result.status)
    } catch (error) {
      io.stderr(`run failed: ${errorMessage(error)}\n`)
      return 1
    }
  } finally {
    await runtime.close()
  }
}

/**
 * A runtime for commands that only read the journal. `createRuntime` owns the
 * journal/module-store wiring, so these commands never assemble it themselves.
 */
async function openRuntime(
  io: CliIO,
  overrides: Partial<RuntimeConfig>,
): Promise<Runtime | undefined> {
  try {
    return await createRuntime(
      loadRuntimeConfig({
        cwd: projectDirectory(io),
        env: io.env ?? process.env,
        overrides,
      }),
    )
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`)
    return undefined
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

  const runtime = await openRuntime(io, {
    ...(values.db === undefined ? {} : { dbPath: values.db }),
    useMemory: false,
    useModules: false,
  })
  if (runtime === undefined) return 1

  try {
    const runs = runtime.journal.listRuns()
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
    await runtime.close()
  }
}

/** `z1 memory context <runId>`: what a resumed graph would be told about itself. */
async function memoryContextCommand(args: readonly string[], io: CliIO): Promise<number> {
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

  const runId = positionals[0]
  if (runId === undefined || positionals.length > 1) return usage(io)

  const runtime = await openRuntime(io, {
    ...(values.db === undefined ? {} : { dbPath: values.db }),
    useMemory: true,
    useModules: false,
  })
  if (runtime === undefined) return 1

  try {
    if (runtime.journal.getRun(runId) === undefined) {
      io.stderr(`unknown run "${runId}"\n`)
      return 1
    }
    const memory = runtime.memory
    if (memory === undefined) {
      io.stderr('memory is disabled\n')
      return 1
    }
    const envelope = await memory.buildContext({ runId })
    if (values.json === true) io.stdout(`${JSON.stringify(envelope)}\n`)
    else if (envelope.text !== '') io.stdout(`${envelope.text}\n`)
    return 0
  } finally {
    await runtime.close()
  }
}

async function memoryCommand(args: readonly string[], io: CliIO): Promise<number> {
  const [subcommand, ...rest] = args
  if (subcommand === 'context') return await memoryContextCommand(rest, io)
  io.stderr(`unknown memory command "${subcommand ?? ''}"\n`)
  return usage(io)
}

function isNodeStartedEvent(value: unknown): value is { type: 'node.started'; path: string } {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record['type'] === 'node.started' && typeof record['path'] === 'string'
}

/**
 * Sequence number of the first `node.started` event for `path` in the run's own
 * numbering. `SqliteJournal.read` merges the fork chain and drops sequence
 * numbers, so the journal exposes `ownedEvents` for exactly this lookup.
 */
function nodeStartedSeq(
  events: readonly SequencedEvent[],
  path: string,
): number | undefined {
  for (const { seq, event } of events) {
    if (isNodeStartedEvent(event) && event.path === path) return seq
  }
  return undefined
}

/**
 * `z1 models [provider]`: what the provider actually serves right now.
 *
 * Discovery is a request, not a catalogue: nothing is written to disk, and a
 * provider without a key or without `/models` is reported next to the ones that
 * answered.
 */
async function modelsCommand(args: readonly string[], io: CliIO): Promise<number> {
  let values: { json?: boolean; db?: string }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        json: { type: 'boolean' },
        db: { type: 'string' },
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

  if (positionals.length > 1) {
    io.stderr('usage: z1 models [provider] [--json] [--db <path>]\n')
    return 2
  }

  // Listing is read-only and inherently live: asking a provider what it serves
  // must not be routed through the deterministic mock.
  const runtime = await openRuntime(io, {
    ...(values.db === undefined ? {} : { dbPath: values.db }),
    useMemory: false,
    useModules: false,
    live: true,
  })
  if (runtime === undefined) return 1

  try {
    const discover = runtime.llm.listModels?.bind(runtime.llm)
    if (discover === undefined) {
      io.stderr('this runtime has no model discovery (the mock backend lists nothing)\n')
      return 1
    }

    const configured = runtime.providers.configs().map((config) => config.id)
    const requested = positionals[0]
    if (requested !== undefined && !configured.includes(requested)) {
      io.stderr(
        `provider "${requested}" is not configured; known: ${configured.join(', ')}\n`,
      )
      return 1
    }
    const ids = requested === undefined ? configured : [requested]

    const rows: { provider: string; models?: readonly ModelInfo[]; error?: string }[] = []
    for (const provider of ids) {
      try {
        rows.push({ provider, models: await discover({ provider }) })
      } catch (error) {
        rows.push({ provider, error: errorMessage(error) })
      }
    }

    if (values.json === true) {
      io.stdout(`${JSON.stringify({ providers: rows })}\n`)
    } else {
      for (const row of rows) {
        if (row.error !== undefined) {
          io.stdout(`${row.provider}: ${row.error}\n`)
          continue
        }
        const models = row.models ?? []
        io.stdout(`${row.provider} (${String(models.length)})\n`)
        for (const model of models) {
          io.stdout(`  ${model.id}${model.name === undefined || model.name === model.id ? '' : `  ${model.name}`}\n`)
        }
      }
    }

    const failed = rows.filter((row) => row.error !== undefined)
    return requested !== undefined && failed.length > 0 ? 1 : 0
  } finally {
    await runtime.close()
  }
}

/**
 * `z1 cassette export <runId>`: turn a recorded run into a replayable file.
 *
 * The journal is the source, so this is a read-only command; it never starts a
 * runtime with providers or modules.
 */
async function cassetteCommand(args: readonly string[], io: CliIO): Promise<number> {
  const [subcommand, ...rest] = args
  if (subcommand !== 'export') {
    io.stderr('usage: z1 cassette export <runId> [-o <file>] [--db <path>]\n')
    return 2
  }

  let values: { db?: string; out?: string }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        db: { type: 'string' },
        out: { type: 'string', short: 'o' },
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

  const runId = positionals[0]
  if (runId === undefined || positionals.length > 1) {
    io.stderr('usage: z1 cassette export <runId> [-o <file>] [--db <path>]\n')
    return 2
  }

  const runtime = await openRuntime(io, {
    ...(values.db === undefined ? {} : { dbPath: values.db }),
    useMemory: false,
    useModules: false,
  })
  if (runtime === undefined) return 1

  try {
    if (runtime.journal.getRun(runId) === undefined) {
      io.stderr(`unknown run "${runId}"\n`)
      return 1
    }
    let text: string
    try {
      text = formatCassette(exportCassette(runtime.journal, runId))
    } catch (error) {
      io.stderr(`${errorMessage(error)}\n`)
      return 1
    }
    if (values.out === undefined) {
      io.stdout(text)
    } else {
      writeFileSync(values.out, text, 'utf8')
      io.stdout(`cassette: ${values.out}\n`)
    }
    return 0
  } finally {
    await runtime.close()
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

  const runtime = await openRuntime(io, {
    ...(values.db === undefined ? {} : { dbPath: values.db }),
    useMemory: false,
    useModules: false,
  })
  if (runtime === undefined) return 1
  const journal = runtime.journal

  try {
    if (journal.getRun(sourceId) === undefined) {
      io.stderr(`unknown run "${sourceId}"\n`)
      return 1
    }

    let atSeq: number
    if (/^\d+$/.test(at)) {
      atSeq = Number(at)
    } else {
      const seq = nodeStartedSeq(journal.ownedEvents(sourceId), at)
      if (seq === undefined) {
        // `z1 tree` and the canvas timeline show the merged chain, so a path
        // inherited from an ancestor is visible but not this run's to fork.
        const owner = journal
          .read(sourceId)
          .find((event) => isNodeStartedEvent(event) && event.path === at)?.runId
        io.stderr(
          owner === undefined || owner === sourceId
            ? `no node.started event with path "${at}" in run "${sourceId}"\n`
            : `path "${at}" ran in ancestor run "${owner}"; fork that run instead\n`,
        )
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
    await runtime.close()
  }
}

const DEFAULT_SERVE_HOST = '127.0.0.1'
const DEFAULT_SERVE_PORT = 7331

/**
 * Resolves once the process is asked to stop, after the server has closed.
 * Signal handlers are process-wide, so they are removed again on the way out;
 * otherwise a second `runCli` call in the same process would stack them.
 */
function waitForShutdown(server: Z1Server): Promise<number> {
  const signals = ['SIGINT', 'SIGTERM'] as const
  return new Promise<number>((resolve) => {
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      void server.close().then(
        () => {
          finish(0)
        },
        () => {
          finish(1)
        },
      )
    }
    const finish = (code: number): void => {
      for (const signal of signals) process.off(signal, stop)
      resolve(code)
    }
    for (const signal of signals) process.on(signal, stop)
  })
}

async function serveCommand(args: readonly string[], io: CliIO): Promise<number> {
  let values: {
    host?: string
    port?: string
    db?: string
    token?: string
    live?: boolean
    json?: boolean
    'modules-dir'?: string
    'templates-dir'?: string
    'no-service-modules'?: boolean
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        db: { type: 'string' },
        token: { type: 'string' },
        live: { type: 'boolean' },
        json: { type: 'boolean' },
        'modules-dir': { type: 'string' },
        'templates-dir': { type: 'string' },
        'no-service-modules': { type: 'boolean' },
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
  if (positionals.length > 0) return usage(io)

  let port = DEFAULT_SERVE_PORT
  if (values.port !== undefined) {
    // `parseArgs` hands back strings, and `Number('')` is 0, so check the shape
    // before converting rather than trusting the cast.
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) {
      io.stderr(`invalid --port "${values.port}"; expected 0-65535\n`)
      return usage(io)
    }
    port = Number(values.port)
  }

  if (values.token === '') {
    io.stderr('--token must not be empty\n')
    return usage(io)
  }

  const host = values.host ?? DEFAULT_SERVE_HOST
  const token = values.token
  const baseEnv = io.env ?? process.env
  const extraEnv: Record<string, string> = {}
  if (values['templates-dir'] !== undefined) extraEnv['Z1_TEMPLATES_DIR'] = values['templates-dir']
  if (values['no-service-modules'] === true) extraEnv['Z1_SERVICE_MODULES'] = '0'
  const env =
    Object.keys(extraEnv).length === 0 ? baseEnv : { ...baseEnv, ...extraEnv }

  let server: Z1Server
  try {
    server = await startServer({
      host,
      port,
      env,
      // Omitted paths fall back to `z1.config.json`, the environment, defaults.
      ...(values.db === undefined ? {} : { dbPath: values.db }),
      ...(values['modules-dir'] === undefined ? {} : { modulesPath: values['modules-dir'] }),
      // Omitting `token` keeps the server's own random generation.
      ...(token === undefined ? {} : { token }),
      ...(values.live === true ? { live: true } : {}),
    })
  } catch (error) {
    io.stderr(`cannot start server: ${errorMessage(error)}\n`)
    return 1
  }

  if (values.json === true) {
    io.stdout(`${JSON.stringify({ url: server.url, token: server.token, port: server.port })}\n`)
  } else {
    io.stdout(`z1 listening on ${server.url} token=${server.token}\n`)
  }

  return await waitForShutdown(server)
}

/**
 * Canvas build locations relative to this module: `src/cli.ts` under tsx is
 * two levels below `apps/`, a built `lib/cli.js` is three. First one that
 * holds an `index.html` wins, so the same helper works for both layouts and for
 * a caller-supplied `file:` URL pointing at a temp tree.
 */
const CANVAS_DIST_CANDIDATES = ['../../canvas/dist', '../../../apps/canvas/dist'] as const

/** Absolute canvas build directory reachable from `baseUrl`, else undefined. */
export function resolveCanvasDist(baseUrl: string | URL = import.meta.url): string | undefined {
  const base = typeof baseUrl === 'string' ? baseUrl : baseUrl.href
  for (const relative of CANVAS_DIST_CANDIDATES) {
    let candidate: string
    try {
      candidate = fileURLToPath(new URL(relative, base))
    } catch {
      continue
    }
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return undefined
}

/** Best effort: opening a browser must never fail the studio server. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {
    // A headless machine has no browser; the printed URL is still the answer.
  })
  child.unref()
}

async function studioCommand(args: readonly string[], io: CliIO): Promise<number> {
  let values: {
    host?: string
    port?: string
    db?: string
    'graphs-dir'?: string
    'modules-dir'?: string
    'templates-dir'?: string
    token?: string
    live?: boolean
    'no-open'?: boolean
    'no-service-modules'?: boolean
    json?: boolean
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        db: { type: 'string' },
        'graphs-dir': { type: 'string' },
        'modules-dir': { type: 'string' },
        'templates-dir': { type: 'string' },
        token: { type: 'string' },
        live: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        'no-service-modules': { type: 'boolean' },
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
  if (positionals.length > 0) return usage(io)

  let port = DEFAULT_SERVE_PORT
  if (values.port !== undefined) {
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) {
      io.stderr(`invalid --port "${values.port}"; expected 0-65535\n`)
      return usage(io)
    }
    port = Number(values.port)
  }

  if (values.token === '') {
    io.stderr('--token must not be empty\n')
    return usage(io)
  }

  const staticDir = resolveCanvasDist()
  if (staticDir === undefined) {
    io.stderr('canvas build not found; run pnpm z1:canvas:build\n')
    return 1
  }

  const host = values.host ?? DEFAULT_SERVE_HOST
  const token = values.token
  const baseEnv = io.env ?? process.env
  const extraEnv: Record<string, string> = {}
  if (values['templates-dir'] !== undefined) extraEnv['Z1_TEMPLATES_DIR'] = values['templates-dir']
  if (values['no-service-modules'] === true) extraEnv['Z1_SERVICE_MODULES'] = '0'
  const env = Object.keys(extraEnv).length === 0 ? baseEnv : { ...baseEnv, ...extraEnv }
  let server: Z1Server
  try {
    server = await startServer({
      host,
      port,
      env,
      staticDir,
      // Omitted paths fall back to `z1.config.json`, the environment, defaults.
      ...(values.db === undefined ? {} : { dbPath: values.db }),
      ...(values['graphs-dir'] === undefined ? {} : { graphsPath: values['graphs-dir'] }),
      ...(values['modules-dir'] === undefined ? {} : { modulesPath: values['modules-dir'] }),
      // Omitting `token` keeps the server's own random generation.
      ...(token === undefined ? {} : { token }),
      ...(values.live === true ? { live: true } : {}),
    })
  } catch (error) {
    io.stderr(`cannot start server: ${errorMessage(error)}\n`)
    return 1
  }

  const page = `http://${host}:${String(server.port)}/?url=${server.url}&token=${server.token}`
  if (values.json === true) {
    io.stdout(
      `${JSON.stringify({ url: page, ws: server.url, token: server.token, port: server.port })}\n`,
    )
  } else {
    io.stdout(`z1 studio on ${page}\n`)
  }

  if (values['no-open'] !== true) openBrowser(page)

  return await waitForShutdown(server)
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
    case 'memory':
      return await memoryCommand(rest, io)
    case 'fork':
      return await forkCommand(rest, io)
    case 'cassette':
      return await cassetteCommand(rest, io)
    case 'models':
      return await modelsCommand(rest, io)
    case 'eval':
      return await evalCommand(rest, io, runCli)
    case 'serve':
      return await serveCommand(rest, io)
    case 'studio':
      return await studioCommand(rest, io)
    case 'module':
      return await moduleCommand(rest, io)
    case 'template':
      return templateCommand(rest, io)
    default:
      io.stderr(`unknown command "${command}"\n`)
      return usage(io)
  }
}
