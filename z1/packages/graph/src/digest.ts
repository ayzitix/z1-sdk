import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.ts'
import type { GraphDocument, GraphEdge, GraphNode } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nodePayload(node: GraphNode): Record<string, unknown> {
  // Presentation-only fields (`position`, `label`) are excluded: moving or
  // renaming a node on the canvas is not a semantic change.
  return {
    id: node.id,
    type: node.type,
    version: node.version,
    config: configPayload(node.config),
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

/** A `config.graph` / `config.body` value is a graph when it has both lists. */
function isGraphValue(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value['nodes']) && Array.isArray(value['edges'])
}

/**
 * A nested graph document is hashed with its own nodes and edges canonicalised,
 * not verbatim.
 *
 * `flow.loop` and `flow.map` carry a whole graph under `config.body`, and
 * `graph.subgraph` one under `config.graph`. Hashing those verbatim would make
 * a canvas-only rename — `title: 'Tool calls'`, a moved node — change the
 * digest and turn every older run into a `RESUME_MISMATCH`. The rules are the
 * top-level ones, applied recursively: display fields out, node order ignored.
 */
function nestedGraphPayload(graph: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(graph)) {
    if (key === 'title' || key === 'metadata' || key === 'position' || key === 'label') continue
    if (key === 'nodes' && Array.isArray(value)) {
      payload[key] = value
        .map((item) => (isRecord(item) ? nestedNodePayload(item) : configPayload(item)))
        .sort(compareByPayload)
    } else if (key === 'edges' && Array.isArray(value)) {
      payload[key] = value
        .map((item) => (isRecord(item) ? nestedEdgePayload(item) : configPayload(item)))
        .sort(compareByPayload)
    } else {
      payload[key] = configPayload(value)
    }
  }
  return payload
}

function nestedNodePayload(node: Record<string, unknown>): Record<string, unknown> {
  return {
    id: node['id'],
    type: node['type'],
    version: node['version'],
    config: configPayload(node['config']),
    ...(node['autonomy'] !== undefined ? { autonomy: node['autonomy'] } : {}),
  }
}

function nestedEdgePayload(edge: Record<string, unknown>): Record<string, unknown> {
  return {
    id: edge['id'],
    kind: edge['kind'],
    from: edge['from'],
    to: edge['to'],
  }
}

/**
 * Canonicalise a config value, looking for nested documents under the two keys
 * a container node uses. Only those keys are inspected: a tool argument named
 * `nodes` is data, not a graph whose titles may be dropped.
 */
function configPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(configPayload)
  if (!isRecord(value)) return value
  const payload: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    payload[key] =
      (key === 'graph' || key === 'body') && isGraphValue(entry)
        ? nestedGraphPayload(entry)
        : configPayload(entry)
  }
  return payload
}

/** Sort key over the semantic payload, so ignored fields cannot reorder nodes. */
function compareByPayload(left: unknown, right: unknown): number {
  const leftJson = canonicalJson(left)
  const rightJson = canonicalJson(right)
  if (leftJson < rightJson) return -1
  if (leftJson > rightJson) return 1
  return 0
}

/**
 * Stable semantic hash: node and edge order does not matter, nested
 * `config.graph` does (it is part of `config`). `metadata`, `title`,
 * `position` and `label` are excluded because they are presentation-only:
 * renaming a graph or moving a node must not invalidate a resume. The same
 * rules apply inside a nested graph document.
 */
export function graphDigest(graph: GraphDocument): string {
  const payload = {
    schemaVersion: graph.schemaVersion,
    id: graph.id,
    nodes: graph.nodes.map(nodePayload).sort(compareByPayload),
    edges: graph.edges.map(edgePayload).sort(compareByPayload),
  }
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
}
