/**
 * The lazy door to the z2q checkout.
 *
 * z2q — published as `z1-tool-sdk` — owns both halves this package needs: the
 * approval check that re-hashes an installed bundle (`loadInstalledTool`) and
 * the QuickJS sandbox that executes it (`createToolRuntime`). It is a sibling
 * checkout and not an npm dependency, so it is imported on the first call that
 * needs it, never at module load: `@z1/installed-tools` must load on a machine
 * that has no checkout and no intention of using one, and `list()` must still
 * answer with the run's own tools there.
 *
 * Two entries are imported, because the package root does not re-export the
 * runtime: `<checkout>/dist/index.js` for the approval check and
 * `<checkout>/dist/runtime/index.js` for the sandbox. Resolution follows
 * `@z1/tool-creator`'s order — an explicit path, then `Z1_TOOL_SDK_PATH` — and
 * parts ways on the last step: the creator asks Node for the package name,
 * while this loader walks up from the working directory looking for the
 * `z1-tool-sdk` checkout that sits beside the z1 repository, so the UI, the CLI
 * and a package test all find the same checkout without configuration.
 *
 * {@link Z2qModule} declares the z2q surface structurally, narrower than z2q's
 * own types and imported from nowhere: this package compiles with no checkout
 * on disk. Only the fields read here are listed.
 *
 * @module @z1/installed-tools/port
 */

import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Json } from '@z1/node'

import { InstalledToolError } from './errors.ts'

/** The variable that names the checkout; the same one `@z1/tool-creator` reads. */
export const TOOL_SDK_ENV = 'Z1_TOOL_SDK_PATH'

/** The checkout's directory name, looked for beside every ancestor of `cwd`. */
export const TOOL_SDK_DIR = 'z1-tool-sdk'

/** Appended to every refusal: the one thing a person can act on. */
const HINT = `${TOOL_SDK_ENV} names a z2q-tool-sdk checkout (it is not published on npm yet)`

/**
 * The manifest fields a schema is built from.
 *
 * `parameters` is already draft-2020-12 JSON Schema: z2q converts the tool's zod
 * object at build time, so nothing here shapes it a second time.
 */
export interface Z2qManifest {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly parameters: Record<string, Json>
}

/** An installed tool as z2q hands it over: `dist/tool.json` plus the bundle bytes. */
export interface Z2qToolPackage {
  readonly manifest: Z2qManifest
  readonly source: string
  readonly sha256: string
}

/**
 * The runtime options this package passes through.
 *
 * `net` and `env` are the host's ceiling; the manifest stays the declaration,
 * so a host can grant less than a tool asks for and never more.
 */
export interface Z2qRuntimeOptions {
  readonly workspace: string
  /**
   * Absolute directories owned by the running runtime; z2q refuses writes into
   * them (`protected_path`). An older z2q ignores the field.
   */
  readonly protectedRoots?: readonly string[]
  readonly net?: false | true | { hosts?: readonly string[] }
  readonly env?: false | { read?: Record<string, string>; inherit?: boolean }
}

/** One call's worth of sandbox; z2q creates its QuickJS runtime inside `run`. */
export interface Z2qRuntime {
  run(pkg: Z2qToolPackage, args: Json): Promise<{ value: Json }>
  /**
   * Absent in the z2q this package was written against (0.1.0), which creates
   * and disposes its QuickJS runtime per call. Declared so a checkout that grows
   * one is released by the caller rather than leaked.
   */
  dispose?(): Promise<void> | void
}

/** Everything this package reads from the checkout. */
export interface Z2qModule {
  /** Re-hashes the bundle against `approval.json`; the highest version by default. */
  loadInstalledTool(toolsDir: string, name: string, version?: string): Promise<Z2qToolPackage>
  createToolRuntime(options: Z2qRuntimeOptions): Promise<Z2qRuntime>
}

/** Where the loader should look; absent fields fall through to the defaults. */
export interface Z2qLoadOptions {
  /** A checkout, its `dist` directory, or its entry file; else `Z1_TOOL_SDK_PATH`. */
  sdkPath?: string
}

type Z2qCreateToolRuntime = (options: Z2qRuntimeOptions) => Promise<Z2qRuntime>
type Z2qLoadInstalledTool = (
  toolsDir: string,
  name: string,
  version?: string,
) => Promise<Z2qToolPackage>

/**
 * Loaded modules, one per root entry file.
 *
 * A failed load is **not** cached: a person who builds the checkout, or sets
 * `Z1_TOOL_SDK_PATH` after the first refusal, must not have to restart the
 * process. Keying on the entry file rather than a directory means two checkouts
 * in one process do not shadow each other.
 */
const modules = new Map<string, Z2qModule>()

/**
 * Import the checkout and hand back the two functions this package calls.
 *
 * Throws {@link InstalledToolError} with `code: 'tool_unavailable'` — never a
 * bare `ERR_MODULE_NOT_FOUND` — when the checkout is missing, unbuilt, or not
 * z2q, and the message names the path that was tried.
 */
