import { describe, expect, test } from 'vitest'

import {
  DEFAULT_SUBAGENT_CONTEXT_WINDOW,
  SUBAGENT_HANDOFF_RATIO,
} from '../src/types.ts'
import { SUBAGENT_HANDOFF_REQUEST } from '../src/prompt.ts'

/**
 * The context hand-off: a child stops at 75% of its window and reports.
 *
 * The requirement, in the user's words: when 75% of the context is used the
 * limit ends the work, and the child says what is done, what is not, what it
 * did, and how to continue.
 *
 * The failure this prevents: a child that fills its window is cut off by the
 * provider with an error it cannot describe, and the parent gets `failed` with
 * nothing in it - the work is lost and the user learns nothing. Stopping early
 * costs the next action, never the report.
 */
describe('the context hand-off', () => {
  test('stops at three quarters of the window', () => {
    expect(SUBAGENT_HANDOFF_RATIO).toBe(0.75)
    // A quarter of the window must survive the threshold: it is what the report
    // and the parent's next turn are written into.
    expect((1 - SUBAGENT_HANDOFF_RATIO) * DEFAULT_SUBAGENT_CONTEXT_WINDOW).toBeGreaterThanOrEqual(16_000)
  })

  test('defaults to the window the CLI itself assumes', () => {
    expect(DEFAULT_SUBAGENT_CONTEXT_WINDOW).toBe(128_000)
  })

  test('asks for the four things a reader needs', () => {
    const text = SUBAGENT_HANDOFF_REQUEST
    expect(text).toMatch(/Done/)
    expect(text).toMatch(/Not done/)
    expect(text).toMatch(/Continue/)
    expect(text).toMatch(/Open questions/)
  })

  test('says the tools are gone, so the last turn is not spent asking for one', () => {
    expect(SUBAGENT_HANDOFF_REQUEST).toMatch(/tools are gone/i)
    expect(SUBAGENT_HANDOFF_REQUEST).toMatch(/Do not ask for them/i)
  })

  test('lets a child that actually finished answer normally', () => {
    expect(SUBAGENT_HANDOFF_REQUEST).toMatch(/If you finished the task/)
  })

  test('stays small: it is appended to an already-full transcript', () => {
    expect(SUBAGENT_HANDOFF_REQUEST.length).toBeLessThan(1_200)
  })

  test('never becomes the parent-facing result block', () => {
    expect(SUBAGENT_HANDOFF_REQUEST).not.toContain('Subagent output')
    expect(SUBAGENT_HANDOFF_REQUEST).not.toContain('delivered:')
  })
})
