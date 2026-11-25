/**
 * The lazy door to `z2q-tool-sdk`.
 *
 * The sdk that knows how to create tools lives in a sibling checkout and is
 * **not published on npm**, so it cannot be a dependency of this package. It is
 * imported on the first `tool.create` call instead, from `Z1_TOOL_SDK_PATH` (or
 * from the package name when a host installed it some other way), and every
 * failure of that import becomes one clear `ToolCreatorUnavailableError` naming
 * the variable. Nothing here is imported at module load: `@z1/tool-creator` must
 * load on a machine that has no sdk and no intention of using this feature.
 *
 * `createZ2qPort` adapts the loaded module to {@link ToolCreatorPort}. It does
 * not translate the creator's own failures: a `review_failed` with its issues
 * arrives at the service with `code` and `issues` intact, and the service
 * re-throws it as this package's `ToolCreatorError`.
 *
 * @module @z1/tool-creator/port
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ToolCreatorError, ToolCreatorUnavailableError } from './errors.ts'
import { toolInstallNext } from './types.ts'
import type {
  ToolCreationRequest,
  ToolCreatorPort,
  ToolGenerate,
  ToolProposalRisk,
  ToolProposalRun,
  ToolProposalSummary,
} from './types.ts'

/** The variable that names the sdk checkout. */
export const TOOL_SDK_ENV = 'Z1_TOOL_SDK_PATH'

/** The package name, for a host that resolved it without the variable. */
export const TOOL_SDK_PACKAGE = 'z1-tool-sdk'

/**
 * Loaded modules, one per specifier.
 *
 * A failed load is **not** cached: a person who fixes `Z1_TOOL_SDK_PATH` (or
 * builds the checkout) must not have to restart the process.
 */
const modules = new Map<string, unknown>()

/** What {@link createZ2qPort} needs beyond the module itself. */
export interface Z2qPortOptions {
  /** Absolute workspace the smoke test runs against. */
  workspace: string
  /**
   * The host's model call; z2q has no model of its own. Without it `propose`
   * refuses with `model_unavailable` — before a review pass spends a budget on
   * a reply no model produced.
   */
  generate?: ToolGenerate
  /** Installed-tools root for `install`; defaults `<workspace>/.z2q/tools`. */
  toolsDir?: string
}

/** Options for {@link loadToolCreatorPort}. */
export interface LoadToolCreatorPortOptions {
  /** A checkout, its `dist` directory, or its entry file; defaults to {@link TOOL_SDK_ENV}. */
  path?: string
  /** Fallback workspace for `install`; `propose` receives one per call. */
  workspace?: string
  /** The model call. Without it the port explains what `tool.create` still needs. */
  generate?: ToolGenerate
  /** Installed-tools root for `install`; defaults `<workspace>/.z2q/tools`. */
  toolsDir?: string
}

/**
 * Load the sdk and wrap it as a port.
 *
 * Throws {@link ToolCreatorUnavailableError} — never a bare `ERR_MODULE_NOT_FOUND`
 * — when the checkout is missing, unbuilt or not the sdk.
 */
export async function loadToolCreatorPort(
  options: LoadToolCreatorPortOptions = {},
): Promise<ToolCreatorPort> {
  const loaded = await loadModule(options.path)
  return createZ2qPort(loaded, {
    workspace: options.workspace ?? process.cwd(),
    ...(options.generate === undefined ? {} : { generate: options.generate }),
    ...(options.toolsDir === undefined ? {} : { toolsDir: options.toolsDir }),
  })
}

/**
 * Adapt a loaded sdk module to {@link ToolCreatorPort}.
 *
 * The creator is built per call, because `propose` carries the workspace its
 * smoke test runs in and one port may serve several runs. `install` — a
 * host-only path the service never takes — hashes `dist/index.js` itself and
 * passes it as `expectSha256`, so a proposal edited after its smoke test is
 * refused instead of installed.
 */
