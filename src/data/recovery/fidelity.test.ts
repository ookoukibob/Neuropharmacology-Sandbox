/**
 * Fidelity unit tests (docs/recovery-backup.md §6): the export-side
 * boundary, RFC 6901 pointers, sidecar materialization and the
 * contractual deep equality E. All fixtures are synthetic test data —
 * not pharmacological information.
 */
import { describe, expect, it } from 'vitest'
import {
  decodePointer,
  deepEqualExact,
  describeValue,
  encodePointerSegment,
  exceedsUtf8ByteLimit,
  isPlainObject,
  materializeSpecialNumbers,
  pointerFromSegments,
  scanRowValue,
  specialNumberKind,
} from './fidelity'
import { MAX_DEPTH } from './format'

const CTX = { store: 'drugs' as const, key: 'row-1' }

describe('specialNumberKind', () => {
  it('classifies exactly the four JSON-unrepresentable numeric shapes', () => {
    expect(specialNumberKind(NaN)).toBe('NaN')
    expect(specialNumberKind(Infinity)).toBe('Infinity')
    expect(specialNumberKind(-Infinity)).toBe('-Infinity')
    expect(specialNumberKind(-0)).toBe('-0')
    expect(specialNumberKind(0)).toBeNull()
    expect(specialNumberKind(4.2)).toBeNull()
    expect(specialNumberKind(Number.MAX_SAFE_INTEGER)).toBeNull()
  })
})

describe('exceedsUtf8ByteLimit', () => {
  it('measures UTF-8 bytes, not string length', () => {
    expect(exceedsUtf8ByteLimit('abc', 3)).toBe(false)
    expect(exceedsUtf8ByteLimit('abc', 2)).toBe(true)
    // 'é' is 2 bytes in 1 UTF-16 unit — a length-based check would pass.
    expect(exceedsUtf8ByteLimit('é', 2)).toBe(false)
    expect(exceedsUtf8ByteLimit('é', 1)).toBe(true)
    // A surrogate pair: 2 UTF-16 units but 4 UTF-8 bytes.
    const emoji = String.fromCodePoint(0x1f9ea)
    expect(exceedsUtf8ByteLimit(emoji, 4)).toBe(false)
    expect(exceedsUtf8ByteLimit(emoji, 3)).toBe(true)
    // A lone surrogate encodes as U+FFFD (3 bytes), like TextEncoder.
    const lone = String.fromCharCode(0xd800)
    expect(exceedsUtf8ByteLimit(lone, 3)).toBe(false)
    expect(exceedsUtf8ByteLimit(lone, 2)).toBe(true)
    // Short text takes the cheap sufficient bound.
    expect(exceedsUtf8ByteLimit('short', 64)).toBe(false)
  })
})

describe('RFC 6901 pointers', () => {
  it('encodes and decodes segments', () => {
    expect(encodePointerSegment('a/b')).toBe('a~1b')
    expect(encodePointerSegment('a~b')).toBe('a~0b')
    expect(pointerFromSegments([])).toBe('')
    expect(pointerFromSegments(['a', 'b'])).toBe('/a/b')
    expect(pointerFromSegments(['a/b', 'c~d'])).toBe('/a~1b/c~0d')

    expect(decodePointer('/a/b')).toEqual({ ok: true, segments: ['a', 'b'] })
    expect(decodePointer('/a~1b')).toEqual({ ok: true, segments: ['a/b'] })
    expect(decodePointer('/a~0b')).toEqual({ ok: true, segments: ['a~b'] })
    // Tokenized in RFC order: '~01' resolves to the literal '~1'.
    expect(decodePointer('/~01')).toEqual({ ok: true, segments: ['~1'] })
    expect(decodePointer('/')).toEqual({ ok: true, segments: [''] })
  })

  it('rejects pointers that cannot address a record property', () => {
    expect(decodePointer('').ok).toBe(false)
    expect(decodePointer('a').ok).toBe(false)
    expect(decodePointer('/a~2').ok).toBe(false)
    expect(decodePointer('/a~').ok).toBe(false)
    expect(decodePointer('/~~').ok).toBe(false)
  })
})

