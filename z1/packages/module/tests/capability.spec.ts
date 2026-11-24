import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  checkFs,
  checkFsReal,
  checkNet,
  checkNetTarget,
  checkProcess,
  classifyNetTarget,
  describeCapabilityRisks,
  isPrivateAddress,
  matchPath,
  parseHostPattern,
  resolveCapabilityPath,
} from '../src/index.ts'
import type { ModuleCapabilities } from '../src/types.ts'

describe('matchPath', () => {
  test('* stays inside one path segment', () => {
    expect(matchPath('*.js', 'a.js')).toBe(true)
    expect(matchPath('*.js', 'dir/a.js')).toBe(false)
    expect(matchPath('data/*.json', 'data/a.json')).toBe(true)
    expect(matchPath('data/*.json', 'data/nested/a.json')).toBe(false)
  })

  test('** crosses segments and may collapse to empty', () => {
    expect(matchPath('**/*.js', 'a.js')).toBe(true)
    expect(matchPath('**/*.js', 'a/b/c.js')).toBe(true)
    expect(matchPath('a/**/b', 'a/b')).toBe(true)
    expect(matchPath('a/**/b', 'a/x/y/b')).toBe(true)
    expect(matchPath('a/**', 'a/b/c')).toBe(true)
    expect(matchPath('a/**', 'a')).toBe(false)
    expect(matchPath('**', 'anything/at/all')).toBe(true)
  })

  test('? matches exactly one non-separator character', () => {
    expect(matchPath('file?.txt', 'file1.txt')).toBe(true)
    expect(matchPath('file?.txt', 'file12.txt')).toBe(false)
    expect(matchPath('a/?/c', 'a//c')).toBe(false)
  })

  test('escapes regex metacharacters', () => {
    expect(matchPath('a.b', 'a.b')).toBe(true)
    expect(matchPath('a.b', 'axb')).toBe(false)
    expect(matchPath('a+b', 'a+b')).toBe(true)
  })
})

describe('resolveCapabilityPath', () => {
  test('replaces every moduleDir placeholder', () => {
    expect(resolveCapabilityPath('${moduleDir}/data/**', '/opt/mod')).toBe('/opt/mod/data/**')
    expect(resolveCapabilityPath('${moduleDir}/${moduleDir}', '/m')).toBe('/m//m')
  })
})

describe('checkFs', () => {
  const moduleDir = join('/tmp', 'z1-capability-module')
  const capabilities: ModuleCapabilities = {
    fs: {
      read: ['${moduleDir}/data/**'],
      write: ['${moduleDir}/out/*.json'],
    },
  }

  test('allows matching reads and writes', () => {
    expect(checkFs(capabilities, 'read', join(moduleDir, 'data', 'a.txt'), moduleDir)).toEqual({
      ok: true,
    })
    expect(checkFs(capabilities, 'write', 'out/result.json', moduleDir)).toEqual({ ok: true })
  })

  test('denies outside the granted patterns and wrong direction', () => {
    expect(checkFs(capabilities, 'read', join(moduleDir, 'secret.txt'), moduleDir).ok).toBe(false)
    expect(checkFs(capabilities, 'write', join(moduleDir, 'data', 'a.txt'), moduleDir).ok).toBe(false)
    expect(checkFs(capabilities, 'write', join(moduleDir, 'out', 'nested', 'a.json'), moduleDir).ok).toBe(
      false,
    )
  })

  test('denies by default and rejects parent segments', () => {
    expect(checkFs(undefined, 'read', 'data/a.txt', moduleDir).ok).toBe(false)
    expect(checkFs({ fs: { read: [] } }, 'read', 'data/a.txt', moduleDir).ok).toBe(false)
    expect(checkFs(capabilities, 'read', 'data/../secret.txt', moduleDir).ok).toBe(false)

    const escapingPattern: ModuleCapabilities = { fs: { read: ['${moduleDir}/data/../secret'] } }
    expect(checkFs(escapingPattern, 'read', join(moduleDir, 'secret'), moduleDir).ok).toBe(false)
  })
})

