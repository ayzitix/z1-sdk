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

  constructor(inner: SqliteJournal, sink: EventSink) {
    this.#inner = inner
    this.#sink = sink
  }

  append(event: RunEvent): void {
    this.#inner.append(event)
    // `read` is the authority on sequence numbers: a fork replays its parent's
    // prefix, so a local counter would report a different seq than `run.get`.
    // That makes this O(n) per event; intentional for a local, single-user
    // server (SPEC M2), and it disappears when the journal exposes seqs.
    const seq = this.#inner.read(event.runId).length
    this.#sink(event.runId, seq, event)
  }

  read(runId: string): readonly RunEvent[] {
    return this.#inner.read(runId)
  }
}
