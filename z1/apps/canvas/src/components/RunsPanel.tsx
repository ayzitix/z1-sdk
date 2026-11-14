import type { SequencedEvent } from '@z1/protocol'
import type { ReactElement } from 'react'

import type { RunEvent } from '../graph.ts'
import { buildRunTree, formatDuration, outputsFromEvents, shortRunId } from '../runs.ts'
import { useCanvas } from '../store.ts'

interface EventRow {
  label: string
  path: string
  at: number | null
  durationMs?: number
  status?: string
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
      return { label: 'node.started', path: event.path, at: event.at, status: 'running' }
    case 'node.completed':
      return {
        label: 'node.completed',
        path: event.path,
        at: event.at,
        durationMs: event.durationMs,
        status: 'completed',
      }
    case 'node.failed':
      return { label: 'node.failed', path: event.path, at: event.at, status: 'failed' }
    case 'node.cached':
      return { label: 'node.cached', path: event.path, at: event.at, status: 'cached' }
    case 'node.stream':
      return { label: `node.stream · ${event.port}`, path: event.path, at: null }
    case 'approval.requested':
      return { label: `approval.requested · ${event.request.action}`, path: event.path, at: null }
    case 'approval.decided':
      return { label: `approval.decided · ${event.decision}`, path: event.path, at: null }
    case 'llm.failed':
      return { label: `llm.failed · ${event.error.slice(0, 80)}`, path: event.path, at: event.at, status: 'failed' }
    case 'llm.request':
      return { label: `llm.request · ${event.provider}/${event.model}`, path: event.path, at: event.at }
    case 'llm.response':
      return {
        label: `llm.response · ${event.stopReason} · ${String(event.latencyMs)}ms`,
        path: event.path,
        at: event.at,
        status: 'completed',
      }
  }
}

function timeOf(row: EventRow): string {
  return row.at === null ? '—' : new Date(row.at).toLocaleTimeString()
}

interface EventListProps {
  events: readonly SequencedEvent[]
  /** When set, a path is clickable and chooses the fork point. */
  onPickPath?: (path: string) => void
}

function EventList({ events, onPickPath }: EventListProps): ReactElement {
  if (events.length === 0) return <p className="muted">no node events</p>
  return (
    <div className="event-list">
      {events.map((entry) => {
        const row = describeEvent(entry.event)
        return (
          <div className="event-row" key={entry.seq} data-testid={`run-event-${entry.seq}`}>
            <span className="event-seq">#{entry.seq}</span>
            <span className="event-label">
              {row.label}
              {row.durationMs === undefined ? null : (
                <span className="event-duration"> · {formatDuration(row.durationMs)}</span>
              )}
            </span>
            {onPickPath === undefined || row.path.length === 0 ? (
              <code className="event-path">{row.path}</code>
            ) : (
              <button
                type="button"
                className="event-path event-path-button"
                title={`fork at ${row.path}`}
                onClick={() => onPickPath(row.path)}
              >
                {row.path}
              </button>
            )}
            <span className="event-status">{row.status ?? ''}</span>
            <span className="event-time">{timeOf(row)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** The timeline shows the per-node execution; run-level rows carry no path. */
function isNodeTimeline(entry: SequencedEvent): boolean {
  return (
    entry.event.type === 'node.started' ||
    entry.event.type === 'node.completed' ||
    entry.event.type === 'node.failed'
  )
}

/** Journal run list as a fork tree, plus the selected run's detail. */
export function RunsPanel(): ReactElement {
  const open = useCanvas((state) => state.runsOpen)
  const runs = useCanvas((state) => state.runs)
  const selectedRun = useCanvas((state) => state.selectedRun)
  const forkInput = useCanvas((state) => state.forkInput)
  const toggleRunsPanel = useCanvas((state) => state.toggleRunsPanel)
  const refreshRuns = useCanvas((state) => state.refreshRuns)
  const selectRun = useCanvas((state) => state.selectRun)
  const setForkInput = useCanvas((state) => state.setForkInput)
  const forkRun = useCanvas((state) => state.forkRun)

  const tree = buildRunTree(runs)
  const timeline = selectedRun === null ? [] : selectedRun.events.filter(isNodeTimeline)
  const outputs = selectedRun === null ? {} : outputsFromEvents(selectedRun.events)

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
            {tree.length === 0 ? <p className="muted">no runs yet</p> : null}
            {tree.map(({ record, depth, parentLabel }) => (
              <button
                type="button"
                key={record.runId}
                data-testid={`run-row-${record.runId}`}
                data-status={record.status}
                data-depth={depth}
                title={record.runId}
                style={{ paddingLeft: `${String(6 + depth * 14)}px` }}
                className={`run-row${selectedRun?.record.runId === record.runId ? ' is-selected' : ''}`}
                onClick={() => void selectRun(record.runId)}
              >
                {depth === 0 ? null : <span className="run-branch">·</span>}
                <span className="run-id">{shortRunId(record.runId)}</span>
                <span className={`run-status run-status-${record.status}`}>{record.status}</span>
                <span className="run-time">{new Date(record.createdAt).toLocaleTimeString()}</span>
                {parentLabel === null ? null : <span className="run-parent">↳ {parentLabel}</span>}
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
              <div className="run-detail" data-testid="run-detail">
                <EventList events={timeline} onPickPath={setForkInput} />
                <h4>outputs</h4>
                <pre className="json-view" data-testid="run-outputs">
                  {JSON.stringify(outputs, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
