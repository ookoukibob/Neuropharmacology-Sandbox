/**
 * Measurement-contract tests for the experimental dataset schemas (phase 50F).
 *
 * The structural schemas already require the right fields on each observation
 * shape. These cases cover the *semantic* invariants a permissive object would
 * otherwise let through: a record may be quantified or below the limit, never
 * both, and an inline `<number` bound must agree with the recorded limit.
 *
 * All fixtures are synthetic test data — not pharmacological information.
 */
import { describe, expect, it } from 'vitest'
import {
  experimentalDatasetInputSchema,
  experimentalDatasetRecordSchema,
  experimentalMeasurementInputSchema,
  experimentalMeasurementRecordSchema,
} from './experimentalDatasets'

const QUANTIFIED = { sourceRow: 1, time: 0, concentration: 2.5 }

const CENSORED = {
  sourceRow: 2,
  time: 1,
  censored: true,
  censoring: 'below-quantification-limit',
  rawText: '<0.1',
  limit: 0.1,
}

const PROVENANCE = { source: 'csv', importedAt: '2026-01-01T00:00:00.000Z' }

function pathsOf(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  if (result.success || result.error === undefined) throw new Error('expected a rejection')
  return result.error.issues.map((issue) => issue.path.join('.'))
}

describe('measurement contract — quantified observations', () => {
  it('accepts a legacy quantified record and keeps unknown extension fields', () => {
    const result = experimentalMeasurementInputSchema.safeParse({
      ...QUANTIFIED,
      futureField: 'kept',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.concentration).toBe(2.5)
    expect((result.data as Record<string, unknown>)['futureField']).toBe('kept')
  })

  it('rejects every reserved censoring field, including censored: false', () => {
    const reserved = [
      { censored: false },
      { censored: true },
      { censoring: 'below-quantification-limit' },
      { rawText: '<0.1' },
      { limit: 0.1 },
    ]
    for (const extra of reserved) {
      const result = experimentalMeasurementInputSchema.safeParse({ ...QUANTIFIED, ...extra })
      expect(result.success, JSON.stringify(extra)).toBe(false)
    }
  })

  it('names the offending field so a preview can locate it', () => {
    const result = experimentalMeasurementInputSchema.safeParse({ ...QUANTIFIED, limit: 0.1 })
    expect(pathsOf(result)).toContain('limit')
  })
})

describe('measurement contract — below-limit observations', () => {
  it('accepts an agreeing inline bound and symbolic markers with an explicit limit', () => {
    const accepted = [
      CENSORED,
      // Symbolic markers carry no inline number: the recorded limit stands.
      { ...CENSORED, rawText: 'BLQ' },
      { ...CENSORED, rawText: '<LLOQ' },
      // The same number, spelled differently, is the same bound.
      { ...CENSORED, rawText: '<0.10' },
      { ...CENSORED, rawText: '<1e-1' },
      // Compared after trimming; the stored text itself is untouched below.
      { ...CENSORED, rawText: '  <0.1  ' },
    ]
    for (const measurement of accepted) {
      expect(
        experimentalMeasurementInputSchema.safeParse(measurement).success,
        JSON.stringify(measurement),
      ).toBe(true)
    }
  })

  it('rejects a censored record that also carries a concentration', () => {
    const result = experimentalMeasurementInputSchema.safeParse({ ...CENSORED, concentration: 0.1 })
    expect(pathsOf(result)).toContain('concentration')
  })

  it('rejects an inline bound that disagrees with the recorded limit', () => {
    const result = experimentalMeasurementInputSchema.safeParse({ ...CENSORED, limit: 10 })
    const paths = pathsOf(result)
    expect(paths).toContain('limit')
    if (result.success || result.error === undefined) return
    expect(result.error.issues.map((issue) => issue.message).join(' ')).toMatch(/disagrees with the 0\.1 bound/)
  })

  it('rejects an inline bound that is not a finite number', () => {
    const result = experimentalMeasurementInputSchema.safeParse({
      ...CENSORED,
      rawText: '<1e400',
      limit: 0.1,
    })
    expect(pathsOf(result)).toContain('rawText')
  })

  it('preserves rawText exactly as recorded', () => {
    const result = experimentalMeasurementInputSchema.safeParse({ ...CENSORED, rawText: ' <0.10 ' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toMatchObject({ rawText: ' <0.10 ', limit: 0.1 })
  })
})

describe('measurement contract — stored records', () => {
  it('applies the same rules to the persisted shape', () => {
    const accept = [
      { ...QUANTIFIED, id: 'm1' },
      { ...CENSORED, id: 'm2' },
    ]
    for (const measurement of accept) {
      expect(
        experimentalMeasurementRecordSchema.safeParse(measurement).success,
        JSON.stringify(measurement),
      ).toBe(true)
    }
    const reject = [
      { ...QUANTIFIED, id: 'm1', censored: false },
      { ...QUANTIFIED, id: 'm1', rawText: '<0.1' },
      { ...CENSORED, id: 'm2', concentration: 0.1 },
      { ...CENSORED, id: 'm2', limit: 10 },
    ]
    for (const measurement of reject) {
      expect(
        experimentalMeasurementRecordSchema.safeParse(measurement).success,
        JSON.stringify(measurement),
      ).toBe(false)
    }
  })

  it('rejects a stored dataset whose measurement mixes the two shapes', () => {
    const base = {
      id: 'ds-1',
      name: 'Study A',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      provenance: PROVENANCE,
    }
    expect(
      experimentalDatasetRecordSchema.safeParse({
        ...base,
        measurements: [
          { ...QUANTIFIED, id: 'm1' },
          { ...CENSORED, id: 'm2' },
        ],
      }).success,
    ).toBe(true)

    const mixed = experimentalDatasetRecordSchema.safeParse({
      ...base,
      measurements: [{ ...QUANTIFIED, id: 'm1', censored: true, rawText: '<0.1', limit: 0.1 }],
    })
    expect(pathsOf(mixed)).toContain('measurements.0.concentration')

    // The mirror case: a quantified record carrying censoring metadata.
    const quantifiedWithLimit = experimentalDatasetRecordSchema.safeParse({
      ...base,
      measurements: [{ ...QUANTIFIED, id: 'm1', limit: 0.1 }],
    })
    expect(pathsOf(quantifiedWithLimit)).toContain('measurements.0.limit')
  })

  it('rejects an imported dataset whose measurement mixes the two shapes', () => {
    const result = experimentalDatasetInputSchema.safeParse({
      name: 'Study A',
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      provenance: PROVENANCE,
      measurements: [{ ...CENSORED, concentration: 0.1 }],
    })
    expect(pathsOf(result)).toContain('measurements.0.concentration')
  })

  it('keeps a valid mixed dataset importable end to end', () => {
    const result = experimentalDatasetInputSchema.safeParse({
      name: 'Study A',
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      provenance: PROVENANCE,
      measurements: [QUANTIFIED, CENSORED],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.measurements).toHaveLength(2)
  })
})
