import type { SequencedEvent } from '@z1/protocol'
import type { ReactElement } from 'react'

import type { RunEvent } from '../graph.ts'
import { useCanvas } from '../store.ts'

interface EventRow {
  label: string
  path: string
  at: number | null
}

function describeEvent(event: RunEvent): EventRow {
  switch (event.type) {
    case 'run.started':
      return { label: 'run.started', path: event.graphId, at: event.at }
    case 'run.resumed':
      return { label: 'run.resumed', path: '', at: event.at }
    case 'run.completed':
      return { label: 'run.completed', path: '', at: event.at }
    case 'run.failed':
      return { label: 'run.failed', path: event.error, at: event.at }
    case 'run.cancelled':
      return { label: 'run.cancelled', path: '', at: event.at }
    case 'run.suspended':
      return { label: 'run.suspended', path: event.path, at: event.at }
    case 'node.started':
      return { label: 'node.started', path: event.path, at: event.at }
    case 'node.completed':
      return { label: 'node.completed', path: event.path, at: event.at }
    case 'node.failed':
      return { label: 'node.failed', path: event.path, at: event.at }
    case 'node.cached':
      return { label: 'node.cached', path: event.path, at: event.at }
    case 'node.stream':
      return { label: `node.stream · ${event.port}`, path: event.path, at: null }
    case 'approval.requested':
      return { label: `approval.requested · ${event.request.action}`, path: event.path, at: null }
    case 'approval.decided':
      return { label: `approval.decided · ${event.decision}`, path: event.path, at: null }
  }
}

function timeOf(row: EventRow): string {
  return row.at === null ? '—' : new Date(row.at).toLocaleTimeString()
}

function EventList({ events }: { events: readonly SequencedEvent[] }): ReactElement {
  if (events.length === 0) return <p className="muted">no events</p>
  return (
    <div className="event-list">
      {events.map((entry) => {
        const row = describeEvent(entry.event)
        return (
          <div className="event-row" key={entry.seq}>
            <span className="event-seq">#{entry.seq}</span>
            <span className="event-label">{row.label}</span>
            <code className="event-path">{row.path}</code>
            <span className="event-time">{timeOf(row)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Journal run list with fork ancestry, and the selected run's events. */
export function RunsPanel(): ReactElement {
  const open = useCanvas((state) => state.runsOpen)
  const runs = useCanvas((state) => state.runs)
  const selectedRun = useCanvas((state) => state.selectedRun)
  const forkInput = useCanvas((state) => state.forkInput)
  const toggleRunsPanel = useCanvas((state) => state.toggleRunsPanel)
  const refreshRuns = useCanvas((state) => state.refreshRuns)
  const openRun = useCanvas((state) => state.openRun)
  const setForkInput = useCanvas((state) => state.setForkInput)
  const forkRun = useCanvas((state) => state.forkRun)

  return (
    <section className={`runs-panel${open ? ' is-open' : ''}`}>
      <div className="runs-header">
        <button type="button" className="runs-toggle" data-testid="runs-toggle" onClick={toggleRunsPanel}>
          {open ? '▾' : '▸'} runs &amp; events
        </button>
        <span className="muted">{runs.length} runs</span>
        <div className="toolbar-spacer" />
        <button type="button" data-testid="runs-refresh" onClick={() => void refreshRuns()}>
          Refresh
        </button>
      </div>
      {open ? (
        <div className="runs-body">
          <div className="runs-list">
            {runs.length === 0 ? <p className="muted">no runs yet</p> : null}
            {runs
              .slice()
              .reverse()
              .map((record) => (
                <button
                  type="button"
                  key={record.runId}
                  data-testid={`run-row-${record.runId}`}
                  data-status={record.status}
                  className={`run-row${selectedRun?.record.runId === record.runId ? ' is-selected' : ''}`}
                  onClick={() => void openRun(record.runId)}
                >
                  <span className="run-id">{record.runId}</span>
                  <span className={`run-status run-status-${record.status}`}>{record.status}</span>
                  {record.parentRunId === undefined ? null : (
                    <span className="run-parent">
                      ↳ {record.parentRunId}@{record.forkSeq ?? '?'}
                    </span>
                  )}
                </button>
              ))}
          </div>
          <div className="runs-events">
            <div className="fork-bar">
              <input
                data-testid="fork-input"
                value={forkInput}
                placeholder="fork at node path or seq"
                onChange={(event) => setForkInput(event.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                data-testid="fork"
                onClick={() => void forkRun()}
                disabled={selectedRun === null}
              >
                Fork at path
              </button>
            </div>
            {selectedRun === null ? (
              <p className="muted">Pick a run to see its events.</p>
            ) : (
              <EventList events={selectedRun.events} />
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
