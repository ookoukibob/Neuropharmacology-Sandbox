/**
 * Duplicate JSON key scanner tests (docs/recovery-backup.md §8.2/2):
 * string-aware scanning, decoded-name comparison, per-object scoping,
 * depth bounding and the documented division of labor with JSON.parse
 * for malformed input. Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest'
import { scanDuplicateJsonKeys } from './duplicateKeys'

const DEPTH = 100

describe('scanDuplicateJsonKeys', () => {
  it('accepts JSON without duplicated keys', () => {
    expect(scanDuplicateJsonKeys('{}', DEPTH)).toEqual({ ok: true })
    expect(scanDuplicateJsonKeys('[]', DEPTH)).toEqual({ ok: true })
    expect(scanDuplicateJsonKeys('', DEPTH)).toEqual({ ok: true })
    expect(
      scanDuplicateJsonKeys(
        '{"a":1,"b":[1,2,{"c":"x"}],"d":{"e":null},"f":true}',
        DEPTH,
      ),
    ).toEqual({ ok: true })
  })

  it('finds a top-level duplicate with key, line and column', () => {
    const text = [
      '{',
      '  "drugs": [],',
      '  "meta": [],',
      '  "drugs": [1]',
      '}',
    ].join('\n')
    const result = scanDuplicateJsonKeys(text, DEPTH)
    expect(result.ok).toBe(false)
    if (result.ok || result.reason !== 'duplicate') {
      throw new Error(`expected a duplicate, got ${JSON.stringify(result)}`)
    }
    expect(result.key).toBe('drugs')
    expect(result.line).toBe(4)
    expect(result.column).toBe(3)
  })

  it('finds duplicates nested in any object, independently per object', () => {
    const nested = '{"entries":[{"key":"a","value":{},"key":"b"}]}'
    const result = scanDuplicateJsonKeys(nested, DEPTH)
    expect(result.ok).toBe(false)
    if (result.ok || result.reason !== 'duplicate') throw new Error('expected a duplicate')
    expect(result.key).toBe('key')

    // The same key in two DIFFERENT objects is not a duplicate.
    expect(scanDuplicateJsonKeys('{"a":{"b":1},"c":{"b":2}}', DEPTH)).toEqual({ ok: true })
  })

  it('compares names after JSON string decoding (escapes are the same key)', () => {
    const escaped = '{"a":1,"a":2}'
    const result = scanDuplicateJsonKeys(escaped, DEPTH)
    expect(result.ok).toBe(false)
    if (result.ok || result.reason !== 'duplicate') throw new Error('expected a duplicate')
    expect(result.key).toBe('a')

    // Non-ASCII: the literal character and its escape decode identically.
    const unicode = '{"' + 'é' + '":1,"\\u00e9":2}'
    const unicodeResult = scanDuplicateJsonKeys(unicode, DEPTH)
    expect(unicodeResult.ok).toBe(false)
    if (unicodeResult.ok || unicodeResult.reason !== 'duplicate') {
      throw new Error('expected a duplicate')
    }
    expect(unicodeResult.key).toBe('é')
  })

  it('never treats structural characters inside strings as keys', () => {
    // The value string contains a complete fake object with its own
    // "drugs" key — strings are opaque to the scanner.
    const text = '{"note":"{\\"drugs\\": 1, \\"drugs\\": 2}","drugs":[]}'
    expect(scanDuplicateJsonKeys(text, DEPTH)).toEqual({ ok: true })

    // Lookalike names differ: case and punctuation matter.
    expect(scanDuplicateJsonKeys('{"a":1,"A":2,"a-b":3}', DEPTH)).toEqual({ ok: true })

    // Escaped quotes inside the key itself.
    const quoted = '{"a\\"b":1,"a\\"b":2}'
    const result = scanDuplicateJsonKeys(quoted, DEPTH)
    expect(result.ok).toBe(false)
    if (result.ok || result.reason !== 'duplicate') throw new Error('expected a duplicate')
    expect(result.key).toBe('a"b')
  })

  it('reports the FIRST duplicate in textual order', () => {
    const text = '{"x":1,"y":2,"x":3,"y":4}'
    const result = scanDuplicateJsonKeys(text, DEPTH)
    expect(result.ok).toBe(false)
    if (result.ok || result.reason !== 'duplicate') throw new Error('expected a duplicate')
    expect(result.key).toBe('x')
    expect(result.column).toBe(14)
  })

  it('bounds nesting depth iteratively (no recursion)', () => {
    const nested = (depth: number): string =>
      '['.repeat(depth) + ']'.repeat(depth)
    expect(scanDuplicateJsonKeys(nested(100), DEPTH).ok).toBe(true)
    const tooDeep = scanDuplicateJsonKeys(nested(101), DEPTH)
    expect(tooDeep.ok).toBe(false)
    if (tooDeep.ok || tooDeep.reason !== 'depth') throw new Error('expected a depth result')
    expect(tooDeep.depth).toBe(101)

    // A deep duplicate inside otherwise-valid nesting still wins over
    // returning an unbounded structure: depth is checked on push.
    const deepDuplicate = nested(50) + '{"a":1,"a":2}' + nested(50)
    const result = scanDuplicateJsonKeys(deepDuplicate, 60)
    expect(result.ok).toBe(false)
  })

  it('defers malformed input to JSON.parse (ARCHIVE_PARSE), never throwing', () => {
    // Unterminated container / string, bare key, stray punctuation.
    expect(scanDuplicateJsonKeys('{"a":1', DEPTH)).toEqual({ ok: false, reason: 'malformed' })
    expect(scanDuplicateJsonKeys('"abc', DEPTH)).toEqual({ ok: false, reason: 'malformed' })
    expect(scanDuplicateJsonKeys('{a:1}', DEPTH)).toEqual({ ok: false, reason: 'malformed' })
    // A comma can never appear at document level.
    expect(scanDuplicateJsonKeys(',', DEPTH)).toEqual({ ok: false, reason: 'malformed' })
    expect(scanDuplicateJsonKeys('{"a":"\\q"}', DEPTH)).toEqual({ ok: false, reason: 'malformed' })
    expect(scanDuplicateJsonKeys('{"a":"\\u00zz"}', DEPTH)).toEqual({ ok: false, reason: 'malformed' })

    // Structural mistakes inside an object (a missing value after a
    // comma) are left to JSON.parse — the scanner only owns duplicates.
    expect(scanDuplicateJsonKeys('{"a":,}', DEPTH)).toEqual({ ok: true })

    // A duplicate next to malformed text is still reported when the scan
    // reaches it first; otherwise JSON.parse owns the verdict.
    expect(scanDuplicateJsonKeys('{"a":1,"a":2', DEPTH)).toEqual({
      ok: false,
      reason: 'duplicate',
      key: 'a',
      line: 1,
      column: 8,
    })

    // Never throws on garbage that happens to be structurally fine.
    expect(scanDuplicateJsonKeys('not json at all', DEPTH)).toEqual({ ok: true })
    expect(scanDuplicateJsonKeys('{} trailing', DEPTH)).toEqual({ ok: true })
  })
})
