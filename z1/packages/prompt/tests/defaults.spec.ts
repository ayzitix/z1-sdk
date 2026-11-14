import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  buildPrompt,
  DEFAULT_SECTIONS,
  PROMPT_VERSION,
  ROLE_SECTIONS,
  type PromptSection,
  type RoleId,
} from '../src/index.ts'
import { section } from './helpers.ts'

const ROLES: readonly RoleId[] = ['planner', 'coder', 'reviewer', 'summarizer', 'judge', 'router']

const CORE_HEADINGS = [
  '## Success',
  '## Safety',
  '## Working context',
  '## Autonomy',
  '## Doing tasks',
  '## Editing',
  '## Failure',
  '## Memory',
  '## Writing for the user',
  '## Output',
]

const snapshot = readFileSync(new URL('./__snapshots__/default.txt', import.meta.url), 'utf8')

describe('DEFAULT_SECTIONS', () => {
  test('is core identity plus the approved headings, all required', () => {
    expect(DEFAULT_SECTIONS).toHaveLength(11)
    expect(DEFAULT_SECTIONS.every((entry) => entry.slot === 'core' && entry.required)).toBe(true)
    expect(DEFAULT_SECTIONS.map((entry) => entry.id)).toEqual([
      'core.identity',
      'core.success',
      'core.non_negotiables',
      'core.graph',
      'core.autonomy',
      'core.loop',
      'core.editing',
      'core.failure',
      'core.memory',
      'core.communication',
      'core.output',
    ])
    expect(DEFAULT_SECTIONS.map((entry) => entry.priority)).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
    ])
  })

  test('renders the core headings in order', () => {
    const { text } = buildPrompt({ role: 'coder' })
    expect(text.startsWith('You are z1')).toBe(true)

    const positions = CORE_HEADINGS.map((heading) => text.indexOf(heading))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test('does not describe the machinery or recite permissions', () => {
    const { text } = buildPrompt({ role: 'coder' })
    expect(text).not.toContain('one node in a typed graph')
    expect(text).not.toContain('Graph contract')
    expect(text).not.toContain('Non-negotiables')
    expect(text).toContain('In user-facing prose, do not describe z1 internals')
    expect(text).toContain('machine-consumed output')
    expect(text).toContain('Do not list what you refuse to do')
    expect(text).toContain('Do not introduce yourself with a role description')
    expect(text).toContain("Reply in the user's language")
  })

  test('leaves no unresolved placeholder for the default vars', () => {
    const { text } = buildPrompt({ role: 'coder' })
    expect(text).not.toMatch(/\{\{\s*[A-Za-z0-9_$.-]+\s*\}\}/)
  })

  test('substitutes placeholders in appended sections from vars', () => {
    const extra = section('context.env', 'context', 0, 'policy: {{policy}}, port: {{port}}')
    const { text } = buildPrompt({ vars: { policy: 'ask', port: 'out' }, sections: [extra] })
    expect(text).toContain('policy: ask, port: out')
  })
})

describe('ROLE_SECTIONS', () => {
  test.each(ROLES)('%s is a role section at priority 0', (role) => {
    const delta = ROLE_SECTIONS[role]
    expect(delta.id).toBe(`role.${role}`)
    expect(delta.slot).toBe('role')
    expect(delta.priority).toBe(0)
    expect(delta.body.trim().length).toBeGreaterThan(0)
  })

  test.each(ROLES)('buildPrompt places the %s delta after the core', (role) => {
    const result = buildPrompt({ role })
    const index = result.sections.findIndex((entry) => entry.id === `role.${role}`)
    const lastCore = result.sections.map((entry) => entry.slot).lastIndexOf('core')

    expect(index).toBeGreaterThan(lastCore)
    expect(result.sections.filter((entry) => entry.slot === 'role')).toHaveLength(1)
  })

  test('planner is a JSON plan with status and nodeType, no edits', () => {
    const body = ROLE_SECTIONS.planner.body
    expect(body).toContain('nodeType')
    expect(body).toContain('status')
    expect(body).toContain('no write tools')
  })

  test('reviewer reports a verdict and proposes no fixes', () => {
    const body = ROLE_SECTIONS.reviewer.body
    expect(body).toContain('verdict')
    expect(body).toContain('evidence')
    expect(body.toLowerCase()).not.toContain('patch')
  })

  test('role deltas stay short, with a two-line coder note', () => {
    const words = (entry: PromptSection): number => entry.body.trim().split(/\s+/).length
    for (const role of ROLES.filter((name) => name !== 'coder')) {
      expect(words(ROLE_SECTIONS[role])).toBeGreaterThanOrEqual(150)
      expect(words(ROLE_SECTIONS[role])).toBeLessThanOrEqual(250)
    }
    expect(words(ROLE_SECTIONS.coder)).toBeLessThanOrEqual(30)
  })
})

describe('buildPrompt', () => {
  test('defaults to the coder role', () => {
    const result = buildPrompt()
    expect(result.sections.some((entry) => entry.id === 'role.coder')).toBe(true)
  })

  test('appends extra sections and resolves id collisions by prompt order', () => {
    const extra = section('task.current', 'task', 0, 'Implement T32')
    // Reusing a core id at a lower priority deliberately replaces the default.
    const override = section('core.success', 'core', 0, 'overridden')
    const result = buildPrompt({ role: 'planner', sections: [extra, override] })

    expect(result.sections.some((entry) => entry.id === 'task.current')).toBe(true)
    expect(result.text).toContain('Implement T32')
    expect(result.text).toContain('overridden')
    expect(result.text).not.toContain('Success means the requested outcome')
    expect(result.sections.filter((entry) => entry.id === 'core.success')).toHaveLength(1)
  })

  test('drops an appended duplicate that sorts after the default', () => {
    const duplicate = section('core.success', 'core', 10, 'duplicate body')
    const result = buildPrompt({ sections: [duplicate] })

    expect(result.text).not.toContain('duplicate body')
    expect(result.text).toContain('Success means the requested outcome')
  })

  test('is deterministic and reports a stable version', () => {
    const one = buildPrompt({ role: 'reviewer' })
    const two = buildPrompt({ role: 'reviewer' })
    expect(one.hash).toBe(two.hash)
    expect(one.text).toBe(two.text)
    expect(PROMPT_VERSION).toBe('2')
  })

  test('matches the committed default snapshot', () => {
    expect(buildPrompt().text).toBe(snapshot)
  })
})