export function createZ2qPort(module: unknown, options: Z2qPortOptions): ToolCreatorPort {
  const createToolCreator = readExport<Z2qCreateToolCreator>(module, 'createToolCreator')
  const workspace = resolve(options.workspace)
  const toolsDir =
    options.toolsDir === undefined ? join(workspace, '.z2q', 'tools') : resolve(options.toolsDir)

  return {
    async propose(request, call): Promise<ToolProposalSummary> {
      if (options.generate === undefined) throw modelUnavailable()
      const creator = createToolCreator({
        workspace: resolve(call.workspace),
        generate: options.generate,
        toolsDir,
      })
      const proposal = await creator.propose(toRequest(request))
      return toSummary(proposal)
    },

    async install(proposalDir, call): Promise<{ path: string; name: string; version: string }> {
      const dir = resolve(proposalDir)
      const sha256 = await hashBundle(join(dir, 'dist', 'index.js'))
      const installTool = readExport<Z2qInstallTool>(module, 'installTool')
      const installed = await installTool({
        toolsDir,
        dir,
        ...(call.approvedBy === undefined ? {} : { approvedBy: call.approvedBy }),
        expectSha256: sha256,
      })
      return { path: installed.path, name: installed.name, version: installed.version }
    },
  }
}

/**
 * The sdk's own shapes, structurally.
 *
 * Deliberately narrower than the sdk's types and declared here rather than
 * imported: this package must compile with no sdk on disk. Only the fields the
 * port reads are listed.
 */
interface Z2qProposal {
  projectDir: string
  sha256: string
  attempts: number
  manifest: { name: string; version: string }
  smoke: { ok: boolean; runs: { ok: boolean; denied: number; code?: string }[] }
  summary: { lines: string[]; risk: ToolProposalRisk }
  history: { attempt: number; issues: string[] }[]
}

interface Z2qCreator {
  propose(request: {
    name: string
    purpose: string
    examples?: { input: unknown }[]
  }): Promise<Z2qProposal>
}

type Z2qCreateToolCreator = (options: {
  workspace: string
  generate: ToolGenerate
  toolsDir?: string
}) => Z2qCreator

type Z2qInstallTool = (options: {
  toolsDir: string
  dir: string
  approvedBy?: string
  expectSha256?: string
}) => Promise<{ path: string; name: string; version: string }>

/** Read one required function export, or explain which variable to fix. */
function readExport<T>(module: unknown, name: string): T {
  const hint = `set ${TOOL_SDK_ENV} to a z2q-tool-sdk checkout (it is not published on npm yet)`
  if (typeof module !== 'object' || module === null) {
    throw new ToolCreatorUnavailableError(
      `the loaded module is not an object, so it has no "${name}" export; ${hint}`,
    )
  }
  const value = (module as Record<string, unknown>)[name]
  if (typeof value !== 'function') {
    throw new ToolCreatorUnavailableError(
      `the loaded module has no "${name}" export, so it is not a built z2q-tool-sdk; ${hint} and run its build`,
    )
  }
  // The module crosses a dynamic import, so its type is unknown here by
  // construction; the fields above are the contract this package relies on.
  return value as unknown as T
}

/** The narrow request the creator takes; a `Json` sample becomes `{ input }`. */
function toRequest(request: ToolCreationRequest): {
  name: string
  purpose: string
  examples?: { input: unknown }[]
} {
  return {
    name: request.name,
    purpose: request.purpose,
    ...(request.examples === undefined
      ? {}
      : { examples: request.examples.map((input) => ({ input })) }),
  }
}

