import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import type { Json, ModelHandle, ToolSchema } from '@z1/node'

export const PACKAGE = '@z1/agent'

/** Every built-in ships at this version until a breaking change forces a bump. */
const NODE_VERSION = '1.0.0'

export interface AgentGraphOptions {
  model: ModelHandle
  system?: string
  /** Iteration cap of the `z1.flow.loop` body. Defaults to 12. */
  maxSteps?: number
  tools?: readonly ToolSchema[]
}

function node(id: string, type: string, x: number, y: number, config: Json = {}): GraphNode {
  return { id, type, version: NODE_VERSION, config, position: { x, y } }
}

function data(
  id: string,
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
): GraphEdge {
  return { id, kind: 'data', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

function flow(
  id: string,
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
): GraphEdge {
  return { id, kind: 'flow', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

/** Wire form of a model handle: only JSON, so it survives the journal and cache. */
function modelJson(handle: ModelHandle): Json {
  const entry: Record<string, Json> = { provider: handle.provider, model: handle.model }
  if (handle.credentialRef !== undefined) entry['credentialRef'] = handle.credentialRef
  if (handle.params !== undefined) entry['params'] = handle.params
  return entry
}

/**
 * Node config is JSON, and a `GraphDocument` has optional properties, so it is
 * copied field by field instead of being cast through an index signature.
 */
function graphJson(graph: GraphDocument): Json {
  return {
    schemaVersion: graph.schemaVersion,
    id: graph.id,
    ...(graph.title === undefined ? {} : { title: graph.title }),
    nodes: graph.nodes.map(
      (item): Json => ({
        id: item.id,
        type: item.type,
        version: item.version,
        config: item.config,
        position: { x: item.position.x, y: item.position.y },
        ...(item.label === undefined ? {} : { label: item.label }),
      }),
    ),
    edges: graph.edges.map(
      (item): Json => ({
        id: item.id,
        kind: item.kind,
        from: { node: item.from.node, port: item.from.port },
        to: { node: item.to.node, port: item.to.port },
      }),
    ),
  }
}

function toolsJson(tools: readonly ToolSchema[]): Json {
  return tools.map((tool): Json => {
    const entry: Record<string, Json> = {
      name: tool.name,
      parameters: tool.parameters,
    }
    if (tool.description !== undefined) entry['description'] = tool.description
    return entry
  })
}

/**
 * The loop body: one model turn, then either a tool round trip or the final
 * answer. Every assembly node is gated on its branch's flow token, and the two
 * branch-local results reach `core.merge` only through the taken side, so a
 * merge can never fire on the untaken branch.
 */
function buildLoopBody(options: AgentGraphOptions): GraphDocument {
  const chatConfig: Record<string, Json> = { model: modelJson(options.model) }
  if (options.system !== undefined) chatConfig['system'] = options.system

  return {
    schemaVersion: 1,
    id: 'agent.loop.body',
    title: 'Agent loop body',
    nodes: [
      node('body', 'z1.core.input', 0, 0),
      node('messages', 'z1.core.get', 220, 0, { path: 'value' }),
      // A root const, so the tool declaration is available on every iteration.
      node('tools', 'z1.core.const', 220, -140, {
        value: toolsJson(options.tools ?? []),
      }),
      node('chat', 'z1.llm.chat', 440, 0, chatConfig),
      node('branch', 'z1.flow.if', 660, 0),
      // The chat `message` carries `toolCalls`, so a single source feeds all three.
      // The assistant message carries `toolCalls`, so it is also the source for
      // the `toolCalls.0.*` reads.
      node('assistantMsg', 'z1.core.message', 880, -120, { role: 'assistant' }),
      node('callName', 'z1.core.get', 1100, -120, { path: 'toolCalls.0.name' }),
      node('callArgs', 'z1.core.get', 1100, 0, { path: 'toolCalls.0.arguments' }),
      node('callId', 'z1.core.get', 1100, 120, { path: 'toolCalls.0.id' }),
      node('tool', 'z1.tool.call', 1320, 0),
      node('toolMsg', 'z1.core.message', 1540, 0, { role: 'tool' }),
      node('thenConcat', 'z1.core.concat', 1760, -60),
      node('thenMsgs', 'z1.core.concat', 1900, 20),
      node('thenDone', 'z1.core.value', 1760, -180, { value: false }),
      // A second, flow-gated read of the loop input: only the else branch runs it.
      node('elseMessages', 'z1.core.get', 880, 340, { path: 'value' }),
      node('elseMsgs', 'z1.core.concat', 1100, 340),
      node('elseDone', 'z1.core.value', 1320, 340, { value: true }),
      node('messagesMerge', 'z1.core.merge', 2060, 0),
      node('doneMerge', 'z1.core.merge', 2060, -180),
      node('outValue', 'z1.core.output', 2280, 0, { port: 'value' }),
      node('outDone', 'z1.core.output', 2280, -180, { port: 'done' }),
    ],
    edges: [
      // Data
      data('d1', 'body', 'value', 'messages', 'value'),
      data('d2', 'messages', 'value', 'chat', 'messages'),
      data('d3', 'tools', 'value', 'chat', 'tools'),
      data('d4', 'chat', 'hasToolCalls', 'branch', 'condition'),
      data('d5', 'assistantMsg', 'message', 'callName', 'value'),
      data('d6', 'assistantMsg', 'message', 'callArgs', 'value'),
      data('d7', 'assistantMsg', 'message', 'callId', 'value'),
      data('d8', 'callName', 'value', 'tool', 'name'),
      data('d9', 'callArgs', 'value', 'tool', 'args'),
      data('d10', 'tool', 'result', 'toolMsg', 'content'),
      data('d11', 'callId', 'value', 'toolMsg', 'toolCallId'),
      data('d12', 'chat', 'text', 'assistantMsg', 'content'),
      data('d13', 'chat', 'toolCalls', 'assistantMsg', 'toolCalls'),
      data('d14', 'messages', 'value', 'thenConcat', 'a'),
      data('d15', 'assistantMsg', 'message', 'thenConcat', 'b'),
      data('d16', 'thenConcat', 'value', 'thenMsgs', 'a'),
      data('d17', 'toolMsg', 'message', 'thenMsgs', 'b'),
      data('d18', 'thenMsgs', 'value', 'messagesMerge', 'a'),
      data('d19', 'body', 'value', 'elseMessages', 'value'),
      data('d20', 'elseMessages', 'value', 'elseMsgs', 'a'),
      data('d21', 'chat', 'message', 'elseMsgs', 'b'),
      data('d22', 'elseMsgs', 'value', 'messagesMerge', 'b'),
      data('d23', 'thenDone', 'value', 'doneMerge', 'a'),
      data('d24', 'elseDone', 'value', 'doneMerge', 'b'),
      data('d25', 'messagesMerge', 'value', 'outValue', 'value'),
      data('d26', 'doneMerge', 'value', 'outDone', 'value'),
      // Flow
      flow('f1', 'body', 'out', 'messages', 'in'),
      flow('f2', 'messages', 'out', 'chat', 'in'),
      flow('f3', 'chat', 'out', 'branch', 'in'),
      flow('f4', 'branch', 'then', 'assistantMsg', 'in'),
      flow('f5', 'assistantMsg', 'out', 'callName', 'in'),
      flow('f6', 'callName', 'out', 'callArgs', 'in'),
      flow('f7', 'callArgs', 'out', 'callId', 'in'),
      flow('f8', 'callId', 'out', 'tool', 'in'),
      flow('f9', 'tool', 'out', 'toolMsg', 'in'),
      flow('f10', 'toolMsg', 'out', 'thenConcat', 'in'),
      flow('f11', 'thenConcat', 'out', 'thenMsgs', 'in'),
      flow('f12', 'thenMsgs', 'out', 'thenDone', 'in'),
      flow('f13', 'branch', 'else', 'elseMessages', 'in'),
      flow('f14', 'elseMessages', 'out', 'elseMsgs', 'in'),
      flow('f15', 'elseMsgs', 'out', 'elseDone', 'in'),
      // Both branch tokens converge; only the taken one is ever propagated.
      flow('f16', 'thenMsgs', 'out', 'messagesMerge', 'in'),
      flow('f17', 'elseMsgs', 'out', 'messagesMerge', 'in'),
      flow('f18', 'thenDone', 'out', 'doneMerge', 'in'),
      flow('f19', 'elseDone', 'out', 'doneMerge', 'in'),
      flow('f20', 'messagesMerge', 'out', 'outValue', 'in'),
      flow('f21', 'doneMerge', 'out', 'outDone', 'in'),
    ],
  }
}

/**
 * The default agent loop as a real graph: seed the transcript with the user
 * prompt, run `z1.flow.loop` over the model/tool body, then publish the last
 * message's content. No host-side loop is hidden behind a custom node.
 */
export function buildAgentGraph(options: AgentGraphOptions): GraphDocument {
  const maxSteps = options.maxSteps ?? 12
  return {
    schemaVersion: 1,
    id: 'agent.loop',
    title: 'Agent loop',
    nodes: [
      node('input', 'z1.core.input', 0, 0),
      // Memory is a root: it reads the run's own tree, not the prompt.
      node('memory', 'z1.memory.context', 0, -140),
      node('userMessage', 'z1.core.message', 220, 0, { role: 'user' }),
      node('seed', 'z1.core.concat', 440, 0),
      node('loop', 'z1.flow.loop', 660, 0, {
        body: graphJson(buildLoopBody(options)),
        maxIterations: maxSteps,
      }),
      node('last', 'z1.core.last', 880, 0),
      node('content', 'z1.core.get', 1100, 0, { path: 'content' }),
      node('output', 'z1.core.output', 1320, 0, { port: 'output' }),
    ],
    edges: [
      data('d1', 'input', 'value', 'userMessage', 'content'),
      data('d2', 'memory', 'messages', 'seed', 'a'),
      data('d3', 'userMessage', 'message', 'seed', 'b'),
      data('d4', 'seed', 'value', 'loop', 'seed'),
      data('d5', 'loop', 'result', 'last', 'items'),
      data('d6', 'last', 'value', 'content', 'value'),
      data('d7', 'content', 'value', 'output', 'value'),
      flow('f1', 'input', 'out', 'userMessage', 'in'),
      flow('f2', 'userMessage', 'out', 'seed', 'in'),
      flow('f3', 'seed', 'out', 'loop', 'in'),
      flow('f4', 'loop', 'out', 'last', 'in'),
      flow('f5', 'last', 'out', 'content', 'in'),
      flow('f6', 'content', 'out', 'output', 'in'),
    ],
  }
}

/** The example graph: deterministic mock provider, no credential needed. */
export const agentLoopExample: GraphDocument = buildAgentGraph({
  model: { provider: 'mock', model: 'mock-1' },
})
