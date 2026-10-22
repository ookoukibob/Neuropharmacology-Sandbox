import { describe, expect, it } from 'vitest'
import {
  concentrationUnitIssue,
  normalizeDatasetName,
  normalizeDatasetNotes,
  normalizeMeasurementNote,
  normalizeSampleId,
  timeUnitIssue,
  toDatasetSummary,
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
