import { realpathSync } from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import type { ModuleCapabilities } from './types.ts'

export type CapabilityCheck = { ok: true } | { ok: false; reason: string }

const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/** `normalize` keeps a trailing slash; capability matching compares clean paths. */
function cleanPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed.length === 0) return '/'
  // `C:/` is the root of a drive, not the drive-relative `C:`.
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`
  return trimmed
}

/**
 * Fold a path for comparison the way the platform compares it.
 *
 * Windows paths are case-insensitive, so a grant spelled `${moduleDir}/Sub/**`
 * and the real directory `sub` name the same place, and comparing them
 * literally denied a path the filesystem considers granted. POSIX keeps the two
 * apart. Only comparisons fold: the paths this module returns, reports and
 * hands back keep the case the caller or the filesystem used.
 */
function foldedPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Resolve a path or capability pattern to a cleaned POSIX form. `resolve` maps
 * a POSIX-style root (`/**`, `/tmp/**`) to the current drive on Windows and
 * leaves it untouched on POSIX; a `C:/...` path stays on its own drive.
 */
function absolutePath(value: string, base: string): string {
  return cleanPath(toPosix(normalize(resolve(base, value))))
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

  const moduleRoot = absolutePath(moduleDir, process.cwd())
  const target = absolutePath(path, moduleRoot)
  // Windows compares paths case-insensitively, so the pattern is matched
  // against the same fold: `Sub/**` names the directory the filesystem also
  // reports as `sub`. Nothing is rewritten, this is a comparison only.
  const probe = foldedPath(target)

  for (const pattern of patterns) {
    if (pattern.trim().length === 0) continue
    if (hasParentSegment(pattern)) continue

    const expanded = resolveCapabilityPath(pattern, moduleRoot)
    const absolute = absolutePath(expanded, moduleRoot)
    if (matchPath(foldedPath(absolute), probe)) return { ok: true }
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
      return cleanPath(toPosix(normalize(missing.length === 0 ? real : join(real, ...missing.reverse()))))
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
 *
 * A pattern with no literal directory (`**`) is anchored at the module
 * directory, which is where {@link checkFs} resolves it: `**` and
 * `${moduleDir}/**` both mean "anywhere inside the module", and neither reaches
 * outside it. A matching pattern that cannot be anchored is skipped rather than
 * allowed to cancel the patterns listed after it.
 *
 * Both the lexical and the containment comparisons fold case on Windows, where
 * `${moduleDir}/Sub/**` and the directory `sub` are the same place. The reported
 * paths keep their own case.
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
  const moduleRoot = absolutePath(moduleDir, process.cwd())
  const realModuleRoot = resolveReal(moduleRoot)
  if (realModuleRoot === undefined) return deny(`cannot resolve the module directory: ${moduleDir}`)

  const target = absolutePath(path, moduleRoot)
  // `fs.stat` uses lstat, so the final component is reported, never followed;
  // resolving it would deny statting a link that points outside the grant while
  // protecting nothing. Intermediate components are still resolved.
  const realTarget =
    options.followFinal === false
      ? (() => {
          const parent = resolveReal(dirname(target))
          return parent === undefined
            ? undefined
            : cleanPath(toPosix(normalize(join(parent, basename(target)))))
        })()
      : resolveReal(target)
  if (realTarget === undefined) return deny(`cannot resolve the path: ${path}`)

  /** The literal base, with any `moduleDir` part mapped onto its real path. */
  const anchor = (pattern: string): string | undefined => {
    const wildcard = pattern.search(/[*?[\]]/)
    const literal = wildcard < 0 ? pattern : pattern.slice(0, pattern.lastIndexOf('/', wildcard) + 1)
    // A pattern with no literal directory at all (`**`, `*`, `*.json`) is
    // resolved against the module directory by `checkFs`, so its base is the
    // module directory. Returning `undefined` here is what made a `**` grant
    // deny every read instead of granting the whole module tree.
    if (literal.length === 0) return realModuleRoot

    const expanded = resolveCapabilityPath(literal, moduleRoot)
    const absolute = absolutePath(expanded, moduleRoot)
    if (absolute === moduleRoot) return realModuleRoot
    if (absolute.startsWith(moduleRoot + '/')) {
      return toPosix(join(realModuleRoot, absolute.slice(moduleRoot.length + 1)))
    }
    // An absolute grant outside the module directory is the operator's choice;
    // resolve it so its own symlinks are honoured.
    return resolveReal(absolute)
  }

  let denied = `fs.${direction} path resolves outside the granted patterns: ${path}`
  // The same fold `checkFs` uses: this loop repeats its lexical match, and an
  // unfolded repeat would deny the path the first pass just allowed.
  const foldedTargetPath = foldedPath(target)
  for (const pattern of patterns) {
    if (pattern.trim().length === 0 || hasParentSegment(pattern)) continue

    const expanded = resolveCapabilityPath(pattern, moduleRoot)
    const absolute = absolutePath(expanded, moduleRoot)
    if (!matchPath(foldedPath(absolute), foldedTargetPath)) continue

    const base = anchor(pattern)
    if (base === undefined) {
      // A matching pattern whose literal base cannot be resolved protects
      // nothing, but it must not cancel the patterns listed after it: record
      // why and let a later pattern have its say.
      denied = `capability pattern has no base directory: ${pattern}`
      continue
    }

    // A grant anchored at the filesystem root (`/**` -> `/` on POSIX, `C:/` on
    // Windows) has a base that already ends in a slash; do not add another.
    // The containment test folds case on Windows, where the base and the real
    // path differ only by spelling; the boundary itself is still the separator,
    // so a sibling that merely shares a prefix stays outside.
    const foldedBase = foldedPath(base)
    const prefix = foldedBase.endsWith('/') ? foldedBase : `${foldedBase}/`
    const foldedTarget = foldedPath(realTarget)
    if (foldedTarget === foldedBase || foldedTarget.startsWith(prefix)) {
      return { ok: true }
    }
    denied = `fs.${direction} path resolves through a symlink outside the granted pattern ${pattern}: ${realTarget}`
  }

  return deny(denied)
}

/**
 * A parsed `net.hosts` entry: `host`, `host:port`, `[ipv6]`, `[ipv6]:port`.
 * A pattern without a port matches any port (patterns written before ports
 * existed keep working); a pattern with one matches only that port.
 */
export interface HostPattern {
  host: string
  port?: number
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535
}

function parsePort(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined
  const port = Number(text)
  return validPort(port) ? port : undefined
}

/**
 * Parse one `net.hosts` entry into `{ host, port? }`. `undefined` means the
 * entry is not usable (empty, malformed brackets, a non-numeric or out-of-range
 * port) and is ignored rather than granting anything.
 *
 * Accepted shapes: `example.com`, `example.com:443`, `[::1]`, `[::1]:8888`,
 * `::1`. A bare IPv6 literal is always a host, never `host:port`, because its
 * colons are the address.
 */
export function parseHostPattern(value: string): HostPattern | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined

  // `[::1]:8888` and `[::1]`: brackets are what makes an IPv6 port possible.
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return undefined
    const host = normalizeHost(trimmed.slice(0, end + 1))
    if (host.length === 0) return undefined
    const rest = trimmed.slice(end + 1)
    if (rest === '') return { host }
    if (!rest.startsWith(':')) return undefined
    const port = parsePort(rest.slice(1))
    return port === undefined ? undefined : { host, port }
  }

  const colons = trimmed.split(':').length - 1
  // A bare IPv6 literal is a host with no port; `a:b` with a non-numeric tail is
  // simply not a host pattern.
  if (colons === 0) return { host: normalizeHost(trimmed) }
  if (colons > 1) return { host: normalizeHost(trimmed) }
  const [hostPart = '', portPart = ''] = trimmed.split(':')
  const host = normalizeHost(hostPart)
  if (host.length === 0) return undefined
  const port = parsePort(portPart)
  return port === undefined ? undefined : { host, port }
}

