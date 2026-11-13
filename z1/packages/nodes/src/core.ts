import { z } from 'zod'
import { defineNode, type Json, type NodeDefinition } from '@z1/node'
import {
  asJson,
  dataPort,
  flowPort,
  inputValues,
  isRecord,
  jsonValue,
  NODE_VERSION,
} from './shared.ts'

/** `config.value` is `unknown`; a missing value becomes JSON null, not "absent". */
function configValue(value: unknown): Json {
  return value === undefined ? null : asJson(value)
}

/** Keys that belong to the prototype chain, never to a vars record. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/

/**
 * Resolves a dotted placeholder path against the vars value.
 *
 * Semantics: a numeric segment indexes an array (`list.0.name`), an object is
 * traversed through its own properties only, and prototype keys are treated as
 * missing so a template can never read `__proto__`-style internals.
 */
function lookup(root: Json | undefined, path: string): Json | undefined {
  let current: Json | undefined = root
  for (const segment of path.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return undefined
      current = current[Number(segment)]
      continue
    }
    if (!isRecord(current)) return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

// Only well-formed placeholders are substituted; a malformed one like `{{a b}}`
// is left alone so a template can contain literal braces.
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_$.-]+)\s*\}\}/g

function renderTemplate(template: string, vars: Json | undefined): string {
  return template.replace(PLACEHOLDER, (_match: string, path: string) => {
    const value = lookup(vars, path)
    return value === undefined ? '' : String(value)
  })
}

const input = defineNode({
  id: 'z1.core.input',
  version: NODE_VERSION,
  title: 'Input',
  description: 'Run input as a value plus the flow token that starts a graph.',
  category: 'core',
  config: z.object({}),
  inputs: [],
  outputs: [dataPort('value', jsonValue), flowPort('out')],
  execute: async (ctx) => ({ value: ctx.input, out: true }),
})

const output = defineNode({
  id: 'z1.core.output',
  version: NODE_VERSION,
  title: 'Output',
  description: 'Publishes a value under the configured run-output port name.',
  category: 'core',
  config: z.object({ port: z.string().optional() }),
  inputs: [flowPort('in'), dataPort('value', jsonValue)],
  outputs: [],
  // The executor reads the `value` input and writes `RunResult.outputs[port]`.
  execute: async () => ({}),
})

const constant = defineNode({
  id: 'z1.core.const',
  version: NODE_VERSION,
  title: 'Constant',
  description: 'Emits a literal JSON value.',
  category: 'core',
  config: z.object({ value: z.unknown() }),
  inputs: [],
  outputs: [dataPort('value', jsonValue)],
  execute: async (ctx) => ({ value: configValue(ctx.config.value) }),
})

const template = defineNode({
  id: 'z1.core.template',
  version: NODE_VERSION,
  title: 'Template',
  description: 'Renders {{dotted.path}} placeholders from the vars record.',
  category: 'core',
  config: z.object({ template: z.string() }),
  // SPEC §7 types `vars` as Json so any JSON root can be piped in; placeholders
  // resolve through arrays (numeric segment) and own object properties.
  inputs: [dataPort('vars', jsonValue, false)],
  outputs: [dataPort('text', z.string())],
  execute: async (ctx) => ({
    text: renderTemplate(ctx.config.template, inputValues(ctx.input)['vars']),
  }),
})

const ROLE = z.enum(['system', 'user', 'assistant', 'tool'])

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: jsonValue,
})

export const messageSchema = z.object({
  role: ROLE,
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
})

/**
 * Branch-local constant. `z1.core.const` is a root: it has no inputs, so it
 * runs unconditionally even inside a branch. Gating a literal on a flow token
 * needs a node whose only trigger is that token.
 */
const value = defineNode({
  id: 'z1.core.value',
  version: NODE_VERSION,
  title: 'Value',
  description: 'Emits a literal value when the flow token arrives.',
  category: 'core',
  config: z.object({ value: jsonValue }),
  inputs: [flowPort('in')],
  outputs: [dataPort('value', jsonValue), flowPort('out')],
  execute: async (ctx) => ({ value: ctx.config.value, out: true }),
})

