import { describe, expect, test } from 'vitest'

import { subagentSystemPrompt } from '../src/index.ts'

describe('subagentSystemPrompt', () => {
  test('states the exact grant and the fixed, closed scope', () => {
    const prompt = subagentSystemPrompt({ tools: ['read', 'web.search'] })

    expect(prompt).toContain('Your tools for this run are exactly: `read`, `web.search`.')
    expect(prompt).toContain('The grant is fixed for the whole run.')
    expect(prompt).toContain('Tools that are not listed do not exist for you')
    expect(prompt).toContain('cannot be enabled')
    expect(prompt).not.toContain('grep')
    expect(prompt).not.toContain('shell')
  })

  test('states the subagent relationship and the one-message contract', () => {
    const prompt = subagentSystemPrompt({ tools: ['read'] })

    expect(prompt).toContain('You are a subagent.')
    expect(prompt).toContain('Your final message is the only thing the parent sees.')
    expect(prompt).toContain('You cannot ask questions')
    expect(prompt).toContain('cannot delegate to another agent')
  })

  test('tells a blocked child to name the missing tool in its first sentence', () => {
    const prompt = subagentSystemPrompt({ tools: ['read'] })

    expect(prompt).toContain('say so in your first sentence')
    expect(prompt).toContain('name the missing tool')
    expect(prompt).toContain('Do not begin with exploration')
    expect(prompt).toContain('do not work around a missing tool')
  })

  test('has a no-tools variant instead of an empty list', () => {
    const prompt = subagentSystemPrompt({ tools: [] })

    expect(prompt).toContain('You have no tools for this run')
    expect(prompt).not.toContain('Your tools for this run are exactly:')
    expect(prompt).toContain('Tools that are not listed do not exist for you')
  })

  test('never mentions the CLI-only /tools command', () => {
    for (const tools of [[], ['read'], ['read', 'grep']]) {
      expect(subagentSystemPrompt({ tools })).not.toContain('/tools')
    }
  })

  test('explains `wait` so a child delegating later chooses the right mode', () => {
    const prompt = subagentSystemPrompt({ tools: ['read'] })

    expect(prompt).toContain('runs the child in the background by default')
    expect(prompt).toContain('wait: true')
    expect(prompt).toContain('only when you need the answer to continue')
  })

  test('is deterministic and lists only the exact grant', () => {
    const first = subagentSystemPrompt({ tools: ['read'] })
    const second = subagentSystemPrompt({ tools: ['read'] })
    const parentOnly = ['grep', 'shell', 'web.search', 'write']

    expect(first).toBe(second)
    expect(first).toContain('Your tools for this run are exactly: `read`.')
    for (const name of parentOnly) expect(first).not.toContain(name)
  })
})
