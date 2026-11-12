import type { AutonomyPolicy, Json } from '@z1/node'

export interface GraphNode {
  id: string
  type: string
  version: string
  config: Json
  autonomy?: AutonomyPolicy
  position: { x: number; y: number }
  label?: string
}

export interface GraphEdge {
  id: string
  kind: 'data' | 'flow'
  from: { node: string; port: string }
  to: { node: string; port: string }
}

export interface GraphDocument {
  schemaVersion: 1
  id: string
  title?: string
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  metadata?: Record<string, Json>
}

export type ValidationCode =
  | 'duplicate-node-id'
  | 'unknown-node-type'
  | 'unknown-port'
  | 'port-kind-mismatch'
  | 'port-type-mismatch'
  | 'missing-required-input'
  | 'dangling-edge'
  | 'self-edge'
  | 'flow-cycle'
  | 'invalid-config'
  | 'duplicate-edge-id'
  | 'duplicate-data-edge'
  | 'nested-too-deep'

export interface ValidationIssue {
  code: ValidationCode
  message: string
  nodeId?: string
  edgeId?: string
}
