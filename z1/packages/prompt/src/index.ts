import { DEFAULT_ROLE, DEFAULT_SECTIONS, ROLE_SECTIONS, type RoleId } from './defaults.ts'
import { stackSections } from './stack.ts'
import type { PromptSection, PromptVars, StackOptions, StackResult } from './types.ts'

/**
 * Bumped whenever the default text or the stack semantics change, so a stored
 * prompt hash can be tied to the version that produced it.
 *
 * 8: `core.current_facts` and `core.loop` no longer command a tool the run may
 * not expose (`web.fetch`, `web.status`), the planner names a registered node
 * id instead of a "graph tool list" that does not exist, and the two read-only
 * roles say what to do if a write tool is in this turn's list.
 *
 * 7: the language rule became its own required `core.language` section, right
 * after the identity. It used to be the sixth bullet of `core.communication`,
 * where a small model ignored it in a long technical answer and replied in
 * English to a message in Russian.
 *
 * 6: `core.loop` requires every `subagent` launch to be announced in the same
 * step. A run suspended under 5 resumes into a different system prompt, which
 * is what the version exists to make visible.
 */
export const PROMPT_VERSION = '8'

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
