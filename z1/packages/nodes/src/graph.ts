import { z } from 'zod'
import { parseGraph } from '@z1/graph'
import { defineNode, type Json, type NodeDefinition } from '@z1/node'
import { dataPort, flowPort, inputValues, jsonValue, NODE_VERSION } from './shared.ts'

const subgraph = defineNode({
  id: 'z1.graph.subgraph',
  version: NODE_VERSION,
  title: 'Subgraph',
  description: 'Runs a nested graph with the same services and returns its result.',
  category: 'graph',
  // `outputPort` selects one run output by name (default `output`). When that
  // port is absent from the nested run the whole outputs map is returned so no
  // value is lost. Sibling outputs are intentionally *not* merged into the
  // selection: a single value keeps the parent edge type predictable.
  config: z.object({ graph: z.unknown(), outputPort: z.string().optional() }),
  defaultConfig: {
    graph: { schemaVersion: 1, id: 'subgraph', nodes: [], edges: [] },
  },
  // A nested graph may write files or call tools.
  cacheable: false,
  inputs: [flowPort('in'), dataPort('input', jsonValue, false)],
  outputs: [flowPort('out'), dataPort('output', jsonValue)],
  execute: async (ctx) => {
    const graph = parseGraph(ctx.config.graph)
    const input = inputValues(ctx.input)['input']
    const { outputs } = await ctx.runSubgraph(
      input === undefined ? { graph } : { graph, input },
    )
    const port = ctx.config.outputPort ?? 'output'
    const output: Json = Object.hasOwn(outputs, port) ? (outputs[port] ?? null) : outputs
    return { out: true, output }
  },
})

export const graphNodes: readonly NodeDefinition[] = [subgraph]
export { subgraph as graphSubgraph }
