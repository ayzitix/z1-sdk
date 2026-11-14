import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { ModuleCapabilities } from './types.ts'

export type CapabilityCheck = { ok: true } | { ok: false; reason: string }

const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** `normalize` keeps a trailing slash; capability matching compares clean paths. */
function cleanPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.length === 0 ? '/' : trimmed
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character
}

/**
 * Anchored glob over POSIX paths.
 *
 * - `*` matches any run of characters except `/`
 * - `**` matches across `/`; `**\/` may collapse to nothing (`a/**\/b` matches
 *   `a/b`)
 * - `?` matches exactly one character except `/`
 */
export function matchPath(glob: string, path: string): boolean {
  let source = '^'
  let index = 0

  while (index < glob.length) {
    const character = glob[index]
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index += 2
        if (glob[index] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        index += 1
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      index += 1
      source += '[^/]'
      continue
    }
    if (character !== undefined) source += escapeRegex(character)
    index += 1
  }

  source += '$'
  return new RegExp(source).test(path)
}

/** Substitute the `${moduleDir}` placeholder used by capability patterns. */
export function resolveCapabilityPath(pattern: string, moduleDir: string): string {
  return pattern.split('${moduleDir}').join(moduleDir)
}

function hasParentSegment(value: string): boolean {
  return PARENT_SEGMENT.test(value)
}

function deny(reason: string): CapabilityCheck {
  return { ok: false, reason }
}

/**
 * Gate an fs operation against the module's declared capability list. Relative
 * patterns and paths are resolved against the module directory. Anything that
 * escapes through `..` is rejected rather than normalised away, so a grant for
 * `data/**` cannot be widened by a crafted path.
 */
export function checkFs(
  capabilities: ModuleCapabilities | undefined,
  direction: 'read' | 'write',
  path: string,
  moduleDir: string,
): CapabilityCheck {
  const patterns = capabilities?.fs?.[direction]
  if (patterns === undefined || patterns.length === 0) {
    return deny(`no fs.${direction} capability granted`)
  }
  if (hasParentSegment(path)) {
    return deny('path contains a parent directory segment')
  }

  const moduleRoot = resolve(moduleDir)
  const target = cleanPath(toPosix(normalize(resolve(moduleRoot, path))))

  for (const pattern of patterns) {
    if (pattern.trim().length === 0) continue
    if (hasParentSegment(pattern)) continue

    const expanded = resolveCapabilityPath(pattern, moduleRoot)
    const absolute = cleanPath(
      toPosix(normalize(isAbsolute(expanded) ? expanded : resolve(moduleRoot, expanded))),
    )
    if (matchPath(absolute, target)) return { ok: true }
  }

  return deny(`fs.${direction} path is outside the granted patterns: ${target}`)
}

/**
 * Resolve `path` the way the filesystem will: realpath of the longest existing
 * ancestor, then the not-yet-existing tail appended unchanged.
 *
 * A missing path is normal for `fs.write`, so it cannot be an error. Returns
 * `undefined` only when no ancestor can be resolved at all.
 */
