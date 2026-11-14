import { z } from 'zod'
import { defineNode, type NodeDefinition } from '@z1/node'
import { messageSchema } from './core.ts'
import { asJson, dataPort, NODE_VERSION } from './shared.ts'

/**
 * External memory as a root. The runtime service decides what the branch tree
 * contributes; without one the node is a well-formed empty envelope, so a fresh
 * run behaves exactly as it did before memory existed.
 */
const memoryContext = defineNode({
  id: 'z1.memory.context',
  version: NODE_VERSION,
  title: 'Memory context',
  description: 'Builds an envelope from ancestor runs, sibling branches and recent steps.',
  category: 'memory',
  config: z.object({}),
  defaultConfig: {},
  // The envelope depends on the journal at the moment it is built.
  cacheable: false,
  inputs: [],
  outputs: [dataPort('text', z.string()), dataPort('messages', z.array(messageSchema))],
  execute: async (ctx) => {
    const envelope =
      ctx.memory === undefined
        ? { text: '', messages: [] }
        : await ctx.memory.buildContext({ runId: ctx.runId })
    return { text: envelope.text, messages: asJson(envelope.messages) }
  },
})

export const memoryNodes: readonly NodeDefinition[] = [memoryContext]

export { memoryContext }
