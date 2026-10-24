import { describe, expect, it } from 'vitest'
import {
  concentrationUnitIssue,
  normalizeDatasetName,
  normalizeDatasetNotes,
  normalizeMeasurementNote,
  normalizeSampleId,
  timeUnitIssue,
  toDatasetSummary,
  validateAdministration,
  type AdministrationMetadata,
  type ExperimentalDataset,
} from './experimental-dataset'

function dataset(): ExperimentalDataset {
  return {
    id: 'dataset-1',
    name: 'Test dataset',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    timeUnit: 'h',
    concentrationUnit: 'mg/L',
    measurements: [
      {
        id: 'measurement-1',
        sourceRow: 1,
        time: 0,
        concentration: 2.5,
      },
    ],
    provenance: {
      source: 'csv',
      fileName: 'input.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    },
    notes: 'Preserved note',
  }
}

describe('experimental dataset domain', () => {
  it('validates declared units against the existing catalog dimensions', () => {
    expect(timeUnitIssue('h')).toBeNull()
    expect(timeUnitIssue('min')).toBeNull()
    expect(timeUnitIssue('mg/L')).toContain('not a time unit')
    expect(timeUnitIssue('fortnight')).toContain('not in the unit catalog')
    expect(timeUnitIssue('')).toBe('A time unit is required.')

    expect(concentrationUnitIssue('mg/L')).toBeNull()
    expect(concentrationUnitIssue('µM')).toBeNull()
    expect(concentrationUnitIssue('h')).toContain('not a concentration unit')
    expect(concentrationUnitIssue('')).toBe('A concentration unit is required.')
  })

  it('trims names only; notes and sample ids keep exact accepted text', () => {
    expect(normalizeDatasetName('  Study A  ')).toEqual({ ok: true, name: 'Study A' })
    expect(normalizeDatasetName('   ')).toEqual({
      ok: false,
      message: 'A dataset name is required.',
    })
    expect(normalizeDatasetNotes('  study note  ')).toEqual({
      ok: true,
      notes: '  study note  ',
    })
    expect(normalizeDatasetNotes('   ')).toEqual({ ok: true, notes: undefined })
    expect(normalizeDatasetNotes(undefined)).toEqual({ ok: true, notes: undefined })
    expect(normalizeSampleId(' S-01 ')).toEqual({ ok: true, sampleId: ' S-01 ' })
    expect(normalizeSampleId('   ')).toEqual({ ok: true, sampleId: undefined })
    expect(normalizeSampleId('')).toEqual({ ok: true, sampleId: undefined })
    expect(normalizeMeasurementNote(' measured at 5 min ')).toEqual({
      ok: true,
      note: ' measured at 5 min ',
    })
  })

  it('builds a list summary without exposing measurements', () => {
    const summary = toDatasetSummary(dataset())
    expect(summary).toEqual({
      id: 'dataset-1',
      name: 'Test dataset',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      measurementCount: 1,
      provenance: dataset().provenance,
    })
    expect('measurements' in summary).toBe(false)
  })
})

describe('administration metadata validation', () => {
  const base = (): AdministrationMetadata => ({
    route: 'iv-bolus',
    regimen: 'single-dose',
    timeReference: 'dose-time',
  })

  it('accepts a complete, well-formed bolus context', () => {
    expect(
      validateAdministration({ ...base(), dose: { value: 100, unit: 'mg' } }),
    ).toEqual([])
  })

  it('accepts an infusion duration and an infusion rate separately', () => {
    expect(
      validateAdministration({
        route: 'iv-infusion',
        regimen: 'single-dose',
        timeReference: 'infusion-start',
        infusion: { duration: { value: 2, unit: 'h' } },
      }),
    ).toEqual([])
    expect(
      validateAdministration({
        route: 'iv-infusion',
        regimen: 'single-dose',
        timeReference: 'infusion-start',
        infusion: { rate: { value: 10, unit: 'mg/h' } },
      }),
    ).toEqual([])
  })

  it('accepts a repeated-dose context with an interval and bioavailability', () => {
    expect(
      validateAdministration({
        route: 'extravascular',
        regimen: 'repeated-dose',
        timeReference: 'first-observation',
        dose: { value: 50, unit: 'mg' },
        dosingInterval: { value: 12, unit: 'h' },
        bioavailability: 0.8,
      }),
    ).toEqual([])
  })

  it('rejects a dose with the wrong dimension or a non-positive value', () => {
    expect(validateAdministration({ ...base(), dose: { value: 100, unit: 'mg/L' } })[0]?.field).toBe(
      'dose.unit',
    )
    expect(validateAdministration({ ...base(), dose: { value: 0, unit: 'mg' } })[0]?.field).toBe(
      'dose.value',
    )
  })

  it('rejects an infusion that declares both a duration and a rate', () => {
    const issues = validateAdministration({
      route: 'iv-infusion',
      regimen: 'single-dose',
      timeReference: 'infusion-start',
      infusion: { duration: { value: 2, unit: 'h' }, rate: { value: 10, unit: 'mg/h' } },
    })
    expect(issues.some((issue) => issue.field === 'infusion')).toBe(true)
  })

  it('rejects an interval with the wrong unit or a non-positive value', () => {
    expect(
      validateAdministration({ ...base(), dosingInterval: { value: 12, unit: 'mg' } })[0]?.field,
    ).toBe('dosingInterval.unit')
    expect(
      validateAdministration({ ...base(), dosingInterval: { value: 0, unit: 'h' } })[0]?.field,
    ).toBe('dosingInterval.value')
  })

  it('rejects bioavailability outside (0, 1] and non-finite values', () => {
    expect(validateAdministration({ ...base(), bioavailability: 0 })[0]?.field).toBe(
      'bioavailability',
    )
    expect(validateAdministration({ ...base(), bioavailability: 1.5 })[0]?.field).toBe(
      'bioavailability',
    )
    expect(validateAdministration({ ...base(), bioavailability: Number.NaN })[0]?.field).toBe(
      'bioavailability',
    )
  })

  it('validates the dose basis against a recorded amount', () => {
    // Absent means "not recorded"; it is never defaulted.
    expect(validateAdministration(base())).toEqual([])
    expect(base().doseBasis).toBeUndefined()

    for (const doseBasis of ['per-administration', 'total-regimen', 'unknown'] as const) {
      expect(
        validateAdministration({ ...base(), dose: { value: 50, unit: 'mg' }, doseBasis }),
      ).toEqual([])
    }

    expect(
      validateAdministration({
        ...base(),
        dose: { value: 50, unit: 'mg' },
        doseBasis: 'per-dose' as never,
      })[0]?.field,
    ).toBe('doseBasis')

    // A basis without an amount describes nothing and is refused rather than
    // stored as an empty claim.
    expect(validateAdministration({ ...base(), doseBasis: 'per-administration' })[0]?.message).toMatch(
      /requires a recorded dose/i,
    )
  })

  it('rejects infusion details when the recorded route is not IV infusion', () => {    const issues = validateAdministration({
      ...base(),
      infusion: { duration: { value: 2, unit: 'h' } },
    })
    expect(issues.some((issue) => issue.field === 'infusion' && /requires the IV-infusion route/i.test(issue.message))).toBe(true)
  })

  it('requires F = 1 for an explicitly intravenous route', () => {
    for (const route of ['iv-bolus', 'iv-infusion'] as const) {
      const issues = validateAdministration({
        route,
        regimen: 'single-dose',
        timeReference: route === 'iv-bolus' ? 'dose-time' : 'infusion-start',
        bioavailability: 0.8,
      })
      expect(issues.some((issue) => issue.field === 'bioavailability' && /intravenous administration is 1/i.test(issue.message))).toBe(true)
    }

    // Explicitly recording F = 1 is consistent with IV administration.
    expect(validateAdministration({ ...base(), bioavailability: 1 })).toEqual([])
  })

  it('rejects unknown enum values', () => {
    const bad = { route: 'oral', regimen: 'steady', timeReference: 'clock' } as unknown as AdministrationMetadata
    const issues = validateAdministration(bad)
    expect(issues.map((issue) => issue.field).sort()).toEqual(['regimen', 'route', 'timeReference'])
  })
})
