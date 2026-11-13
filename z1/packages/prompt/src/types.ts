/**
 * Slots are the coarse ordering axis of a prompt: everything in `core` precedes
 * everything in `role`, and so on. Within a slot only `priority` decides, so a
 * role delta never has to fight the core for position.
 */
export type SectionSlot = 'core' | 'role' | 'task' | 'context' | 'contract' | 'custom'

export interface PromptSection {
  /** Stable identity, e.g. `core.success` or `role.planner`. */
  id: string
  slot: SectionSlot
  /** Lower first inside a slot; ties break on id so ordering is deterministic. */
  priority: number
  /** A required section survives every budget cut. */
  required?: boolean
  body: string
}

export interface RenderedSection {
  id: string
  slot: SectionSlot
  tokens: number
  text: string
}

export interface StackResult {
  text: string
  hash: string
  tokens: number
  sections: RenderedSection[]
}

export interface StackOptions {
  /** Token ceiling for the whole stack. Defaults to 6000. */
  budgetTokens?: number
}

export type PromptVars = Record<string, unknown>
