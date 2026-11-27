/**
 * The installed-tools decorator.
 *
 * z2q's `installTool` writes an approved tool to
 * `<workspace>/.z2q/tools/<name>/<version>/{approval.json,dist/*}`, and until
 * this service nothing in z1 read that directory: a tool a person created with
 * `tool.create` and installed by hand could never be called by a run. Here
 * those tools join the run's inventory and answer their own names, each call
 * inside z2q's QuickJS sandbox with the capabilities its `approval.json`
 * records — the host policy in the options can only lower that ceiling, never
 * raise it.
 *
 * The service is **read-only** over the tools directory: it never installs,
 * copies or deletes. It also caches nothing about the inventory, because a
 * cached copy is exactly the stale listing the next turn would show; the only
 * thing kept across calls is the loaded z2q module itself.
 *
 * A broken tool never takes the inventory down: `list()` skips it with one
 * warning naming the tool and the code, and every other tool — plus everything
 * the run already had — is still advertised.
 *
 * @module @z1/installed-tools/service
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import { InstalledToolError, installedToolErrorTap } from './errors.ts'
import { loadZ2q } from './port.ts'
import type { Z2qManifest, Z2qModule, Z2qRuntime, Z2qToolPackage } from './port.ts'

/** The switch the bootstrap reads; `0`/`false`/`off`/`no` disables. Default on. */
export const INSTALLED_TOOLS_ENV = 'Z1_INSTALLED_TOOLS'

/** Where `installTool` puts tools, relative to the workspace. */
const TOOLS_DIR = join('.z2q', 'tools')

/** The levels every z1 service logger takes (`ModuleServiceLogLevel`). */
export type InstalledToolLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** What the decorator needs from its host. */
export interface InstalledToolServiceOptions {
  /** The tools the run already has; every name not installed here goes to it. */
  inner: ToolService
  /** Where installed tools live. Default `<workspace>/.z2q/tools`. */
  toolsDir?: string
  /** The workspace a tool runs against, absolute. */
  workspace: string
  /** z2q checkout. Default: `Z1_TOOL_SDK_PATH`, else the sibling `../z1-tool-sdk`. */
  sdkPath?: string
  /** Host ceiling over the manifest's `net.hosts`. Default `true` (the manifest decides). */
  net?: boolean | { hosts: readonly string[] }
  /**
   * Host env policy. Default `{ inherit: true, file: '.env' }`: only declared
   * names resolve, and the workspace's `.env` is read before `process.env`.
   */
  env?: false | { read?: Record<string, string>; inherit?: boolean }
  /**
   * Absolute directories owned by the running runtime (the CLI and SDK
   * checkouts, the agent home). A tool may never write into them, so an agent
   * cannot break the runtime it is running on.
   */
  protectedRoots?: readonly string[]
  log?: (level: InstalledToolLogLevel, message: string, data?: Json) => void
}

/**
 * Is the decorator enabled for this process?
 *
 * On by default, like `tool.create`: the point of the feature is that a tool a
 * person installed becomes callable without ceremony. `Z1_INSTALLED_TOOLS` set
 * to `0`, `false`, `off` or `no` (trimmed, any case) turns it off; an unset,
 * empty or unknown value leaves it on — and a run that turns it off keeps the
 * very instance of its tool service it had. The bootstrap reads its resolved
 * environment, not `process.env` directly, so a test or a host that supplies
 * `env` decides for itself.
 */
export function installedToolsEnabled(env: Record<string, string | undefined>): boolean {
  const value = env[INSTALLED_TOOLS_ENV]?.trim().toLowerCase()
  if (value === undefined || value === '') return true
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no'
}

/**
 * Wrap a tool service with the tools installed in the workspace.
 *
 * `list()` appends one schema per installed tool after the inner inventory, and
 * `call()` routes every name that no `approval.json` claims to `inner`
 * untouched — same arguments, same result, same throw. Without a checkout the
 * inventory is the inner one and a call to an installed name fails with a
 * `tool_unavailable` error naming the path, because a missing z2q is a fact
 * about the machine, not a reason to hide the run's own tools.
 */
