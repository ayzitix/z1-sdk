import { z } from 'zod'
import type { AutonomyPolicy, Json } from '@z1/node'
import type { GraphDocument, GraphEdge, GraphNode } from './types.ts'

/** A shape-compatible subset of a zod issue; keeps `src` free of zod internals. */
export interface GraphParseIssue {
  readonly code: string
  readonly path: readonly PropertyKey[]
  readonly message: string
}

export class GraphParseError extends Error {
  readonly issues: readonly GraphParseIssue[]

  constructor(issues: readonly GraphParseIssue[]) {
    super(
      issues.length === 0
        ? 'invalid graph document'
        : `invalid graph document: ${issues.map(formatIssue).join('; ')}`,
    )
    this.name = 'GraphParseError'
    this.issues = issues
  }
}

function formatIssue(issue: GraphParseIssue): string {
  const path = issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)).join('.')
  return `${path.length > 0 ? path : '<root>'}: ${issue.message}`
}

/**
 * Recursive JSON schema. `config`, `metadata` and node payloads are opaque to
 * the graph layer, but they must still be JSON so digests and the journal can
 * serialize them.
 */
const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
) as z.ZodType<Json>

const autonomySchema = z.object({
  mode: z.enum(['auto', 'ask', 'deny']),
  reason: z.string().optional(),
  timeoutMs: z.number().optional(),
  onTimeout: z.enum(['deny', 'approve']).optional(),
})

const endpointSchema = z.object({
  node: z.string().min(1),
  port: z.string().min(1),
})

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.string().min(1),
  config: jsonValue,
  autonomy: autonomySchema.optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  label: z.string().optional(),
})

const edgeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['data', 'flow']),
  from: endpointSchema,
  to: endpointSchema,
})

const graphSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().optional(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  metadata: z.record(z.string(), jsonValue).optional(),
})

type ParsedGraph = z.infer<typeof graphSchema>
type ParsedNode = ParsedGraph['nodes'][number]
type ParsedAutonomy = NonNullable<ParsedNode['autonomy']>

function toAutonomy(value: ParsedAutonomy | undefined): AutonomyPolicy | undefined {
  if (value === undefined) return undefined
  // exactOptionalPropertyTypes: optional members are omitted, never set to undefined.
  return {
    mode: value.mode,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
    ...(value.onTimeout !== undefined ? { onTimeout: value.onTimeout } : {}),
  }
}

function toNode(node: ParsedNode): GraphNode {
  const autonomy = toAutonomy(node.autonomy)
  return {
    id: node.id,
    type: node.type,
    version: node.version,
    config: node.config,
    ...(autonomy !== undefined ? { autonomy } : {}),
    position: { x: node.position.x, y: node.position.y },
    ...(node.label !== undefined ? { label: node.label } : {}),
  }
}

function toEdge(edge: ParsedGraph['edges'][number]): GraphEdge {
  return {
    id: edge.id,
    kind: edge.kind,
    from: { node: edge.from.node, port: edge.from.port },
    to: { node: edge.to.node, port: edge.to.port },
  }
}

/**
 * Parse and structurally validate a graph document. Duplicate node ids are
 * deliberately allowed here: they are a semantic problem reported by
 * `validateGraph`, not a malformed document.
 */
export function parseGraph(input: unknown): GraphDocument {
  const result = graphSchema.safeParse(input)
  if (!result.success) {
    throw new GraphParseError(
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      })),
    )
  }

  const parsed = result.data
  return {
    schemaVersion: 1,
    id: parsed.id,
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    nodes: parsed.nodes.map(toNode),
    edges: parsed.edges.map(toEdge),
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
  }
}
