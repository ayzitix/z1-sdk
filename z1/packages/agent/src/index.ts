import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import type { Json, ModelHandle, ToolSchema } from '@z1/node'
import {
  DEFAULT_SECTIONS,
  ROLE_SECTIONS,
  type PromptSection,
  type RoleId,
} from '@z1/prompt'
import type { GraphTemplate, TemplateContext, TemplateRegistry } from '@z1/template'

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
 * The map body: one tool call per assistant `toolCalls` entry. `core.input`
 * holds the map contract's `{ item, index }`, and the body publishes the tool
 * message so the caller can concat the whole array of results.
 */
function buildToolMapBody(): GraphDocument {
  return {
    schemaVersion: 1,
    id: 'agent.loop.tools',
    title: 'Tool calls',
    nodes: [
      node('mapInput', 'z1.core.input', 0, 0),
      node('itemName', 'z1.core.get', 220, -120, { path: 'item.name' }),
      node('itemArgs', 'z1.core.get', 220, 0, { path: 'item.arguments' }),
      node('itemId', 'z1.core.get', 220, 120, { path: 'item.id' }),
      node('mapCall', 'z1.tool.call', 440, 0),
      // A tool result becomes message content; clipping here bounds the
      // transcript without changing what the tool returned on disk.
      node('mapClip', 'z1.ctx.clip', 550, 0),
      node('mapMessage', 'z1.core.message', 660, 0, { role: 'tool' }),
      node('mapOut', 'z1.core.output', 880, 0, { port: 'value' }),
    ],
    edges: [
      data('m1', 'mapInput', 'value', 'itemName', 'value'),
      data('m2', 'mapInput', 'value', 'itemArgs', 'value'),
      data('m3', 'mapInput', 'value', 'itemId', 'value'),
      data('m4', 'itemName', 'value', 'mapCall', 'name'),
      data('m5', 'itemArgs', 'value', 'mapCall', 'args'),
      data('m6', 'mapCall', 'result', 'mapClip', 'value'),
      data('m6b', 'mapClip', 'value', 'mapMessage', 'content'),
      data('m6c', 'itemName', 'value', 'mapClip', 'name'),
      data('m7', 'itemId', 'value', 'mapMessage', 'toolCallId'),
      data('m8', 'mapMessage', 'message', 'mapOut', 'value'),
      flow('mf1', 'mapInput', 'out', 'itemName', 'in'),
      flow('mf2', 'itemName', 'out', 'itemArgs', 'in'),
      flow('mf3', 'itemArgs', 'out', 'itemId', 'in'),
      flow('mf4', 'itemId', 'out', 'mapCall', 'in'),
      flow('mf5', 'mapCall', 'out', 'mapClip', 'in'),
      flow('mf5b', 'mapClip', 'out', 'mapMessage', 'in'),
      flow('mf6', 'mapMessage', 'out', 'mapOut', 'in'),
    ],
  }
}

/**
 * The loop body: one model turn, then either a tool round trip or the final
 * answer. Every assembly node is gated on its branch's flow token, and the two
 * branch-local results reach `core.merge` only through the taken side, so a
 * merge can never fire on the untaken branch.
 *
 * The tool branch maps over every entry of `chat.toolCalls`, so one assistant
 * message with N calls becomes N tool messages. The assistant message (with all
 * its `toolCalls`) is appended first, then the mapped messages are spread after
 * it, so the transcript keeps one `tool_call_id` per tool message, in order.
 */
