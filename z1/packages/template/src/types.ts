/**
 * A graph template: a reusable graph plus the metadata that names it.
 *
 * A `builder` template turns a `TemplateContext` into a graph (the agent loop
 * can be parameterized by model, tools and prompt settings); a `static`
 * template is a graph loaded from data that is cloned on every build.
 *
 * @module @z1/template/types
 */

import type { GraphDocument } from '@z1/graph'
import type { ModelHandle, ToolSchema } from '@z1/node'

/** Everything a builder template may need; every field is optional. */
export interface TemplateContext {
  /** Model the graph's chat node should call. */
  model?: ModelHandle
  /** Tools declared to the model. */
  tools?: readonly ToolSchema[]
  /** Prompt role id, e.g. `coder`. */
  role?: string
  /** Iteration cap of the agent loop. */
  maxSteps?: number
  /** Extra instructions rendered as a custom prompt section. */
  system?: string
  /** Token ceiling of the prompt stack. */
  budgetTokens?: number
}

/** What `template list` and `registry.list()` expose; the graph stays hidden. */
export interface TemplateMeta {
  id: string
  version: string
  title: string
  description?: string
}

export interface GraphTemplate extends TemplateMeta {
  kind: 'builder' | 'static'
  /** Required for `builder` templates. */
  build?(context: TemplateContext): GraphDocument
  /** Required for `static` templates. */
  graph?: GraphDocument
}
