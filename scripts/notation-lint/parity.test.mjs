import { describe, expect, it } from 'vitest'
import { NOTATION_UNDERSCORE_BASES } from '../../src/components/scientific/notation'
import { NOTATION_BASES } from './detect.mjs'

/**
 * The renderer and the static guard must agree on what a symbol is. If they
 * drift, either notation renders but lint stays silent (a recurrence), or lint
 * demands a renderer that would not treat the text as notation (a false
 * positive). This test is the only place the two lists are compared.
 */
describe('notation base allowlist parity', () => {
  it('matches the parser in src/components/scientific/notation.ts', () => {
    expect([...NOTATION_BASES].sort()).toEqual([...NOTATION_UNDERSCORE_BASES].sort())
  })
})
