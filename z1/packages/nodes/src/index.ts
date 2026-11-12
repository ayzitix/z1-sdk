import { NodeRegistry, type NodeDefinition } from '@z1/node'
import { coreNodes, coreConst, coreInput, coreOutput, coreTemplate } from './core.ts'
import { flowIf, flowLoop, flowMap, flowNodes } from './flow.ts'
import { graphNodes, graphSubgraph } from './graph.ts'
import { llmChat, llmModel, llmNodes } from './llm.ts'
import { toolCall, toolNodes } from './tools.ts'

export const PACKAGE = '@z1/nodes'

/**
 * Every node defined in SPEC §7, in family order. The array is intentionally
 * `NodeDefinition[]`: the registry stores config-erased definitions, and the
 * executor resolves the concrete config type through each schema at run time.
 */
export const builtinNodes: readonly NodeDefinition[] = [
  ...coreNodes,
  ...flowNodes,
  ...graphNodes,
  ...llmNodes,
  ...toolNodes,
]

export function createBuiltinRegistry(): NodeRegistry {
  const registry = new NodeRegistry()
  for (const definition of builtinNodes) registry.register(definition)
  return registry
}

export {
  coreNodes,
  coreConst,
  coreInput,
  coreOutput,
  coreTemplate,
  flowNodes,
  flowIf,
  flowLoop,
  flowMap,
  graphNodes,
  graphSubgraph,
  llmNodes,
  llmChat,
  llmModel,
  toolNodes,
  toolCall,
}
