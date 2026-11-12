import type { ReactElement } from 'react'

import { useCanvas } from '../store.ts'

/** Modal for the head of the server's approval queue. */
export function ApprovalDialog(): ReactElement | null {
  const entry = useCanvas((state) => state.approvals[0] ?? null)
  const respondApproval = useCanvas((state) => state.respondApproval)
  if (entry === null) return null
  const { params } = entry
  const { request } = params

  return (
    <div className="approval-backdrop" role="dialog" aria-modal="true" aria-label="approval required">
      <div className="approval-dialog">
        <h2>approval required</h2>
        <div className="inspector-row">
          <span className="inspector-key">action</span>
          <code>{request.action}</code>
        </div>
        <div className="inspector-row">
          <span className="inspector-key">target</span>
          <code>{request.target ?? '—'}</code>
        </div>
        <div className="inspector-row">
          <span className="inspector-key">reason</span>
          <span>{request.reason ?? '—'}</span>
        </div>
        <div className="inspector-row">
          <span className="inspector-key">node</span>
          <code>{params.path}</code>
        </div>
        <div className="inspector-row">
          <span className="inspector-key">run</span>
          <code>{params.runId}</code>
        </div>
        <div className="approval-actions">
          <button
            type="button"
            className="primary"
            data-testid="approval-approve"
            onClick={() => respondApproval(params.approvalId, 'allowed-once')}
          >
            Approve once
          </button>
          <button type="button" data-testid="approval-reject" onClick={() => respondApproval(params.approvalId, 'rejected')}>
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}