function buildLoopBody(options: AgentGraphOptions): GraphDocument {
  // The system prompt is never baked into config: it arrives in the seed as a
  // system message and is also exposed on the chat `system` port.
  const chatConfig: Record<string, Json> = { model: modelJson(options.model) }

  // Explicit tools are a declaration the caller made, so they stay a const and
  // override whatever the runtime exposes (tests and total conversions rely on
  // it). Without them the body asks the run's tool service what is available,
  // so the model sees the live toolset instead of a stale snapshot.
  const explicitTools = options.tools ?? []
  const usesExplicitTools = explicitTools.length > 0
  const tools = usesExplicitTools
    ? node('tools', 'z1.core.const', 220, -140, { value: toolsJson(explicitTools) })
    : node('tools', 'z1.tools.list', 220, -140)
  // Both declarations feed `chat.tools`, but their source ports differ: a const
  // publishes `value`, the list publishes `tools`.
  const toolsPort = usesExplicitTools ? 'value' : 'tools'

  return {
    schemaVersion: 1,
    id: 'agent.loop.body',
    title: 'Agent loop body',
    nodes: [
      node('body', 'z1.core.input', 0, 0),
      node('messages', 'z1.core.get', 220, 0, { path: 'value' }),
      // Observe-only: reports the transcript size, drops nothing, so the
      // journal records how close a turn came to the window.
      node('budget', 'z1.ctx.budget', 330, 0),
      // Compaction is flow-gated on the budget, so a transcript that fits is
      // passed through byte-identical and no summary call is made.
      node('ctxGate', 'z1.flow.if', 440, -360),
      node('ctxCompact', 'z1.ctx.compact', 550, 160),
      node('ctxSummary', 'z1.ctx.summarize', 660, 160, chatConfig),
      node('ctxMerge', 'z1.core.merge', 770, 0),
      // The seed's first entry is the system message built from the prompt
      // stack; it feeds the chat's `system` port and the message list alike.
      node('systemText', 'z1.core.get', 440, -300, { path: '0.content' }),
      // Root, so the tool declaration is available on every iteration.
      tools,
      node('chat', 'z1.llm.chat', 440, 0, chatConfig),
      node('branch', 'z1.flow.if', 660, 0),
      // The chat `message` carries every `toolCalls` entry, so the assistant
      // message is also what the map iterates over.
      node('assistantMsg', 'z1.core.message', 880, -120, { role: 'assistant' }),
      node('toolMap', 'z1.flow.map', 880, 120, { body: graphJson(buildToolMapBody()) }),
      node('thenConcat', 'z1.core.concat', 1100, -60),
      node('thenMsgs', 'z1.core.concat', 1320, 20),
      node('thenDone', 'z1.core.value', 1540, -180, { value: false }),
      // A second, flow-gated read of the loop input: only the else branch runs it.
      node('elseMessages', 'z1.core.get', 880, 340, { path: 'value' }),
      node('elseMsgs', 'z1.core.concat', 1100, 340),
      node('elseDone', 'z1.core.value', 1320, 340, { value: true }),
      node('messagesMerge', 'z1.core.merge', 1760, 0),
      node('doneMerge', 'z1.core.merge', 1760, -180),
      node('outValue', 'z1.core.output', 1980, 0, { port: 'value' }),
      node('outDone', 'z1.core.output', 1980, -180, { port: 'done' }),
    ],
    edges: [
      // Data
      data('d1', 'body', 'value', 'messages', 'value'),
      data('d2', 'messages', 'value', 'budget', 'messages'),
      data('d2b', 'budget', 'messages', 'ctxCompact', 'messages'),
      data('d2c', 'budget', 'messages', 'ctxMerge', 'b'),
      data('d2d', 'ctxCompact', 'messages', 'ctxSummary', 'messages'),
      data('d2e', 'ctxSummary', 'messages', 'ctxMerge', 'a'),
      data('d2f', 'ctxMerge', 'value', 'chat', 'messages'),
      data('d2g', 'budget', 'over', 'ctxGate', 'condition'),
      data('d2h', 'tools', toolsPort, 'ctxSummary', 'tools'),
      data('d3', 'tools', toolsPort, 'chat', 'tools'),
      data('d4', 'chat', 'hasToolCalls', 'branch', 'condition'),
      data('d5', 'chat', 'text', 'assistantMsg', 'content'),
      data('d6', 'chat', 'toolCalls', 'assistantMsg', 'toolCalls'),
      data('d7', 'chat', 'toolCalls', 'toolMap', 'items'),
      data('d8', 'messages', 'value', 'thenConcat', 'a'),
      data('d9', 'assistantMsg', 'message', 'thenConcat', 'b'),
      data('d10', 'thenConcat', 'value', 'thenMsgs', 'a'),
      data('d11', 'toolMap', 'results', 'thenMsgs', 'b'),
      data('d12', 'thenMsgs', 'value', 'messagesMerge', 'a'),
      data('d13', 'body', 'value', 'elseMessages', 'value'),
      data('d14', 'elseMessages', 'value', 'elseMsgs', 'a'),
      data('d15', 'chat', 'message', 'elseMsgs', 'b'),
      data('d16', 'elseMsgs', 'value', 'messagesMerge', 'b'),
      data('d17', 'thenDone', 'value', 'doneMerge', 'a'),
      data('d18', 'elseDone', 'value', 'doneMerge', 'b'),
      data('d19', 'messagesMerge', 'value', 'outValue', 'value'),
      data('d20', 'doneMerge', 'value', 'outDone', 'value'),
      data('d21', 'body', 'value', 'systemText', 'value'),
      data('d22', 'systemText', 'value', 'chat', 'system'),
      // Flow
      flow('f1', 'body', 'out', 'messages', 'in'),
      flow('f2', 'messages', 'out', 'systemText', 'in'),
      flow('f3', 'systemText', 'out', 'ctxGate', 'in'),
      flow('f3b', 'ctxGate', 'then', 'ctxCompact', 'in'),
      flow('f3c', 'ctxCompact', 'out', 'ctxSummary', 'in'),
      flow('f3d', 'ctxSummary', 'out', 'ctxMerge', 'in'),
      flow('f3e', 'ctxGate', 'else', 'ctxMerge', 'in'),
      flow('f3f', 'ctxMerge', 'out', 'chat', 'in'),
      flow('f4', 'chat', 'out', 'branch', 'in'),
      flow('f5', 'branch', 'then', 'assistantMsg', 'in'),
      flow('f6', 'assistantMsg', 'out', 'toolMap', 'in'),
      flow('f7', 'toolMap', 'out', 'thenConcat', 'in'),
      flow('f8', 'thenConcat', 'out', 'thenMsgs', 'in'),
      flow('f9', 'thenMsgs', 'out', 'thenDone', 'in'),
      flow('f10', 'branch', 'else', 'elseMessages', 'in'),
      flow('f11', 'elseMessages', 'out', 'elseMsgs', 'in'),
      flow('f12', 'elseMsgs', 'out', 'elseDone', 'in'),
      // Both branch tokens converge; only the taken one is ever propagated.
      flow('f13', 'thenMsgs', 'out', 'messagesMerge', 'in'),
      flow('f14', 'elseMsgs', 'out', 'messagesMerge', 'in'),
      flow('f15', 'thenDone', 'out', 'doneMerge', 'in'),
      flow('f16', 'elseDone', 'out', 'doneMerge', 'in'),
      flow('f17', 'messagesMerge', 'out', 'outValue', 'in'),
      flow('f18', 'doneMerge', 'out', 'outDone', 'in'),
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
 * content — but only when the loop reported `completed`. Hitting the step cap
 * means the transcript ends inside a tool round trip, so the graph fails with a
 * clear error instead of publishing tool JSON as the answer. No host-side loop
 * is hidden behind a custom node.
 */
export function buildAgentGraph(options: AgentGraphOptions): GraphDocument {
  const maxSteps = options.maxSteps ?? 12
  // `maxSteps` also feeds the loop's `maxIterations` schema (integer, min 1);
  // failing here names the option instead of surfacing a graph validation code.
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error('maxSteps must be >= 1')
  }
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
      // The loop's own `completed` flag decides whether the transcript ended on
      // an assistant answer or was cut short by the cap.
      node('doneCheck', 'z1.flow.if', 1760, 0),
      node('last', 'z1.core.last', 1980, 0),
      node('content', 'z1.core.get', 2200, 0, { path: 'content' }),
      node('output', 'z1.core.output', 2420, 0, { port: 'output' }),
      node('fail', 'z1.core.fail', 1980, -180, {
        message: `step limit reached after ${String(maxSteps)} steps`,
      }),
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
      data('d13', 'loop', 'completed', 'doneCheck', 'condition'),
      ...prompt.edges,
      flow('f1', 'input', 'out', prompt.first, 'in'),
      flow('f2', prompt.last, 'out', 'userMessage', 'in'),
      flow('f3', 'userMessage', 'out', 'promptMessage', 'in'),
      flow('f4', 'promptMessage', 'out', 'promptHead', 'in'),
      flow('f5', 'promptHead', 'out', 'seedUser', 'in'),
      flow('f6', 'seedUser', 'out', 'seed', 'in'),
      flow('f7', 'seed', 'out', 'loop', 'in'),
      flow('f8', 'loop', 'out', 'doneCheck', 'in'),
      flow('f9', 'doneCheck', 'then', 'last', 'in'),
      flow('f10', 'last', 'out', 'content', 'in'),
      flow('f11', 'content', 'out', 'output', 'in'),
      flow('f12', 'doneCheck', 'else', 'fail', 'in'),
    ],
  }
}

