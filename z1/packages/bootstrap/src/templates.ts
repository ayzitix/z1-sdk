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
 * A registry with `agent.loop` already registered. Static files load in name
 * order; a file that redefines a built-in fails here rather than at run time.
 */
export function createTemplateRegistry(config: RuntimeConfig): TemplateRegistry {
  const registry = new TemplateRegistry()
  registerAgentTemplates(registry)
  for (const template of loadStaticTemplates(config.templatesPath)) {
    registry.register(template)
  }
  return registry
}
