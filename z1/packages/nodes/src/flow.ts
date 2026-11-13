import { z } from 'zod'
import { parseGraph } from '@z1/graph'
import { defineNode, type Json, type NodeDefinition } from '@z1/node'
import { dataPort, flowPort, inputValues, jsonValue, NODE_VERSION } from './shared.ts'

/**
 * Body contract for `z1.flow.loop` and `z1.flow.map`: the body is a graph whose
 * `core.input` node receives a port-keyed record (`{ value, iteration }` for a
 * loop, `{ item, index }` for a map) and whose results are published by
 * `core.output` nodes. The documented value port is `value`; `output` is
 * accepted because it is the default port name, so a plain body graph works
 * without extra config.
 */
function bodyValue(outputs: Record<string, Json>): Json {
  if ('value' in outputs) return outputs['value'] ?? null
  return outputs['output'] ?? null
}

const branch = defineNode({
  id: 'z1.flow.if',
  version: NODE_VERSION,
  title: 'If',
  description: 'Routes the flow token to exactly one branch.',
  category: 'flow',
  config: z.object({}),
  defaultConfig: {},
  inputs: [flowPort('in'), dataPort('condition', z.boolean())],
  outputs: [flowPort('then'), flowPort('else')],
  execute: async (ctx) =>
    inputValues(ctx.input)['condition'] === true ? { then: true } : { else: true },
})

/**
 * Repeats a body graph.
 *
 * Body contract: input is `{ value, iteration }`; the next `value` and the
 * `done` flag are read from the body's `core.output` ports named `value` and
 * `done`. `done` is optional — a body without a `done` port runs exactly
 * `maxIterations` times. `seed` is optional and defaults to `null`.
 */
const loop = defineNode({
  id: 'z1.flow.loop',
  version: NODE_VERSION,
  title: 'Loop',
  description: 'Runs a body graph until it reports done or the iteration cap is hit.',
  category: 'flow',
  config: z.object({
    body: z.unknown(),
    maxIterations: z.number().int().min(1).max(10_000),
  }),
  // A loop body starts as an empty graph: it is still a valid graph, and the
  // caps stay inside the schema's own bounds.
  defaultConfig: {
    body: { schemaVersion: 1, id: 'body', title: 'loop body', nodes: [], edges: [] },
    maxIterations: 3,
  },
  inputs: [flowPort('in'), dataPort('seed', jsonValue, false)],
  outputs: [flowPort('out'), dataPort('result', jsonValue), dataPort('iterations', z.number())],
  execute: async (ctx) => {
    const body = parseGraph(ctx.config.body)
    const values = inputValues(ctx.input)
    // An absent seed is a deliberate `null`, not "skip the first iteration".
    let current = Object.hasOwn(values, 'seed') ? (values['seed'] ?? null) : null
    let iterations = 0

    while (iterations < ctx.config.maxIterations) {
      const { outputs } = await ctx.runSubgraph({
        graph: body,
        input: { value: current, iteration: iterations },
        // The iteration is part of the execution path so a journal resume can
        // replay iteration N and re-execute the one that was interrupted.
        label: String(iterations),
      })
      iterations += 1
      current = bodyValue(outputs)
      // A body without a `done` output never stops early: it runs to the cap.
      if (outputs['done'] === true) break
    }

    return { out: true, result: current, iterations }
  },
})

/**
 * Runs a body graph over an array.
 *
 * Body contract: input is `{ item, index }`; the per-item result is read from
 * the body's `core.output` port `value` (or `output`). `maxItems` caps the
 * item count and is a guard, not a truncation: exceeding it fails the node.
 */
const map = defineNode({
  id: 'z1.flow.map',
  version: NODE_VERSION,
  title: 'Map',
  description: 'Runs a body graph once per item, sequentially, preserving order.',
  category: 'flow',
  config: z.object({
    body: z.unknown(),
    maxItems: z.number().int().positive().optional(),
  }),
  defaultConfig: {
    body: { schemaVersion: 1, id: 'body', title: 'map body', nodes: [], edges: [] },
  },
  inputs: [flowPort('in'), dataPort('items', z.array(jsonValue))],
  outputs: [flowPort('out'), dataPort('results', z.array(jsonValue))],
  execute: async (ctx) => {
    const body = parseGraph(ctx.config.body)
    const raw = inputValues(ctx.input)['items']
    const items = Array.isArray(raw) ? raw : []
    const cap = ctx.config.maxItems
    if (cap !== undefined && items.length > cap) {
      throw new Error(`z1.flow.map: ${items.length} items exceed maxItems ${cap}`)
    }

    const results: Json[] = []
    for (const [index, item] of items.entries()) {
      const { outputs } = await ctx.runSubgraph({
        graph: body,
        input: { item, index },
        // Same as a loop: the index distinguishes per-item paths in the journal.
        label: String(index),
      })
      results.push(bodyValue(outputs))
    }

    return { out: true, results }
  },
})

export const flowNodes: readonly NodeDefinition[] = [branch, loop, map]
export { branch as flowIf, loop as flowLoop, map as flowMap }
