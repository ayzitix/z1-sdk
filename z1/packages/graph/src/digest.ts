import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.ts'
import type { GraphDocument, GraphEdge, GraphNode } from './types.ts'

function nodePayload(node: GraphNode): Record<string, unknown> {
  // Presentation-only fields (`position`, `label`) are excluded: moving or
  // renaming a node on the canvas is not a semantic change.
  return {
    id: node.id,
    type: node.type,
    version: node.version,
    config: node.config,
    ...(node.autonomy !== undefined ? { autonomy: node.autonomy } : {}),
  }
}

function edgePayload(edge: GraphEdge): Record<string, unknown> {
  return {
    id: edge.id,
    kind: edge.kind,
    from: { node: edge.from.node, port: edge.from.port },
    to: { node: edge.to.node, port: edge.to.port },
  }
}

/** Sort key over the semantic payload, so ignored fields cannot reorder nodes. */
function compareByPayload(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftJson = canonicalJson(left)
  const rightJson = canonicalJson(right)
  if (leftJson < rightJson) return -1
  if (leftJson > rightJson) return 1
  return 0
}

/**
 * Stable semantic hash: node and edge order does not matter, nested
 * `config.graph` does (it is part of `config`). `metadata`, `position` and
 * `label` are excluded because they are presentation-only.
 */
export function graphDigest(graph: GraphDocument): string {
  const payload = {
    schemaVersion: graph.schemaVersion,
    id: graph.id,
    ...(graph.title !== undefined ? { title: graph.title } : {}),
    nodes: graph.nodes.map(nodePayload).sort(compareByPayload),
    edges: graph.edges.map(edgePayload).sort(compareByPayload),
  }
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
}
