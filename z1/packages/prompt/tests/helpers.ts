import type { PromptSection, SectionSlot } from '../src/index.ts'

export function section(
  id: string,
  slot: SectionSlot,
  priority: number,
  body: string,
  required = false,
): PromptSection {
  return { id, slot, priority, required, body }
}
