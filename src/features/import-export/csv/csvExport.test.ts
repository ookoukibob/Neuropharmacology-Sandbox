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

const headerIndex = (name: string): number => CSV_HEADERS.indexOf(name)

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

describe('CSV export — spreadsheet formula injection guard', () => {
  /** A record whose every text surface carries a dangerous leading value. */
  const hostile = syntheticLibrary([
    syntheticDrug({
      identifiers: {
        name: '=1+1',
        synonyms: ['+SUM(A1:A9)', 'Plain synonym'],
        description: ' -2+3 hidden behind a space',
        casNumber: '@SYSTEM("id")',
      },
      tags: ['-tag-looking'],
      notes: '\t=cmd|calc',
      targets: [
        {
          id: '-target-id',
          name: '=HAZARD',
          gene: '+GENE',
          action: 'agonist',
          species: '@species',
          kd: {
            value: -2.5,
            unit: 'nM',
            provenance: {
              type: 'literature',
              source: '=EVIL("source")',
              citation: 'Synthetic hostile fixture, 2026',
              notes: 'provenance note with = inside is inert mid-cell',
            },
          },
          ic50: {
            value: 1e-9,
            unit: 'M',
            provenance: { type: 'user', recordedAt: '2026-01-01T00:00:00.000Z' },
          },
        },
      ],
      pharmacokinetics: {
        halfLife: {
          value: 0,
          unit: 'h',
          provenance: { type: 'user', recordedAt: '2026-01-01T00:00:00.000Z' },
        },
      },
    }),
  ])

  it('guards dangerous text cells in the actual exported rows', () => {
    const [row] = libraryToCsvRows(hostile)
    expect(row).toBeDefined()
    expect(row![headerIndex('name')]).toBe("'=1+1")
    expect(row![headerIndex('synonyms')]).toBe("'+SUM(A1:A9); Plain synonym")
    expect(row![headerIndex('description')]).toBe("' -2+3 hidden behind a space")
    expect(row![headerIndex('cas_number')]).toBe("'@SYSTEM(\"id\")")
    expect(row![headerIndex('tags')]).toBe("'-tag-looking")
    expect(row![headerIndex('notes')]).toBe("'\t=cmd|calc")
    expect(row![headerIndex('target_id')]).toBe("'-target-id")
    expect(row![headerIndex('target_name')]).toBe("'=HAZARD")
    expect(row![headerIndex('target_gene')]).toBe("'+GENE")
    expect(row![headerIndex('target_species')]).toBe("'@species")
    // Provenance source cells are untrusted text too.
    expect(row![headerIndex('kd_provenance_source')]).toBe("'=EVIL(\"source\")")
    expect(row![headerIndex('kd_provenance_type')]).toBe('literature')
  })

  it('preserves numeric scientific cells byte-exact (negatives, zero, notation)', () => {
    const [row] = libraryToCsvRows(hostile)
    expect(row![headerIndex('kd')]).toBe('-2.5')
    expect(row![headerIndex('ic50')]).toBe('1e-9')
    expect(row![headerIndex('half_life')]).toBe('0')
    // No apostrophe ever lands on a value cell — guarding them would
    // corrupt legitimate negative numbers.
    expect(row![headerIndex('kd')]).not.toMatch(/^'/)
    expect(row![headerIndex('kd_unit')]).toBe('nM')
    expect(row![headerIndex('half_life_unit')]).toBe('h')
  })

  it('produces structurally valid CSV that parses back cell-for-cell', () => {
    const text = libraryToCsv(hostile)
    const result = parseCsv(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.table.headers).toEqual([...CSV_HEADERS])
    expect(result.table.rows).toEqual(libraryToCsvRows(hostile))
    // JSON companion cells still start with `{` (inert by shape) and parse.
    const json = result.table.rows[0]![headerIndex('kd_provenance_json')]!
    expect(json.startsWith('{')).toBe(true)
    expect(JSON.parse(json)).toEqual({
      citation: 'Synthetic hostile fixture, 2026',
      notes: 'provenance note with = inside is inert mid-cell',
    })
  })

  it('never mutates the library — the guard exists only in the CSV text', () => {
    const before = JSON.stringify(hostile)
    libraryToCsv(hostile)
    libraryToCsvRows(hostile)
    expect(JSON.stringify(hostile)).toBe(before)
    expect(hostile.drugs[0]?.identifiers.name).toBe('=1+1')
    expect(hostile.drugs[0]?.targets[0]?.kd?.value).toBe(-2.5)
  })

  it('leaves ordinary records byte-identical (no apostrophes appear)', () => {
    const text = libraryToCsv(library)
    expect(text).not.toContain("'")
    const result = parseCsv(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.table.rows[0]?.[headerIndex('name')]).toBe('Fixture Compound A')
    expect(result.table.rows[0]?.[headerIndex('kd')]).toBe('12.4')
  })
})
