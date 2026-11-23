import { describe, expect, test } from 'vitest'

import {
  MAX_SUBAGENT_PROMPT_BYTES,
  MAX_SUBAGENT_TOOL_ENTRIES,
  MAX_SUBAGENT_TOOL_NAME_LENGTH,
  SubagentGrantError,
  normalizeToolName,
  parseSubagentInput,
  resolveToolGrant,
  type SubagentGrantErrorCode,
  type SubagentInventory,
} from '../src/index.ts'
import { schema } from './fakes.ts'

const inventory: SubagentInventory = {
  installed: [
    schema('read'),
    schema('grep'),
    schema('shell'),
    schema('web.search'),
    schema('subagent'),
  ],
  enabled: [schema('read'), schema('grep'), schema('web.search'), schema('subagent')],
}

function expectGrantError(
  action: () => unknown,
  code: SubagentGrantErrorCode,
): SubagentGrantError {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SubagentGrantError)
  const error = caught as SubagentGrantError
  expect(error.code).toBe(code)
  return error
}

describe('resolveToolGrant', () => {
  test('selects exact names and returns them in parent list order', () => {
    const grant = resolveToolGrant(
      { enable: ['web.search', 'read'] },
      { inventory },
    )

    expect(grant.names).toEqual(['read', 'web.search'])
    expect(grant.requested).toEqual(['read', 'web.search'])
    expect(grant.denied).toEqual([])
  })

  test('does not inherit tools that were not enabled explicitly', () => {
    const grant = resolveToolGrant({ enable: ['grep'] }, { inventory })

    expect(grant.names).toEqual(['grep'])
    expect(grant.names).not.toContain('read')
    expect(grant.names).not.toContain('web.search')
  })

  test('disable wins and the overlap is reported', () => {
    const grant = resolveToolGrant(
      { enable: ['read', 'grep'], disable: ['grep', 'read'] },
      { inventory },
    )

    expect(grant.names).toEqual([])
    expect(grant.denied).toEqual(['read', 'grep'])
  })

  test('a valid disable name that was not requested is a no-op', () => {
    const grant = resolveToolGrant(
      { enable: ['read'], disable: ['grep'] },
      { inventory },
    )

    expect(grant.names).toEqual(['read'])
    expect(grant.denied).toEqual([])
  })

  test('enable: [] is valid and grants no tools', () => {
    const grant = resolveToolGrant({ enable: [] }, { inventory })

    expect(grant).toEqual({ requested: [], names: [], denied: [] })
  })

  test('"*" expands to the parent effective set and skips the subagent tool', () => {
    const grant = resolveToolGrant({ enable: ['*'] }, { inventory })

    expect(grant.requested).toEqual(['read', 'grep', 'web.search'])
    expect(grant.names).toEqual(['read', 'grep', 'web.search'])
    expect(grant.names).not.toContain('subagent')
  })

  test('"*" mixed with another entry is rejected', () => {
    const error = expectGrantError(
      () => resolveToolGrant({ enable: ['*', 'read'] }, { inventory }),
      'invalid_pattern',
    )

    expect(error.message).toContain('"*" must be the only entry')
  })

  test('disable: ["*"] is invalid', () => {
    const error = expectGrantError(
      () => resolveToolGrant({ enable: ['read'], disable: ['*'] }, { inventory }),
      'invalid_pattern',
    )

    expect(error.message).toContain('"*" is not a valid tool name')
  })

  test('an unknown enable name names the missing tool', () => {
    const error = expectGrantError(
      () => resolveToolGrant({ enable: ['readd'] }, { inventory }),
      'unknown_tool',
    )

    expect(error.message).toBe('subagent unknown_tool: no installed tool named "readd"')
    expect(error.requested).toEqual(['readd'])
  })

  test('installed but disabled is a distinct error', () => {
    const error = expectGrantError(
      () => resolveToolGrant({ enable: ['shell'] }, { inventory }),
      'disabled_tool',
    )

    expect(error.message).toContain('installed but not enabled for the parent')
    expect(error.message).not.toContain('no installed tool')
  })

  test('a typo in disable is an error, never a silent no-op', () => {
    const error = expectGrantError(
      () => resolveToolGrant({ enable: ['read'], disable: ['reed'] }, { inventory }),
      'unknown_tool',
    )

    expect(error.message).toContain('no installed tool named "reed"')
    expect(error.requested).toEqual(['read'])
  })

  test('a disabled tool in disable is an error too', () => {
    expectGrantError(
      () => resolveToolGrant({ enable: ['read'], disable: ['shell'] }, { inventory }),
      'disabled_tool',
    )
  })

  test('a name in both enable and disable is denied, not an error', () => {
    const grant = resolveToolGrant(
      { enable: ['read', 'grep'], disable: ['read'] },
      { inventory },
    )

    expect(grant.names).toEqual(['grep'])
    expect(grant.denied).toEqual(['read'])
  })

  test('a list may contain at most 64 entries', () => {
    const names = Array.from({ length: 65 }, (_, index) => `tool${String(index)}`)

    expectGrantError(
      () => resolveToolGrant({ enable: names }, { inventory }),
      'too_many_tools',
    )
    expectGrantError(
      () => resolveToolGrant({ enable: [], disable: names }, { inventory }),
      'too_many_tools',
    )
  })

  test('tool names are trimmed, exact and validated', () => {
    expect(
      resolveToolGrant({ enable: [' read ', 'grep'] }, { inventory }).names,
    ).toEqual(['read', 'grep'])

    for (const name of ['', 'bad name', 'web.*', 'read\nx', 'read`x']) {
      expectGrantError(
        () => resolveToolGrant({ enable: [name] }, { inventory }),
        'invalid_name',
      )
    }

    // The grammar is intentionally permissive for module-defined exact names.
    expect(normalizeToolName('@scope/tool', 'test')).toBe('@scope/tool')
    expect(normalizeToolName('-read', 'test')).toBe('-read')
    expect(normalizeToolName('foo+bar', 'test')).toBe('foo+bar')

    expectGrantError(
      () =>
        resolveToolGrant(
          { enable: [`r${'x'.repeat(MAX_SUBAGENT_TOOL_NAME_LENGTH)}`] },
          { inventory },
        ),
      'invalid_name',
    )
    expectGrantError(
      () => resolveToolGrant({ enable: [42] }, { inventory }),
      'invalid_name',
    )
  })

  test('explicitly granting the delegation tool is rejected unconditionally', () => {
    const error = expectGrantError(
      () => resolveToolGrant({ enable: ['subagent'] }, { inventory }),
      'depth_exceeded',
    )

    expect(error.message).toContain('cannot grant the delegation tool "subagent"')
    expect(error.message).toContain('nested subagents are disabled in v1')
  })

  test('a legacy maxDepth above 1 is clamped and cannot permit the subagent tool', () => {
    const error = expectGrantError(
      () =>
        resolveToolGrant(
          { enable: ['subagent'] },
          { inventory, depth: 0, maxDepth: 2 },
        ),
      'depth_exceeded',
    )

    expect(error.message).toContain('maxDepth 1')
    expect(error.message).toContain('nested subagents are disabled in v1')
  })

  test('"*" omits the delegation tool even with a legacy maxDepth above 1', () => {
    const grant = resolveToolGrant(
      { enable: ['*'] },
      { inventory, depth: 0, maxDepth: 2 },
    )

    expect(grant.names).toEqual(['read', 'grep', 'web.search'])
    expect(grant.names).not.toContain('subagent')
  })

  test('granting the delegation tool at depth 1 is rejected even with maxDepth 2', () => {
    expectGrantError(
      () =>
        resolveToolGrant(
          { enable: ['subagent'] },
          { inventory, depth: 1, maxDepth: 2 },
        ),
      'depth_exceeded',
    )
  })

  test('duplicate installed or ceiling names fail closed', () => {
    expectGrantError(
      () =>
        resolveToolGrant(
          { enable: [] },
          {
            inventory: {
              installed: [schema('read'), schema('read')],
              enabled: [schema('read')],
            },
          },
        ),
      'duplicate_tool',
    )
    expectGrantError(
      () =>
        resolveToolGrant(
          { enable: [] },
          {
            inventory: {
              installed: [schema('read')],
              enabled: [schema('read'), schema('read')],
            },
          },
        ),
      'duplicate_tool',
    )
    expectGrantError(
      () =>
        resolveToolGrant(
          { enable: [] },
          {
            inventory: {
              installed: [schema('read')],
              enabled: [schema('grep')],
            },
          },
        ),
      'invalid_tools',
    )
  })

  test('the selection record rejects unknown and missing fields', () => {
    expectGrantError(
      () => resolveToolGrant({ enable: [], extra: [] }, { inventory }),
      'invalid_tools',
    )
    expectGrantError(
      () => resolveToolGrant({ disable: [] }, { inventory }),
      'invalid_tools',
    )
    expectGrantError(() => resolveToolGrant({ enable: 'read' }, { inventory }), 'invalid_tools')
  })
})

