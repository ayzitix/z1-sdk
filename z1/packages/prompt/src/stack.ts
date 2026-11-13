import { sha256Hex } from './sha256.ts'
import { renderTemplate } from './template.ts'
import type {
  PromptSection,
  PromptVars,
  RenderedSection,
  SectionSlot,
  StackOptions,
  StackResult,
} from './types.ts'

/** Default stack budget; large enough for the core plus one role delta. */
export const DEFAULT_BUDGET_TOKENS = 6000

/** Roughly four characters per token; good enough to size a prompt budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const SLOT_ORDER: readonly SectionSlot[] = [
  'core',
  'role',
  'task',
  'context',
  'contract',
  'custom',
]

const SLOT_RANK: ReadonlyMap<SectionSlot, number> = new Map(
  SLOT_ORDER.map((slot, index) => [slot, index]),
)

function rank(slot: SectionSlot): number {
  return SLOT_RANK.get(slot) ?? SLOT_ORDER.length
}

/** Plain code-point comparison keeps ordering locale-independent. */
function compareIds(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Slot first, then priority, then id: the documented prompt order. */
function compareSections(a: PromptSection, b: PromptSection): number {
  return rank(a.slot) - rank(b.slot) || a.priority - b.priority || compareIds(a.id, b.id)
}

/**
 * A section kept through rendering, including the fields the hash covers but
 * the public `RenderedSection` deliberately hides.
 */
interface StackedSection {
  id: string
  slot: SectionSlot
  priority: number
  required: boolean
  tokens: number
  text: string
}

/** Content hash of one section definition, independent of any vars. */
export function sectionHash(section: PromptSection): string {
  return sha256Hex(
    JSON.stringify({
      id: section.id,
      slot: section.slot,
      priority: section.priority,
      required: section.required === true,
      body: section.body,
    }),
  )
}

/**
 * Hash of the ordered, rendered stack. The key order below is the canonical
 * form: any change to ids, slots, priorities, required flags or text moves the
 * hash, and reordering the input does not.
 */
function hashStack(sections: readonly StackedSection[]): string {
  const canonical = sections.map((section) => ({
    id: section.id,
    slot: section.slot,
    priority: section.priority,
    required: section.required,
    text: section.text,
  }))
  return sha256Hex(JSON.stringify(canonical))
}

function resolveBudget(options: StackOptions | undefined): number {
  const requested = options?.budgetTokens
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_BUDGET_TOKENS
  return Math.max(0, Math.floor(requested))
}

/**
 * Drops optional sections, least valuable first: lowest priority, then latest
 * slot, then latest id. Required sections are never candidates, so a stack made
 * only of required sections can legitimately exceed its budget.
 */
function applyBudget(sections: readonly StackedSection[], budget: number): StackedSection[] {
  let total = sections.reduce((sum, section) => sum + section.tokens, 0)
  if (total <= budget) return [...sections]

  const droppable = sections
    .filter((section) => !section.required)
    .sort(
      (a, b) =>
        b.priority - a.priority || rank(b.slot) - rank(a.slot) || compareIds(b.id, a.id),
    )

  const dropped = new Set<string>()
  for (const section of droppable) {
    if (total <= budget) break
    dropped.add(section.id)
    total -= section.tokens
  }
  return sections.filter((section) => !dropped.has(section.id))
}

/**
 * Renders the sections into one system prompt. A section with pre-rendered
 * `text` is emitted exactly as given and is never rendered again; otherwise
 * only placeholders in `body` are substituted. A section whose effective text
 * is whitespace-only disappears before hashing and budgeting.
 */
export function stackSections(
  sections: readonly PromptSection[],
  vars: PromptVars,
  options?: StackOptions,
): StackResult {
  const ordered = [...sections].sort(compareSections)

  // A role delta and a caller override may share an id; the first in prompt
  // order wins so resolution stays deterministic.
  const seen = new Set<string>()
  const stacked: StackedSection[] = []
  for (const section of ordered) {
    if (seen.has(section.id)) continue
    seen.add(section.id)
    const text = section.text ?? renderTemplate(section.body, vars)
    if (text.trim() === '') continue
    stacked.push({
      id: section.id,
      slot: section.slot,
      priority: section.priority,
      required: section.required === true,
      tokens: estimateTokens(text),
      text,
    })
  }

  const kept = applyBudget(stacked, resolveBudget(options))
  const rendered: RenderedSection[] = kept.map((section) => ({
    id: section.id,
    slot: section.slot,
    tokens: section.tokens,
    text: section.text,
  }))

  return {
    text: rendered.map((section) => section.text).join('\n\n'),
    hash: hashStack(kept),
    tokens: rendered.reduce((sum, section) => sum + section.tokens, 0),
    sections: rendered,
  }
}
