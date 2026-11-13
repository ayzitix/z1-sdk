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
  type InstalledModule,
  type ModuleNodeDeclaration,
  type ProposedModule,
} from '@z1/module'
import {
  APP_ERRORS,
  appFault,
  invalidParams,
  type ModuleNodeSummary,
  type ModuleSummary,
  type ProposalSummary,
} from '@z1/protocol'

function nodeSummary(declaration: ModuleNodeDeclaration): ModuleNodeSummary {
  return {
    id: declaration.id,
    title: declaration.title,
    category: declaration.category,
    inputs: declaration.inputs.length,
    outputs: declaration.outputs.length,
  }
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
