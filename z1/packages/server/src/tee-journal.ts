/**
 * Journal decorator that turns every durable append into a live notification.
 *
 * `@z1/runtime` only journals what it persists (stream chunks are excluded), so
 * a subscriber that listens here sees exactly the events `run.get` can replay.
 *
 * @module @z1/server/tee-journal
 */

import type { SqliteJournal } from '@z1/journal'
import type { Journal, RunEvent } from '@z1/runtime'

/** Called once per appended event, with the sequence number the journal gave it. */
export type EventSink = (runId: string, seq: number, event: RunEvent) => void

export class TeeJournal implements Journal {
  readonly #inner: SqliteJournal
  readonly #sink: EventSink
  /**
   * Last sequence number this decorator has handed to the sink, per run.
   * Absent until the run's first append, which reads the journal instead: a
   * fork replays its parent's prefix, so only the journal knows where a new
   * run actually starts. Every later append is then O(1).
   */
  readonly #seqs = new Map<string, number>()

  constructor(inner: SqliteJournal, sink: EventSink) {
    this.#inner = inner
    this.#sink = sink
  }

  append(event: RunEvent): void {
    this.#inner.append(event)
    const known = this.#seqs.get(event.runId)
    // Notifications use merged numbering (the parent prefix plus this run's own
    // events), matching the `seq` values `run.get`/`run.subscribe` replay.
    // `journal.fork` instead uses own numbering; the mapping between the two is
    // deliberately not exposed here.
    const seq = known === undefined ? this.#inner.read(event.runId).length : known + 1
    this.#seqs.set(event.runId, seq)
    this.#sink(event.runId, seq, event)
  }

  read(runId: string): readonly RunEvent[] {
    return this.#inner.read(runId)
  }
}
