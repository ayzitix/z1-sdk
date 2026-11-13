import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ReactElement } from 'react'

import { handleId, type Z1FlowNode } from '../graph.ts'
import { formatDuration } from '../runs.ts'

/** One node on the canvas: typed handles, title, autonomy and run state. */
export function Z1Node({ id, data, selected }: NodeProps<Z1FlowNode>): ReactElement {
  const { descriptor, status, autonomy } = data
  return (
    <div
      data-testid={`node-${id}`}
      data-status={status}
      className={[
        'z1-node',
        selected ? 'is-selected' : '',
        status === undefined ? '' : `z1-node-${status}`,
      ]
        .filter((part) => part.length > 0)
        .join(' ')}
    >
      <div className="z1-node-header">
        <span className="z1-node-title">{descriptor.title}</span>
        {autonomy === 'ask' ? <span className="z1-ask-badge">ask</span> : null}
        {autonomy === 'deny' ? <span className="z1-deny-badge">deny</span> : null}
      </div>
      <div className="z1-node-type">
        {descriptor.id}@{descriptor.version}
      </div>
      <div className="z1-ports">
        <div className="z1-port-column">
          {descriptor.inputs.map((port) => (
            <div className="z1-port" key={port.id}>
              <Handle
                type="target"
                position={Position.Left}
                id={handleId(id, port.id, port.kind)}
                className={`z1-handle z1-handle-${port.kind}`}
              />
              <span className="z1-port-label">{port.id}</span>
              {port.required === false ? <span className="z1-port-tag">opt</span> : null}
            </div>
          ))}
        </div>
        <div className="z1-port-column z1-port-column-out">
          {descriptor.outputs.map((port) => (
            <div className="z1-port z1-port-out" key={port.id}>
              <span className="z1-port-label">{port.id}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={handleId(id, port.id, port.kind)}
                className={`z1-handle z1-handle-${port.kind}`}
              />
            </div>
          ))}
        </div>
      </div>
      {status === undefined ? null : (
        <div className="z1-node-status">
          <span className="z1-node-status-label">{status}</span>
          {data.durationMs === undefined ? null : (
            <span className="z1-node-duration">{formatDuration(data.durationMs)}</span>
          )}
        </div>
      )}
    </div>
  )
}
