import { describe, expect, it } from 'vitest'
import fixture from '../../tests/fixtures/example-library.npsl.json'
import {
  NPSL_FORMAT_VERSION,
  NPSL_SCHEMA_VERSION,
  checkNpslVersions,
  npslFileSchema,
} from './npsl'

function parseOk(input: unknown) {
  const result = npslFileSchema.safeParse(input)
  if (!result.success) {
    throw new Error(
      `expected parse to succeed: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  return result.data
}

function parseFails(input: unknown) {
  const result = npslFileSchema.safeParse(input)
  expect(result.success).toBe(false)
  return result.success ? [] : result.error.issues
}

describe('npslFileSchema', () => {
  it('accepts a valid .npsl document and preserves provenance structure', () => {
    const parsed = parseOk(fixture)

    expect(parsed.libraryMetadata.name).toBe('NPSL Schema Test Fixture')
    expect(parsed.libraryMetadata.dataStatus).toBe('example')
    expect(parsed.drugs).toHaveLength(1)

    const target = parsed.drugs[0]?.targets[0]
    expect(target?.kd?.provenance.type).toBe('literature')
    expect(target?.ki?.provenance.type).toBe('user')
    expect(target?.ec50?.provenance.type).toBe('unknown')
    expect(target?.ic50?.provenance.type).toBe('derived')
    expect(parsed.drugs[0]?.pharmacokinetics.halfLife?.provenance.type).toBe(
      'calculated',
    )

    // Units and provenance are never flattened away.
    expect(target?.kd).toMatchObject({ value: 1, unit: 'nM' })
  })

  it('applies normalization defaults for omitted collections', () => {
    const input = structuredClone(fixture) as Record<string, unknown>
    const drug = (input['drugs'] as Record<string, unknown>[])[0]
    if (!drug) throw new Error('fixture must contain at least one drug')
    delete drug['tags']
    delete drug['targets']
    delete (drug['identifiers'] as Record<string, unknown>)['synonyms']
    const metadata = input['libraryMetadata'] as Record<string, unknown>
    delete metadata['dataStatus']

    const parsed = parseOk(input)
    expect(parsed.drugs[0]?.tags).toEqual([])
    expect(parsed.drugs[0]?.targets).toEqual([])
    expect(parsed.drugs[0]?.identifiers.synonyms).toEqual([])
    expect(parsed.libraryMetadata.dataStatus).toBe('unspecified')
  })

  it('preserves unknown keys for forward compatibility', () => {
    const input = structuredClone(fixture) as Record<string, unknown>
    input['futureTopLevelField'] = { hello: 'world' }
    const drug = (input['drugs'] as Record<string, unknown>[])[0]
    if (drug) drug['futureDrugField'] = 'kept'

    const parsed = parseOk(input) as Record<string, unknown>
    expect(parsed['futureTopLevelField']).toEqual({ hello: 'world' })
    expect((parsed['drugs'] as Record<string, unknown>[])[0]?.['futureDrugField']).toBe('kept')
  })

  it('rejects a non-finite numeric value', () => {
    const input = structuredClone(fixture)
    const target = input.drugs[0]?.targets[0]
    if (target?.kd) target.kd.value = Number.POSITIVE_INFINITY
    parseFails(input)
  })

  it('rejects a wrong value type', () => {
    const input = structuredClone(fixture) as unknown
    const mutated = JSON.parse(JSON.stringify(input)) as typeof input
    const drugs = (mutated as { drugs: Record<string, unknown>[] }).drugs
    const firstDrug = drugs[0]
    if (!firstDrug) throw new Error('fixture must contain at least one drug')
    const firstTarget = (
      firstDrug['targets'] as Record<string, unknown>[]
    )[0]
    if (!firstTarget) throw new Error('fixture must contain at least one target')
    const kd = firstTarget['kd'] as Record<string, unknown>
    kd['value'] = '1'
    parseFails(mutated)
  })

  it('rejects an empty unit', () => {
    const input = structuredClone(fixture)
    const kd = input.drugs[0]?.targets[0]?.kd
    if (kd) kd.unit = ''
    parseFails(input)
  })

  it('rejects an unknown provenance type', () => {
    const input = structuredClone(fixture)
    const kd = input.drugs[0]?.targets[0]?.kd
    if (kd) {
      // @ts-expect-error -- deliberately invalid provenance type
      kd.provenance = { type: 'verified', reviewer: 'nobody' }
    }
    const issues = parseFails(input)
    expect(JSON.stringify(issues)).toContain('Invalid discriminator value')
  })

  it('rejects literature provenance without a source', () => {
    const input = structuredClone(fixture)
    const kd = input.drugs[0]?.targets[0]?.kd
    if (kd && kd.provenance.type === 'literature') {
      // @ts-expect-error -- source is required for literature provenance
      delete kd.provenance.source
    }
    parseFails(input)
  })

  it('accepts the portable attribution fields on a promoted literature value', () => {
    const input = structuredClone(fixture)
    const kd = input.drugs[0]?.targets[0]?.kd
    if (kd && kd.provenance.type === 'literature') {
      const provenance = kd.provenance as Record<string, unknown>
      provenance['sourceRecordId'] = '99000001'
      provenance['licenseNotice'] = 'ChEMBL data is licensed under CC BY-SA 3.0.'
      provenance['licenseUrl'] = 'https://creativecommons.org/licenses/by-sa/3.0/'
    }
    const parsed = parseOk(input)
    expect(parsed.drugs[0]?.targets[0]?.kd?.provenance).toMatchObject({
      type: 'literature',
      sourceRecordId: '99000001',
      licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    })
  })

  it('rejects empty or malformed portable attribution fields', () => {
    const input = structuredClone(fixture)
    const kd = input.drugs[0]?.targets[0]?.kd
    if (kd && kd.provenance.type === 'literature') {
      const provenance = kd.provenance as Record<string, unknown>
      provenance['sourceRecordId'] = ''
      provenance['licenseUrl'] = 'not-a-url'
    }
    parseFails(input)
  })

  it('rejects a missing libraryMetadata block', () => {
    const input = structuredClone(fixture) as Record<string, unknown>
    delete input['libraryMetadata']
    parseFails(input)
  })

  it('rejects a malformed ISO date-time', () => {
    const input = structuredClone(fixture)
    input.libraryMetadata.createdAt = 'yesterday'
    parseFails(input)
  })

  it('rejects an invalid version string', () => {
    const input = structuredClone(fixture)
    input.formatVersion = 'one-point-oh'
    parseFails(input)
  })
})

describe('npslFileSchema — target source references (phase 18I)', () => {
  const CHEMBL_REF = {
    source: 'chembl',
    sourceName: 'ChEMBL',
    sourceTargetId: 'CHEMBL99991001',
    name: 'Synthetic Target A',
    organism: 'Homo sapiens',
    url: 'https://www.ebi.ac.uk/chembl/explore/target/CHEMBL99991001',
    licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
  }

  function withReference(reference: unknown): unknown {
    const input = structuredClone(fixture) as Record<string, unknown>
    const drug = (input['drugs'] as Record<string, unknown>[])[0]
    if (!drug) throw new Error('fixture must contain at least one drug')
    const targets = drug['targets'] as Record<string, unknown>[]
    const target = targets[0]
    if (!target) throw new Error('fixture must contain at least one target')
    target['sourceReferences'] = [reference]
    return input
  }

  it('accepts a complete reference and keeps every field verbatim', () => {
    const parsed = parseOk(withReference(CHEMBL_REF))
    expect(parsed.drugs[0]?.targets[0]?.sourceReferences).toEqual([CHEMBL_REF])
  })

  it('keeps records without references valid and omits the key entirely', () => {
    const parsed = parseOk(fixture) as Record<string, unknown>
    const drugs = parsed['drugs'] as Record<string, unknown>[]
    const targets = drugs[0]?.['targets'] as Record<string, unknown>[] | undefined
    const target = targets?.[0]
    // Absent stays absent — never written as an empty array or undefined.
    expect(target !== undefined && 'sourceReferences' in target).toBe(false)
  })

  it('accepts multiple references from different source systems, preserving order', () => {
    const input = structuredClone(fixture) as Record<string, unknown>
    const drug = (input['drugs'] as Record<string, unknown>[])[0]
    const targets = drug?.['targets'] as Record<string, unknown>[] | undefined
    const target = targets?.[0]
    if (!target) throw new Error('fixture must contain at least one target')
    const otherRef = { source: 'pubchem', sourceName: 'PubChem', sourceTargetId: '12345' }
    target['sourceReferences'] = [CHEMBL_REF, otherRef]
    const parsed = parseOk(input)
    const refs = parsed.drugs[0]?.targets[0]?.sourceReferences
    expect(refs?.map((reference) => reference.source)).toEqual(['chembl', 'pubchem'])
    expect(refs?.[1]).toEqual(otherRef) // no source silently replaces another
  })

  it('rejects non-HTTPS or malformed reference URLs, naming the field', () => {
    for (const url of ['http://example.com/x', 'javascript:alert(1)', '/relative/path', '   ']) {
      const issues = parseFails(withReference({ ...CHEMBL_REF, url }))
      expect(
        issues.some((issue) => issue.path.join('.').includes('sourceReferences.0.url')),
      ).toBe(true)
    }
    // The license URL follows the same rule.
    const issues = parseFails(withReference({ ...CHEMBL_REF, licenseUrl: 'ftp://licen.se' }))
    expect(
      issues.some((issue) => issue.path.join('.').includes('sourceReferences.0.licenseUrl')),
    ).toBe(true)
  })

  it('rejects references with missing or empty identity fields', () => {
    for (const partial of [
      { sourceName: 'ChEMBL', sourceTargetId: 'X' }, // no source
      { source: 'chembl', sourceTargetId: 'X' }, // no sourceName
      { source: 'chembl', sourceName: 'ChEMBL' }, // no sourceTargetId
      { ...CHEMBL_REF, sourceTargetId: '' }, // empty id
    ]) {
      expect(parseFails(withReference(partial)).length).toBeGreaterThan(0)
    }
  })

  it('keeps unknown keys inside a reference (forward compatibility)', () => {
    const withUnknown = { ...CHEMBL_REF, futureReferenceField: 'kept' }
    const parsed = parseOk(withReference(withUnknown)) as Record<string, unknown> as {
      drugs: Record<string, unknown>[]
    }
    const targets = parsed.drugs[0]?.['targets'] as Record<string, unknown>[] | undefined
    const refs = targets?.[0]?.['sourceReferences'] as Record<string, unknown>[] | undefined
    const ref = refs?.[0]
    expect(ref?.['futureReferenceField']).toBe('kept')
  })
})

describe('checkNpslVersions', () => {
  const current = {
    formatVersion: NPSL_FORMAT_VERSION,
    schemaVersion: NPSL_SCHEMA_VERSION,
  }

  it('accepts the current version', () => {
    expect(checkNpslVersions(current)).toEqual({ ok: true })
  })

  it('accepts an older minor version of the same major', () => {
    expect(
      checkNpslVersions({ formatVersion: '1.0.0', schemaVersion: '1.0.0' }),
    ).toEqual({ ok: true })
  })

  it('rejects a newer minor version', () => {
    const result = checkNpslVersions({ ...current, schemaVersion: '1.99.0' })
    expect(result.ok).toBe(false)
  })

  it('rejects a different major version', () => {
    const result = checkNpslVersions({ ...current, formatVersion: '2.0.0' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('formatVersion')
  })
})
