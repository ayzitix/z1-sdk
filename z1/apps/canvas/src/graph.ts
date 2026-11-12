/**
 * Pure conversion between the graph document and React Flow state.
 *
 * Nothing here touches React, the DOM or the network: the canvas and the tests
 * share exactly these rules for handles, edge kinds and schema compatibility.
 *
 * @module canvas/graph
 */

import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import type { AutonomyMode, Json, PortKind } from '@z1/node'
import type { NodeDescriptor, NotificationMap, PortDescriptor } from '@z1/protocol'
import type { Edge, Node } from '@xyflow/react'

/** The wire event type, taken from the protocol so it cannot drift. */
export type RunEvent = NotificationMap['run.event']['event']

/** Per-node state derived from run events. */
export type NodeRunStatus = 'running' | 'completed' | 'failed' | 'cached'

/** The view state `mergeRunEvent` folds events into. */
export interface RunGraphState {
  nodeStatus: Record<string, NodeRunStatus>
  error?: string
}

export type Z1NodeData = {
  descriptor: NodeDescriptor
  config: Json
  autonomy?: AutonomyMode
  status?: NodeRunStatus
}

export type Z1FlowNode = Node<Z1NodeData, 'z1'>

export type Z1EdgeData = {
  kind: PortKind
}

export type Z1FlowEdge = Edge<Z1EdgeData>

export interface FlowDocument {
  nodes: Z1FlowNode[]
  edges: Z1FlowEdge[]
}

/** Handle ids are namespaced by node and port so an edge names both ends. */
export function handleId(nodeId: string, port: string, kind: PortKind): string {
  return `${nodeId}:${port}:${kind}`
}

/**
 * Split a handle id back into its parts. Node ids may themselves contain `:`,
 * so the last two separators are the meaningful ones.
 */
export function parseHandleId(
  handle: string | null | undefined,
): { node: string; port: string; kind: PortKind } | undefined {
  if (handle === null || handle === undefined) return undefined
  const kindAt = handle.lastIndexOf(':')
  if (kindAt <= 0) return undefined
  const kind = handle.slice(kindAt + 1)
  if (kind !== 'data' && kind !== 'flow') return undefined
  const rest = handle.slice(0, kindAt)
  const portAt = rest.lastIndexOf(':')
  if (portAt < 0) return undefined
  const port = rest.slice(portAt + 1)
  if (port.length === 0) return undefined
  return { node: rest.slice(0, portAt), port, kind }
}

function descriptorFor(node: GraphNode, descriptors: readonly NodeDescriptor[]): NodeDescriptor {
  for (const descriptor of descriptors) {
    if (descriptor.id === node.type && descriptor.version === node.version) return descriptor
  }
  for (const descriptor of descriptors) {
    if (descriptor.id === node.type) return descriptor
  }
  // An unknown type still renders: the graph may have been written by another
  // build, and dropping the node would hide the problem from the user.
  return {
    id: node.type,
    version: node.version,
    title: node.type,
    category: 'unknown',
    inputs: [],
    outputs: [],
  }
}

/** Visual language: data edges solid black, flow edges dashed grey. */
export function edgeStyle(kind: PortKind): NonNullable<Z1FlowEdge['style']> {
  return kind === 'data'
    ? { stroke: '#0a0a0a', strokeWidth: 1.6 }
    : { stroke: '#9b9b9b', strokeWidth: 1.4, strokeDasharray: '5 4' }
}

/** Convert a graph document into the canvas's nodes and edges. */
export function toFlow(
  graph: GraphDocument,
  descriptors: readonly NodeDescriptor[],
): FlowDocument {
  const nodes: Z1FlowNode[] = graph.nodes.map((node) => {
    const data: Z1NodeData = {
      descriptor: descriptorFor(node, descriptors),
      config: node.config,
    }
    if (node.autonomy !== undefined) data.autonomy = node.autonomy.mode
    return {
      id: node.id,
      type: 'z1',
      position: { x: node.position.x, y: node.position.y },
      data,
    }
  })
  const edges: Z1FlowEdge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.from.node,
    target: edge.to.node,
    sourceHandle: handleId(edge.from.node, edge.from.port, edge.kind),
    targetHandle: handleId(edge.to.node, edge.to.port, edge.kind),
    type: 'smoothstep',
    data: { kind: edge.kind },
    style: edgeStyle(edge.kind),
  }))
  return { nodes, edges }
}

