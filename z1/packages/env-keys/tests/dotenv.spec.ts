/**
 * The pure half: what a `.env` file is read as, and what a rewrite does to the
 * bytes around the line it changes.
 *
 * These are the promises `set` and `unset` make to a person who also edits the
 * file by hand — comments, blank lines, indentation and line endings survive —
 * so they are asserted against whole strings rather than parsed fragments.
 */

import { describe, expect, test } from 'vitest'

import {
  MIN_SECRET_LENGTH,
  findLeaks,
  parseValue,
  readKeys,
  readSecrets,
  removeAssignment,
  upsertAssignment,
} from '../src/index.ts'

/** A file with comments, blank lines, odd indentation and one assignment. */
const ANNOTATED = [
  '# z1 keys — hand-edited',
  '',
  'API_KEY=old-value',
  '   ',
  '# keep me',
  'OTHER=kept',
  '',
].join('\n')

describe('readKeys', () => {
  test('reports names and value lengths, never values', () => {
    const keys = readKeys(
      ['A=one', 'B="two words"', 'C=three # comment', 'D = spaced', 'E='].join('\n'),
    )

    expect(keys).toEqual([
      { name: 'A', length: 3 },
      { name: 'B', length: 9 },
      { name: 'C', length: 5 },
      { name: 'D', length: 6 },
      { name: 'E', length: 0 },
    ])
    expect(JSON.stringify(keys)).not.toContain('two words')
  })

  test('a duplicated name is one key, in first-seen order', () => {
    expect(readKeys('A=1\nB=2\nA=3\n')).toEqual([
      { name: 'A', length: 1 },
      { name: 'B', length: 1 },
    ])
  })

  test('honours export, tabs and the CRLF of a Windows file', () => {
    expect(readKeys('export A=1\r\n\tB\t=2\r\n')).toEqual([
      { name: 'A', length: 1 },
      { name: 'B', length: 1 },
    ])
  })

  test('a line that is not an assignment is skipped, not invented', () => {
    const keys = readKeys(['# A=1', 'NO_EQUALS', '1BAD=x', 'A-B=x', 'GOOD=yes'].join('\n'))
    expect(keys).toEqual([{ name: 'GOOD', length: 3 }])
  })

  test('an empty file has no keys', () => {
    expect(readKeys('')).toEqual([])
    expect(readKeys('\n\n')).toEqual([])
  })
})

describe('parseValue', () => {
  test('drops matching quotes', () => {
    expect(parseValue('"a b"')).toBe('a b')
    expect(parseValue("'x'")).toBe('x')
    expect(parseValue('"open')).toBe('open')
  })

  test('drops an inline comment only where a space starts it', () => {
    expect(parseValue('x # note')).toBe('x')
    expect(parseValue('a#b')).toBe('a#b')
    expect(parseValue('pass#word=1')).toBe('pass#word=1')
  })

  test('keeps a `=` inside the value', () => {
    expect(parseValue('a=b=c')).toBe('a=b=c')
  })
})

