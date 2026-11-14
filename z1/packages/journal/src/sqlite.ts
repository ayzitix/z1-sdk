import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import type { Journal, RunEvent } from '@z1/runtime'

import { type BlobRecord, type RunJournal, type RunRecord, type SequencedEvent, parseRunStatus } from './types.ts'

/** A fork chain deeper than this point at corrupted data rather than a real tree. */
const MAX_FORK_DEPTH = 64

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  graph_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  parent_run_id TEXT,
  fork_seq INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_created_at ON runs (created_at DESC, run_id);
`

interface ChainLink {
  runId: string
  /** Inclusive upper bound on this link's own sequence numbers. */
  maxSeq: number
}

function columnText(row: Record<string, SQLOutputValue>, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`journal: column ${field} is not text`)
  return value
}

function columnNumber(row: Record<string, SQLOutputValue>, field: string): number {
  const value = row[field]
  if (typeof value !== 'number') throw new Error(`journal: column ${field} is not a number`)
  return value
}

function rowToRun(row: Record<string, SQLOutputValue>): RunRecord {
  const record: RunRecord = {
    runId: columnText(row, 'run_id'),
    graphId: columnText(row, 'graph_id'),
    graphDigest: columnText(row, 'graph_digest'),
    status: parseRunStatus(columnText(row, 'status')),
    createdAt: columnNumber(row, 'created_at'),
    updatedAt: columnNumber(row, 'updated_at'),
  }
  const parentRunId = row['parent_run_id']
  if (typeof parentRunId === 'string') record.parentRunId = parentRunId
  const forkSeq = row['fork_seq']
  if (typeof forkSeq === 'number') record.forkSeq = forkSeq
  return record
}

/**
 * SQLite-backed journal. Synchronous by design: a run must never report an
 * event it failed to persist, so writes commit before `append` returns.
 */
export class SqliteJournal implements Journal, RunJournal {
  readonly #file: string
  #db: DatabaseSync | undefined

  constructor(file: string) {
    this.#file = file
    let db: DatabaseSync
    try {
      // SQLite creates the file but never the directories leading to it.
      if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
      db = new DatabaseSync(file)
    } catch (error) {
      throw new Error(`journal: cannot open database at ${file}: ${describe(error)}`, {
        cause: error,
      })
    }
    // WAL turns into 'memory' for :memory:; harmless either way.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA synchronous = NORMAL')
    // Two processes share the journal (a CLI while `z1 serve` runs, a fork from
    // the canvas while a run appends). Without a busy handler SQLite fails
    // `BEGIN IMMEDIATE` instantly instead of waiting for the writer.
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    this.#db = db
  }

  createRun(record: RunRecord): void {
    const db = this.#handle()
    if (this.getRun(record.runId) !== undefined) {
      throw new Error(`journal: run ${record.runId} already exists`)
    }
    db.prepare(
      `INSERT INTO runs
        (run_id, graph_id, graph_digest, status, created_at, updated_at, parent_run_id, fork_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.runId,
      record.graphId,
      record.graphDigest,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.parentRunId ?? null,
      record.forkSeq ?? null,
    )
  }

  updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, 'status' | 'updatedAt'>>,
  ): void {
    const assignments: string[] = []
    const values: SQLOutputValue[] = []
    if (patch.status !== undefined) {
      assignments.push('status = ?')
      values.push(patch.status)
    }
    if (patch.updatedAt !== undefined) {
      assignments.push('updated_at = ?')
      values.push(patch.updatedAt)
    }
    if (assignments.length === 0) return
    const db = this.#handle()
    values.push(runId)
    const changes = db
      .prepare(`UPDATE runs SET ${assignments.join(', ')} WHERE run_id = ?`)
      .run(...values).changes
    if (changes === 0) throw new Error(`journal: unknown run ${runId}`)
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.#handle()
      .prepare('SELECT * FROM runs WHERE run_id = ?')
      .get(runId)
    return row === undefined ? undefined : rowToRun(row)
  }

  /** Newest first; run id breaks ties so the order stays stable. */
  listRuns(): readonly RunRecord[] {
    const rows = this.#handle()
      .prepare('SELECT * FROM runs ORDER BY created_at DESC, run_id DESC')
      .all()
    return rows.map(rowToRun)
  }

  append(event: RunEvent): void {
    const db = this.#handle()
    // The `UPDATE runs` below would silently match nothing for a run that was
    // never created, leaving orphan events that `read` can still surface. Fail
    // loudly instead: sequence numbers only mean something inside a run row.
    if (this.getRun(event.runId) === undefined) {
      throw new Error(
        `journal: cannot append to unknown run ${event.runId}; create the run first`,
      )
    }
    const data = JSON.stringify(event)
    db.exec('BEGIN IMMEDIATE')
    try {
      const seq = this.#nextSeq(event.runId)
      db.prepare(
        'INSERT INTO events (run_id, seq, type, data) VALUES (?, ?, ?, ?)',
      ).run(event.runId, seq, event.type, data)
      db.prepare('UPDATE runs SET updated_at = ? WHERE run_id = ?').run(Date.now(), event.runId)
      db.exec('COMMIT')
    } catch (error) {
      // Rolling back keeps the sequence contiguous for the next caller.
      if (this.#db !== undefined) db.exec('ROLLBACK')
      throw error
    }
  }

  read(runId: string): readonly RunEvent[] {
    const chain = this.#chain(runId)
    const db = this.#handle()
    const statement = db.prepare(
      'SELECT data FROM events WHERE run_id = ? AND seq <= ? ORDER BY seq',
    )
    const events: RunEvent[] = []
    // Root first: a child replays its parent's prefix before its own events.
    for (const link of chain) {
      for (const row of statement.all(link.runId, link.maxSeq)) {
        events.push(JSON.parse(columnText(row, 'data')) as RunEvent)
      }
    }
    return events
  }

  /**
   * This run's own rows, ascending, with their stored sequence numbers. Unlike
   * `read` it never walks the fork chain, so `seq` is the run's own numbering
   * (a fork point is a position in that numbering, not in the merged replay).
   */
  ownedEvents(runId: string): readonly SequencedEvent[] {
    const rows = this.#handle()
      .prepare('SELECT seq, data FROM events WHERE run_id = ? ORDER BY seq')
      .all(runId)
    return rows.map((row) => ({
      seq: columnNumber(row, 'seq'),
      event: JSON.parse(columnText(row, 'data')) as RunEvent,
    }))
  }

  fork(sourceRunId: string, atSeq: number, newRunId: string): RunRecord {
    if (!Number.isInteger(atSeq) || atSeq < 0) {
      throw new Error(`journal: fork seq must be a non-negative integer, got ${atSeq}`)
    }
    const source = this.getRun(sourceRunId)
    if (source === undefined) throw new Error(`journal: unknown run ${sourceRunId}`)
    if (this.getRun(newRunId) !== undefined) {
      throw new Error(`journal: run ${newRunId} already exists`)
    }
    // `atSeq` is a position in the source's own numbering (the same numbering
    // `ownedEvents` reports), not in the merged replay `read` returns. A
    // position past the last own event would replay more than the caller asked
    // for, so treat it as a caller bug rather than clamping.
    const owned = this.ownedEvents(sourceRunId)
    const lastSeq = owned.length === 0 ? 0 : owned[owned.length - 1]!.seq
    if (atSeq > lastSeq) {
      throw new Error(
        `journal: fork seq ${atSeq} is past run ${sourceRunId}'s last own event (${lastSeq})`,
      )
    }
    const now = Date.now()
    const record: RunRecord = {
      runId: newRunId,
      graphId: source.graphId,
      graphDigest: source.graphDigest,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      parentRunId: sourceRunId,
      forkSeq: atSeq,
    }
    this.createRun(record)
    return record
  }

  putBlob(bytes: Uint8Array, mime: string): string {
    const hash = createHash('sha256').update(bytes).digest('hex')
    // Identical bytes with a different mime keep the first record: content
    // addressing means the hash, not the label, identifies the blob.
    this.#handle()
      .prepare('INSERT OR IGNORE INTO blobs (hash, mime, bytes) VALUES (?, ?, ?)')
      .run(hash, mime, bytes)
    return hash
  }

  getBlob(hash: string): BlobRecord | undefined {
    const row = this.#handle().prepare('SELECT * FROM blobs WHERE hash = ?').get(hash)
    if (row === undefined) return undefined
    const bytes = row['bytes']
    if (!(bytes instanceof Uint8Array)) throw new Error('journal: blob column is not a blob')
    return {
      hash: columnText(row, 'hash'),
      mime: columnText(row, 'mime'),
      // Copy out of SQLite's buffer so callers cannot alias internal memory.
      bytes: new Uint8Array(bytes),
    }
  }

  /** Every open statement is owned by the connection; closing is enough. */
  close(): void {
    const db = this.#db
    if (db === undefined) return
    this.#db = undefined
    db.close()
  }

  #handle(): DatabaseSync {
    const db = this.#db
    if (db === undefined) throw new Error(`journal: database at ${this.#file} is closed`)
    return db
  }

  #nextSeq(runId: string): number {
    const row = this.#handle()
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE run_id = ?')
      .get(runId)
    if (row === undefined) return 1
    return columnNumber(row, 'max_seq') + 1
  }

  /** Root-to-leaf links, each with the prefix of its own events to replay. */
  #chain(runId: string): readonly ChainLink[] {
    const chain: ChainLink[] = []
    const visited = new Set<string>()
    let cursor: string | undefined = runId
    let maxSeq = Number.POSITIVE_INFINITY
    while (cursor !== undefined) {
      if (visited.has(cursor)) {
        throw new Error(`journal: fork cycle detected at run ${cursor}`)
      }
      if (chain.length >= MAX_FORK_DEPTH) {
        throw new Error(`journal: fork chain for run ${runId} exceeds ${MAX_FORK_DEPTH} links`)
      }
      visited.add(cursor)
      chain.unshift({ runId: cursor, maxSeq })
      const record = this.getRun(cursor)
      if (record === undefined) break
      if (record.parentRunId === undefined) break
      maxSeq = record.forkSeq ?? Number.POSITIVE_INFINITY
      cursor = record.parentRunId
    }
    return chain
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
