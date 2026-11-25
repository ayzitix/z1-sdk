export const PACKAGE = '@z1/tool-creator'

export {
  TOOL_CREATOR_ERROR_CODES,
  ToolCreatorError,
  ToolCreatorUnavailableError,
  isToolCreatorErrorCode,
  toolCreatorErrorTap,
} from './errors.ts'
export type { ToolCreatorErrorCode, ToolCreatorErrorOptions, ToolCreatorErrorTap } from './errors.ts'
export {
  TOOL_SDK_ENV,
  TOOL_SDK_PACKAGE,
  createZ2qPort,
  loadToolCreatorPort,
} from './port.ts'
export type { LoadToolCreatorPortOptions, Z2qPortOptions } from './port.ts'
export {
  MAX_TOOL_CREATE_NAME_LENGTH,
  MAX_TOOL_CREATE_PURPOSE_LENGTH,
  TOOL_CREATE_NAME,
  TOOL_CREATOR_ENV,
  createToolCreatorService,
  toolCreateSchema,
  toolCreatorEnabled,
} from './service.ts'
export type { ToolCreatorLogLevel, ToolCreatorServiceOptions } from './service.ts'
export { toolInstallCommand, toolInstallNext } from './types.ts'
export type {
  ToolCreationRequest,
  ToolCreatorPort,
  ToolGenerate,
  ToolProposalRisk,
  ToolProposalRun,
  ToolProposalSummary,
} from './types.ts'
