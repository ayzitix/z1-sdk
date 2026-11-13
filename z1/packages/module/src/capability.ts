import { isAbsolute, normalize, resolve, sep } from 'node:path'
import type { ModuleCapabilities } from './types.ts'

export type CapabilityCheck = { ok: true } | { ok: false; reason: string }

const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

function toPosix(path: string): string {
  return path.split(sep).join('/')
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
  const target = toPosix(normalize(resolve(moduleRoot, path)))

  for (const pattern of patterns) {
    if (pattern.trim().length === 0) continue
    if (hasParentSegment(pattern)) continue

    const expanded = resolveCapabilityPath(pattern, moduleRoot)
    const absolute = toPosix(
      normalize(isAbsolute(expanded) ? expanded : resolve(moduleRoot, expanded)),
    )
    if (matchPath(absolute, target)) return { ok: true }
  }

  return deny(`fs.${direction} path is outside the granted patterns: ${target}`)
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
