/**
 * Template composition: the built-in agent loop plus every static template on
 * disk. Kept beside the runtime so the CLI can list templates without opening
 * a journal.
 *
 * @module @z1/bootstrap/templates
 */

import { registerAgentTemplates } from '@z1/agent'
import { TemplateRegistry, loadStaticTemplates } from '@z1/template'

import type { RuntimeConfig } from './config.ts'

/**
 * The builder templates that need no file I/O. A runtime starts with this and
 * only reads `templatesPath` when a caller asks for templates, so a malformed
 * file can never brick `z1 run <graph>`.
 */
export function createAgentTemplateRegistry(): TemplateRegistry {
  const registry = new TemplateRegistry()
  registerAgentTemplates(registry)
  return registry
}

/**
 * A registry with `agent.loop` already registered plus the static files under
 * `templatesPath`. Static files load in name order; a file that redefines a
 * built-in fails here rather than at run time, naming the file.
 */
export function createTemplateRegistry(config: RuntimeConfig): TemplateRegistry {
  const registry = createAgentTemplateRegistry()
  for (const template of loadStaticTemplates(config.templatesPath)) {
    registry.register(template)
  }
  return registry
}
