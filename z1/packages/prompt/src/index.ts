import { DEFAULT_ROLE, DEFAULT_SECTIONS, ROLE_SECTIONS, type RoleId } from './defaults.ts'
import { stackSections } from './stack.ts'
import type { PromptSection, PromptVars, StackOptions, StackResult } from './types.ts'

/**
 * Bumped whenever the default text or the stack semantics change, so a stored
 * prompt hash can be tied to the version that produced it.
 */
export const PROMPT_VERSION = '2'

export interface BuildPromptOptions {
  /** Role delta appended after the core. Defaults to `coder`. */
  role?: RoleId
  /** Extra sections, appended after the role delta. */
  sections?: readonly PromptSection[]
  vars?: PromptVars
  budgetTokens?: number
}

/**
 * Assembles the default prompt for one role. Extra sections are appended, not
 * merged: id collisions resolve through `stackSections`'s first-in-order rule.
 */
export function buildPrompt(options: BuildPromptOptions = {}): StackResult {
  const role = options.role ?? DEFAULT_ROLE
  const sections = [...DEFAULT_SECTIONS, ROLE_SECTIONS[role], ...(options.sections ?? [])]
  const budgetTokens = options.budgetTokens
  const stackOptions: StackOptions = budgetTokens === undefined ? {} : { budgetTokens }
  return stackSections(sections, options.vars ?? {}, stackOptions)
}

export { DEFAULT_BUDGET_TOKENS, sectionHash, stackSections, estimateTokens } from './stack.ts'
export { DEFAULT_ROLE, DEFAULT_SECTIONS, ROLE_SECTIONS } from './defaults.ts'
export type { RoleId } from './defaults.ts'
export { renderTemplate } from './template.ts'
export type {
  PromptSection,
  PromptVars,
  RenderedSection,
  SectionSlot,
  StackOptions,
  StackResult,
} from './types.ts'
