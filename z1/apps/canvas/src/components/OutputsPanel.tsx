import type { ReactElement } from 'react'

import { useCanvas } from '../store.ts'

/** Run status, outputs and validation issues. */
export function OutputsPanel(): ReactElement {
  const runId = useCanvas((state) => state.runId)
  const runStatus = useCanvas((state) => state.runStatus)
  const outputs = useCanvas((state) => state.outputs)
  const runError = useCanvas((state) => state.runError)
  const issues = useCanvas((state) => state.issues)

  return (
    <section className="panel outputs">
      <h2>run</h2>
      <div className="inspector-row">
        <span className="inspector-key">status</span>
        <span className={`run-status run-status-${runStatus ?? 'idle'}`}>{runStatus ?? 'idle'}</span>
      </div>
      <div className="inspector-row">
        <span className="inspector-key">run</span>
        <code data-testid="current-run">{runId ?? '—'}</code>
      </div>
      {runError === null ? null : <p className="inline-error">{runError}</p>}
      {issues.length > 0 ? (
        <ul className="issue-list">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${String(index)}`}>
              <code>{issue.code}</code> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <h3>outputs</h3>
      <pre className="json-view" data-testid="outputs">{JSON.stringify(outputs, null, 2)}</pre>
    </section>
  )
}
