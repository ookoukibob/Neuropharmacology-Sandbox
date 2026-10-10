/**
 * NPSL serializer tests — negative-zero preservation (data-integrity audit
 * DI-04). `JSON.stringify` canonicalizes `-0` to `0`, so
 * `serializeNpslDocument` tags every negative-zero number in the document —
 * recognized scientific values and unknown extension fields alike — with a
 * collision-proof placeholder string and rewrites only those positions back
 * to the valid JSON number token `-0`.
 *
 * Every fixture value is synthetic test data — not pharmacological
 * information. The negative-zero fixtures are built as in-memory object
 * literals (never through `JSON.stringify`, which would erase the sign
 * before the test reaches the implementation), and every sign assertion
 * uses `Object.is` — never `toEqual`, `===`-on-zero or visual output.
 */
import { describe, expect, it } from 'vitest'
import { syntheticDrug, syntheticDrugB, syntheticMetadata } from '../../tests/fixtures'
import { fieldAt } from '../../tests/runtimeFields'
import { scientificValueSchema } from '../schemas/npsl'
import type { NpslDocument } from './npslDocument'
import { serializeNpslDocument, toNpslDocument } from './npslDocument'

const USER_PROVENANCE = { type: 'user' as const, recordedAt: '2026-01-01T00:00:00.000Z' }

/**
 * Synthetic document exercising every serializer contract at once: two
 * negative-zero scientific values (`kd`, `halfLife`), a positive zero, an
 * ordinary nonzero value, strings that LOOK like the numeric tokens, and a
 * nested unknown extension field (object + array) that itself carries a
 * `-0`, a `0` and a `1e-7` — the unknown-field riding promise applies to
 * numbers inside extensions too.
 */
function negZeroDocument(): NpslDocument {
  const document = {
    formatVersion: '1.0.0',
    schemaVersion: '1.0.0',
    libraryMetadata: syntheticMetadata(),
    drugs: [
      {
        ...syntheticDrug({
          identifiers: {
            name: 'Synthetic Negative-Zero Fixture',
            synonyms: [],
            // Look-alike tokens that must stay strings, never be rewritten.
            description: 'Synthetic string containing 0 and -0 tokens.',
          },
          targets: [
            {
              id: 'negzero-target-1',
              name: 'NZ-R',
              kd: { value: -0, unit: 'nM', provenance: USER_PROVENANCE },
              ic50: { value: 0, unit: 'nM', provenance: USER_PROVENANCE },
            },
            {
              id: 'negzero-target-2',
              name: 'NZ-S',
              kd: { value: 12.4, unit: 'nM', provenance: USER_PROVENANCE },
            },
          ],
          pharmacokinetics: {
            halfLife: { value: -0, unit: 'h', provenance: USER_PROVENANCE },
          },
        }),
        // Unknown nested extension data (outside the domain interfaces on
        // purpose — exactly what the format promises to ride along).
        futureField: {
          offset: -0,
          list: [-0, 0, 1e-7],
          label: '-0 stays a string',
        },
      },
    ],
  }
  // The extension field is intentionally outside the domain interfaces; the
  // fixture is assembled untyped and structurally asserted into the
  // document type here (no `any`, no suppression) — mirroring the
  // repository extension-fixture convention.
  return document
}

function parseDocument(document: NpslDocument): NpslDocument {
  return JSON.parse(serializeNpslDocument(document)) as NpslDocument
}

