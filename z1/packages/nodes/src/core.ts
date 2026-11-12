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

export const coreNodes: readonly NodeDefinition[] = [input, output, constant, template]
export { input as coreInput, output as coreOutput, constant as coreConst, template as coreTemplate }
