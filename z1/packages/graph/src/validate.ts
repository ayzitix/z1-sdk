import type { NodeDefinition, NodeRegistry, PortSpec } from '@z1/node'
import { portJsonSchema } from '@z1/node'
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  ValidationCode,
  ValidationIssue,
} from './types.ts'

type DataPort = Extract<PortSpec, { kind: 'data' }>

interface NodePorts {
  readonly definition: NodeDefinition | undefined
  readonly inputs: ReadonlyMap<string, PortSpec>
  readonly outputs: ReadonlyMap<string, PortSpec>
}

interface IssueRefs {
  nodeId?: string
  edgeId?: string
}

function issue(code: ValidationCode, message: string, refs: IssueRefs = {}): ValidationIssue {
  return {
    code,
    message,
    ...(refs.nodeId !== undefined ? { nodeId: refs.nodeId } : {}),
    ...(refs.edgeId !== undefined ? { edgeId: refs.edgeId } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function portMap(ports: readonly PortSpec[]): ReadonlyMap<string, PortSpec> {
  return new Map(ports.map((port) => [port.id, port]))
}

function resolvePorts(node: GraphNode, registry: NodeRegistry): NodePorts {
  const definition = registry.get(node.type, node.version)
  return {
    definition,
    inputs: portMap(definition?.inputs ?? []),
    outputs: portMap(definition?.outputs ?? []),
  }
}

/** JSON Schema of a data port; T1's helper can return an empty schema. */
function jsonSchemaOf(port: DataPort): Record<string, unknown> {
  const raw: unknown = portJsonSchema(port)
  return isRecord(raw) ? raw : {}
}

function typeNames(schema: Record<string, unknown>): readonly string[] | undefined {
  const type = schema['type']
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) {
    const names = type.filter((entry): entry is string => typeof entry === 'string')
    return names.length > 0 ? names : undefined
  }
  return undefined
}

/**
 * M0 compatibility: an unconstrained schema (or one without `type`) matches
 * anything; otherwise the `type` sets must intersect. No structural
 * assignability is attempted.
 */
function isPortTypeCompatible(source: DataPort, target: DataPort): boolean {
  const sourceTypes = typeNames(jsonSchemaOf(source))
  const targetTypes = typeNames(jsonSchemaOf(target))
  if (sourceTypes === undefined || targetTypes === undefined) return true
  return sourceTypes.some((name) => targetTypes.includes(name))
}

function configIssue(node: GraphNode, definition: NodeDefinition): ValidationIssue | undefined {
  const result = definition.config.safeParse(node.config)
  if (result.success) return undefined
  const details = result.error.issues
    .map((problem) => {
      const path = problem.path.join('.')
      return path.length > 0 ? `${path}: ${problem.message}` : problem.message
    })
    .join('; ')
  return issue('invalid-config', `config of node "${node.id}" is invalid: ${details}`, {
    nodeId: node.id,
  })
}

function flowCycleIssues(graph: GraphDocument): ValidationIssue[] {
  const outgoing = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) {
    if (edge.kind !== 'flow') continue
    const list = outgoing.get(edge.from.node)
    if (list === undefined) outgoing.set(edge.from.node, [edge])
    else list.push(edge)
  }

  const issueList: ValidationIssue[] = []
  // 0 = unvisited, 1 = on the current DFS stack, 2 = fully explored.
  const state = new Map<string, 0 | 1 | 2>()

  const visit = (nodeId: string): void => {
    state.set(nodeId, 1)
    for (const edge of outgoing.get(nodeId) ?? []) {
      const target = edge.to.node
      const targetState = state.get(target) ?? 0
      if (targetState === 1) {
        issueList.push(
          issue('flow-cycle', `flow edges form a cycle through "${nodeId}" and "${target}"`, {
            nodeId: target,
            edgeId: edge.id,
          }),
        )
        continue
      }
      if (targetState === 2) continue
      if (!graph.nodes.some((node) => node.id === target)) continue
      visit(target)
    }
    state.set(nodeId, 2)
  }

  for (const node of graph.nodes) {
    if ((state.get(node.id) ?? 0) === 0) visit(node.id)
  }
  return issueList
}

/** Structural shape check used before descending into `config.graph` / `config.body`. */
function isGraphShaped(value: unknown): value is GraphDocument {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== 1 || typeof value['id'] !== 'string') return false
  const nodes = value['nodes']
  const edges = value['edges']
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false
  const nodesOk = nodes.every(
    (node: unknown) =>
      isRecord(node) &&
      typeof node['id'] === 'string' &&
      typeof node['type'] === 'string' &&
      typeof node['version'] === 'string' &&
      'config' in node &&
      isRecord(node['position']) &&
      typeof node['position']['x'] === 'number' &&
      typeof node['position']['y'] === 'number',
  )
  const edgesOk = edges.every(
    (edge: unknown) =>
      isRecord(edge) &&
      typeof edge['id'] === 'string' &&
      (edge['kind'] === 'data' || edge['kind'] === 'flow') &&
      isRecord(edge['from']) &&
      isRecord(edge['to']) &&
      typeof edge['from']['node'] === 'string' &&
      typeof edge['from']['port'] === 'string' &&
      typeof edge['to']['node'] === 'string' &&
      typeof edge['to']['port'] === 'string',
  )
  return nodesOk && edgesOk
}

