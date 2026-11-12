import { z } from 'zod'
import { defineNode, type NodeDefinition } from '@z1/node'
import {
  dataPort,
  errorMessage,
  flowPort,
  inputValues,
  jsonValue,
  NODE_VERSION,
} from './shared.ts'

const call = defineNode({
  id: 'z1.tool.call',
  version: NODE_VERSION,
  title: 'Call tool',
  description: 'Invokes a tool and reports failure as data instead of throwing.',
  category: 'tool',
  config: z.object({ name: z.string().optional() }),
  inputs: [
    flowPort('in'),
    dataPort('name', z.string(), false),
    dataPort('args', jsonValue),
  ],
  outputs: [dataPort('result', jsonValue), dataPort('isError', z.boolean()), flowPort('out')],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    // A connected `name` port is authoritative: a bad value there is an error,
    // not a reason to silently fall back to config.name.
    let name: string | undefined
    if (Object.hasOwn(values, 'name')) {
      const portName = values['name']
      if (typeof portName !== 'string' || portName.length === 0) {
        return {
          result: { error: 'tool name must be a non-empty string' },
          isError: true,
          out: true,
        }
      }
      name = portName
    } else {
      name = ctx.config.name
    }
    if (name === undefined || name.length === 0) {
      return { result: { error: 'tool name is required' }, isError: true, out: true }
    }

    try {
      const result = await ctx.tools.call(name, values['args'] ?? null)
      return { result, isError: false, out: true }
    } catch (error) {
      // A failed tool is a normal graph outcome: the caller decides what to do.
      return { result: { error: errorMessage(error) }, isError: true, out: true }
    }
  },
})

export const toolNodes: readonly NodeDefinition[] = [call]
export { call as toolCall }
