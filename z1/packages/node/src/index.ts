import type { NodeDefinition } from './types.ts'

/**
 * Identity helper. It exists purely so a node literal infers its config type and
 * gets checked against {@link NodeDefinition} at the definition site.
 */
export function defineNode<C>(definition: NodeDefinition<C>): NodeDefinition<C> {
  return definition
}

export * from './types.ts'
export * from './memory.ts'
export * from './registry.ts'
export * from './schema.ts'
