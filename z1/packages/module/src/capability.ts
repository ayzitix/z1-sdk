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
  options: { followFinal?: boolean } = {},
): CapabilityCheck {
  const lexical = checkFs(capabilities, direction, path, moduleDir)
  if (!lexical.ok) return lexical

  const patterns = capabilities?.fs?.[direction] ?? []
  const moduleRoot = cleanPath(toPosix(normalize(resolve(moduleDir))))
  const realModuleRoot = resolveReal(moduleRoot)
  if (realModuleRoot === undefined) return deny(`cannot resolve the module directory: ${moduleDir}`)

  const target = cleanPath(toPosix(normalize(resolve(moduleRoot, path))))
  // `fs.stat` uses lstat, so the final component is reported, never followed;
  // resolving it would deny statting a link that points outside the grant while
  // protecting nothing. Intermediate components are still resolved.
  const realTarget =
    options.followFinal === false
      ? (() => {
          const parent = resolveReal(dirname(target))
          return parent === undefined ? undefined : join(parent, basename(target))
        })()
      : resolveReal(target)
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
 * How a host or resolved address is classified by the SSRF guard.
 *
 * Only `public` is reachable without an explicit grant. `reserved` covers the
 * blocks that are neither routable nor a documented special case (for example
 * `240.0.0.0/4`), because a request to them is never a legitimate page fetch.
 */
export type NetAddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'ula'
  | 'unspecified'
  | 'multicast'
  | 'reserved'

/** Cloud metadata endpoints that must never be reachable through a wildcard. */
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

/** Lower-case, drop brackets and the root-label dot, so `[::1]` and `::1` compare. */
function normalizeHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
}

function parseIPv4(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    octets.push(octet)
  }
  return octets
}

/** Eight hextets, or `undefined` when `value` is not an IPv6 literal. */
function parseIPv6(value: string): number[] | undefined {
  let text = value
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (!text.includes(':')) return undefined

  // A trailing dotted quad is two hextets: `::ffff:127.0.0.1`.
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (v4 === undefined) return undefined
    const high = ((v4[0]! << 8) | v4[1]!).toString(16)
    const low = ((v4[2]! << 8) | v4[3]!).toString(16)
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const groups = (part: string): number[] | undefined => {
    if (part.length === 0) return []
    const out: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
      out.push(parseInt(group, 16))
    }
    return out
  }
  const head = groups(halves[0] ?? '')
  if (head === undefined) return undefined
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const rest = groups(halves[1] ?? '')
  if (rest === undefined) return undefined
  const fill = 8 - head.length - rest.length
  if (fill < 0) return undefined
  return [...head, ...Array<number>(fill).fill(0), ...rest]
}

function classifyIPv4(octets: readonly number[]): NetAddressClass {
  const [a, b] = octets as [number, number, number, number]
  if (a === 0) return 'unspecified'
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'link-local'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  return 'public'
}

function classifyIPv6(hextets: readonly number[]): NetAddressClass {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [
    number, number, number, number, number, number, number, number,
  ]
  const leadingZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0
  // `::ffff:a.b.c.d` is an IPv4 address wearing an IPv6 hat; classify the v4.
  if (leadingZero && h5 === 0xffff) {
    return classifyIPv4([h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff])
  }
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0) {
    // `::` is unspecified, `::1` loopback, everything else in `::/64` reserved.
    if (h7 === 0) return 'unspecified'
    if (h7 === 1) return 'loopback'
    return 'reserved'
  }
  if ((h0 & 0xfe00) === 0xfc00) return 'ula'
  if ((h0 & 0xffc0) === 0xfe80) return 'link-local'
  if ((h0 & 0xff00) === 0xff00) return 'multicast'
  return 'public'
}

/**
 * Classify one address literal or hostname. Hostnames are only judged on the
 * names that are private by definition (`localhost`, cloud metadata aliases);
 * everything else needs a DNS answer, which is the caller's job.
 */
export function classifyNetTarget(value: string): NetAddressClass {
  const host = normalizeHost(value)
  if (host.length === 0) return 'reserved'
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  if (METADATA_HOSTNAMES.has(host)) return 'link-local'

  const v4 = parseIPv4(host)
  if (v4 !== undefined) return classifyIPv4(v4)
  const v6 = parseIPv6(host)
  if (v6 !== undefined) return classifyIPv6(v6)
  return 'public'
}

/** True when the address is not publicly routable and needs an explicit grant. */
export function isPrivateAddress(value: string): boolean {
  return classifyNetTarget(value) !== 'public'
}

/**
 * The SSRF half of the network gate: refuse a target that resolves somewhere
 * private unless the module asked for **that exact host**.
 *
 * A wildcard is a statement about the public internet ("any site"), never a
 * statement about the operator's machine, so `*` cannot unlock loopback, the
 * LAN, link-local or the cloud metadata service. `hosts: ['*', '127.0.0.1']`
 * reaches a local service at `http://127.0.0.1:8888` and still fails for
 * `http://192.168.1.5`.
 *
 * `resolved` is every address the name resolved to; the target is blocked if
 * *any* of them is private, so a DNS answer with one public and one private
 * record cannot be used to smuggle the request past the check.
 */
export function checkNetTarget(
  capabilities: ModuleCapabilities | undefined,
  host: string,
  resolved: readonly string[],
): CapabilityCheck {
  const normalizedHost = normalizeHost(host)
  const privateAddresses = resolved.filter((address) => isPrivateAddress(address))
  const hostIsPrivate = isPrivateAddress(normalizedHost)
  if (!hostIsPrivate && privateAddresses.length === 0) return { ok: true }

  const patterns = capabilities?.net?.hosts ?? []
  for (const pattern of patterns) {
    const normalizedPattern = normalizeHost(pattern)
    if (normalizedPattern.length === 0) continue
    // Wildcards are not an explicit grant, even when they happen to match.
    if (/[*?]/.test(normalizedPattern)) continue
    if (normalizedPattern === normalizedHost) return { ok: true }
  }

  const target = privateAddresses.length > 0 ? privateAddresses.join(', ') : normalizedHost
  return deny(
    `private, loopback, link-local or metadata target ${normalizedHost} (${target}) needs an explicit net.hosts entry; a wildcard does not grant it`,
  )
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
