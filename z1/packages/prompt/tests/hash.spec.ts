import { describe, expect, test } from 'vitest'
import { sectionHash, stackSections } from '../src/index.ts'
import { sha256Hex } from '../src/sha256.ts'
import { section } from './helpers.ts'

const A = section('core.a', 'core', 0, 'alpha', true)
const B = section('role.b', 'role', 0, 'beta')

describe('sha256', () => {
  test('matches the published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })
})

describe('hash', () => {
  test('is identical for identical content', () => {
    const one = stackSections([A, B], {})
    const two = stackSections([A, B], {})
    expect(one.hash).toBe(two.hash)
  })

  test('is stable across input reordering', () => {
    const one = stackSections([A, B], {})
    const two = stackSections([B, A], {})
    expect(one.hash).toBe(two.hash)
  })

  test('changes when rendered text changes', () => {
    const one = stackSections([A], {})
    const two = stackSections([section('core.a', 'core', 0, 'alpha!', true)], {})
    expect(one.hash).not.toBe(two.hash)
  })

  test('changes when a priority changes', () => {
    const one = stackSections([section('core.a', 'core', 0, 'alpha', true)], {})
    const two = stackSections([section('core.a', 'core', 1, 'alpha', true)], {})
    expect(one.hash).not.toBe(two.hash)
  })

  test('changes with a section id', () => {
    const one = stackSections([section('core.a', 'core', 0, 'alpha', true)], {})
    const two = stackSections([section('core.z', 'core', 0, 'alpha', true)], {})
    expect(one.hash).not.toBe(two.hash)
  })

  test('sectionHash tracks the body and ignores the stack', () => {
    expect(sectionHash(A)).toBe(sectionHash({ ...A }))
    expect(sectionHash(A)).not.toBe(sectionHash({ ...A, body: 'alpha!' }))
    expect(sectionHash(A)).toMatch(/^[0-9a-f]{64}$/)
  })
})
