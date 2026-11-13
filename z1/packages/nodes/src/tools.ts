import { z } from 'zod'
import { defineNode, type NodeDefinition } from '@z1/node'
import {
  asJson,
  dataPort,
  errorMessage,
  flowPort,
  inputValues,
  jsonValue,
  NODE_VERSION,
} from './shared.ts'

/**
 * Wire shape of a declared tool. It mirrors the `z1.llm.chat` tools port so the
 * two can be wired directly: `parameters` is optional on the wire and the chat
 * node fills in an empty object.
 */
const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), jsonValue).optional(),
})

const call = defineNode({
  id: 'z1.tool.call',
  version: NODE_VERSION,
  title: 'Call tool',
  description: 'Invokes a tool and reports failure as data instead of throwing.',
  category: 'tool',
  config: z.object({ name: z.string().optional() }),
  defaultConfig: { name: 'echo' },
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

/**
 * Lists the tools the runtime exposes as a root, so a graph can declare to the
 * model exactly what it can call. A runtime with no registered tools yields an
 * empty array, which the chat node treats as "no tools" rather than a failure.
 */
const list = defineNode({
  id: 'z1.tools.list',
  version: NODE_VERSION,
  title: 'List tools',
  description: 'Reads the tool declarations the runtime service exposes.',
  category: 'tool',
  config: z.object({}),
  defaultConfig: {},
  inputs: [],
  outputs: [dataPort('tools', z.array(toolSchema))],
  execute: async (ctx) => ({ tools: asJson([...(await ctx.tools.list())]) }),
})

export const toolNodes: readonly NodeDefinition[] = [call, list]
export { call as toolCall, list as toolList }
