import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type NodeTypes,
} from '@xyflow/react'
import { useCallback, type ReactElement } from 'react'

import { canConnect, type Z1FlowEdge } from '../graph.ts'
import { useCanvas } from '../store.ts'
import { Z1Node } from './Z1Node.tsx'

const nodeTypes: NodeTypes = { z1: Z1Node }

/** The editor surface. */
export function GraphCanvas(): ReactElement {
  const nodes = useCanvas((state) => state.nodes)
  const edges = useCanvas((state) => state.edges)
  const descriptors = useCanvas((state) => state.descriptors)
  const onNodesChange = useCanvas((state) => state.onNodesChange)
  const onEdgesChange = useCanvas((state) => state.onEdgesChange)
  const connectNodes = useCanvas((state) => state.connectNodes)
  const select = useCanvas((state) => state.select)

  const isValid = useCallback(
    (connection: Connection | Z1FlowEdge) => canConnect(connection, nodes, descriptors, edges),
    [nodes, descriptors, edges],
  )

  return (
    <ReactFlow
      data-testid="graph-canvas"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={(connection: Connection) => connectNodes(connection)}
      isValidConnection={isValid}
      onNodeClick={(_, node) => select(node.id)}
      onPaneClick={() => select(null)}
      fitView
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d6d6d6" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor="#111111" maskColor="rgba(255,255,255,0.72)" />
    </ReactFlow>
  )
}