describe('checkFsReal', () => {
  function fixture(): { root: string; moduleDir: string; outside: string } {
    const root = mkdtempSync(join(tmpdir(), 'z1-fsreal-'))
    const moduleDir = join(root, 'mod')
    mkdirSync(join(moduleDir, 'data', 'sub'), { recursive: true })
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(moduleDir, 'data', 'a.txt'), 'inside')
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    return { root, moduleDir, outside }
  }

  const capabilities: ModuleCapabilities = {
    fs: { read: ['${moduleDir}/data/**'], write: ['${moduleDir}/out/**'] },
  }

  test('allows real paths inside the granted tree', () => {
    const { moduleDir } = fixture()
    expect(checkFsReal(capabilities, 'read', join(moduleDir, 'data', 'a.txt'), moduleDir)).toEqual({
      ok: true,
    })
  })

  test('denies a symlink that escapes the granted tree', () => {
    const { moduleDir, outside } = fixture()
    symlinkSync(outside, join(moduleDir, 'data', 'link'))

    // The lexical check cannot see the link, the real one must.
    const path = join(moduleDir, 'data', 'link', 'secret.txt')
    expect(checkFs(capabilities, 'read', path, moduleDir).ok).toBe(true)
    expect(checkFsReal(capabilities, 'read', path, moduleDir).ok).toBe(false)
  })

  test('denies a symlinked directory used as a write target', () => {
    const { moduleDir, outside } = fixture()
    symlinkSync(outside, join(moduleDir, 'out'))

    expect(checkFsReal(capabilities, 'write', join(moduleDir, 'out', 'new.txt'), moduleDir).ok).toBe(
      false,
    )
  })

  test('allows a symlink that stays inside the granted tree', () => {
    const { moduleDir } = fixture()
    symlinkSync(join(moduleDir, 'data', 'sub'), join(moduleDir, 'data', 'inner'))
    writeFileSync(join(moduleDir, 'data', 'sub', 'b.txt'), 'b')

    expect(
      checkFsReal(capabilities, 'read', join(moduleDir, 'data', 'inner', 'b.txt'), moduleDir),
    ).toEqual({ ok: true })
  })

  test('a grant anchored at the filesystem root matches every absolute path', () => {
    // The tools module grants `/**`; an implementation that appends '/' to the
    // base turns the root into '//' and silently denies everything.
    const root: ModuleCapabilities = { fs: { read: ['/**'], write: ['/**'] } }
    for (const path of ['/tmp/x', '/home/me/project/file.ts', '/etc/passwd', '/']) {
      expect(checkFsReal(root, 'read', path, '/opt/module')).toEqual({ ok: true })
    }
  })

  test('a subtree grant still confines an absolute path', () => {
    const subtree: ModuleCapabilities = { fs: { read: ['/tmp/**'] } }
    expect(checkFsReal(subtree, 'read', '/tmp/x', '/opt/module')).toEqual({ ok: true })
    expect(checkFsReal(subtree, 'read', '/etc/passwd', '/opt/module').ok).toBe(false)
    expect(checkFsReal(subtree, 'write', '/tmp/x', '/opt/module').ok).toBe(false)
  })

  test('stat resolves intermediate symlinks but not the final one', () => {
    const { moduleDir, outside } = fixture()
    symlinkSync(outside, join(moduleDir, 'data', 'link'))
    writeFileSync(join(outside, 'secret.txt'), 'outside')

    // `data/link/secret.txt` reaches outside through an intermediate link.
    expect(
      checkFsReal(capabilities, 'read', join(moduleDir, 'data', 'link', 'secret.txt'), moduleDir, {
        followFinal: false,
      }).ok,
    ).toBe(false)

    // A final symlink is reported by lstat and is not followed, so it stays
    // stattable without exposing the target.
    const fileLink = join(moduleDir, 'data', 'file-link')
    symlinkSync(join(outside, 'secret.txt'), fileLink)
    expect(
      checkFsReal(capabilities, 'read', fileLink, moduleDir, { followFinal: false }),
    ).toEqual({ ok: true })
  })

  test('keeps the lexical denials', () => {
    const { moduleDir } = fixture()
    expect(checkFsReal(capabilities, 'read', 'data/../a.txt', moduleDir).ok).toBe(false)
    expect(checkFsReal(capabilities, 'read', join(moduleDir, 'data', 'a.txt'), moduleDir).ok).toBe(
      true,
    )
    expect(checkFsReal(capabilities, 'write', join(moduleDir, 'data', 'a.txt'), moduleDir).ok).toBe(
      false,
    )
    expect(checkFsReal(undefined, 'read', join(moduleDir, 'data', 'a.txt'), moduleDir).ok).toBe(
      false,
    )
  })

  test('`**` grants the module tree and stops at its edge', () => {
    // A bare `**` has no literal directory to anchor on. It used to fall
    // through to "capability pattern has no base directory" and deny every
    // read, so a manifest asking for the whole module got nothing at all.
    const { moduleDir, outside } = fixture()
    const broad: ModuleCapabilities = { fs: { read: ['**'], write: ['**'] } }

    expect(checkFsReal(broad, 'read', join(moduleDir, 'data', 'a.txt'), moduleDir)).toEqual({
      ok: true,
    })
    // A write to a not-yet-existing directory is checked through its nearest
    // existing ancestor, which is the module directory itself.
    expect(checkFsReal(broad, 'write', join(moduleDir, 'out', 'new.txt'), moduleDir)).toEqual({
      ok: true,
    })
    expect(checkFsReal(broad, 'read', join(outside, 'secret.txt'), moduleDir).ok).toBe(false)
    expect(checkFsReal(broad, 'write', join(outside, 'new.txt'), moduleDir).ok).toBe(false)
    // The lexical escape is still rejected, not normalised away.
    expect(checkFsReal(broad, 'read', 'data/../data/a.txt', moduleDir).ok).toBe(false)
  })

  test('`**` and `${moduleDir}/**` mean the same tree in either order', () => {
    const { moduleDir, outside } = fixture()
    // A `**` at the front of the list used to cancel the patterns behind it:
    // `anchor()` returned early instead of letting the loop continue.
    const orders: ModuleCapabilities[] = [
      { fs: { read: ['**', '${moduleDir}/data/**'] } },
      { fs: { read: ['${moduleDir}/data/**', '**'] } },
    ]

    for (const order of orders) {
      expect(checkFsReal(order, 'read', join(moduleDir, 'data', 'a.txt'), moduleDir)).toEqual({
        ok: true,
      })
      expect(checkFsReal(order, 'read', join(outside, 'secret.txt'), moduleDir).ok).toBe(false)
    }
  })

  test('pattern order decides which pattern is tried first, not the verdict', () => {
    // Two narrow grants with no wide one in sight: the second pattern must get
    // its turn when the first one does not match.
    const { moduleDir } = fixture()
    const narrow: ModuleCapabilities = {
      fs: { read: ['${moduleDir}/other/**', '${moduleDir}/data/**'] },
    }
    expect(checkFsReal(narrow, 'read', join(moduleDir, 'data', 'a.txt'), moduleDir)).toEqual({
      ok: true,
    })
    expect(checkFsReal(narrow, 'read', join(moduleDir, 'secret.txt'), moduleDir).ok).toBe(false)
  })

  test('a grant reaches a directory spelled with another case on Windows only', () => {
    const { moduleDir, outside } = fixture()
    mkdirSync(join(moduleDir, 'sub'))
    writeFileSync(join(moduleDir, 'sub', 'b.txt'), 'b')

    const capabilities: ModuleCapabilities = { fs: { read: ['${moduleDir}/Sub/**'] } }
    // Windows compares paths case-insensitively, so the grant and the directory
    // on disk are the same place; POSIX keeps them apart and must keep denying.
    const folded = process.platform === 'win32'
    expect(checkFsReal(capabilities, 'read', join(moduleDir, 'sub', 'b.txt'), moduleDir).ok).toBe(
      folded,
    )
    // The same path spelled the way the grant spells it resolves through the
    // real directory, which used to be denied for the case alone.
    expect(checkFsReal(capabilities, 'read', join(moduleDir, 'Sub', 'b.txt'), moduleDir).ok).toBe(
      folded,
    )

    // Folding case must not turn containment into a prefix test.
    expect(
      checkFsReal(capabilities, 'read', join(moduleDir, 'subset', 'b.txt'), moduleDir).ok,
    ).toBe(false)
    expect(checkFsReal(capabilities, 'read', join(outside, 'secret.txt'), moduleDir).ok).toBe(
      false,
    )
    expect(checkFsReal(capabilities, 'read', 'sub/../sub/b.txt', moduleDir).ok).toBe(false)
  })
})

