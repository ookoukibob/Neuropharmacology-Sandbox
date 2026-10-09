/**
 * CSV export tests — stable header schema, one row per target, provenance
 * companion columns, and escaping safety through a parse round trip.
 * Fixtures are synthetic test data (see src/tests/fixtures.ts).
 */
import { describe, expect, it } from 'vitest'
import { syntheticDrug, syntheticDrugB, syntheticLibrary } from '../../../tests/fixtures'
import { CSV_HEADERS, libraryToCsv, libraryToCsvRows } from './csvExport'
import { CSV_PARAMS } from './params'
import { parseCsv } from './parseCsv'

const library = syntheticLibrary([syntheticDrug(), syntheticDrugB()])

describe('CSV export — schema', () => {
  it('has a stable, unique header covering identity, target and PK columns', () => {
    expect(CSV_HEADERS).toHaveLength(57)
    expect(new Set(CSV_HEADERS).size).toBe(CSV_HEADERS.length)
    for (const required of [
      'drug_id',
      'origin',
      'name',
      'target_id',
      'target_name',
      'kd',
      'kd_unit',
      'kd_provenance_type',
      'kd_provenance_source',
      'kd_provenance_json',
      'ic50',
      'pk_notes',
      'half_life',
      'volume_of_distribution_unit',
      'bioavailability_provenance_json',
    ]) {
      expect(CSV_HEADERS).toContain(required)
    }
  })

  it('orders every parameter as value, unit, type, source, json', () => {
    for (const param of CSV_PARAMS) {
      const start = CSV_HEADERS.indexOf(param.column)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(CSV_HEADERS.slice(start, start + 5)).toEqual([
        param.column,
        `${param.column}_unit`,
        `${param.column}_provenance_type`,
        `${param.column}_provenance_source`,
        `${param.column}_provenance_json`,
      ])
    }
  })
})

describe('CSV export — rows', () => {
  it('produces one row per target and one row for a drug without targets', () => {
    // syntheticDrug has 2 targets, syntheticDrugB has none → 3 rows.
    const rows = libraryToCsvRows(library)
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row).toHaveLength(CSV_HEADERS.length)
    expect(rows[2]?.[0]).toBe('fixture-drug-2')
    expect(rows[2]?.[10]).toBe('') // target_id empty for the targetless drug
  })

  it('repeats drug-level identity on every target row', () => {
    const rows = libraryToCsvRows(library)
    expect(rows[0]?.[0]).toBe('fixture-drug-1')
    expect(rows[1]?.[0]).toBe('fixture-drug-1')
    expect(rows[0]?.[2]).toBe('Fixture Compound A')
    expect(rows[1]?.[2]).toBe('Fixture Compound A')
  })

  it('keeps storage origin distinct from provenance columns', () => {
    const rows = libraryToCsvRows(library)
    const originIndex = CSV_HEADERS.indexOf('origin')
    expect(rows[0]?.[originIndex]).toBe('user')
    // kd provenance type is literature, origin stays 'user' — never merged.
    expect(rows[0]?.[CSV_HEADERS.indexOf('kd_provenance_type')]).toBe('literature')
  })

  it('splits literature provenance into type, source and JSON remainder', () => {
    const rows = libraryToCsvRows(library)
    const kdStart = CSV_HEADERS.indexOf('kd')
    const [value, unit, type, source, json] = rows[0]!.slice(kdStart, kdStart + 5) as [
      string,
      string,
      string,
      string,
      string,
    ]
    expect(value).toBe('12.4')
    expect(unit).toBe('nM')
    expect(type).toBe('literature')
    expect(source).toBe('Synthetic fixture source')
    expect(JSON.parse(json)).toEqual({ citation: 'Invented for tests, 2026' })
  })

  it('serializes user provenance with an empty source cell', () => {
    const rows = libraryToCsvRows(library)
    const ic50Start = CSV_HEADERS.indexOf('ic50')
    const cells = rows[1]!.slice(ic50Start, ic50Start + 5)
    expect(cells[2]).toBe('user')
    expect(cells[3]).toBe('')
    expect(JSON.parse(cells[4]!)).toEqual({ recordedAt: '2026-01-01T00:00:00.000Z' })
  })
})

describe('CSV export — serialization', () => {
  it('round trips through the CSV parser with identical headers and rows', () => {
    const text = libraryToCsv(library)
    const result = parseCsv(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.table.headers).toEqual([...CSV_HEADERS])
    expect(result.table.rows).toEqual(libraryToCsvRows(library))
  })

  it('escapes CSV-sensitive characters in names and descriptions', () => {
    const tricky = syntheticDrug({
      identifiers: {
        name: 'Compound, "Q"',
        synonyms: ['Q, one'],
        description: 'line1\nline2',
      },
      tags: ['a,b'],
    })
    const text = libraryToCsv(syntheticLibrary([tricky]))
    const result = parseCsv(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.table.rows[0]?.[2]).toBe('Compound, "Q"')
    expect(result.table.rows[0]?.[3]).toBe('Q, one')
    expect(result.table.rows[0]?.[4]).toBe('line1\nline2')
    expect(result.table.rows[0]?.[6]).toBe('a,b')
  })
})
