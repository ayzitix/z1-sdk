import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import type { Json, ModelHandle, ToolSchema } from '@z1/node'
import {
  DEFAULT_SECTIONS,
  ROLE_SECTIONS,
  type PromptSection,
  type RoleId,
} from '@z1/prompt'

export const PACKAGE = '@z1/agent'

/** Every built-in ships at this version until a breaking change forces a bump. */
const NODE_VERSION = '1.0.0'

export interface AgentGraphOptions {
  model: ModelHandle
  /** Role delta appended to the core prompt. Defaults to `coder`. */
  role?: RoleId
  /** Extra instructions, rendered as the last (custom) section. */
  system?: string
  /** Iteration cap of the `z1.flow.loop` body. Defaults to 12. */
  maxSteps?: number
  tools?: readonly ToolSchema[]
  /** Token ceiling of the prompt stack. Defaults to the prompt package's own. */
  budgetTokens?: number
  /** Autonomy policy exposed to the prompt as `{{autonomy}}`. Defaults to `auto`. */
  autonomyPolicy?: string
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
  // The system prompt is never baked into config: it arrives in the seed as a
  // system message and is also exposed on the chat `system` port.
  const chatConfig: Record<string, Json> = { model: modelJson(options.model) }

  return {
    schemaVersion: 1,
    id: 'agent.loop.body',
    title: 'Agent loop body',
    nodes: [
      node('body', 'z1.core.input', 0, 0),
      node('messages', 'z1.core.get', 220, 0, { path: 'value' }),
      // The seed's first entry is the system message built from the prompt
      // stack; it feeds the chat's `system` port and the message list alike.
      node('systemText', 'z1.core.get', 440, -300, { path: '0.content' }),
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
      data('d27', 'body', 'value', 'systemText', 'value'),
      data('d28', 'systemText', 'value', 'chat', 'system'),
      // Flow
      flow('f1', 'body', 'out', 'messages', 'in'),
      flow('f2', 'messages', 'out', 'systemText', 'in'),
      flow('f22', 'systemText', 'out', 'chat', 'in'),
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

interface PromptChain {
  readonly nodes: GraphNode[]
  readonly edges: GraphEdge[]
  /** First `z1.core.concat` of the fragment chain (the flow entry). */
  readonly first: string
  /** Last `z1.core.concat`, whose value feeds the stack. */
  readonly last: string
}

/**
 * The system prompt as a visible graph: context → one section per default,
 * role delta, memory and custom, then a concat chain the stack consumes.
 */
function promptChain(options: AgentGraphOptions): PromptChain {
  const role = options.role ?? 'coder'
  const sections: PromptSection[] = [
    ...DEFAULT_SECTIONS,
    ROLE_SECTIONS[role],
    { id: 'context.memory', slot: 'context', priority: 0, required: false, body: '{{memory}}' },
  ]
  if (options.system !== undefined) {
    sections.push({
      id: 'custom.instructions',
      slot: 'custom',
      priority: 1000,
      required: false,
      body: options.system,
    })
  }

  const nodes: GraphNode[] = [
    node('promptTools', 'z1.core.const', 0, 240, {
      value: toolsJson(options.tools ?? []),
    }),
    node('promptAutonomy', 'z1.core.const', 0, 380, {
      value: options.autonomyPolicy ?? 'auto',
    }),
    // Reserved: the run's graph description is not part of the prompt yet.
    node('promptGraph', 'z1.core.const', 0, 520, { value: {} }),
    node('promptContext', 'z1.prompt.context', 220, 380),
    node('promptFragments', 'z1.core.const', 440, 200, { value: [] }),
  ]
  const edges: GraphEdge[] = [
    data('pc.memory', 'memory', 'text', 'promptContext', 'memory'),
    data('pc.tools', 'promptTools', 'value', 'promptContext', 'tools'),
    data('pc.autonomy', 'promptAutonomy', 'value', 'promptContext', 'autonomy'),
    data('pc.graph', 'promptGraph', 'value', 'promptContext', 'graph'),
  ]

  for (const [index, section] of sections.entries()) {
    const id = `promptSection.${section.id}`
    const config: Record<string, Json> = {
      id: section.id,
      slot: section.slot,
      priority: section.priority,
      required: section.required === true,
      body: section.body,
    }
    nodes.push(node(id, 'z1.prompt.section', 440, 360 + index * 150, config))
    edges.push(data(`ps.vars.${section.id}`, 'promptContext', 'vars', id, 'vars'))
  }

  // `a` is the previous array, `b` the next fragment: the stack receives the
  // same order the sections were declared in.
  let previous = 'promptFragments'
  for (const [index, section] of sections.entries()) {
    const id = `promptConcat${String(index)}`
    nodes.push(node(id, 'z1.core.concat', 660, 1980 + index * 90))
    edges.push(data(`ps.a.${String(index)}`, previous, 'value', id, 'a'))
    edges.push(
      data(`ps.b.${String(index)}`, `promptSection.${section.id}`, 'fragment', id, 'b'),
    )
    if (index > 0) {
      edges.push(flow(`ps.flow.${String(index)}`, previous, 'out', id, 'in'))
    }
    previous = id
  }

  const stackConfig: Record<string, Json> = {}
  if (options.budgetTokens !== undefined) stackConfig['budgetTokens'] = options.budgetTokens
  nodes.push(node('promptStack', 'z1.prompt.stack', 1200, 1980, stackConfig))
  edges.push(data('ps.stack', previous, 'value', 'promptStack', 'fragments'))

  return { nodes, edges, first: 'promptConcat0', last: previous }
}

/**
 * The default agent loop as a real graph: compose the system prompt from
 * sections, seed the transcript with that system message plus the user prompt,
 * run `z1.flow.loop` over the model/tool body, then publish the last message's
 * content. No host-side loop is hidden behind a custom node.
 */
export function buildAgentGraph(options: AgentGraphOptions): GraphDocument {
  const maxSteps = options.maxSteps ?? 12
  const prompt = promptChain(options)
  return {
    schemaVersion: 1,
    id: 'agent.loop',
    title: 'Agent loop',
    nodes: [
      node('input', 'z1.core.input', 0, 0),
      // Memory is a root: it reads the run's own tree, not the prompt.
      node('memory', 'z1.memory.context', 0, -140),
      node('userMessage', 'z1.core.message', 220, 0, { role: 'user' }),
      // The stack text is materialized as the transcript's system message; the
      // body reads it back from the seed to fill the chat `system` port.
      node('promptMessage', 'z1.core.message', 880, -300, { role: 'system' }),
      node('promptEmpty', 'z1.core.const', 660, -300, { value: [] }),
      node('promptHead', 'z1.core.concat', 1100, -300),
      node('seedEmpty', 'z1.core.const', 660, 120, { value: [] }),
      node('seedUser', 'z1.core.concat', 880, 120),
      node('seed', 'z1.core.concat', 1320, 0),
      node('loop', 'z1.flow.loop', 1540, 0, {
        body: graphJson(buildLoopBody(options)),
        maxIterations: maxSteps,
      }),
      node('last', 'z1.core.last', 1760, 0),
      node('content', 'z1.core.get', 1980, 0, { path: 'content' }),
      node('output', 'z1.core.output', 2200, 0, { port: 'output' }),
      ...prompt.nodes,
    ],
    edges: [
      data('d1', 'input', 'value', 'userMessage', 'content'),
      data('d12', 'promptStack', 'text', 'promptMessage', 'content'),
      data('d2', 'userMessage', 'message', 'seedUser', 'b'),
      data('d3', 'seedEmpty', 'value', 'seedUser', 'a'),
      data('d4', 'promptMessage', 'message', 'promptHead', 'b'),
      data('d5', 'promptEmpty', 'value', 'promptHead', 'a'),
      data('d6', 'promptHead', 'value', 'seed', 'a'),
      data('d7', 'seedUser', 'value', 'seed', 'b'),
      data('d8', 'seed', 'value', 'loop', 'seed'),
      data('d9', 'loop', 'result', 'last', 'items'),
      data('d10', 'last', 'value', 'content', 'value'),
      data('d11', 'content', 'value', 'output', 'value'),
      ...prompt.edges,
      flow('f1', 'input', 'out', prompt.first, 'in'),
      flow('f2', prompt.last, 'out', 'userMessage', 'in'),
      flow('f3', 'userMessage', 'out', 'promptMessage', 'in'),
      flow('f4', 'promptMessage', 'out', 'promptHead', 'in'),
      flow('f5', 'promptHead', 'out', 'seedUser', 'in'),
      flow('f6', 'seedUser', 'out', 'seed', 'in'),
      flow('f7', 'seed', 'out', 'loop', 'in'),
      flow('f8', 'loop', 'out', 'last', 'in'),
      flow('f9', 'last', 'out', 'content', 'in'),
      flow('f10', 'content', 'out', 'output', 'in'),
    ],
  }
}

/** The example graph: deterministic mock provider, no credential needed. */
export const agentLoopExample: GraphDocument = buildAgentGraph({
  model: { provider: 'mock', model: 'mock-1' },
})