describe('parseSubagentInput', () => {
  const valid = {
    description: 'check the parser',
    prompt: 'read one file and report',
    tools: { enable: ['read'] },
  }

  test('accepts the documented shape and preserves disable', () => {
    const parsed = parseSubagentInput({
      ...valid,
      tools: { enable: ['read', 'grep'], disable: ['grep'] },
    })

    expect(parsed).toEqual({
      description: valid.description,
      prompt: valid.prompt,
      tools: { enable: ['read', 'grep'], disable: ['grep'] },
    })
  })

  test('rejects an invalid description', () => {
    expect(() => parseSubagentInput({ ...valid, description: '' })).toThrow(/must not be empty/)
    expect(() =>
      parseSubagentInput({ ...valid, description: 'd'.repeat(121) }),
    ).toThrow(/longer than 120/)
    expect(() => parseSubagentInput({ ...valid, description: 1 })).toThrow(/must be a string/)
  })

  test('caps the prompt in UTF-8 bytes', () => {
    expect(() =>
      parseSubagentInput({
        ...valid,
        prompt: 'p'.repeat(MAX_SUBAGENT_PROMPT_BYTES + 1),
      }),
    ).toThrow(/limit is 65536/)

    expect(
      parseSubagentInput({
        ...valid,
        prompt: 'p'.repeat(MAX_SUBAGENT_PROMPT_BYTES),
      }).prompt,
    ).toHaveLength(MAX_SUBAGENT_PROMPT_BYTES)

    // A multi-byte prompt hits the byte cap before the character count does.
    expect(() =>
      parseSubagentInput({
        ...valid,
        prompt: 'é'.repeat(MAX_SUBAGENT_PROMPT_BYTES / 2 + 1),
      }),
    ).toThrow(/limit is 65536/)
  })

  test('rejects missing, unknown and mistyped structure', () => {
    expect(() => parseSubagentInput(null)).toThrow(/must be an object/)
    expect(() => parseSubagentInput({ ...valid, extra: true })).toThrow(/unknown property/)
    expect(() =>
      parseSubagentInput({ description: 'd', prompt: 'p' }),
    ).toThrow(/tools must be an object/)
    expect(() =>
      parseSubagentInput({ ...valid, tools: { enable: ['read'], extra: [] } }),
    ).toThrow(/unknown property/)
    expect(() =>
      parseSubagentInput({ ...valid, tools: { enable: 'read' } }),
    ).toThrow(/enable must be an array/)
    expect(() =>
      parseSubagentInput({ ...valid, tools: { enable: [], disable: 'read' } }),
    ).toThrow(/disable must be an array/)
    expect(() =>
      parseSubagentInput({ ...valid, tools: { enable: [1] } }),
    ).toThrow(/entries must be strings/)
  })

  test('rejects an empty or missing prompt', () => {
    expect(() => parseSubagentInput({ ...valid, prompt: '  ' })).toThrow(/must not be empty/)
    expect(() => parseSubagentInput({ ...valid, prompt: undefined })).toThrow(/must be a string/)
  })

  test('caps tool-list entries and tool-name length during parsing', () => {
    const tooMany = Array.from(
      { length: MAX_SUBAGENT_TOOL_ENTRIES + 1 },
      (_value, index) => `tool${String(index)}`,
    )
    const atLimit = tooMany.slice(0, MAX_SUBAGENT_TOOL_ENTRIES)
    const tooLong = 'n'.repeat(MAX_SUBAGENT_TOOL_NAME_LENGTH + 1)
    const atNameLimit = 'n'.repeat(MAX_SUBAGENT_TOOL_NAME_LENGTH)

    expect(() =>
      parseSubagentInput({ ...valid, tools: { enable: tooMany } }),
    ).toThrow(/at most 64 entries/)
    expect(() =>
      parseSubagentInput({ ...valid, tools: { enable: [], disable: tooMany } }),
    ).toThrow(/at most 64 entries/)
    expect(
      parseSubagentInput({ ...valid, tools: { enable: atLimit } }).tools.enable,
    ).toHaveLength(MAX_SUBAGENT_TOOL_ENTRIES)

    expect(() =>
      parseSubagentInput({ ...valid, tools: { enable: [tooLong] } }),
    ).toThrow(/longer than 128 characters/)
    expect(() =>
      parseSubagentInput({ ...valid, tools: { enable: [], disable: [tooLong] } }),
    ).toThrow(/longer than 128 characters/)
    expect(
      parseSubagentInput({ ...valid, tools: { enable: [atNameLimit] } }).tools.enable,
    ).toEqual([atNameLimit])
  })
})