/** `undefined` when the caller did not supply a port (a host-only check). */
function normalizePort(port: number | undefined): number | undefined {
  return port !== undefined && validPort(port) ? port : undefined
}

/**
 * Gate a network request. Host matching is case-insensitive and glob-aware.
 *
 * `port` is the **effective** port of the request: the explicit one, or the
 * scheme's default (80/443). A pattern that names a port (`127.0.0.1:8888`)
 * only matches that port, so granting a local backend one port no longer
 * grants every listener on the loopback interface. A pattern without a port
 * matches any port — the pre-port behaviour, unchanged.
 */
export function checkNet(
  capabilities: ModuleCapabilities | undefined,
  host: string,
  port?: number,
): CapabilityCheck {
  const patterns = capabilities?.net?.hosts
  if (patterns === undefined || patterns.length === 0) {
    return deny('no net capability granted')
  }

  const normalizedHost = normalizeHost(host)
  if (normalizedHost.length === 0) return deny('empty host')
  const wantedPort = normalizePort(port)

  for (const pattern of patterns) {
    const parsed = parseHostPattern(pattern)
    if (parsed === undefined) continue
    if (!matchPath(parsed.host, normalizedHost)) continue
    if (parsed.port !== undefined) {
      // A port-scoped grant cannot be honoured without knowing the port.
      if (wantedPort === undefined || parsed.port !== wantedPort) continue
    }
    return { ok: true }
  }

  const suffix = wantedPort === undefined ? '' : `:${String(wantedPort)}`
  return deny(`host is outside the granted patterns: ${normalizedHost}${suffix}`)
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
  // Alibaba Cloud's ECS metadata service, reachable as a bare address.
  '100.100.100.200',
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

/**
 * One part of a legacy `inet_aton` address: decimal, octal with a leading `0`,
 * or hexadecimal with `0x`. Anything else returns `undefined`, so a hostname is
 * never mistaken for an address.
 */
function parseLegacyPart(part: string): number | undefined {
  if (/^0x[0-9a-f]+$/.test(part)) return Number.parseInt(part.slice(2), 16)
  // `08` and `09` are neither octal nor decimal in `inet_aton`; `0` alone is.
  if (/^0[0-7]*$/.test(part)) return Number.parseInt(part, 8)
  if (/^[1-9]\d*$/.test(part)) return Number(part)
  return undefined
}

/**
 * The legacy `inet_aton` IPv4 forms that the C library still accepts: one to
 * four dot-separated parts, each decimal, octal or hexadecimal, where the last
 * part fills the bytes the earlier ones left over.
 *
 * `parseIPv4` only understands four decimal octets, so `127.1`, `0x7f.0.0.1`,
 * `0177.0.0.1` and `2130706433` were classified as public hostnames while
 * `fetch` and `getaddrinfo` connected them to loopback — a wildcard grant
 * reached a local service. Byte order follows `inet_aton`: one part is the
 * whole 32-bit value, four parts are four octets.
 */
function parseIPv4Legacy(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length > 4) return undefined
  const numbers: number[] = []
  for (const part of parts) {
    const parsed = parseLegacyPart(part)
    if (parsed === undefined) return undefined
    numbers.push(parsed)
  }
  const tail = numbers[numbers.length - 1]
  if (tail === undefined) return undefined
  const head = numbers.slice(0, -1)
  for (const number of head) {
    if (number > 0xff) return undefined
  }
  const tailBytes = 4 - head.length
  if (tail >= 2 ** (8 * tailBytes)) return undefined
  const octets = [...head]
  for (let shift = tailBytes - 1; shift >= 0; shift -= 1) {
    octets.push((tail >>> (8 * shift)) & 0xff)
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
  const [a, b, c] = octets as [number, number, number, number]
  if (a === 0) return 'unspecified'
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  // RFC 6598 carrier-grade NAT. Alibaba's metadata service (100.100.100.200)
  // and many container networks live here, and it is never a public page.
  if (a === 100 && b >= 64 && b <= 127) return 'private'
  if (a === 169 && b === 254) return 'link-local'
  // RFC 2544 benchmarking range: never a real destination.
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'
  // RFC 5737 documentation ranges, and 192.0.0.0/24 (IETF protocol
  // assignments, which includes 192.0.0.170/171 used by NAT64 discovery).
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved'
  if (a === 198 && b === 51 && c === 100) return 'reserved'
  if (a === 203 && b === 0 && c === 113) return 'reserved'
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
  // `::ffff:0:a.b.c.d` (RFC 6052 IPv4-translated, `::ffff:0:0/96`): the v4 sits
  // in the last 32 bits behind `0:0:0:0:ffff:0`. It is not the mapped block
  // above, and a naive parser calls `::ffff:0:127.0.0.1` public.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
    const inner = classifyIPv4([h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff])
    return inner === 'public' ? 'reserved' : inner
  }
  // `64:ff9b::/96` is the well-known NAT64 prefix: an IPv4 destination in an
  // IPv6 coat. Judge the embedded address, and never let the coat make a
  // translation-only route look public.
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    const inner = classifyIPv4([h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff])
    return inner === 'public' ? 'reserved' : inner
  }
  // `2002::/16` is 6to4: `2002:V4HI:V4LO::/48`. Deprecated, never a page fetch;
  // a tunnel to a private/loopback v4 is exactly the SSRF case to refuse.
  if (h0 === 0x2002) {
    const inner = classifyIPv4([h1 >> 8, h1 & 0xff, h2 >> 8, h2 & 0xff])
    return inner === 'public' ? 'reserved' : inner
  }
  // `2001:db8::/32` is documentation-only.
  if (h0 === 0x2001 && h1 === 0x0db8) return 'reserved'
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
 *
 * Numeric literals include the legacy `inet_aton` spellings ({@link
 * parseIPv4Legacy}), because `127.1` and `2130706433` are loopback to the
 * resolver even though they are not four decimal octets.
 */