export async function loadZ2q(options: Z2qLoadOptions = {}): Promise<Z2qModule> {
  const resolution = await resolveEntries(options.sdkPath)
  const entries = resolution.entries
  if (entries === undefined) throw unavailable(resolution.attempted)

  const cached = modules.get(entries.root)
  if (cached !== undefined) return cached

  let root: unknown
  let runtime: unknown
  try {
    root = await importModule(entries.root)
    runtime = await importModule(entries.runtime)
  } catch (error) {
    throw new InstalledToolError(
      'tool_unavailable',
      `cannot import the z2q checkout at ${resolution.attempted}: ${messageOf(error)}; ${HINT}`,
      { cause: error },
    )
  }

  const loaded: Z2qModule = {
    createToolRuntime: readExport<Z2qCreateToolRuntime>(runtime, 'createToolRuntime'),
    loadInstalledTool: readExport<Z2qLoadInstalledTool>(root, 'loadInstalledTool'),
  }
  modules.set(entries.root, loaded)
  return loaded
}

/** What the loader found, and where it looked when it found nothing. */
interface Resolution {
  /** The first candidate, named by the error so a person knows where to look. */
  readonly attempted: string
  readonly entries: Z2qEntries | undefined
}

/** The two entry files of one checkout. */
interface Z2qEntries {
  readonly root: string
  readonly runtime: string
}

async function resolveEntries(sdkPath: string | undefined): Promise<Resolution> {
  const candidates = checkoutCandidates(sdkPath)
  const attempted = candidates[0] ?? resolve(TOOL_SDK_DIR)
  for (const candidate of candidates) {
    const entries = await entriesAt(candidate)
    if (entries !== undefined) return { attempted: candidate, entries }
  }
  return { attempted, entries: undefined }
}

/**
 * Where to look, in order: the explicit path, the variable, then the checkout
 * beside the working directory's nearest ancestors.
 *
 * A relative path resolves against the working directory, which is what a
 * person types. The ancestor walk exists because the z1 repository and the z2q
 * checkout are siblings: a command started in `z1/packages/bootstrap` must find
 * the same checkout a command started at the repository root finds.
 */
function checkoutCandidates(sdkPath: string | undefined): readonly string[] {
  const chosen = trimmed(sdkPath) ?? trimmed(process.env[TOOL_SDK_ENV])
  if (chosen !== undefined) return [resolve(chosen)]

  const siblings: string[] = []
  let dir = resolve(process.cwd())
  for (;;) {
    siblings.push(join(dirname(dir), TOOL_SDK_DIR))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return siblings
}

/**
 * The two entry files of a candidate, or `undefined` when it is not a built
 * checkout.
 *
 * A path may name the checkout root (whose entry is `<root>/dist/index.js`), its
 * `dist` directory (whose entry is `index.js` inside it) or the entry file
 * itself, which is what a person is most likely to paste. The runtime entry is
 * derived from whichever file the root resolved to, so both halves always come
 * from the same checkout.
 */
async function entriesAt(target: string): Promise<Z2qEntries | undefined> {
  const path = resolve(target)
  const root = (await isFile(path))
    ? path
    : await firstFile(join(path, 'index.js'), join(path, 'dist', 'index.js'))
  if (root === undefined) return undefined
  const runtime = join(dirname(root), 'runtime', 'index.js')
  return (await isFile(runtime)) ? { root, runtime } : undefined
}

/** Read one required function export, or explain which variable to fix. */
function readExport<T>(module: unknown, name: string): T {
  if (typeof module !== 'object' || module === null) {
    throw new InstalledToolError(
      'tool_unavailable',
      `the loaded module is not an object, so it has no "${name}" export; ${HINT}`,
    )
  }
  const value = (module as Record<string, unknown>)[name]
  if (typeof value !== 'function') {
    throw new InstalledToolError(
      'tool_unavailable',
      `the loaded module has no "${name}" export, so it is not a built z2q checkout; ${HINT}`,
    )
  }
  // The module crosses a dynamic import, so its type is unknown here by
  // construction; the declarations above are the contract relied on.
  return value as unknown as T
}

/**
 * A run-time specifier.
 *
 * `import()` is the whole point of this module: a static import would make the
 * checkout a hard requirement. Its namespace type is therefore unknown to the
 * compiler, and the cast says so instead of inventing a type.
 */
async function importModule(file: string): Promise<unknown> {
  return (await import(pathToFileURL(file).href)) as unknown
}

function unavailable(attempted: string): InstalledToolError {
  return new InstalledToolError(
    'tool_unavailable',
    `no built z2q checkout at ${attempted}: expected dist/index.js and dist/runtime/index.js, so run its build there (npm run build) or point ${TOOL_SDK_ENV} at one; ${HINT}`,
  )
}

async function firstFile(...paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await isFile(path)) return path
  }
  return undefined
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() === true
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text === undefined || text === '' ? undefined : text
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
