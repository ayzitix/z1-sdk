import { NodeRegistry, type NodeDefinition } from '@z1/node'
import {
  coreNodes,
  coreConcat,
  coreConst,
  coreGet,
  coreInput,
  coreLast,
  coreMerge,
  coreMessage,
  coreOutput,
  coreTemplate,
  coreValue,
} from './core.ts'
import { flowIf, flowLoop, flowMap, flowNodes } from './flow.ts'
import { graphNodes, graphSubgraph } from './graph.ts'
import { llmChat, llmModel, llmNodes } from './llm.ts'
import { memoryContext, memoryNodes } from './memory.ts'
import { promptContext, promptNodes, promptSection, promptStack, promptText } from './prompt.ts'
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
  ...memoryNodes,
  ...promptNodes,
  ...toolNodes,
]

export function createBuiltinRegistry(): NodeRegistry {
  const registry = new NodeRegistry()
  for (const definition of builtinNodes) registry.register(definition)
  return registry
}

export {
  coreNodes,
  coreConcat,
  coreConst,
  coreGet,
  coreInput,
  coreLast,
  coreMerge,
  coreMessage,
  coreOutput,
  coreTemplate,
  coreValue,
  flowNodes,
  flowIf,
  flowLoop,
  flowMap,
  graphNodes,
  graphSubgraph,
  llmNodes,
  llmChat,
  llmModel,
  memoryNodes,
  memoryContext,
  promptNodes,
  promptSection,
  promptStack,
  promptText,
  promptContext,
  toolNodes,
  toolCall,
}
