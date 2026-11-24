export const PACKAGE = '@z1/subagent'

export {
  DEFAULT_SUBAGENT_CONTEXT_WINDOW,
  DEFAULT_SUBAGENT_MAX_CHILDREN,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  DEFAULT_SUBAGENT_MAX_STEPS,
  DEFAULT_SUBAGENT_MAX_TOTAL,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_SUBAGENT_DESCRIPTION_LENGTH,
  MAX_SUBAGENT_PROMPT_BYTES,
  MAX_SUBAGENT_TOOL_ENTRIES,
  MAX_SUBAGENT_TOOL_NAME_LENGTH,
  SUBAGENT_HANDOFF_RATIO,
  SUBAGENT_TOOL_NAME,
  SubagentBudget,
  SubagentError,
  SubagentGrantError,
  subagentErrorTap,
} from './types.ts'
export type {
  RestrictToolServiceOptions,
  RunEventWithRunId,
  SubagentBackgroundResult,
  SubagentBudgetOptions,
  SubagentCallGuard,
  SubagentErrorCode,
  SubagentErrorTap,
  SubagentGrantErrorCode,
  SubagentGrantErrorDetails,
  SubagentHost,
  SubagentInput,
  SubagentInputLimits,
  SubagentInventory,
  SubagentLaunch,
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
  SubagentToolStatus,
  ToolGrant,
  ToolGrantContext,
  WithSubagentToolOptions,
} from './types.ts'
export { normalizeToolName, parseSubagentInput, resolveToolGrant } from './grant.ts'
export { SUBAGENT_WAIT_GUIDANCE, subagentSystemPrompt } from './prompt.ts'
export type { SubagentPromptOptions } from './prompt.ts'
export {
  MAX_SUBAGENT_RESULT_TEXT,
  SUBAGENT_LAUNCH_LINE,
  SUBAGENT_RESULT_PREAMBLE,
  assistantTexts,
  backgroundLaunchText,
  neutraliseChildText,
  partialText,
  resultText,
  statusLine,
  stepCapDetail,
  stepLimitSteps,
  toolStatus,
  truncateText,
} from './result.ts'
export type {
  SubagentLaunchTextInput,
  SubagentResultInput,
  SubagentResultSection,
  SubagentResultText,
} from './result.ts'
export {
  createSubagentTool,
  restrictToolService,
  subagentToolSchema,
  withSubagentTool,
} from './tool.ts'
export { denyApprovalService, runSubagent, subagentBudgetFor } from './run.ts'
