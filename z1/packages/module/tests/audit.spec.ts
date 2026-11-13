import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AuditChainError, AuditLog, GENESIS_HASH } from '../src/index.ts'

const created: string[] = []

function logFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'z1-module-audit-'))
  created.push(directory)
  return join(directory, 'audit.jsonl')
}

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AuditLog', () => {
  test('starts at the genesis hash and links each entry', () => {
    const file = logFile()
    const log = new AuditLog(file)
    expect(log.read()).toEqual([])

    const first = log.append({
      type: 'propose',
      moduleId: 'com.example.echo',
      version: '1.0.0',
      integrity: 'a'.repeat(64),
      ts: 1000,
    })
    const second = log.append({
      type: 'install',
      moduleId: 'com.example.echo',
      version: '1.0.0',
      ts: 2000,
    })

    expect(first.seq).toBe(1)
    expect(first.prev).toBe(GENESIS_HASH)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(second.seq).toBe(2)
    expect(second.prev).toBe(first.hash)
    expect(log.read()).toHaveLength(2)
  })

  test('writes atomically and leaves no temporary files', () => {
    const file = logFile()
    const log = new AuditLog(file)
    log.append({ type: 'deny', moduleId: 'com.example.echo', version: '1.0.0', detail: { reason: 'no' } })
    expect(readdirSync(dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('throws on the first tampered line', () => {
    const file = logFile()
    const log = new AuditLog(file)
    log.append({ type: 'propose', moduleId: 'com.example.echo', version: '1.0.0', ts: 1 })
    log.append({ type: 'install', moduleId: 'com.example.echo', version: '1.0.0', ts: 2 })
    log.append({ type: 'activate', moduleId: 'com.example.echo', version: '1.0.0', ts: 3 })

    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    const second = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>
    second['version'] = '9.9.9'
    lines[1] = JSON.stringify(second)
    writeFileSync(file, `${lines.join('\n')}\n`)

    expect(() => log.read()).toThrow(AuditChainError)
  })

  test('throws on malformed JSON and a broken prev link', () => {
    const malformed = logFile()
    writeFileSync(malformed, 'not json\n')
    expect(() => new AuditLog(malformed).read()).toThrow(AuditChainError)

    const broken = logFile()
    const log = new AuditLog(broken)
    log.append({ type: 'deny', moduleId: 'com.example.echo', version: '1.0.0', ts: 1 })
    const raw = JSON.parse(readFileSync(broken, 'utf8')) as Record<string, unknown>
    raw['prev'] = 'b'.repeat(64)
    writeFileSync(broken, `${JSON.stringify(raw)}\n`)
    expect(() => log.read()).toThrow(AuditChainError)
  })
})