function resolveReal(path: string): string | undefined {
  let current = path
  const missing: string[] = []

  for (;;) {
    try {
      const real = realpathSync.native(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * {@link checkFs} plus symlink resolution.
 *
 * The lexical check alone can be widened by a symlink inside a granted
 * directory: `data/link -> /etc` passes a `data/**` grant. This variant resolves
 * the real target of the path and requires it to stay under the real target of
 * the pattern's literal base.
 *
 * The literal base is anchored to the **real** module directory rather than
 * resolved itself, so a grant `${moduleDir}/out/**` where `out` is a symlink
 * does not become a grant for the link's destination. Symlinks that stay inside
 * the granted tree remain allowed, and a write to a not-yet-existing file is
 * checked through its nearest existing ancestor.
 */
export function checkFsReal(
  capabilities: ModuleCapabilities | undefined,
  direction: 'read' | 'write',
  path: string,
  moduleDir: string,
): CapabilityCheck {
  const lexical = checkFs(capabilities, direction, path, moduleDir)
  if (!lexical.ok) return lexical

  const patterns = capabilities?.fs?.[direction] ?? []
  const moduleRoot = cleanPath(toPosix(normalize(resolve(moduleDir))))
  const realModuleRoot = resolveReal(moduleRoot)
  if (realModuleRoot === undefined) return deny(`cannot resolve the module directory: ${moduleDir}`)

  const target = cleanPath(toPosix(normalize(resolve(moduleRoot, path))))
  const realTarget = resolveReal(target)
  if (realTarget === undefined) return deny(`cannot resolve the path: ${path}`)

  /** The literal base, with any `moduleDir` part mapped onto its real path. */
  const anchor = (pattern: string): string | undefined => {
    const wildcard = pattern.search(/[*?[\]]/)
    const literal = wildcard < 0 ? pattern : pattern.slice(0, pattern.lastIndexOf('/', wildcard) + 1)
    if (literal.length === 0) return undefined

    const expanded = resolveCapabilityPath(literal, moduleRoot)
    const absolute = cleanPath(
      toPosix(normalize(isAbsolute(expanded) ? expanded : resolve(moduleRoot, expanded))),
    )
    if (absolute === moduleRoot) return realModuleRoot
    if (absolute.startsWith(moduleRoot + '/')) {
      return toPosix(join(realModuleRoot, absolute.slice(moduleRoot.length + 1)))
    }
    // An absolute grant outside the module directory is the operator's choice;
    // resolve it so its own symlinks are honoured.
    return resolveReal(absolute)
  }

  let denied = `fs.${direction} path resolves outside the granted patterns: ${path}`
  for (const pattern of patterns) {
    if (pattern.trim().length === 0 || hasParentSegment(pattern)) continue

    const expanded = resolveCapabilityPath(pattern, moduleRoot)
    const absolute = cleanPath(
      toPosix(normalize(isAbsolute(expanded) ? expanded : resolve(moduleRoot, expanded))),
    )
    if (!matchPath(absolute, target)) continue

    const base = anchor(pattern)
    if (base === undefined) return deny(`capability pattern has no base directory: ${pattern}`)

    // A grant anchored at the filesystem root (`/**`) has base `/`, and
    // `'/' + '/'` would be `//`, which no path starts with.
    if (realTarget === base || base === '/' || realTarget.startsWith(base + '/')) {
      return { ok: true }
    }
    denied = `fs.${direction} path resolves through a symlink outside the granted pattern ${pattern}: ${realTarget}`
  }

  return deny(denied)
}

/** Gate a network request. Host matching is case-insensitive and glob-aware. */
export function checkNet(
  capabilities: ModuleCapabilities | undefined,
  host: string,
): CapabilityCheck {
  const patterns = capabilities?.net?.hosts
  if (patterns === undefined || patterns.length === 0) {
    return deny('no net capability granted')
  }

  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, '')
  if (normalizedHost.length === 0) return deny('empty host')

  for (const pattern of patterns) {
    const normalizedPattern = pattern.trim().toLowerCase().replace(/\.$/, '')
    if (normalizedPattern.length === 0) continue
    if (matchPath(normalizedPattern, normalizedHost)) return { ok: true }
  }

  return deny(`host is outside the granted patterns: ${normalizedHost}`)
}

/**
 * Gate `ctx.process.run` on the declared command allowlist.
 *
 * `process.spawn` is a list of command globs. A command matches either its
 * full string (`/usr/local/bin/node`) or its basename (`node`), using the same
 * anchored glob as {@link matchPath}. Matching is case-sensitive, and `'*'`
 * grants every command. An absent or empty list grants nothing.
 */
export function checkProcess(
  capabilities: ModuleCapabilities | undefined,
  command: string,
): CapabilityCheck {
  const patterns = capabilities?.process?.spawn
  if (patterns === undefined || patterns.length === 0) {
    return deny('no process.spawn capability granted')
  }

  const wanted = command.trim()
  if (wanted.length === 0) return deny('empty command')
  const wantedBase = basename(wanted)

  for (const pattern of patterns) {
    const trimmed = pattern.trim()
    if (trimmed.length === 0) continue
    if (trimmed === '*') return { ok: true }
    if (matchPath(trimmed, wanted) || matchPath(trimmed, wantedBase)) return { ok: true }
  }

  return deny(`command "${wanted}" is outside the granted process.spawn patterns`)
}

/**
 * Gate `ctx.llm.chat` on the declared provider.
 *
 * `llm: true` grants every provider; `{ providers: [...] }` grants exactly the
 * listed ones (case-insensitive, no globs) and an empty list grants none.
 */
export function checkLlm(
  capabilities: ModuleCapabilities | undefined,
  provider: string,
): CapabilityCheck {
  const grant = capabilities?.llm
  if (grant === undefined) return deny('no llm capability granted')
  if (grant === true) return { ok: true }

  const wanted = provider.trim().toLowerCase()
  if (wanted.length === 0) return deny('empty model provider')
  const providers = grant.providers ?? []
  if (providers.length === 0) return deny('llm.providers is empty')
  for (const candidate of providers) {
    if (candidate.trim().toLowerCase() === wanted) return { ok: true }
  }
  return deny(`model provider "${wanted}" is outside the granted providers`)
}

/** Gate `ctx.tools.call` on the declared tool name. Same grant rules as {@link checkLlm}. */
export function checkTool(
  capabilities: ModuleCapabilities | undefined,
  name: string,
): CapabilityCheck {
  const grant = capabilities?.tools
  if (grant === undefined) return deny('no tools capability granted')
  if (grant === true) return { ok: true }

  const wanted = name.trim()
  if (wanted.length === 0) return deny('empty tool name')
  const names = grant.names ?? []
  if (names.length === 0) return deny('tools.names is empty')
  for (const candidate of names) {
    if (candidate === wanted) return { ok: true }
  }
  return deny(`tool "${wanted}" is outside the granted tools`)
}