describe('serializeNpslDocument — negative-zero preservation (audit DI-04)', () => {
  it('emits the numeric token -0 for negative-zero values and keeps +0 positive', () => {
    const text = serializeNpslDocument(negZeroDocument())

    // The pretty-printed output carries the literal JSON token `-0` — not
    // the canonicalized `0`, not the string "-0" — for both negative-zero
    // scientific values, while the positive zero stays `0`.
    expect(text.match(/"value": -0/g) ?? []).toHaveLength(2)
    expect(text).toContain('"value": 0,\n')
    // The internal marker text never leaks into an ordinary fixture's
    // output. (A raw-NUL check would be meaningless: JSON escaping means
    // a leaked placeholder appears as the escaped text `\u0000…`, never
    // as a literal NUL character. This fixture legitimately contains no
    // marker-like data, so the marker's distinctive text must be absent —
    // the collision test below covers fixtures that DO contain it.)
    expect(text).not.toContain('npsl-negative-zero')
  })

  it('parses back to exact negative zero (JSON.parse + Object.is)', () => {
    const parsed = parseDocument(negZeroDocument())
    const targets = parsed.drugs[0]?.targets ?? []

    expect(Object.is(targets[0]?.kd?.value, -0)).toBe(true)
    expect(Object.is(parsed.drugs[0]?.pharmacokinetics.halfLife?.value, -0)).toBe(true)
    // Positive zero stays positive zero, and ordinary values are untouched.
    expect(Object.is(targets[0]?.ic50?.value, 0)).toBe(true)
    expect(Object.is(targets[0]?.ic50?.value, -0)).toBe(false)
    expect(targets[1]?.kd?.value).toBe(12.4)
  })

  it('round-trips nested unknown fields and arrays containing -0 without damage', () => {
    const text = serializeNpslDocument(negZeroDocument())
    const parsed = JSON.parse(text) as NpslDocument

    expect(text).toContain('"offset": -0')
    const extension = fieldAt(parsed, 'drugs', '0', 'futureField')
    expect(Object.is(fieldAt(extension, 'offset'), -0)).toBe(true)
    const list = fieldAt(extension, 'list') as unknown[]
    expect(list).toHaveLength(3)
    expect(Object.is(list[0], -0)).toBe(true)
    expect(Object.is(list[1], 0)).toBe(true)
    expect(Object.is(list[2], 1e-7)).toBe(true)
    expect(fieldAt(extension, 'label')).toBe('-0 stays a string')
  })

  it('never rewrites strings that look like the numeric tokens', () => {
    const text = serializeNpslDocument(negZeroDocument())
    const parsed = JSON.parse(text) as NpslDocument

    expect(parsed.drugs[0]?.identifiers.description).toBe(
      'Synthetic string containing 0 and -0 tokens.',
    )
    expect(text).toContain('"Synthetic string containing 0 and -0 tokens."')
  })

  it('serializes a document without negative zero exactly like plain JSON.stringify', () => {
    // Format stability: for the ordinary case the output is byte-identical
    // to the previous implementation (same pretty-print, same key order).
    // (The token pattern — not the raw substring, which ISO dates like
    // "2026-01-01" also contain — proves no `-0` was introduced.)
    const document = syntheticLibraryOfTwo()
    expect(serializeNpslDocument(document)).toBe(JSON.stringify(document, null, 2))
    expect(serializeNpslDocument(document)).not.toContain('"value": -0')
  })

  it('keeps rejecting NaN and infinities at the schema boundary', () => {
    // The serializer fix never broadens accepted numeric states: the schema
    // still refuses NaN/±Infinity, and no such token can appear in output.
    for (const value of [NaN, Infinity, -Infinity]) {
      const result = scientificValueSchema.safeParse({
        value,
        unit: 'nM',
        provenance: USER_PROVENANCE,
      })
      expect(result.success).toBe(false)
    }
    const text = serializeNpslDocument(negZeroDocument())
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('Infinity')
  })

  it('survives placeholder collisions: source data containing the marker itself', () => {
    // The implementation's private initial marker (a NUL-delimited string),
    // rebuilt here from character codes so the test drives only the PUBLIC
    // serializer. The source data contains BOTH the initial marker (as an
    // extension value and as an extension property key) AND the first
    // extended candidate ('<marker>-extended'), forcing the collision loop
    // to advance twice before serialization.
    const NUL = String.fromCharCode(0)
    const marker = `${NUL}npsl-negative-zero${NUL}`
    const firstExtended = `${marker}-extended`
    const document = {
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: syntheticMetadata(),
      drugs: [
        {
          ...syntheticDrug({
            targets: [
              {
                id: 'collision-target-1',
                name: 'CL-R',
                kd: { value: -0, unit: 'nM', provenance: USER_PROVENANCE },
              },
            ],
          }),
          futureField: {
            // Marker-like extension key AND marker-like values.
            [marker]: 'marker-key value kept',
            markerValue: marker,
            firstExtendedValue: firstExtended,
            offset: -0,
            note: 'unrelated',
          },
        },
      ],
    }
    const text = serializeNpslDocument(document)
    const parsed = JSON.parse(text) as NpslDocument

    // Negative zero is still exact despite the collisions.
    expect(Object.is(fieldAt(parsed, 'drugs', '0', 'targets', '0', 'kd', 'value'), -0)).toBe(true)
    expect(Object.is(fieldAt(parsed, 'drugs', '0', 'futureField', 'offset'), -0)).toBe(true)
    // Every marker-like source string survives byte-identical: if the
    // loop had stopped at the initial marker (or after a single
    // extension), the replacement would have rewritten these positions
    // to the `-0` token instead.
    const extension = fieldAt(parsed, 'drugs', '0', 'futureField')
    expect(fieldAt(extension, 'markerValue')).toBe(marker)
    expect(fieldAt(extension, 'firstExtendedValue')).toBe(firstExtended)
    // The marker-like property key survives as a key.
    expect(fieldAt(extension, marker)).toBe('marker-key value kept')
    // Unrelated fields and recognized fields are not corrupted.
    expect(fieldAt(extension, 'note')).toBe('unrelated')
    expect(parsed.drugs[0]?.identifiers.name).toBe('Fixture Compound A')
    expect(parsed.drugs[0]?.targets[0]?.name).toBe('CL-R')
  })
})

function syntheticLibraryOfTwo(): NpslDocument {
  return toNpslDocument({
    metadata: syntheticMetadata(),
    drugs: [syntheticDrug(), syntheticDrugB()],
  })
}
