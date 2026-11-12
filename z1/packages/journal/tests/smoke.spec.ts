import { expect, test } from 'vitest'
import { PACKAGE } from '../src/index.ts'

test('package identity', () => {
  expect(PACKAGE).toBe('@z1/journal')
})