export function createInstalledToolService(options: InstalledToolServiceOptions): ToolService {
  const { inner, log } = options
  const workspace = resolve(options.workspace)
  const toolsDir =
    options.toolsDir === undefined ? join(workspace, TOOLS_DIR) : resolve(options.toolsDir)
  const net = options.net ?? true
  // `<workspace>/.env` first, then this process's environment: an installed tool
  // declares a name and expects the key the person put in the file, exactly as
  // the smoke test that approved it did.
  const env = options.env ?? { inherit: true, file: '.env' }
  const loadOptions = options.sdkPath === undefined ? {} : { sdkPath: options.sdkPath }

  let z2q: Z2qModule | undefined
  const warned = new Set<string>()

  /**
   * The z2q module, loaded at most once per service.
   *
   * A failed load is not cached here either: the port refuses to cache it, and
   * a host that builds the checkout after the first warning must be able to try
   * again inside the same run.
   */
  async function useZ2q(): Promise<Z2qModule> {
    return (z2q ??= await loadZ2q(loadOptions))
  }

  /**
   * One warning per cause per service.
   *
   * `list()` runs for every prompt build and every `z1.tools.list` call, so the
   * same broken tool would otherwise repeat its line forever. The key carries
   * the code, so a tool that breaks differently is still reported again.
   */
  function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return
    warned.add(key)
    log?.('warn', message)
  }

  /**
   * The version directories of `name` whose `approval.json` describes it.
   *
   * This is the routing question and nothing more: which name a directory
   * owns. Whether the bytes still match the approval is z2q's check, made on
   * every call and on every listing, and duplicating it here would be a second
   * place to keep right. An empty answer means the name belongs to `inner`.
   */
  async function approvedVersions(name: string): Promise<readonly string[]> {
    if (!isSafeName(name)) return []
    const toolDir = join(toolsDir, name)
    const versions = await readdir(toolDir).catch(() => [] as string[])
    const approved: string[] = []
    for (const version of versions) {
      const record = await readApproval(join(toolDir, version))
      if (record?.name === name && record.version === version) approved.push(version)
    }
    return approved
  }

  /** Every installed name, sorted, read from the workspace on each call. */
  async function installedNames(): Promise<readonly string[]> {
    const entries = await readdir(toolsDir, { withFileTypes: true }).catch(() => [])
    const names: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if ((await approvedVersions(entry.name)).length === 0) continue
      names.push(entry.name)
    }
    return names.sort(byName)
  }

  /** Run one installed tool in its sandbox and return the tool's plain JSON. */
  async function runInstalled(name: string, args: Json): Promise<Json> {
    let api: Z2qModule
    try {
      api = await useZ2q()
    } catch (error) {
      throw failed(name, error)
    }

    let pkg: Z2qToolPackage
    try {
      // No version: z2q picks the highest installed one and re-hashes the bytes
      // against the approval on every call, so an edited bundle cannot run.
      pkg = await api.loadInstalledTool(toolsDir, name)
    } catch (error) {
      throw failed(name, error)
    }

    let runtime: Z2qRuntime
    try {
      runtime = await api.createToolRuntime({
        workspace,
        net,
        env,
        ...(options.protectedRoots === undefined ? {} : { protectedRoots: options.protectedRoots }),
      })
    } catch (error) {
      throw failed(name, error)
    }

    try {
      const result = await runtime.run(pkg, args)
      return result.value
    } catch (error) {
      log?.('warn', `installed tools: "${name}" failed: ${described(error)}`)
      throw failed(name, error)
    } finally {
      // z2q builds and disposes its QuickJS runtime inside `run` and exposes no
      // `dispose()` today; a checkout that grows one is released here either way.
      await runtime.dispose?.()
    }
  }

  return {
    async list(): Promise<readonly ToolSchema[]> {
      const current = await inner.list()
      const names = await installedNames()
      // Nothing installed: the run keeps the inventory it had, and a machine
      // without a checkout never sees a warning it cannot act on.
      if (names.length === 0) return current

      let api: Z2qModule
      try {
        api = await useZ2q()
      } catch (error) {
        warnOnce('unavailable', `installed tools: ${described(error)}`)
        return current
      }

      const owned = new Set(current.map((schema) => schema.name))
      const merged: ToolSchema[] = [...current]
      for (const name of names) {
        let manifest: Z2qManifest
        try {
          manifest = (await api.loadInstalledTool(toolsDir, name)).manifest
        } catch (error) {
          warnOnce(
            `broken:${name}:${codeOf(error)}`,
            `installed tools: skipping "${name}": ${described(error)}`,
          )
          continue
        }
        if (owned.has(manifest.name)) {
          // Never silently: the inner tool keeps the name, and this says so once.
          warnOnce(
            `collision:${manifest.name}`,
            `installed tools: the run already advertises "${manifest.name}"; its own tool keeps the name and the installed one is ignored`,
          )
          continue
        }
        merged.push({
          name: manifest.name,
          description: manifest.description,
          parameters: manifest.parameters,
        })
      }
      return merged
    },

    async call(name: string, args: Json): Promise<Json> {
      if ((await approvedVersions(name)).length === 0) return await inner.call(name, args)
      return await runInstalled(name, args)
    },
  }
}

/** The plain-JSON part of an approval record this package routes on. */
interface ApprovalRecord {
  readonly name: string
  readonly version: string
}

/**
 * The `approval.json` of one version directory, when it parses and names itself.
 *
 * Deliberately shallow: `schemaVersion`, the sha, the capabilities and the
 * manifest are z2q's business. This only has to answer "does this directory
 * claim this name", which is what makes a name the installed service's to
 * route; every refusal worth reporting comes from `loadInstalledTool`.
 */
async function readApproval(dir: string): Promise<ApprovalRecord | undefined> {
  const text = await readFile(join(dir, 'approval.json'), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { name?: unknown; version?: unknown }
  if (typeof record.name !== 'string' || typeof record.version !== 'string') return undefined
  return { name: record.name, version: record.version }
}

/**
 * A name the model chose must never become a path.
 *
 * z2q installs only `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$` names, and this guard
 * is deliberately looser than that pattern rather than a copy of it: it refuses
 * a separator, a `..`, an NTFS stream and the trailing dot or space Windows
 * drops, and leaves the rest to the directory listing.
 */
function isSafeName(name: string): boolean {
  if (name.length === 0 || name === '.' || name === '..') return false
  if (/[\\/:]/.test(name)) return false
  return !name.endsWith('.') && !name.endsWith(' ')
}

/** One coded failure, in the shape the model and the host both read. */
function failed(tool: string, error: unknown): InstalledToolError {
  if (error instanceof InstalledToolError && error.tool !== undefined) return error
  const tapped = installedToolErrorTap(error)
  const options = { tool, cause: error }
  return tapped === undefined
    ? new InstalledToolError('tool_failed', messageOf(error), options)
    : new InstalledToolError(tapped.code, tapped.message, options)
}

/** `code: detail` for a log line, whether or not the throw had a code. */
function described(error: unknown): string {
  const tapped = installedToolErrorTap(error)
  return tapped === undefined ? messageOf(error) : `${tapped.code}: ${tapped.message}`
}

function codeOf(error: unknown): string {
  return installedToolErrorTap(error)?.code ?? 'tool_failed'
}

function byName(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
