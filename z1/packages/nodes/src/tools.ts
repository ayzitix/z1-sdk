import { z } from 'zod'
import { defineNode, type NodeDefinition } from '@z1/node'
import {
  asJson,
  dataPort,
  errorMessage,
  flowPort,
  inputValues,
  isRecord,
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
  // A tool call is a side effect: identical arguments in two places are two
  // calls, never one cached result.
  cacheable: false,
  // A tool may be a shell command with a 300 s budget; the node must outlive
  // the 120 s default so the tool, not the executor, decides when it is done.
  timeoutMs: 300_000,
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
  // The installed set can change between steps of one run.
  cacheable: false,
  inputs: [],
  outputs: [dataPort('tools', z.array(toolSchema))],
  execute: async (ctx) => ({ tools: asJson([...(await ctx.tools.list())]) }),
})

/**
 * Whether a step handed its work off to the background.
 *
 * A tool result whose content is `{ status: "running", runId: "…" }` is a
 * *launch*, not an answer: the work continues elsewhere and the model has
 * nothing left to read in this step. The agent loop uses this to close the
 * turn on such a step instead of asking the model again - the parent hands
 * control back instead of waiting, which is the point of a background child.
 *
 * It reads the mapped tool results, not the assistant message. One blocking
 * tool in the same step means the model still has an answer to read, so that
 * step is not a hand-off.
 */
const background = defineNode({
  id: 'z1.tool.background',
  version: NODE_VERSION,
  title: 'Background?',
  description: 'True when every tool result of the step is a background launch.',
  category: 'tool',
  config: z.object({}),
  defaultConfig: {},
  inputs: [flowPort('in'), dataPort('results', z.array(jsonValue), false)],
  outputs: [dataPort('value', z.boolean()), flowPort('out')],
  execute: async (ctx) => {
    const raw = inputValues(ctx.input)['results']
    const results = Array.isArray(raw) ? raw : []
    // No results is an ordinary answer, not a hand-off.
    if (results.length === 0) return { value: false, out: true }
    const handOff = results.every((entry) => {
      if (!isRecord(entry)) return false
      // A tool message's `content` is the JSON the tool returned, as text.
      const content = entry['content']
      const parsed = typeof content === 'string' ? safeJson(content) : content
      if (!isRecord(parsed)) return false
      return parsed['status'] === 'running' && typeof parsed['runId'] === 'string'
    })
    return { value: handOff, out: true }
  },
})

/** JSON.parse that answers `undefined` instead of throwing. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const toolNodes: readonly NodeDefinition[] = [call, list, background]
export { call as toolCall, list as toolList, background as toolBackground }
