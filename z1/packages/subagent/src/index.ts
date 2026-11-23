export const PACKAGE = '@z1/subagent'

export {
  DEFAULT_SUBAGENT_MAX_CHILDREN,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  DEFAULT_SUBAGENT_MAX_STEPS,
  DEFAULT_SUBAGENT_MAX_TOTAL,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_SUBAGENT_DESCRIPTION_LENGTH,
  MAX_SUBAGENT_PROMPT_BYTES,
  MAX_SUBAGENT_TOOL_ENTRIES,
  MAX_SUBAGENT_TOOL_NAME_LENGTH,
  SUBAGENT_TOOL_NAME,
  SubagentBudget,
  SubagentError,
  SubagentGrantError,
} from './types.ts'
export type {
  RestrictToolServiceOptions,
  SubagentBudgetOptions,
  SubagentCallGuard,
  SubagentErrorCode,
  SubagentGrantErrorCode,
  SubagentGrantErrorDetails,
  SubagentHost,
  SubagentInput,
  SubagentInputLimits,
  SubagentInventory,
  SubagentReservation,
  SubagentRunHandle,
  SubagentRunOverrides,
  SubagentRunPatch,
  SubagentRunRecorder,
  SubagentRunRecord,
  SubagentRunRecordStatus,
  SubagentRunStatus,
  SubagentTool,
  SubagentToolOptions,
  SubagentToolResult,
  SubagentToolSelection,
  ToolGrant,
  ToolGrantContext,
  WithSubagentToolOptions,
} from './types.ts'
export { normalizeToolName, parseSubagentInput, resolveToolGrant } from './grant.ts'
export { subagentSystemPrompt } from './prompt.ts'
export type { SubagentPromptOptions } from './prompt.ts'
export {
  createSubagentTool,
  restrictToolService,
  subagentToolSchema,
  withSubagentTool,
} from './tool.ts'
export { denyApprovalService, runSubagent, subagentBudgetFor } from './run.ts'