/** The creator's proposal, narrowed to the JSON the tool returns. */
function toSummary(proposal: Z2qProposal): ToolProposalSummary {
  return {
    name: proposal.manifest.name,
    version: proposal.manifest.version,
    sha256: proposal.sha256,
    projectDir: proposal.projectDir,
    attempts: proposal.attempts,
    history: proposal.history.map((entry) => [...entry.issues]),
    smoke: { ok: proposal.smoke.ok, runs: proposal.smoke.runs.map(toRun) },
    capabilities: { lines: [...proposal.summary.lines], risk: proposal.summary.risk },
    next: toolInstallNext(proposal.projectDir),
  }
}

function toRun(run: { ok: boolean; denied: number; code?: string }): ToolProposalRun {
  return { ok: run.ok, denied: run.denied, ...(run.code === undefined ? {} : { code: run.code }) }
}

async function hashBundle(file: string): Promise<string> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    throw new ToolCreatorError('install_failed', `cannot read "${file}": ${messageOf(error)}`, {
      cause: error,
    })
  }
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Import the sdk once per process.
 *
 * The specifier is the explicit path, else `Z1_TOOL_SDK_PATH`, else the package
 * name. Only the success is cached, and only under the specifier it was loaded
 * from, so two checkouts in one process do not shadow each other.
 */
async function loadModule(from: string | undefined): Promise<unknown> {
  const explicit = from?.trim()
  const target = explicit === undefined || explicit === '' ? envTarget() : explicit
  const specifier = target === undefined ? TOOL_SDK_PACKAGE : await bundleSpecifier(target)
  const cached = modules.get(specifier)
  if (cached !== undefined) return cached
  let loaded: unknown
  try {
    loaded = await importModule(specifier)
  } catch (error) {
    throw unavailable(target, specifier, error)
  }
  modules.set(specifier, loaded)
  return loaded
}

function envTarget(): string | undefined {
  const value = process.env[TOOL_SDK_ENV]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * A file URL for the sdk entry.
 *
 * A path may name the checkout root (whose entry is `<root>/dist/index.js`),
 * its `dist` directory (whose entry is `index.js` inside it) or the entry file
 * itself, which is what a person is most likely to paste. Nothing is required
 * to exist: a missing path still produces a file URL, and the import fails with
 * the message that names the variable.
 */
async function bundleSpecifier(target: string): Promise<string> {
  const path = resolve(target)
  if (await isFile(path)) return pathToFileURL(path).href
  const direct = join(path, 'index.js')
  if (await isFile(direct)) return pathToFileURL(direct).href
  return pathToFileURL(join(path, 'dist', 'index.js')).href
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() === true
}

/**
 * A run-time specifier.
 *
 * `import()` is the whole point of the module: a static import would make the
 * sdk a hard requirement. Its namespace type is therefore unknown to the
 * compiler, and the cast says so instead of inventing a type.
 */
async function importModule(specifier: string): Promise<unknown> {
  return (await import(specifier)) as unknown
}

function unavailable(
  target: string | undefined,
  specifier: string,
  cause: unknown,
): ToolCreatorUnavailableError {
  const hint = `set ${TOOL_SDK_ENV} to a z2q-tool-sdk checkout (it is not published on npm yet)`
  const detail = messageOf(cause)
  if (target === undefined) {
    return new ToolCreatorUnavailableError(`cannot import "${specifier}": ${detail}; ${hint}`, {
      cause,
    })
  }
  return new ToolCreatorUnavailableError(
    `cannot import "${specifier}" from ${TOOL_SDK_ENV}="${target}": ${detail}; ${hint} and build it there (npm run build)`,
    { cause },
  )
}

/**
 * What a port without a model call refuses with.
 *
 * The sdk is model-agnostic on purpose, so a port without `generate` can be
 * loaded but cannot propose. Saying which hook is missing is more useful than
 * the sdk's own `model_failed`, which would blame the model for the host's
 * missing wiring.
 */
function modelUnavailable(): ToolCreatorError {
  return new ToolCreatorError(
    'model_unavailable',
    'the tool creator has no model call: pass "generate" to createToolCreatorService (or to loadToolCreatorPort) so the host writes the tool source',
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
