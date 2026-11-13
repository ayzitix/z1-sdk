export const PACKAGE = '@z1/node-host'

export type {
  WorkerCapabilityDenial,
  WorkerExecutionHooks,
  WorkerHostOptions,
  WorkerHostServices,
  WorkerLogEvent,
  WorkerStreamEvent,
} from './host.ts'
export { ModuleWorker } from './host.ts'
export type { ModuleRuntimeOptions } from './runtime.ts'
export { ModuleRuntime } from './runtime.ts'
export type { WorkerNodeInfo } from './protocol.ts'
export { asJsonOutputs, declaredPortToPortSpec, moduleCapabilities, moduleNodeDefinition } from './adapter.ts'
