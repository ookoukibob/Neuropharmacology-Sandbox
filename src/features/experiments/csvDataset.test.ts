import { describe, expect, it } from 'vitest'
import type { CsvTable } from '@/features/import-export/csv/parseCsv'
import {
  buildDatasetFromCsv,
  readExperimentalCsv,
  type CsvDatasetMapping,
} from './csvDataset'

const IMPORTED_AT = '2026-01-02T03:04:05.000Z'

function table(text: string): CsvTable {
  const parsed = readExperimentalCsv(text)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.table
}

const BASE_MAPPING: CsvDatasetMapping = {
  datasetName: 'Study A',
  notes: 'Imported notes',
  timeColumn: 0,
  timeUnit: 'h',
  concentrationColumn: 1,
  concentrationUnit: 'mg/L',
  sampleColumn: null,
  noteColumn: null,
  allowCensored: false,
  lloqColumn: null,
}

const SAMPLE_TABLE = table(
  'time,conc,sample,note\n0,0,A,first\n0,0,A,duplicate\n2,1.5,B,third\n',
)

describe('CSV experimental dataset import', () => {
  it('preserves source order, duplicate timestamps, exact replicates and optional fields', () => {
    const preview = buildDatasetFromCsv(
      SAMPLE_TABLE,
      { ...BASE_MAPPING, sampleColumn: 2, noteColumn: 3 },
      'study-a.csv',
      IMPORTED_AT,
    )
    expect(preview.issues).toEqual([])
    expect(preview.rowCount).toBe(3)
    expect(preview.validRowCount).toBe(3)
    if (preview.dataset === undefined) throw new Error('expected a valid dataset')
    expect(preview.dataset.name).toBe('Study A')
    expect(preview.dataset.timeUnit).toBe('h')
    expect(preview.dataset.concentrationUnit).toBe('mg/L')
    expect(preview.dataset.provenance).toEqual({
      source: 'csv',
      fileName: 'study-a.csv',
      importedAt: IMPORTED_AT,
    })
    expect(preview.dataset.measurements).toEqual([
      { sourceRow: 1, time: 0, concentration: 0, sampleId: 'A', note: 'first' },
      { sourceRow: 2, time: 0, concentration: 0, sampleId: 'A', note: 'duplicate' },
      { sourceRow: 3, time: 2, concentration: 1.5, sampleId: 'B', note: 'third' },
    ])
    // Exactly three stored points: no averaging, deduplication or sorting.
    expect(preview.dataset.measurements).toHaveLength(3)
  })

  it('preserves accepted sample id, measurement note and dataset notes exactly', () => {
    const preview = buildDatasetFromCsv(
      table('time,conc,sample,note\n0,1," S-01 "," measured at 5 min "\n'),
      {
        ...BASE_MAPPING,
        notes: ' dataset-level note ',
        sampleColumn: 2,
        noteColumn: 3,
      },
      'exact-text.csv',
      IMPORTED_AT,
    )
    expect(preview.issues).toEqual([])
    expect(preview.dataset?.notes).toBe(' dataset-level note ')
    expect(preview.dataset?.measurements).toEqual([
      {
        sourceRow: 1,
        time: 0,
        concentration: 1,
        sampleId: ' S-01 ',
        note: ' measured at 5 min ',
      },
    ])
  })

  it('rejects qualifiers and markers with the exact data row and no dataset', () => {
    const cases = ['<0.1', 'BLQ', 'N/A', '>5', '0.1-0.2', '']
    for (const value of cases) {
      const preview = buildDatasetFromCsv(
        table(`time,conc\n1,${value}\n`),
        BASE_MAPPING,
        'bad.csv',
        IMPORTED_AT,
      )
      expect(preview.dataset).toBeUndefined()
      expect(preview.invalidRowCount).toBe(1)
      expect(preview.issues.some((entry) => entry.message.includes('data row 1'))).toBe(true)
      expect(preview.issues.some((entry) => entry.column === 'conc')).toBe(true)
    }
  })

  it('rejects negative and non-finite values, but accepts zero', () => {
    const negative = buildDatasetFromCsv(
      table('time,conc\n-1,2\n'),
      BASE_MAPPING,
      'negative.csv',
      IMPORTED_AT,
    )
    expect(negative.dataset).toBeUndefined()
    expect(negative.issues[0]?.message).toContain('data row 1')
    expect(negative.issues[0]?.message).toContain('negative')

    const overflow = buildDatasetFromCsv(
      table('time,conc\n1,1e999\n'),
      BASE_MAPPING,
      'overflow.csv',
      IMPORTED_AT,
    )
    expect(overflow.dataset).toBeUndefined()
    expect(overflow.issues[0]?.message).toContain('not a finite number')

    const zero = buildDatasetFromCsv(
      table('time,conc\n0,0\n'),
      BASE_MAPPING,
      'zero.csv',
      IMPORTED_AT,
    )
    expect(zero.dataset?.measurements).toEqual([{ sourceRow: 1, time: 0, concentration: 0 }])
  })

  it('reports every invalid row and writes nothing (all-or-nothing)', () => {
    const preview = buildDatasetFromCsv(
      table('time,conc\n0,1\nbad,2\n3,-4\n'),
      BASE_MAPPING,
      'mixed.csv',
      IMPORTED_AT,
    )
    expect(preview.dataset).toBeUndefined()
    expect(preview.rowCount).toBe(3)
    expect(preview.validRowCount).toBe(1)
    expect(preview.invalidRowCount).toBe(2)
    expect(preview.issues.map((entry) => entry.row)).toEqual([2, 3])
  })

  it('requires explicit columns and explicit catalog units', () => {
    const missingColumns = buildDatasetFromCsv(
      SAMPLE_TABLE,
      {
        ...BASE_MAPPING,
        timeColumn: null,
        concentrationColumn: null,
        timeUnit: '',
        concentrationUnit: '',
      },
      'study.csv',
      IMPORTED_AT,
    )
    expect(missingColumns.dataset).toBeUndefined()
    expect(missingColumns.issues.map((entry) => entry.message).join(' ')).toContain(
      'time unit is required',
    )
    expect(missingColumns.issues.map((entry) => entry.message).join(' ')).toContain(
      'concentration unit is required',
    )
    expect(missingColumns.issues.map((entry) => entry.message).join(' ')).toContain(
      'time column must be selected',
    )
    expect(missingColumns.issues.map((entry) => entry.message).join(' ')).toContain(
      'concentration column must be selected',
    )
  })

  it('rejects a source column mapped to two destinations', () => {
    const preview = buildDatasetFromCsv(
      SAMPLE_TABLE,
      { ...BASE_MAPPING, sampleColumn: 0 },
      'study.csv',
      IMPORTED_AT,
    )
    expect(preview.dataset).toBeUndefined()
    expect(preview.issues.map((entry) => entry.message).join(' ')).toContain(
      'only one destination',
    )
  })

  it('does not infer units from headers that happen to look like units', () => {
    const preview = buildDatasetFromCsv(
      table('time (h),conc (mg/L)\n1,2\n'),
      {
        ...BASE_MAPPING,
        timeUnit: '',
        concentrationUnit: '',
      },
      'units-in-header.csv',
      IMPORTED_AT,
    )
    expect(preview.dataset).toBeUndefined()
    expect(preview.issues.map((entry) => entry.message).join(' ')).toContain('time unit is required')
  })

  it('enforces the row-count limit in the reader', () => {
    const rows = Array.from({ length: 25_001 }, () => '0,1').join('\n')
    const parsed = readExperimentalCsv(`time,conc\n${rows}\n`)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('25,001')
    expect(parsed.error).toContain('25,000')
  })

  it('interprets "<number" as a below-limit record only when explicitly enabled', () => {
    const csv = table('time,conc\n0,5\n1,<0.1\n')
    const enabled = buildDatasetFromCsv(
      csv,
      { ...BASE_MAPPING, allowCensored: true },
      'blq.csv',
      IMPORTED_AT,
    )
    expect(enabled.issues).toEqual([])
    expect(enabled.dataset?.measurements).toEqual([
      { sourceRow: 1, time: 0, concentration: 5 },
      { sourceRow: 2, time: 1, censored: true, censoring: 'below-quantification-limit', rawText: '<0.1', limit: 0.1 },
    ])

    const disabled = buildDatasetFromCsv(csv, BASE_MAPPING, 'blq.csv', IMPORTED_AT)
    expect(disabled.dataset).toBeUndefined()
    expect(disabled.issues.some((entry) => entry.message.includes('data row 2'))).toBe(true)
  })

  it('requires an explicit LLOQ column for BLQ / <LLOQ markers', () => {
    const csv = table('time,conc,lloq\n0,5,0.1\n1,BLQ,0.1\n')
    const withLloq = buildDatasetFromCsv(
      csv,
      { ...BASE_MAPPING, allowCensored: true, lloqColumn: 2 },
      'blq.csv',
      IMPORTED_AT,
    )
    expect(withLloq.dataset?.measurements).toEqual([
      { sourceRow: 1, time: 0, concentration: 5 },
      { sourceRow: 2, time: 1, censored: true, censoring: 'below-quantification-limit', rawText: 'BLQ', limit: 0.1 },
    ])

    const withoutLloq = buildDatasetFromCsv(
      table('time,conc\n1,BLQ\n'),
      { ...BASE_MAPPING, allowCensored: true },
      'blq.csv',
      IMPORTED_AT,
    )
    expect(withoutLloq.dataset).toBeUndefined()
    expect(withoutLloq.issues[0]?.message).toMatch(/map an LLOQ column/i)
  })

  it('rejects an inline bound that conflicts with a mapped LLOQ column', () => {
    const preview = buildDatasetFromCsv(
      table('time,conc,lloq\n1,<0.1,0.5\n'),
      { ...BASE_MAPPING, allowCensored: true, lloqColumn: 2 },
      'blq.csv',
      IMPORTED_AT,
    )
    expect(preview.dataset).toBeUndefined()
    expect(preview.issues.some((entry) => entry.message.includes('conflicts with the LLOQ'))).toBe(true)
  })

  it('rejects a non-positive, non-finite or unparsable LLOQ', () => {
    for (const value of ['0', '-1', 'abc', '']) {
      const preview = buildDatasetFromCsv(
        table(`time,conc,lloq\n1,BLQ,${value}\n`),
        { ...BASE_MAPPING, allowCensored: true, lloqColumn: 2 },
        'blq.csv',
        IMPORTED_AT,
      )
      expect(preview.dataset).toBeUndefined()
      expect(preview.issues.some((entry) => entry.message.includes('data row 1'))).toBe(true)
    }
  })

  it('keeps quantified and censored records distinct in a mixed file', () => {
    const preview = buildDatasetFromCsv(
      table('time,conc\n0,5\n1,<0.1\n2,4\n'),
      { ...BASE_MAPPING, allowCensored: true },
      'mixed.csv',
      IMPORTED_AT,
    )
    expect(preview.issues).toEqual([])
    expect(preview.validRowCount).toBe(3)
    expect(preview.dataset?.measurements).toHaveLength(3)
    // The limit is never a measured concentration: no "0.1" appears as a value.
    const serialized = JSON.stringify(preview.dataset?.measurements)
    expect(serialized).toContain('"limit":0.1')
    expect(serialized).not.toContain('"concentration":0.1')
  })
})