describe('deepEqualExact (E)', () => {
  it('uses Object.is at the leaves', () => {
    expect(deepEqualExact(NaN, NaN)).toBe(true)
    expect(deepEqualExact(-0, -0)).toBe(true)
    expect(deepEqualExact(0, -0)).toBe(false)
    expect(deepEqualExact([-0], [0])).toBe(false)
    expect(deepEqualExact('a', 'a')).toBe(true)
    expect(deepEqualExact(null, undefined)).toBe(false)
  })

  it('compares objects by own enumerable keys (order-independent) and arrays by position', () => {
    expect(deepEqualExact({ a: 1, b: [NaN] }, { b: [NaN], a: 1 })).toBe(true)
    expect(deepEqualExact({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqualExact({ a: 1 }, { b: 1 })).toBe(false)
    expect(deepEqualExact({ a: { b: -0 } }, { a: { b: 0 } })).toBe(false)
    expect(deepEqualExact([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(deepEqualExact([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqualExact({}, [])).toBe(false)
    expect(deepEqualExact('1', 1)).toBe(false)
  })
})

describe('scanRowValue', () => {
  it('accepts every JSON-domain value without annotations for ordinary numbers', () => {
    const row = {
      s: 'x',
      n: 4.2,
      b: true,
      nul: null,
      arr: [1, 'two', false],
      obj: { k: 'v' },
    }
    const result = scanRowValue(row, CTX)
    expect(result.issues).toEqual([])
    expect(result.annotations).toEqual([])
  })

  it('annotates -0/NaN/±Infinity anywhere with RFC 6901 paths', () => {
    const row: Record<string, unknown> = {
      negZero: -0,
      nan: NaN,
      posInf: Infinity,
      negInf: -Infinity,
      nested: { list: [{ deep: -Infinity }] },
      'weird/key~': NaN,
    }
    const result = scanRowValue(row, CTX)
    expect(result.issues).toEqual([])
    expect(result.annotations).toHaveLength(6)
    expect(result.annotations).toEqual(
      expect.arrayContaining([
        { path: '/negZero', kind: '-0' },
        { path: '/nan', kind: 'NaN' },
        { path: '/posInf', kind: 'Infinity' },
        { path: '/negInf', kind: '-Infinity' },
        { path: '/nested/list/0/deep', kind: '-Infinity' },
        { path: '/weird~1key~0', kind: 'NaN' },
      ]),
    )
  })

  it('reports unsupported values with store, key, path and runtime type', () => {
    const cases: readonly [unknown, string][] = [
      [undefined, 'undefined'],
      [BigInt(1), 'bigint'],
      [() => undefined, 'function'],
      [Symbol('sym'), 'symbol'],
      [new Date(), 'date'],
      [new Map(), 'map'],
      [new Set([1]), 'set'],
      [/x/, 'regexp'],
      [new Uint8Array(1), 'uint8array'],
    ]
    for (const [value, type] of cases) {
      const result = scanRowValue({ bad: value }, CTX)
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0]?.code).toBe('BACKUP_UNSUPPORTED_VALUE')
      expect(result.issues[0]?.store).toBe('drugs')
      expect(result.issues[0]?.key).toBe('row-1')
      expect(result.issues[0]?.path).toBe('/bad')
      expect(result.issues[0]?.valueType).toBe(type)
      expect(result.annotations).toEqual([])
    }
  })

  it('rejects true cycles but allows shared (acyclic) references', () => {
    const cyclic: Record<string, unknown> = { name: 'cycle' }
    cyclic['self'] = cyclic
    const result = scanRowValue(cyclic, CTX)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.valueType).toBe('cycle')
    expect(result.issues[0]?.path).toBe('/self')

    const shared = { s: 'shared' }
    const dag = { a: shared, b: shared }
    expect(scanRowValue(dag, CTX).issues).toEqual([])

    // Specials in a shared subtree are annotated once per occurrence.
    const special = { n: NaN }
    const dagSpecial = { a: special, b: special }
    expect(scanRowValue(dagSpecial, CTX).annotations).toEqual([
      { path: '/a/n', kind: 'NaN' },
      { path: '/b/n', kind: 'NaN' },
    ])
  })

  it('reports rows JSON would silently drop (holes, props, symbol keys, hidden props)', () => {
    const sparse: unknown[] = []
    sparse[2] = 3
    expect(scanRowValue({ list: sparse }, CTX).issues[0]?.valueType).toBe('sparse-array')

    const arrWithProp: unknown[] = [1, 2]
    Reflect.set(arrWithProp, 'extra', 'dropped')
    expect(scanRowValue({ list: arrWithProp }, CTX).issues[0]?.valueType).toBe('array-property')

    const symKeyed: Record<string, unknown> = { ok: 1 }
    Object.defineProperty(symKeyed, Symbol('secret'), { value: 2, enumerable: true })
    expect(scanRowValue({ obj: symKeyed }, CTX).issues[0]?.valueType).toBe('symbol-key')

    const hidden: Record<string, unknown> = { ok: 1 }
    Object.defineProperty(hidden, 'hidden', { value: 2, enumerable: false })
    expect(scanRowValue({ obj: hidden }, CTX).issues[0]?.valueType).toBe('non-enumerable')
  })

  it('enforces the depth limit on export with a limit diagnostic', () => {
    const build = (depth: number): unknown => {
      let value: unknown = 0
      for (let i = 0; i < depth; i += 1) value = { n: value }
      return value
    }
    expect(scanRowValue(build(MAX_DEPTH), CTX).issues).toEqual([])

    const tooDeep = scanRowValue(build(MAX_DEPTH + 1), CTX)
    expect(tooDeep.issues).toHaveLength(1)
    expect(tooDeep.issues[0]?.code).toBe('BACKUP_LIMIT_EXCEEDED')
    expect(tooDeep.issues[0]?.limit).toBe('depth')
    expect(tooDeep.issues[0]?.store).toBe('drugs')
  })
})

describe('materializeSpecialNumbers', () => {
  it('replaces placeholders through own-property-only resolution', () => {
    const value = JSON.parse(
      '{"a":null,"list":[{"x":0}],"__proto__":null}',
    ) as Record<string, unknown>
    const result = materializeSpecialNumbers(
      value,
      [
        { path: '/a', kind: 'NaN' },
        { path: '/list/0/x', kind: '-0' },
        { path: '/__proto__', kind: 'Infinity' },
      ],
      { store: 'meta', key: 'm1' },
    )
    expect(result.ok).toBe(true)
    expect(Number.isNaN(result.value['a'] as number)).toBe(true)
    const list = result.value['list'] as { x: number }[]
    expect(Object.is(list[0]?.x, -0)).toBe(true)
    // The literal name "__proto__" is a plain own data property here —
    // the assignment must not touch the prototype chain.
    expect(result.value['__proto__']).toBe(Infinity)
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype)
    expect(result.issues).toEqual([])
  })

  it('rejects malformed annotations with precise ARCHIVE_ANNOTATION_* codes', () => {
    const base = (): Record<string, unknown> => JSON.parse('{"a":null}') as Record<string, unknown>

    const badKind = materializeSpecialNumbers(base(), [{ path: '/a', kind: 'zero' }], CTX)
    expect(badKind.ok).toBe(false)
    expect(badKind.issues[0]?.code).toBe('ARCHIVE_ANNOTATION_SHAPE')

    const notArray = materializeSpecialNumbers(base(), { path: '/a', kind: 'NaN' }, CTX)
    expect(notArray.ok).toBe(false)
    expect(notArray.issues[0]?.code).toBe('ARCHIVE_ANNOTATION_SHAPE')

    const notPointer = materializeSpecialNumbers(base(), [{ path: 'a', kind: 'NaN' }], CTX)
    expect(notPointer.issues[0]?.code).toBe('ARCHIVE_ANNOTATION_PATH')

    const rootPointer = materializeSpecialNumbers(base(), [{ path: '', kind: 'NaN' }], CTX)
    expect(rootPointer.issues[0]?.code).toBe('ARCHIVE_ANNOTATION_PATH')

    const dup = materializeSpecialNumbers(
      base(),
      [
        { path: '/a', kind: 'NaN' },
        { path: '/a', kind: 'Infinity' },
      ],
      CTX,
    )
    expect(dup.issues[0]?.code).toBe('ARCHIVE_ANNOTATION_DUPLICATE')

    // Own-property-only: 'constructor' is inherited, never traversed.
    const inherited = materializeSpecialNumbers(
      base(),
      [{ path: '/constructor/name', kind: 'NaN' }],
      CTX,
    )
    expect(inherited.issues[0]?.code).toBe('ARCHIVE_ANNOTATION_PATH')

    const missing = materializeSpecialNumbers(base(), [{ path: '/nope', kind: 'NaN' }], CTX)
    expect(missing.issues[0]?.code).toBe('ARCHIVE_ANNOTATION_PATH')

    // Placeholder must match the annotation's kind (§6.3).
    const wrongPlaceholder = materializeSpecialNumbers(base(), [{ path: '/a', kind: '-0' }], CTX)
    expect(wrongPlaceholder.ok).toBe(false)
    expect(wrongPlaceholder.issues[0]?.code).toBe('ARCHIVE_ANNOTATION_PLACEHOLDER')
  })

  it('rejects unannotated special numbers and keeps annotated ones', () => {
    // JSON text can only carry -0 as a literal unannotated special.
    const unannotated = materializeSpecialNumbers(
      JSON.parse('{"z":-0}') as Record<string, unknown>,
      undefined,
      CTX,
    )
    expect(unannotated.ok).toBe(false)
    expect(unannotated.issues[0]?.code).toBe('ARCHIVE_VALUE_DOMAIN')
    expect(unannotated.issues[0]?.valueType).toBe('-0')
    expect(unannotated.issues[0]?.path).toBe('/z')

    const annotated = materializeSpecialNumbers(
      JSON.parse('{"z":-0}') as Record<string, unknown>,
      [{ path: '/z', kind: '-0' }],
      CTX,
    )
    expect(annotated.ok).toBe(true)
    expect(Object.is(annotated.value['z'], -0)).toBe(true)
  })

  it('stays idempotent for an already-applied -0 placeholder', () => {
    const value = JSON.parse('{"z":-0}') as Record<string, unknown>
    const again = materializeSpecialNumbers(value, [{ path: '/z', kind: '-0' }], CTX)
    expect(again.ok).toBe(true)
    expect(Object.is(again.value['z'], -0)).toBe(true)
  })

  it('enforces the depth limit during materialization', () => {
    let value: unknown = 0
    for (let i = 0; i < MAX_DEPTH + 1; i += 1) value = { n: value }
    const result = materializeSpecialNumbers(value as Record<string, unknown>, undefined, CTX)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.code).toBe('ARCHIVE_LIMIT_EXCEEDED')
    expect(result.issues[0]?.limit).toBe('depth')
  })
})

describe('type helpers', () => {
  it('isPlainObject accepts object records only', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null) as object)).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })

  it('describeValue names runtime types for diagnostics', () => {
    expect(describeValue(undefined)).toBe('undefined')
    expect(describeValue(BigInt(1))).toBe('bigint')
    expect(describeValue(new Date())).toBe('date')
    expect(describeValue(new Map())).toBe('map')
    expect(describeValue([])).toBe('array')
    expect(describeValue(null)).toBe('null')
    expect(describeValue({})).toBe('object')
  })
})
