import { readFileSync, existsSync } from 'node:fs'
import { canonicalJson } from './canonical.ts'
import { writeFileAtomic } from './fsutil.ts'
import { sha256Hex } from './integrity.ts'

export const GENESIS_HASH = '0'.repeat(64)

export interface AuditEntry {
  seq: number
  ts: number
  type:
    | 'propose'
    | 'approve'
    | 'install'
    | 'activate'
    | 'rollback'
    | 'deny'
    | 'capability.denied'
  moduleId: string
  version: string
  integrity?: string
  detail?: Record<string, unknown>
  prev: string
  hash: string
}

export interface AuditAppend {
  type: AuditEntry['type']
  moduleId: string
  version: string
  integrity?: string
  detail?: Record<string, unknown>
  /** Testing seam; production entries use the wall clock. */
  ts?: number
}

/** Raised when the persisted chain no longer matches its own hashes. */
export class AuditChainError extends Error {
  readonly seq: number

  constructor(seq: number, message: string) {
    super(`audit chain broken at seq ${seq}: ${message}`)
    this.name = 'AuditChainError'
    this.seq = seq
  }
}

const AUDIT_TYPES = new Set<string>([
  'propose',
  'approve',
  'install',
  'activate',
  'rollback',
  'deny',
  'capability.denied',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!isRecord(value)) return false
  if (typeof value['seq'] !== 'number' || !Number.isInteger(value['seq'])) return false
  if (typeof value['ts'] !== 'number' || !Number.isFinite(value['ts'])) return false
  if (typeof value['type'] !== 'string' || !AUDIT_TYPES.has(value['type'])) return false
  if (typeof value['moduleId'] !== 'string' || value['moduleId'].length === 0) return false
  if (typeof value['version'] !== 'string' || value['version'].length === 0) return false
  if (value['integrity'] !== undefined && typeof value['integrity'] !== 'string') return false
  if (value['detail'] !== undefined && !isRecord(value['detail'])) return false
  if (typeof value['prev'] !== 'string' || !/^[0-9a-f]{64}$/.test(value['prev'])) return false
  if (typeof value['hash'] !== 'string' || !/^[0-9a-f]{64}$/.test(value['hash'])) return false
  return true
}

/** SHA-256 (hex) of the canonical entry, excluding the `hash` field itself. */
export function auditEntryHash(entry: Omit<AuditEntry, 'hash'>): string {
  return sha256Hex(canonicalJson(entry))
}

/**
 * Append-only JSONL audit log with a SHA-256 hash chain. Each write rewrites
 * the file through a temporary file, so a crash leaves either the old log or
 * the complete new one.
 */
export class AuditLog {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  private text(): string {
    if (!existsSync(this.file)) return ''
    return readFileSync(this.file, 'utf8')
  }

  read(): readonly AuditEntry[] {
    const text = this.text()
    if (text.length === 0) return []

    const lines = text.split('\n')
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    const entries: AuditEntry[] = []
    let previous = GENESIS_HASH

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const seq = index + 1
      if (line === undefined || line.trim().length === 0) {
        throw new AuditChainError(seq, 'empty line')
      }

      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        throw new AuditChainError(seq, 'line is not valid JSON')
      }
      if (!isAuditEntry(raw)) {
        throw new AuditChainError(seq, 'entry shape is invalid')
      }
      if (raw.seq !== seq) {
        throw new AuditChainError(seq, `expected seq ${seq}, found ${raw.seq}`)
      }
      if (raw.prev !== previous) {
        throw new AuditChainError(seq, 'prev hash does not match the previous entry')
      }

      const { hash, ...rest } = raw
      const expected = auditEntryHash(rest)
      if (hash !== expected) {
        throw new AuditChainError(seq, 'hash does not match the entry content')
      }

      entries.push(raw)
      previous = raw.hash
    }

    return entries
  }

  append(input: AuditAppend): AuditEntry {
    const entries = this.read()
    const previous = entries.length === 0 ? GENESIS_HASH : (entries[entries.length - 1]?.hash ?? GENESIS_HASH)

    const base: Omit<AuditEntry, 'hash'> = {
      seq: entries.length + 1,
      ts: input.ts ?? Date.now(),
      type: input.type,
      moduleId: input.moduleId,
      version: input.version,
      prev: previous,
    }
    if (input.integrity !== undefined) base.integrity = input.integrity
    if (input.detail !== undefined) base.detail = input.detail

    const entry: AuditEntry = { ...base, hash: auditEntryHash(base) }
    const prefix = this.text().replace(/\n*$/, '')
    const next = prefix.length === 0 ? `${JSON.stringify(entry)}\n` : `${prefix}\n${JSON.stringify(entry)}\n`
    writeFileAtomic(this.file, next)
    return entry
  }
}