describe('checkNet', () => {
  test('allows exact and wildcard hosts, case-insensitively', () => {
    const capabilities: ModuleCapabilities = {
      net: { hosts: ['api.example.com', '*.internal.test'] },
    }
    expect(checkNet(capabilities, 'api.example.com')).toEqual({ ok: true })
    expect(checkNet(capabilities, 'API.EXAMPLE.COM.')).toEqual({ ok: true })
    expect(checkNet(capabilities, 'worker.internal.test')).toEqual({ ok: true })
  })

  test('denies by default and non-matching hosts', () => {
    expect(checkNet(undefined, 'api.example.com').ok).toBe(false)
    expect(checkNet({ net: { hosts: [] } }, 'api.example.com').ok).toBe(false)
    expect(checkNet({ net: { hosts: ['api.example.com'] } }, 'evil.test').ok).toBe(false)
    expect(checkNet({ net: { hosts: ['api.example.com'] } }, 'api.example.com.evil.test').ok).toBe(
      false,
    )
  })
})

describe('parseHostPattern', () => {
  test('splits host:port, brackets an IPv6 port, and never breaks a bare IPv6 literal', () => {
    expect(parseHostPattern(' example.com:443 ')).toEqual({ host: 'example.com', port: 443 })
    expect(parseHostPattern('Example.COM:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseHostPattern('[::1]:8888')).toEqual({ host: '::1', port: 8888 })
    expect(parseHostPattern('[::1]')).toEqual({ host: '::1' })
    expect(parseHostPattern('::1')).toEqual({ host: '::1' })
    // A bare IPv6 literal is a host, never `host:port`.
    expect(parseHostPattern('2001:db8::1')).toEqual({ host: '2001:db8::1' })
  })

  test('rejects unusable entries instead of granting them', () => {
    for (const value of [
      '',
      '   ',
      '127.0.0.1:0',
      '127.0.0.1:65536',
      '127.0.0.1:',
      'example.com:https',
      '[::1',
      '[::1]x',
      '[::1]:',
      '[::1]:70000',
      ':8888',
    ]) {
      expect([value, parseHostPattern(value)]).toEqual([value, undefined])
    }
  })
})

describe('port-scoped net grants', () => {
  const onePort: ModuleCapabilities = { net: { hosts: ['127.0.0.1:8888'] } }

  test('a host:port entry grants that port only', () => {
    expect(checkNet(onePort, '127.0.0.1', 8888)).toEqual({ ok: true })
    const denied = checkNet(onePort, '127.0.0.1', 35545)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toContain('127.0.0.1:35545')
    // A port-scoped grant cannot be honoured without knowing the port.
    expect(checkNet(onePort, '127.0.0.1').ok).toBe(false)
    // A bare host keeps the pre-port any-port meaning.
    expect(checkNet({ net: { hosts: ['127.0.0.1'] } }, '127.0.0.1', 35545)).toEqual({ ok: true })
  })

  test('brackets, hostnames and a trailing dot keep their port', () => {
    const v6: ModuleCapabilities = { net: { hosts: ['[::1]:8888'] } }
    expect(checkNet(v6, '::1', 8888)).toEqual({ ok: true })
    expect(checkNet(v6, '[::1]', 8888)).toEqual({ ok: true })
    expect(checkNet(v6, '::1', 8889).ok).toBe(false)
    expect(checkNet(v6, '::1').ok).toBe(false)

    const named: ModuleCapabilities = { net: { hosts: ['localhost:8888'] } }
    expect(checkNet(named, 'localhost', 8888)).toEqual({ ok: true })
    expect(checkNet(named, 'LOCALHOST.', 8888)).toEqual({ ok: true })
    expect(checkNet(named, 'localhost.', 8889).ok).toBe(false)
  })

  test('the SSRF half honours a port-scoped private grant', () => {
    expect(checkNetTarget(onePort, '127.0.0.1', ['127.0.0.1'], 8888)).toEqual({ ok: true })
    const denied = checkNetTarget(onePort, '127.0.0.1', ['127.0.0.1'], 35545)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toContain('127.0.0.1:35545')
    // Port unknown: a port grant does not cover it.
    expect(checkNetTarget(onePort, '127.0.0.1', ['127.0.0.1']).ok).toBe(false)

    const named = checkNetTarget(
      { net: { hosts: ['localhost:8888'] } },
      'localhost.',
      ['::1'],
      8888,
    )
    expect(named).toEqual({ ok: true })
  })

  test('a wildcard still denies every private target, port or not', () => {
    const wildcard: ModuleCapabilities = { net: { hosts: ['*'] } }
    for (const port of [8888, 35545]) {
      const denied = checkNetTarget(wildcard, '127.0.0.1', ['127.0.0.1'], port)
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toMatch(/explicit net\.hosts entry/)
    }
  })
})

describe('isPrivateAddress', () => {
  test('classifies the special-purpose ranges and hostnames', () => {
    const table: Array<[string, boolean]> = [
      ['127.0.0.1', true],
      ['10.0.0.1', true],
      ['172.16.0.1', true],
      ['172.32.0.1', false],
      ['192.168.1.1', true],
      ['169.254.169.254', true],
      ['0.0.0.0', true],
      ['224.0.0.1', true],
      ['::', true],
      ['::1', true],
      ['fc00::1', true],
      ['fd12:3456::1', true],
      ['fe80::1', true],
      ['ff02::1', true],
      ['::ffff:127.0.0.1', true],
      ['::ffff:8.8.8.8', false],
      ['[::1]', true],
      ['93.184.216.34', false],
      ['142.250.185.78', false],
      ['localhost', true],
      ['api.localhost', true],
      ['metadata.google.internal', true],
      ['example.com', false],
      ['searx.lan', false],
      ['', true],
    ]
    for (const [value, expected] of table) {
      expect([value, isPrivateAddress(value)]).toEqual([value, expected])
    }
  })

  test('names the class it found', () => {
    expect(classifyNetTarget('10.1.2.3')).toBe('private')
    expect(classifyNetTarget('172.20.0.1')).toBe('private')
    expect(classifyNetTarget('172.32.0.1')).toBe('public')
    expect(classifyNetTarget('169.254.169.254')).toBe('link-local')
    expect(classifyNetTarget('fe80::1')).toBe('link-local')
    expect(classifyNetTarget('fc00::1')).toBe('ula')
    expect(classifyNetTarget('::1')).toBe('loopback')
    expect(classifyNetTarget('::')).toBe('unspecified')
    expect(classifyNetTarget('239.1.1.1')).toBe('multicast')
    expect(classifyNetTarget('240.0.0.1')).toBe('reserved')
    expect(classifyNetTarget('93.184.216.34')).toBe('public')
  })

  test('the legacy inet_aton spellings of loopback are private', () => {
    // `getaddrinfo` and `inet_aton` accept one to four parts, each decimal,
    // octal or hexadecimal, and every one of these reaches 127.0.0.1. A
    // classifier that only understood four decimal octets called them public,
    // so a `net.hosts: ["*"]` grant was allowed to open a local socket.
    const table: Array<[string, string]> = [
      ['127.1', 'loopback'],
      ['127.0.1', 'loopback'],
      ['0177.0.0.1', 'loopback'],
      ['0x7f.0.0.1', 'loopback'],
      ['0X7F.0.0.1', 'loopback'],
      ['2130706433', 'loopback'],
      ['0x7f000001', 'loopback'],
      ['127.0.0.1', 'loopback'],
      // The wide parser must not swallow ordinary addresses or hostnames.
      ['8.8.8.8', 'public'],
      ['134744072', 'public'],
      ['0x08080808', 'public'],
      ['4294967296', 'public'],
      ['127.0.0.1.5', 'public'],
      ['example.com', 'public'],
      // The private ranges keep working in the legacy forms too.
      ['10.1', 'private'],
      ['192.168.1', 'private'],
      ['169.254.169.254', 'link-local'],
      ['0.0.0.0', 'unspecified'],
      ['::ffff:127.0.0.1', 'loopback'],
    ]
    for (const [value, expected] of table) {
      expect([value, classifyNetTarget(value)]).toEqual([value, expected])
      expect([value, isPrivateAddress(value)]).toEqual([value, expected !== 'public'])
    }
  })

  test('a wildcard grant still cannot reach a legacy loopback spelling', () => {
    const wildcard: ModuleCapabilities = { net: { hosts: ['*'] } }
    for (const host of ['127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1']) {
      expect([host, checkNetTarget(wildcard, host, [], 80).ok]).toEqual([host, false])
    }
    // An explicit entry still grants it, so a module that really talks to a
    // local service keeps a way to say so.
    const explicit: ModuleCapabilities = { net: { hosts: ['127.1'] } }
    expect(checkNetTarget(explicit, '127.1', [], 80)).toEqual({ ok: true })
  })

  test('the special-purpose blocks a naive range check calls public', () => {
    const table: Array<[string, string]> = [
      // RFC 6598 carrier-grade NAT: container networks and vendor metadata.
      ['100.64.0.1', 'private'],
      // Alibaba Cloud's metadata service, by name and by address.
      ['100.100.100.200', 'link-local'],
      // RFC 2544 benchmarking range.
      ['198.18.0.1', 'reserved'],
      // RFC 5737 documentation range.
      ['192.0.2.1', 'reserved'],
      // NAT64 `64:ff9b::/96` with 127.0.0.1 embedded.
      ['64:ff9b::7f00:1', 'loopback'],
      // RFC 6052 IPv4-translated `::ffff:0:0/96` with 127.0.0.1 embedded.
      ['::ffff:0:127.0.0.1', 'loopback'],
      // 6to4 `2002::/16` with 127.0.0.1 embedded.
      ['2002:7f00:1::', 'loopback'],
      // `2001:db8::/32` documentation prefix.
      ['2001:db8::1', 'reserved'],
    ]
    for (const [value, expected] of table) {
      expect([value, classifyNetTarget(value)]).toEqual([value, expected])
      expect([value, isPrivateAddress(value)]).toEqual([value, true])
    }
  })
})

describe('checkNetTarget', () => {
  const loopbackGrant: ModuleCapabilities = { net: { hosts: ['127.0.0.1'] } }

  test('public targets need no special grant', () => {
    expect(checkNetTarget({ net: { hosts: ['*'] } }, 'example.com', ['93.184.216.34'])).toEqual({
      ok: true,
    })
  })

  test('an explicit host entry unlocks a private target', () => {
    expect(checkNetTarget(loopbackGrant, '127.0.0.1', ['127.0.0.1'])).toEqual({ ok: true })
    expect(checkNetTarget({ net: { hosts: ['searx.lan'] } }, 'searx.lan', ['192.168.1.5'])).toEqual(
      { ok: true },
    )
    expect(checkNetTarget({ net: { hosts: ['localhost'] } }, 'localhost', ['::1'])).toEqual({
      ok: true,
    })
  })

  test('a wildcard never unlocks a private target', () => {
    const noExplicit: ModuleCapabilities = { net: { hosts: ['*'] } }
    const denied = checkNetTarget(noExplicit, '127.0.0.1', ['127.0.0.1'])
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toMatch(/explicit net\.hosts entry/)
    expect(checkNetTarget(noExplicit, '192.168.1.5', ['192.168.1.5']).ok).toBe(false)
    expect(checkNetTarget(noExplicit, 'metadata.google.internal', []).ok).toBe(false)
    // `*` plus one literal: the literal is granted, the rest of the LAN is not.
    const mixed: ModuleCapabilities = { net: { hosts: ['*', '127.0.0.1'] } }
    expect(checkNetTarget(mixed, '127.0.0.1', ['127.0.0.1'])).toEqual({ ok: true })
    expect(checkNetTarget(mixed, '192.168.1.5', ['192.168.1.5']).ok).toBe(false)
    // A wildcard pattern that is not `*` is still a wildcard.
    expect(checkNetTarget({ net: { hosts: ['10.*'] } }, '10.0.0.1', ['10.0.0.1']).ok).toBe(false)
  })

  test('one private address in the answer blocks the name', () => {
    const mixed = checkNetTarget(
      { net: { hosts: ['*'] } },
      'rebind.example',
      ['93.184.216.34', '127.0.0.1'],
    )
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(mixed.reason).toContain('127.0.0.1')
  })

  test('an explicit grant for another host does not cover this one', () => {
    expect(checkNetTarget(loopbackGrant, '127.0.0.2', ['127.0.0.2']).ok).toBe(false)
  })
})

describe('checkProcess', () => {
  test('denies when the capability is absent or the list is empty', () => {
    expect(checkProcess(undefined, 'node')).toEqual({
      ok: false,
      reason: 'no process.spawn capability granted',
    })
    expect(checkProcess({}, 'node').ok).toBe(false)
    expect(checkProcess({ process: {} }, 'node').ok).toBe(false)
    expect(checkProcess({ process: { spawn: [] } }, 'node').ok).toBe(false)
  })

  test('matches the command by full string or basename', () => {
    const capabilities: ModuleCapabilities = { process: { spawn: ['node', 'git'] } }
    expect(checkProcess(capabilities, 'node')).toEqual({ ok: true })
    expect(checkProcess(capabilities, '/usr/local/bin/node')).toEqual({ ok: true })
    expect(checkProcess(capabilities, 'C:/tools/git-helper').ok).toBe(false)
    // Windows executable suffixes are not part of the command name an operator
    // grants: `git` covers `git.exe`, and only on Windows.
    expect(checkProcess(capabilities, 'C:/tools/git.exe').ok).toBe(process.platform === 'win32')

    const absolute: ModuleCapabilities = { process: { spawn: ['/usr/local/bin/node'] } }
    expect(checkProcess(absolute, '/usr/local/bin/node')).toEqual({ ok: true })
    expect(checkProcess(absolute, 'node').ok).toBe(false)
  })

  test('`*` grants every command and matching is case-sensitive', () => {
    expect(checkProcess({ process: { spawn: ['*'] } }, '/opt/bin/anything')).toEqual({ ok: true })
    expect(checkProcess({ process: { spawn: ['Node'] } }, 'node').ok).toBe(false)
    expect(checkProcess({ process: { spawn: ['node*'] } }, 'nodejs')).toEqual({ ok: true })
  })

  test('rejects empty commands', () => {
    expect(checkProcess({ process: { spawn: ['*'] } }, '   ').ok).toBe(false)
  })
})

describe('describeCapabilityRisks', () => {
  test('a narrow grant says nothing', () => {
    expect(describeCapabilityRisks(undefined)).toEqual([])
    expect(describeCapabilityRisks({})).toEqual([])
    expect(
      describeCapabilityRisks({ fs: { read: ['/**'] }, net: { hosts: ['api.example.com'] } }),
    ).toEqual([])
  })

  test('any spawn grant is described as full host access', () => {
    const narrow = describeCapabilityRisks({ process: { spawn: ['/opt/bin/convert'] } })
    expect(narrow).toHaveLength(1)
    expect(narrow[0]).toContain('spawn is full host access')
    expect(narrow[0]).toContain('bypasses fs/net grants')
  })

  test('an interpreter, shell, VCS tool or wildcard adds the specific warning', () => {
    const node = describeCapabilityRisks({ process: { spawn: ['node'] } })
    expect(node).toHaveLength(2)
    expect(node[1]).toContain('grants an interpreter, shell or wildcard (node)')
    expect(node[1]).toContain('only grant commands whose entire behaviour is acceptable')

    const shell = describeCapabilityRisks({ process: { spawn: ['/bin/bash', 'git'] } })
    expect(shell).toHaveLength(2)
    expect(shell[1]).toContain('/bin/bash, git')

    const star = describeCapabilityRisks({ process: { spawn: ['*'] } })
    expect(star).toHaveLength(2)
    expect(star[1]).toContain('(*)')
  })

  test('net wildcards are called out without overclaiming what `*` reaches', () => {
    const pattern = describeCapabilityRisks({ net: { hosts: ['*.example.com'] } })
    expect(pattern).toHaveLength(1)
    expect(pattern[0]).toContain('wildcard pattern')

    const star = describeCapabilityRisks({ net: { hosts: ['*'] } })
    expect(star).toHaveLength(1)
    expect(star[0]).toContain('never private/metadata targets')

    for (const host of ['0.0.0.0', '::']) {
      const other = describeCapabilityRisks({ net: { hosts: [host] } })
      expect(other[0]).toContain('never private/metadata targets')
    }
  })
})
