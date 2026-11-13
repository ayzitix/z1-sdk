/**
 * Module-store projections for the protocol.
 *
 * The server never imports module code itself: `module.list` is derived from
 * manifests, and `node.list`/`graph.validate` use inert stub definitions. A
 * real `ModuleRuntime` is only started for a run that needs it.
 *
 * @module @z1/server/modules
 */

import {
  ModuleStoreError,
  type DeclaredPort,
  type InstalledModule,
  type ModuleNodeDeclaration,
  type ModuleStore,
  type ProposedModule,
} from '@z1/module'
import { NodeRegistry, type NodeDefinition, type PortSpec } from '@z1/node'
import {
  APP_ERRORS,
  appFault,
  invalidParams,
  type ModuleNodeSummary,
  type ModuleSummary,
  type ProposalSummary,
} from '@z1/protocol'
import { z } from 'zod'

function declaredPort(port: DeclaredPort): PortSpec {
  if (port.kind === 'flow') {
    return {
      kind: 'flow',
      id: port.id,
      ...(port.title === undefined ? {} : { title: port.title }),
      ...(port.description === undefined ? {} : { description: port.description }),
    }
  }
  return {
    kind: 'data',
    id: port.id,
    // The manifest's JSON Schema is documentation only; the runtime re-validates
    // whatever the worker returns, so a stub keeps the port unconstrained.
    schema: z.unknown(),
    ...(port.title === undefined ? {} : { title: port.title }),
    ...(port.description === undefined ? {} : { description: port.description }),
    ...(port.required === undefined ? {} : { required: port.required }),
    ...(port.mode === undefined ? {} : { mode: port.mode }),
  }
}

function nodeSummary(declaration: ModuleNodeDeclaration): ModuleNodeSummary {
  return {
    id: declaration.id,
    title: declaration.title,
    category: declaration.category,
    inputs: declaration.inputs.length,
    outputs: declaration.outputs.length,
  }
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
    inputs: declaration.inputs.map(declaredPort),
    outputs: declaration.outputs.map(declaredPort),
    cacheable: false,
    execute: async () => {
      throw new Error('module is not loaded')
    },
  }
}

/** A fresh registry holding the same definitions; used as a per-run base. */
export function cloneRegistry(source: NodeRegistry): NodeRegistry {
  const registry = new NodeRegistry()
  for (const definition of source.list()) registry.register(definition)
  return registry
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

export function moduleSummary(installed: InstalledModule): ModuleSummary {
  const { manifest } = installed
  return {
    moduleId: manifest.id,
    version: manifest.version,
    title: manifest.title,
    integrity: installed.integrity,
    active: installed.active,
    capabilities: manifest.capabilities ?? {},
    nodes: manifest.nodes.map(nodeSummary),
  }
}

export function proposalSummary(proposed: ProposedModule): ProposalSummary {
  const { manifest } = proposed
  return {
    moduleId: manifest.id,
    version: manifest.version,
    title: manifest.title,
    integrity: proposed.integrity,
    capabilities: manifest.capabilities ?? {},
    directory: proposed.directory,
  }
}

/**
 * Turn a store failure into a protocol fault: an integrity conflict is a
 * conflict, everything else (unknown proposal, not installed, bad directory) is
 * an invalid-params error carrying the store's own explanation.
 */
export function moduleFault(error: unknown): unknown {
  if (!(error instanceof ModuleStoreError)) return error
  if (error.code === 'integrity-conflict') {
    return appFault(APP_ERRORS.conflict, error.message)
  }
  return invalidParams(error.message)
}
