/**
 * Registry projections over installed module declarations.
 *
 * The server and the composition root both need a registry that names every
 * node an active module declares, without starting a worker. These stubs make
 * `node.list`/`graph.validate` answer correctly; a real run replaces them with
 * worker-backed definitions.
 *
 * @module @z1/node-host/declarations
 */

import type { ModuleNodeDeclaration, ModuleStore } from '@z1/module'
import { NodeRegistry, type NodeDefinition } from '@z1/node'
import { z } from 'zod'

import { declaredPortToPortSpec } from './adapter.ts'

/** A fresh registry holding the same definitions; used as a per-run base. */
export function cloneRegistry(source: NodeRegistry): NodeRegistry {
  const registry = new NodeRegistry()
  for (const definition of source.list()) registry.register(definition)
  return registry
}

/** A declared node that cannot execute until a `ModuleRuntime` replaces it. */
export function stubNodeDefinition(declaration: ModuleNodeDeclaration): NodeDefinition {
  return {
    id: declaration.id,
    version: declaration.version,
    title: declaration.title,
    category: declaration.category,
    config: z.unknown(),
    // Declarations carry no executable schema, so nothing is inserted beyond an
    // empty object: the module panel edits config as raw JSON.
    defaultConfig: {},
    inputs: declaration.inputs.map(declaredPortToPortSpec),
    outputs: declaration.outputs.map(declaredPortToPortSpec),
    cacheable: false,
    execute: async () => {
      throw new Error('module is not loaded')
    },
  }
}

/**
 * Built-ins plus one stub per node declared by an active installed module.
 * Recomputed on every call so an approval or rollback is visible immediately.
 */
export function declarationRegistry(base: NodeRegistry, store: ModuleStore): NodeRegistry {
  const registry = cloneRegistry(base)
  for (const installed of store.list()) {
    if (!installed.active) continue
    for (const declaration of installed.manifest.nodes) {
      // A built-in always wins: a module cannot shadow a core node.
      if (registry.has(declaration.id, declaration.version)) continue
      registry.register(stubNodeDefinition(declaration))
    }
  }
  return registry
}
