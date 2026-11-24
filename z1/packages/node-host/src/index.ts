export const PACKAGE = '@z1/node-host'

export type {
  ServiceCallOptions,
  StartedWorker,
  WorkerCapabilityDenial,
  WorkerExecutionHooks,
  WorkerHostOptions,
  WorkerHostServices,
  WorkerLogEvent,
  WorkerStreamEvent,
} from './host.ts'
export { ModuleWorker, bootstrapPackageRoot, resolveWorkerBootstrap } from './host.ts'
export { DEFAULT_SERVICE_CALL_TIMEOUT_MS } from './host.ts'
export {
  DEFAULT_PROCESS_TIMEOUT_MS,
  PROCESS_KILL_GRACE_MS,
  executionProcessOwner,
  installRunProcessExitReaper,
  killAllRunProcesses,
  killRunProcessesFor,
  liveRunProcessPids,
  liveRunProcessPidsFor,
  runProcess,
  serviceCallProcessOwner,
} from './process-run.ts'
export type { RunProcessOptions, RunProcessOwner } from './process-run.ts'
export { workerEnvironment } from './worker-env.ts'
export { DEFAULT_TASK_OUTPUT_CHARS, ProcessTaskError, ProcessTasks } from './process-tasks.ts'
export {
  cloneRegistry,
  declarationRegistry,
  stubNodeDefinition,
} from './declarations.ts'
export type { ModuleRuntimeOptions, ModuleWorkerService } from './runtime.ts'
export { ModuleRuntime } from './runtime.ts'
export type {
  ModuleServiceContext,
  ModuleServiceEntrypoints,
  ModuleServiceEnvironment,
  ModuleServiceFactory,
  ModuleServiceLog,
  ModuleServiceLogLevel,
  StartedModuleServices,
} from './services.ts'
export { ModuleServiceRuntime, StartedServiceRegistry } from './services.ts'
export type {
  BackgroundTaskPollRequest,
  BackgroundTaskSnapshot,
  BackgroundTaskStartRequest,
  BackgroundTaskStatus,
  FsListEntry,
  FsListResult,
  FsStatResult,
  ProcessRunRequest,
  ProcessRunResult,
  WorkerNodeInfo,
  WorkerServiceInfo,
} from './protocol.ts'
export {
  workerArtifactService,
  workerFsService,
  workerLlmService,
  workerMemoryService,
  workerToolService,
} from './adapters.ts'
export {
  asJsonOutputs,
  declaredPortToPortSpec,
  moduleCapabilities,
  moduleNodeDefinition,
} from './adapter.ts'
export type { ModuleWorkerSource } from './adapter.ts'