describe('upsertAssignment', () => {
  test('replaces the assignment in place and keeps every other byte', () => {
    const next = upsertAssignment(ANNOTATED, 'API_KEY', 'new-value')

    expect(next.replaced).toBe(true)
    expect(next.text).toBe(
      ['# z1 keys — hand-edited', '', 'API_KEY=new-value', '   ', '# keep me', 'OTHER=kept', ''].join(
        '\n',
      ),
    )
  })

  test('appends to a file that does not end with a newline', () => {
    const next = upsertAssignment('A=1', 'B', '2')

    expect(next.replaced).toBe(false)
    expect(next.text).toBe('A=1\nB=2\n')
  })

  test('creates a file from nothing', () => {
    expect(upsertAssignment('', 'A', '1')).toEqual({ text: 'A=1\n', replaced: false })
  })

  test('appends with the line ending the file already uses', () => {
    expect(upsertAssignment('A=1\r\n', 'B', '2').text).toBe('A=1\r\nB=2\r\n')
    expect(upsertAssignment('A=1\r\n', 'A', '2').text).toBe('A=2\r\n')
  })

  test('two sets of the same name leave one line', () => {
    const first = upsertAssignment('', 'A', '1')
    const second = upsertAssignment(first.text, 'A', '2')

    expect(second.text).toBe('A=2\n')
    expect(second.replaced).toBe(true)
  })

  test('a duplicate already in the file is collapsed, so the write is not defeated', () => {
    // A dotenv reader takes the last assignment; leaving the stale one would
    // make `set` a no-op with a success result.
    expect(upsertAssignment('A=old\nB=1\nA=older\n', 'A', 'new').text).toBe('A=new\nB=1\n')
  })

  test('keeps the name spelling, `export` and the spacing around `=`', () => {
    expect(upsertAssignment('export API_KEY = old\n', 'API_KEY', 'new').text).toBe(
      'export API_KEY = new\n',
    )
  })

  test('a value with a `#` or `=` survives a round trip', () => {
    const value = 'pass#word=a=b'
    const next = upsertAssignment('', 'A', value)

    expect(next.text).toBe(`A=${value}\n`)
    expect(readKeys(next.text)).toEqual([{ name: 'A', length: value.length }])
    expect(readSecrets(next.text)).toEqual([{ name: 'A', value }])
  })

  test('a malformed line is preserved verbatim, never rewritten', () => {
    const next = upsertAssignment('1BAD=x\nNO_EQUALS\nA=1\n', 'A', '2')
    expect(next.text).toBe('1BAD=x\nNO_EQUALS\nA=2\n')
  })

  test('a classic-Mac file is lines too, not one long assignment', () => {
    // A `\r`-only file read as a single line would make `set` replace everything
    // after the first `=`, which is the one way this module could lose keys.
    expect(readKeys('A=1\rB=2\r')).toEqual([
      { name: 'A', length: 1 },
      { name: 'B', length: 1 },
    ])
    expect(upsertAssignment('A=1\rB=2\r', 'A', '3').text).toBe('A=3\rB=2\r')
    expect(removeAssignment('A=1\rB=2\r', 'A').text).toBe('B=2\r')
  })
})

describe('removeAssignment', () => {
  test('removes only its own line', () => {
    const next = removeAssignment(ANNOTATED, 'API_KEY')

    expect(next.removed).toBe(true)
    expect(next.text).toBe(['# z1 keys — hand-edited', '', '   ', '# keep me', 'OTHER=kept', ''].join('\n'))
  })

  test('removes every assignment of the name', () => {
    expect(removeAssignment('A=1\nB=2\nA=3\n', 'A').text).toBe('B=2\n')
  })

  test('leaves a file without a trailing newline alone', () => {
    expect(removeAssignment('A=1\nB=2', 'A').text).toBe('B=2')
  })

  test('reports nothing removed and returns the text untouched', () => {
    const text = 'A=1\n'
    const next = removeAssignment(text, 'MISSING')

    expect(next.removed).toBe(false)
    expect(next.text).toBe(text)
  })

  test('removes a CRLF line without touching the others', () => {
    expect(removeAssignment('A=1\r\nB=2\r\n', 'A').text).toBe('B=2\r\n')
  })
})

describe('readSecrets', () => {
  test('keeps only values long enough to be evidence', () => {
    const secrets = readSecrets(
      [`SHORT=${'x'.repeat(MIN_SECRET_LENGTH - 1)}`, `LONG=${'y'.repeat(MIN_SECRET_LENGTH)}`, 'EMPTY='].join(
        '\n',
      ),
    )

    expect(secrets.map((secret) => secret.name)).toEqual(['LONG'])
    expect(secrets[0]?.value).toHaveLength(MIN_SECRET_LENGTH)
  })

  test('two names that share a value are kept apart', () => {
    const value = 'same-value'
    expect(readSecrets(`A=${value}\nB=${value}\n`)).toEqual([
      { name: 'A', value },
      { name: 'B', value },
    ])
  })
})

describe('findLeaks', () => {
  const value = 'sk-live-abcdef0123'

  test('names path and line, and never the value', () => {
    const text = ['const a = 1', '', `const key = '${value}'`, 'never-squash'].join('\n')
    const leaks = findLeaks('src/config.ts', text, [{ name: 'API_KEY', value }])

    expect(leaks).toEqual([{ name: 'API_KEY', path: 'src/config.ts', line: 3 }])
    expect(JSON.stringify(leaks)).not.toContain(value)
  })

  test('a file without the value has no leaks', () => {
    expect(findLeaks('a.ts', 'nothing here', [{ name: 'API_KEY', value }])).toEqual([])
  })

  test('an empty secret list costs nothing', () => {
    expect(findLeaks('a.ts', value, [])).toEqual([])
  })
})
