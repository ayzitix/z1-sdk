import type { Journal, RunEvent } from './types.ts'

/** Process-local journal used when the host supplies none. */
export class MemoryJournal implements Journal {
  readonly #events = new Map<string, RunEvent[]>()

  append(event: RunEvent): void {
    const events = this.#events.get(event.runId)
    if (events === undefined) this.#events.set(event.runId, [event])
    else events.push(event)
  }

  read(runId: string): readonly RunEvent[] {
    // A copy keeps callers from mutating the journal through the returned array.
    return [...(this.#events.get(runId) ?? [])]
  }
}