export function classifyNetTarget(value: string): NetAddressClass {
  const host = normalizeHost(value)
  if (host.length === 0) return 'reserved'
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  if (METADATA_HOSTNAMES.has(host)) return 'link-local'

  const v4 = parseIPv4(host) ?? parseIPv4Legacy(host)
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
 * An explicit entry is a host, or `host:port` to scope it to one port. The
 * `port` argument is the effective port of the request (explicit or scheme
 * default), so `hosts: ['127.0.0.1:8888']` unlocks only 8888 while a bare
 * `127.0.0.1` keeps the old any-port meaning.
 *
 * `resolved` is every address the name resolved to; the target is blocked if
 * *any* of them is private, so a DNS answer with one public and one private
 * record cannot be used to smuggle the request past the check.
 */
export function checkNetTarget(
  capabilities: ModuleCapabilities | undefined,
  host: string,
  resolved: readonly string[],
  port?: number,
): CapabilityCheck {
  const normalizedHost = normalizeHost(host)
  const privateAddresses = resolved.filter((address) => isPrivateAddress(address))
  const hostIsPrivate = isPrivateAddress(normalizedHost)
  if (!hostIsPrivate && privateAddresses.length === 0) return { ok: true }

  const wantedPort = normalizePort(port)
  const patterns = capabilities?.net?.hosts ?? []
  for (const pattern of patterns) {
    const parsed = parseHostPattern(pattern)
    if (parsed === undefined) continue
    // Wildcards are not an explicit grant, even when they happen to match.
    if (/[*?]/.test(parsed.host)) continue
    if (parsed.host !== normalizedHost) continue
    if (parsed.port !== undefined) {
      if (wantedPort === undefined || parsed.port !== wantedPort) continue
    }
    return { ok: true }
  }

  const target = privateAddresses.length > 0 ? privateAddresses.join(', ') : normalizedHost
  const suffix = wantedPort === undefined ? '' : `:${String(wantedPort)}`
  return deny(
    `private, loopback, link-local or metadata target ${normalizedHost}${suffix} (${target}) needs an explicit net.hosts entry; a wildcard does not grant it`,
  )
}

/**
 * Gate `ctx.process.run` on the declared command allowlist.
 *
 * `process.spawn` is a list of command globs. A command matches either its
 * full string (`/usr/local/bin/node`) or its basename (`node`), using the same
 * anchored glob as {@link matchPath}. Matching is case-sensitive, and `'*'`
 * grants every command. An absent or empty list grants nothing.
 *
 * ## `process.spawn` is host access, not a narrow grant
 *
 * There is no sandbox around the spawned command. Granting an *interpreter* or
 * a *tool with an escape hatch* grants everything the z1 process can do:
 *
 * - `node -e '<code>'` (and `python -c`, `perl -e`, `ruby -e`, `deno eval`)
 *   executes arbitrary code with no `fs`/`net`/`process` capability check;
 * - `git -c alias.x='!sh -c …' x` runs a shell because git runs aliases;
 * - `env`, `sh`, `bash`, `find -exec`, `xargs`, `tar --to-command`, `awk`
 *   `system()`, and anything that launches a child are equivalent.
 *
 * So a `process.spawn` grant is exactly as strong as `fs.read: ['/**']` plus
 * `net.hosts: ['*']` plus `process.spawn: ['*']`, and the per-call fs/net
 * gates do not apply to code the child runs. Only grant commands whose *entire*
 * behaviour is acceptable, and never grant an interpreter to a module that is
 * not fully trusted. Closing this needs an OS-level sandbox (container, seccomp,
 * user namespace), which this package does not provide.
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
  const wantedPosix = toPosix(wanted)
  const wantedBase = basename(wanted)
  // A Windows grant for `node` must match `node.exe`; the extension is not
  // part of the command name an operator writes. Only strip executable
  // extensions, never an arbitrary dotted suffix (`python3.12`).
  const wantedStem =
    process.platform === 'win32'
      ? wantedBase.replace(/\.(exe|cmd|bat|com)$/i, '')
      : wantedBase

  for (const pattern of patterns) {
    const trimmed = pattern.trim()
    if (trimmed.length === 0) continue
    if (trimmed === '*') return { ok: true }
    const normalized = toPosix(trimmed)
    if (
      matchPath(normalized, wantedPosix) ||
      matchPath(normalized, wantedBase) ||
      matchPath(normalized, wantedStem)
    ) {
      return { ok: true }
    }
  }

  return deny(`command "${wanted}" is outside the granted process.spawn patterns`)
}

/** Commands that can run arbitrary code or launch another command themselves. */
const INTERPRETER_PATTERNS = [
  /(^|\/)(node|nodejs|deno|bun|tsx|ts-node|python[0-9.]*|perl|ruby|php|java|lua|Rscript|osascript)$/,
  /(^|\/)(sh|bash|zsh|dash|fish|csh|ksh|pwsh|powershell|cmd)(\.exe)?$/,
  /(^|\/)(env|xargs|find|awk|gawk|sed|tar|make|cmake|git|npm|npx|pnpm|yarn|cargo|go|docker|kubectl|ssh)$/,
]

/** A grant that is not a single narrow binary: an interpreter, a shell, or `*`. */
function isBroadCommand(pattern: string): boolean {
  const trimmed = pattern.trim()
  if (trimmed === '') return false
  if (trimmed === '*') return true
  return (
    INTERPRETER_PATTERNS.some((test) => test.test(trimmed)) ||
    INTERPRETER_PATTERNS.some((test) => test.test(basename(trimmed)))
  )
}

/**
 * Human-readable warnings for a capability grant, for approval prompts and the
 * audit trail. Empty when nothing in the grant is broader than it looks.
 *
 * The one that matters: `process.spawn` is host access. See
 * {@link checkProcess} — an interpreter grant is equivalent to giving the
 * module the user's whole account, and the fs/net capability checks stop
 * applying to whatever the child does.
 */
export function describeCapabilityRisks(capabilities: ModuleCapabilities | undefined): string[] {
  const warnings: string[] = []
  const spawn = capabilities?.process?.spawn ?? []
  if (spawn.length > 0) {
    // Always say this, whatever the command: `git` runs aliases, `node -e`
    // runs code, and both are as strong as the whole grant set.
    warnings.push(
      'spawn is full host access (`node -e`, `git`, `python`) — it bypasses fs/net grants',
    )
    const broad = spawn.filter((pattern) => isBroadCommand(pattern))
    if (broad.length > 0) {
      warnings.push(
        `process.spawn grants an interpreter, shell or wildcard (${broad.join(', ')}): ` +
          'only grant commands whose entire behaviour is acceptable',
      )
    }
  }
  const hosts = capabilities?.net?.hosts ?? []
  if (hosts.some((host) => host.includes('*') && host.trim() !== '*')) {
    warnings.push('net.hosts contains a wildcard pattern; prefer a literal host, or host:port for a local backend')
  }
  if (hosts.some((host) => /^(\*|0\.0\.0\.0|::)$/.test(host.trim()))) {
    warnings.push('net.hosts "*" reaches the public internet but never private/metadata targets; explicit private entries are still needed')
  }
  return warnings
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