/** Maximum nesting of graph documents validated by `validateGraphTree`. */
const MAX_NESTED_DEPTH = 32

/**
 * Validate one graph document. Nested graphs stored in node config are opaque
 * here; use `validateGraphTree` for recursive validation.
 */
export function validateGraph(
  graph: GraphDocument,
  registry: NodeRegistry,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeById = new Map<string, GraphNode>()
  const portsById = new Map<string, NodePorts>()

  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      issues.push(
        issue('duplicate-node-id', `duplicate node id "${node.id}"`, { nodeId: node.id }),
      )
      continue
    }
    nodeById.set(node.id, node)
  }

  for (const node of nodeById.values()) {
    const ports = resolvePorts(node, registry)
    portsById.set(node.id, ports)
    if (ports.definition === undefined) {
      issues.push(
        issue(
          'unknown-node-type',
          `node "${node.id}" uses unknown type "${node.type}" at version "${node.version}"`,
          { nodeId: node.id },
        ),
      )
      continue
    }
    const invalid = configIssue(node, ports.definition)
    if (invalid !== undefined) issues.push(invalid)
  }

  const seenEdgeIds = new Set<string>()
  const connectedDataInputs = new Set<string>()
  const dataEdgeByPort = new Map<string, string>()
  for (const edge of graph.edges) {
    if (seenEdgeIds.has(edge.id)) {
      issues.push(issue('duplicate-edge-id', `duplicate edge id "${edge.id}"`, { edgeId: edge.id }))
    } else {
      seenEdgeIds.add(edge.id)
    }
    if (edge.kind === 'data') {
      const inputKey = `${edge.to.node}\u0000${edge.to.port}`
      connectedDataInputs.add(inputKey)
      // SPEC §5: a data input port takes exactly one incoming edge.
      const firstEdgeId = dataEdgeByPort.get(inputKey)
      if (firstEdgeId === undefined) {
        dataEdgeByPort.set(inputKey, edge.id)
      } else {
        issues.push(
          issue(
            'duplicate-data-edge',
            `input port "${edge.to.port}" of node "${edge.to.node}" already has incoming data edge "${firstEdgeId}"`,
            { nodeId: edge.to.node, edgeId: edge.id },
          ),
        )
      }
    }

    const sourceNode = nodeById.get(edge.from.node)
    const targetNode = nodeById.get(edge.to.node)
    const missingNodes: string[] = []
    if (sourceNode === undefined) missingNodes.push(edge.from.node)
    if (targetNode === undefined) missingNodes.push(edge.to.node)
    if (missingNodes.length > 0) {
      const missingNode = missingNodes[0]
      issues.push(
        issue('dangling-edge', `edge "${edge.id}" references unknown node(s): ${missingNodes.join(', ')}`, {
          edgeId: edge.id,
          ...(missingNode !== undefined ? { nodeId: missingNode } : {}),
        }),
      )
    }

    if (edge.from.node === edge.to.node) {
      issues.push(
        issue('self-edge', `edge "${edge.id}" connects node "${edge.from.node}" to itself`, {
          nodeId: edge.from.node,
          edgeId: edge.id,
        }),
      )
    }

    // Without resolved definitions the port layout is unknown; only node-level
    // problems (dangling edge above) can be reported.
    const sourcePorts = sourceNode === undefined ? undefined : portsById.get(sourceNode.id)
    const targetPorts = targetNode === undefined ? undefined : portsById.get(targetNode.id)
    if (sourcePorts?.definition === undefined || targetPorts?.definition === undefined) continue

    const fromPort = sourcePorts.outputs.get(edge.from.port)
    const toPort = targetPorts.inputs.get(edge.to.port)

    if (fromPort === undefined) {
      issues.push(
        issue(
          'unknown-port',
          `node "${edge.from.node}" (${sourcePorts.definition.id}) has no output port "${edge.from.port}"`,
          { edgeId: edge.id, nodeId: edge.from.node },
        ),
      )
    }
    if (toPort === undefined) {
      issues.push(
        issue(
          'unknown-port',
          `node "${edge.to.node}" (${targetPorts.definition.id}) has no input port "${edge.to.port}"`,
          { edgeId: edge.id, nodeId: edge.to.node },
        ),
      )
    }

    if (fromPort !== undefined && fromPort.kind !== edge.kind) {
      issues.push(
        issue(
          'port-kind-mismatch',
          `edge "${edge.id}" is a ${edge.kind} edge but "${edge.from.node}.${edge.from.port}" is a ${fromPort.kind} port`,
          { edgeId: edge.id, nodeId: edge.from.node },
        ),
      )
    }
    if (toPort !== undefined && toPort.kind !== edge.kind) {
      issues.push(
        issue(
          'port-kind-mismatch',
          `edge "${edge.id}" is a ${edge.kind} edge but "${edge.to.node}.${edge.to.port}" is a ${toPort.kind} port`,
          { edgeId: edge.id, nodeId: edge.to.node },
        ),
      )
    }

    if (
      fromPort?.kind === 'data' &&
      toPort?.kind === 'data' &&
      !isPortTypeCompatible(fromPort, toPort)
    ) {
      issues.push(
        issue(
          'port-type-mismatch',
          `edge "${edge.id}" connects ${describeDataPort(fromPort)} to ${describeDataPort(toPort)}`,
          { edgeId: edge.id, nodeId: edge.to.node },
        ),
      )
    }
  }

  for (const node of nodeById.values()) {
    const ports = portsById.get(node.id)
    if (ports === undefined || ports.inputs.size === 0) continue
    for (const port of ports.inputs.values()) {
      if (port.kind !== 'data' || port.required === false) continue
      if (!connectedDataInputs.has(`${node.id}\u0000${port.id}`)) {
        issues.push(
          issue(
            'missing-required-input',
            `required input "${port.id}" of node "${node.id}" is not connected`,
            { nodeId: node.id },
          ),
        )
      }
    }
  }

  issues.push(...flowCycleIssues(graph))
  return issues
}

function describeDataPort(port: DataPort): string {
  const names = typeNames(jsonSchemaOf(port))
  return names === undefined ? `"${port.id}" (unconstrained)` : `"${port.id}" (${names.join('|')})`
}

/**
 * Validate a graph and every graph document nested under `config.graph` or
 * `config.body`, up to MAX_NESTED_DEPTH levels. Deeper nesting is reported as
 * `nested-too-deep` on the parent node instead of descending.
 */
export function validateGraphTree(
  graph: GraphDocument,
  registry: NodeRegistry,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const visit = (current: GraphDocument, depth: number): void => {
    issues.push(...validateGraph(current, registry))

    for (const node of current.nodes) {
      if (!isRecord(node.config)) continue
      for (const key of ['graph', 'body'] as const) {
        const nested = node.config[key]
        if (!isGraphShaped(nested)) continue
        if (depth + 1 > MAX_NESTED_DEPTH) {
          issues.push(
            issue(
              'nested-too-deep',
              `node "${node.id}" nests a graph deeper than ${MAX_NESTED_DEPTH} levels`,
              { nodeId: node.id },
            ),
          )
          continue
        }
        visit(nested, depth + 1)
      }
    }
  }

  visit(graph, 0)
  return issues
}