const get = defineNode({
  id: 'z1.core.get',
  version: NODE_VERSION,
  title: 'Get',
  description: 'Reads a dotted path from a JSON value; a missing path is null.',
  category: 'core',
  config: z.object({ path: z.string() }),
  inputs: [flowPort('in'), dataPort('value', jsonValue)],
  outputs: [dataPort('value', jsonValue), flowPort('out')],
  execute: async (ctx) => ({
    value: lookup(inputValues(ctx.input)['value'], ctx.config.path) ?? null,
    out: true,
  }),
})

const concat = defineNode({
  id: 'z1.core.concat',
  version: NODE_VERSION,
  title: 'Concat',
  description: 'Appends `b` to the `a` array, spreading `b` when it is an array.',
  category: 'core',
  config: z.object({}),
  inputs: [flowPort('in'), dataPort('a', z.array(jsonValue)), dataPort('b', jsonValue)],
  outputs: [dataPort('value', z.array(jsonValue)), flowPort('out')],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    const a = values['a']
    const list: Json[] = Array.isArray(a) ? [...a] : []
    const b = values['b']
    if (Array.isArray(b)) list.push(...b)
    else if (b !== undefined) list.push(b)
    return { value: list, out: true }
  },
})

const message = defineNode({
  id: 'z1.core.message',
  version: NODE_VERSION,
  title: 'Message',
  description: 'Builds a chat message; non-string content is JSON-stringified.',
  category: 'core',
  config: z.object({ role: ROLE }),
  inputs: [
    flowPort('in'),
    dataPort('content', jsonValue),
    dataPort('toolCallId', z.string(), false),
    dataPort('toolCalls', z.array(toolCallSchema), false),
  ],
  outputs: [dataPort('message', messageSchema), flowPort('out')],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    const content = values['content']
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? null)
    const result: Record<string, Json> = { role: ctx.config.role, content: text }

    // Absent keys are omitted so the executor's message shape stays exact.
    const toolCallId = values['toolCallId']
    if (typeof toolCallId === 'string') result['toolCallId'] = toolCallId
    const toolCalls = values['toolCalls']
    if (Array.isArray(toolCalls)) result['toolCalls'] = toolCalls
    return { message: asJson(result), out: true }
  },
})

const last = defineNode({
  id: 'z1.core.last',
  version: NODE_VERSION,
  title: 'Last',
  description: 'Emits the last item of an array, or null when it is empty.',
  category: 'core',
  config: z.object({}),
  inputs: [flowPort('in'), dataPort('items', z.array(jsonValue))],
  outputs: [dataPort('value', jsonValue), flowPort('out')],
  execute: async (ctx) => {
    const items = inputValues(ctx.input)['items']
    const list = Array.isArray(items) ? items : []
    return { value: list.length === 0 ? null : (list[list.length - 1] ?? null), out: true }
  },
})

/**
 * First defined input wins. Both ports are `waitFor: 'any'`: a branch may only
 * produce one side, and the node must run as soon as that side arrives.
 */
const merge = defineNode({
  id: 'z1.core.merge',
  version: NODE_VERSION,
  title: 'Merge',
  description: 'Passes through the first defined input, preferring `a` over `b`.',
  category: 'core',
  config: z.object({}),
  inputs: [
    flowPort('in'),
    dataPort('a', jsonValue, false, 'any'),
    dataPort('b', jsonValue, false, 'any'),
  ],
  outputs: [dataPort('value', jsonValue), flowPort('out')],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    const a = values['a']
    if (a !== undefined) return { value: a, out: true }
    return { value: values['b'] ?? null, out: true }
  },
})

export const coreNodes: readonly NodeDefinition[] = [
  input,
  output,
  constant,
  value,
  template,
  get,
  concat,
  message,
  last,
  merge,
]
export {
  input as coreInput,
  output as coreOutput,
  constant as coreConst,
  value as coreValue,
  template as coreTemplate,
  get as coreGet,
  concat as coreConcat,
  message as coreMessage,
  last as coreLast,
  merge as coreMerge,
}