/** The example graph: deterministic mock provider, no credential needed. */
export const agentLoopExample: GraphDocument = buildAgentGraph({
  model: { provider: 'mock', model: 'mock-1' },
})

function isRoleId(value: string): value is RoleId {
  return Object.prototype.hasOwnProperty.call(ROLE_SECTIONS, value)
}

/** A role name is data, so an unknown one names the role instead of failing in a node. */
function templateRole(role: string | undefined): RoleId | undefined {
  if (role === undefined) return undefined
  if (!isRoleId(role)) {
    throw new Error(`unknown role "${role}"; expected ${Object.keys(ROLE_SECTIONS).join(', ')}`)
  }
  return role
}

/**
 * The agent loop as a template: `kind: 'builder'` because its graph depends on
 * the model, tools and prompt settings the caller supplies.
 */
export const agentTemplate: GraphTemplate = {
  kind: 'builder',
  id: 'agent.loop',
  version: '1.0.0',
  title: 'Agent loop',
  description: 'Prompt stack, model turn, tool round trip and final answer as one graph.',
  build(context: TemplateContext): GraphDocument {
    const role = templateRole(context.role)
    return buildAgentGraph({
      model: context.model ?? { provider: 'mock', model: 'mock-1' },
      ...(role === undefined ? {} : { role }),
      ...(context.tools === undefined ? {} : { tools: context.tools }),
      ...(context.maxSteps === undefined ? {} : { maxSteps: context.maxSteps }),
      ...(context.system === undefined ? {} : { system: context.system }),
      ...(context.budgetTokens === undefined ? {} : { budgetTokens: context.budgetTokens }),
    })
  },
}

/** Register the built-in templates; the registry stays the caller's. */
export function registerAgentTemplates(registry: TemplateRegistry): void {
  registry.register(agentTemplate)
}