/** Convert canvas state back into a graph document. */
export function fromFlow(
  nodes: readonly Z1FlowNode[],
  edges: readonly Z1FlowEdge[],
  title?: string,
): GraphDocument {
  const graphNodes: GraphNode[] = nodes.map((node) => {
    const graphNode: GraphNode = {
      id: node.id,
      type: node.data.descriptor.id,
      version: node.data.descriptor.version,
      config: node.data.config,
      position: { x: node.position.x, y: node.position.y },
    }
    if (node.data.autonomy !== undefined) graphNode.autonomy = { mode: node.data.autonomy }
    return graphNode
  })
  const graphEdges: GraphEdge[] = []
  for (const edge of edges) {
    const from = parseHandleId(edge.sourceHandle)
    const to = parseHandleId(edge.targetHandle)
    if (from === undefined || to === undefined) continue
    graphEdges.push({
      id: edge.id,
      kind: edge.data?.kind ?? from.kind,
      from: { node: from.node, port: from.port },
      to: { node: to.node, port: to.port },
    })
  }
  const document: GraphDocument = {
    schemaVersion: 1,
    id: 'canvas-graph',
    nodes: graphNodes,
    edges: graphEdges,
  }
  if (title !== undefined && title.length > 0) return { ...document, title }
  return document
}

/** The subset of a React Flow connection the compatibility rules need. */
export interface ConnectShape {
  source: string | null
  target: string | null
  sourceHandle?: string | null
  targetHandle?: string | null
}

function findPort(
  node: Z1FlowNode,
  handle: { port: string; kind: PortKind },
  descriptors: readonly NodeDescriptor[],
  direction: 'input' | 'output',
): PortDescriptor | undefined {
  const descriptor =
    descriptors.find(
      (candidate) =>
        candidate.id === node.data.descriptor.id &&
        candidate.version === node.data.descriptor.version,
    ) ?? node.data.descriptor
  const ports = direction === 'input' ? descriptor.inputs : descriptor.outputs
  return ports.find((port) => port.id === handle.port && port.kind === handle.kind)
}

function schemaType(schema: Record<string, unknown> | undefined): string | undefined {
  if (schema === undefined) return undefined
  const type = schema['type']
  return typeof type === 'string' ? type : undefined
}

/** Two data ports are compatible when their JSON Schema types agree. */
function schemasCompatible(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  const left = schemaType(a)
  const right = schemaType(b)
  if (left === undefined || right === undefined) return true
  return left === right
}

/**
 * Decide whether a connection may be created.
 *
 * Rules: same port kind, never a self-edge, never a second data edge into the
 * same target port, and data schemas must agree (an unconstrained side always
 * agrees). `edges` is optional so callers without edge state can still check
 * everything except the duplicate rule.
 */
export function canConnect(
  connection: ConnectShape,
  nodes: readonly Z1FlowNode[],
  descriptors: readonly NodeDescriptor[],
  edges: readonly Z1FlowEdge[] = [],
): boolean {
  const source = connection.source
  const target = connection.target
  if (source === null || target === null || source === target) return false
  const from = parseHandleId(connection.sourceHandle)
  const to = parseHandleId(connection.targetHandle)
  if (from === undefined || to === undefined) return false
  if (from.kind !== to.kind) return false
  const sourceNode = nodes.find((node) => node.id === source)
  const targetNode = nodes.find((node) => node.id === target)
  if (sourceNode === undefined || targetNode === undefined) return false
  const fromPort = findPort(sourceNode, from, descriptors, 'output')
  const toPort = findPort(targetNode, to, descriptors, 'input')
  if (fromPort === undefined || toPort === undefined) return false
  if (from.kind === 'data') {
    const duplicate = edges.some(
      (edge) =>
        edge.target === target &&
        edge.targetHandle === connection.targetHandle &&
        (edge.data?.kind ?? 'data') === 'data',
    )
    if (duplicate) return false
    return schemasCompatible(fromPort.schema, toPort.schema)
  }
  return true
}

/**
 * Fold one run event into the per-node status map.
 *
 * Only what the canvas draws is tracked: the latest state of each node and the
 * most recent error. Historical events keep flowing into the events panel.
 */
export function mergeRunEvent(state: RunGraphState, event: RunEvent): RunGraphState {
  switch (event.type) {
    case 'run.started':
      return { nodeStatus: {} }
    case 'node.started':
      return setStatus(state, event.nodeId, 'running')
    case 'node.cached':
      return setStatus(state, event.nodeId, 'cached')
    case 'node.completed':
      return setStatus(state, event.nodeId, 'completed')
    case 'node.failed':
      return { nodeStatus: { ...state.nodeStatus, [event.nodeId]: 'failed' }, error: event.error }
    case 'run.failed':
      return { nodeStatus: { ...state.nodeStatus }, error: event.error }
    case 'run.completed':
      return { nodeStatus: { ...state.nodeStatus } }
    default:
      return state
  }
}

function setStatus(
  state: RunGraphState,
  nodeId: string,
  status: NodeRunStatus,
): RunGraphState {
  const next: RunGraphState = {
    nodeStatus: { ...state.nodeStatus, [nodeId]: status },
  }
  if (state.error !== undefined) next.error = state.error
  return next
}
