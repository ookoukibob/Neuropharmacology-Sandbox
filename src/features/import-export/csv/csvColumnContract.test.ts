/**
 * NV-3 — exhaustive 57-column CSV contract (phase 22).
 *
 * Every actual header has explicit executable coverage here:
 * - the full ordered header is pinned as an independent literal (drift
 *   detection: a production header change cannot bypass this file);
 * - a fully populated marker library asserts the intended exported cell
 *   value of ALL 57 columns (table-driven, not just "the header exists");
 * - the complete importable set (56 destinations) is round-tripped through
 *   the real parser → explicit mapping → NPSL validation → repository;
 * - every deliberate transformation/loss boundary is asserted as policy:
 *   `origin` is exported but never importable (imports stamp "imported"),
 *   formula-guard apostrophes survive re-import verbatim, `-0` loses its
 *   sign, unknown forward-compatible fields are dropped, empty cells
 *   become absent optionals, missing provenance is stamped `{type:'user'}`.
 *
 * CSV is a lossy projection by contract — `.npsl` remains the lossless
 * backup. All fixture values are synthetic test data, never
 * pharmacological information.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SandboxDatabase } from '@/data/db/database'
import { previewNpslImport } from '@/data/import/importPipeline'
import { serializeNpslDocument, type NpslDocument } from '@/data/mappers/npslDocument'
import { DexieDrugRepository } from '@/data/repositories/dexieDrugRepository'
import type { Drug } from '@/domain/drug/drug'
import type { LibraryMetadata } from '@/domain/library/library'
import { syntheticLibrary } from '../../../tests/fixtures'
import { CSV_HEADERS, libraryToCsv, libraryToCsvRows } from './csvExport'
import {
  buildCsvImport,
  CSV_DESTINATIONS,
  type CsvBuildResult,
  type CsvImportContext,
  type CsvMappingState,
} from './csvImport'
import { parseCsv } from './parseCsv'

/* ------------------------------------------------------------------ */
/* The header contract — written independently of the implementation.  */
/* ------------------------------------------------------------------ */

const EXPECTED_HEADERS: readonly string[] = [
  // drug-level (10)
  'drug_id',
  'origin',
  'name',
  'synonyms',
  'description',
  'cas_number',
  'tags',
  'notes',
  'created_at',
  'updated_at',
  // target-level (6)
  'target_id',
  'target_name',
  'target_gene',
  'target_action',
  'target_species',
  'target_notes',
  // target parameters (4 × 5)
  'kd',
  'kd_unit',
  'kd_provenance_type',
  'kd_provenance_source',
  'kd_provenance_json',
  'ki',
  'ki_unit',
  'ki_provenance_type',
  'ki_provenance_source',
  'ki_provenance_json',
  'ec50',
  'ec50_unit',
  'ec50_provenance_type',
  'ec50_provenance_source',
  'ec50_provenance_json',
  'ic50',
  'ic50_unit',
  'ic50_provenance_type',
  'ic50_provenance_source',
  'ic50_provenance_json',
  // PK notes (1)
  'pk_notes',
  // PK parameters (4 × 5)
  'half_life',
  'half_life_unit',
  'half_life_provenance_type',
  'half_life_provenance_source',
  'half_life_provenance_json',
  'clearance',
  'clearance_unit',
  'clearance_provenance_type',
  'clearance_provenance_source',
  'clearance_provenance_json',
  'volume_of_distribution',
  'volume_of_distribution_unit',
  'volume_of_distribution_provenance_type',
  'volume_of_distribution_provenance_source',
  'volume_of_distribution_provenance_json',
  'bioavailability',
  'bioavailability_unit',
  'bioavailability_provenance_type',
  'bioavailability_provenance_source',
  'bioavailability_provenance_json',
]

/** Destination id per importable header. `origin` is the sole omission. */
const HEADER_DESTINATION: Record<string, string> = {
  drug_id: 'drug.id',
  name: 'drug.name',
  synonyms: 'drug.synonyms',
  description: 'drug.description',
  cas_number: 'drug.casNumber',
  tags: 'drug.tags',
  notes: 'drug.notes',
  created_at: 'drug.createdAt',
  updated_at: 'drug.updatedAt',
  target_id: 'target.id',
  target_name: 'target.name',
  target_gene: 'target.gene',
  target_action: 'target.action',
  target_species: 'target.species',
  target_notes: 'target.notes',
  pk_notes: 'pk.notes',
}
/** Parameter column → domain key (value/unit/provenance companions). */
const PARAM_KEY_BY_COLUMN: Record<string, string> = {
  kd: 'kd',
  ki: 'ki',
  ec50: 'ec50',
  ic50: 'ic50',
  half_life: 'halfLife',
  clearance: 'clearance',
  volume_of_distribution: 'volumeOfDistribution',
  bioavailability: 'bioavailability',
}
for (const [column, key] of Object.entries(PARAM_KEY_BY_COLUMN)) {
  HEADER_DESTINATION[column] = `${key}.value`
  HEADER_DESTINATION[`${column}_unit`] = `${key}.unit`
  HEADER_DESTINATION[`${column}_provenance_type`] = `${key}.prov.type`
  HEADER_DESTINATION[`${column}_provenance_source`] = `${key}.prov.source`
  HEADER_DESTINATION[`${column}_provenance_json`] = `${key}.prov.json`
}

/* ------------------------------------------------------------------ */
/* Fully populated marker library                                      */
/* ------------------------------------------------------------------ */

const T1: Drug['targets'][number] = {
  id: 'nv3-target-1',
  name: 'NV3 Target One',
  gene: 'NV3G1',
  action: 'agonist',
  species: 'human',
  notes: 'NV3 target-one notes',
  // literature provenance with citation + doi → JSON remainder of 2 keys
  kd: {
    value: -2.5,
    unit: 'nM',
    provenance: {
      type: 'literature',
      source: 'NV3 kd source',
      citation: 'NV3 kd citation',
      doi: '10.0000/nv3.kd',
    },
  },
  // user provenance (recordedAt → JSON remainder)
  ki: {
    value: 0.5,
    unit: 'nM',
    provenance: { type: 'user', recordedAt: '2026-01-02T00:00:00.000Z' },
  },
  // calculated provenance (model + recordedAt); scientific-notation value
  ec50: {
    value: 1e-9,
    unit: 'M',
    provenance: {
      type: 'calculated',
      model: 'nv3.test-model',
      recordedAt: '2026-01-03T00:00:00.000Z',
    },
  },
  // derived provenance (method + from array + recordedAt)
  ic50: {
    value: 42,
    unit: 'µM',
    provenance: {
      type: 'derived',
      method: 'k = ln(2) / t½',
      from: ['half_life'],
      recordedAt: '2026-01-04T00:00:00.000Z',
    },
  },
}

/** Sparse target: only a name and a Kd with note-less-unknown provenance. */
const T2: Drug['targets'][number] = {
  id: 'nv3-target-2',
  name: 'NV3 Target Two',
  kd: {
    value: 7,
    unit: 'nM',
    provenance: { type: 'unknown', notes: 'NV3 unknown-provenance note' },
  },
}

const MARKER_DRUG: Drug = {
  id: 'nv3-drug-1',
  origin: 'user',
  identifiers: {
    name: 'NV3 Marker Drug',
    synonyms: ['NVM-1', 'NVM-2'],
    description: 'NV3 marker description',
    casNumber: '50-78-2',
  },
  tags: ['nv3-tag-a', 'nv3-tag-b'],
  targets: [T1, T2],
  pharmacokinetics: {
    halfLife: {
      value: 5.5,
      unit: 'h',
      provenance: {
        type: 'literature',
        source: 'NV3 hl source',
        citation: 'NV3 hl citation',
      },
    },
    // free-text unit (catalog has no clearance dimension)
    clearance: {
      value: 12.5,
      unit: 'L/h',
      provenance: { type: 'user', recordedAt: '2026-01-05T00:00:00.000Z' },
    },
    volumeOfDistribution: {
      value: 3.3,
      unit: 'L',
      provenance: { type: 'unknown' }, // no notes → EMPTY JSON cell
    },
    bioavailability: {
      value: 0.85,
      unit: 'fraction',
      provenance: { type: 'calculated', model: 'nv3.test-model' },
    },
    notes: 'NV3 pharmacokinetic notes',
  },
  notes: 'NV3 drug notes',
  createdAt: '2026-01-06T00:00:00.000Z',
  updatedAt: '2026-01-07T00:00:00.000Z',
}

/** Targetless drug whose every text surface is hostile/hostile-adjacent. */
const HOSTILE_DRUG: Drug = {
  id: 'nv3-drug-2',
  origin: 'imported', // stored origin is carried verbatim into the column
  identifiers: {
    name: '=1+1 hostile name',
    synonyms: ['comma, synonym', 'quote"synonym', 'line\nbreak'],
    description: ' leading space and "quotes", plus\na newline',
    casNumber: '@CAS-TRIGGER',
  },
  tags: ['-tag-trigger', 'tag,with,commas'],
  targets: [],
  pharmacokinetics: { notes: '\t=pk|calc' },
  notes: '+1-900 host notes',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
}

const library = syntheticLibrary([MARKER_DRUG, HOSTILE_DRUG])
const rows = libraryToCsvRows(library)

const index = (header: string): number => EXPECTED_HEADERS.indexOf(header)
const cell = (row: readonly string[], header: string): string => row[index(header)]!

/* The intended exported value of every one of the 57 columns for the
 * fully populated marker row (drug 1 / target 1). */
const EXPECTED_MARKER_ROW: Record<string, string> = {
  drug_id: 'nv3-drug-1',
  origin: 'user',
  name: 'NV3 Marker Drug',
  synonyms: 'NVM-1; NVM-2',
  description: 'NV3 marker description',
  cas_number: '50-78-2',
  tags: 'nv3-tag-a; nv3-tag-b',
  notes: 'NV3 drug notes',
  created_at: '2026-01-06T00:00:00.000Z',
  updated_at: '2026-01-07T00:00:00.000Z',
  target_id: 'nv3-target-1',
  target_name: 'NV3 Target One',
  target_gene: 'NV3G1',
  target_action: 'agonist',
  target_species: 'human',
  target_notes: 'NV3 target-one notes',
  kd: '-2.5',
  kd_unit: 'nM',
  kd_provenance_type: 'literature',
  kd_provenance_source: 'NV3 kd source',
  kd_provenance_json: '{"citation":"NV3 kd citation","doi":"10.0000/nv3.kd"}',
  ki: '0.5',
  ki_unit: 'nM',
  ki_provenance_type: 'user',
  ki_provenance_source: '',
  ki_provenance_json: '{"recordedAt":"2026-01-02T00:00:00.000Z"}',
  ec50: '1e-9',
  ec50_unit: 'M',
  ec50_provenance_type: 'calculated',
  ec50_provenance_source: '',
  ec50_provenance_json: '{"model":"nv3.test-model","recordedAt":"2026-01-03T00:00:00.000Z"}',
  ic50: '42',
  ic50_unit: 'µM',
  ic50_provenance_type: 'derived',
  ic50_provenance_source: '',
  ic50_provenance_json:
    '{"method":"k = ln(2) / t½","from":["half_life"],"recordedAt":"2026-01-04T00:00:00.000Z"}',
  pk_notes: 'NV3 pharmacokinetic notes',
  half_life: '5.5',
  half_life_unit: 'h',
  half_life_provenance_type: 'literature',
  half_life_provenance_source: 'NV3 hl source',
  half_life_provenance_json: '{"citation":"NV3 hl citation"}',
  clearance: '12.5',
  clearance_unit: 'L/h',
  clearance_provenance_type: 'user',
  clearance_provenance_source: '',
  clearance_provenance_json: '{"recordedAt":"2026-01-05T00:00:00.000Z"}',
  volume_of_distribution: '3.3',
  volume_of_distribution_unit: 'L',
  volume_of_distribution_provenance_type: 'unknown',
  volume_of_distribution_provenance_source: '',
  volume_of_distribution_provenance_json: '',
  bioavailability: '0.85',
  bioavailability_unit: 'fraction',
  bioavailability_provenance_type: 'calculated',
  bioavailability_provenance_source: '',
  bioavailability_provenance_json: '{"model":"nv3.test-model"}',
}

/* ------------------------------------------------------------------ */
/* Mapping helpers (the strongest path: real export → real mapping)    */
/* ------------------------------------------------------------------ */

const CONTEXT: CsvImportContext = {
  now: '2026-03-01T00:00:00.000Z',
  metadata: {
    id: 'nv3-library',
    name: 'NV3 Synthetic Library',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    dataStatus: 'example',
  } satisfies LibraryMetadata,
}

function mappingState(
  text: string,
): { state: CsvMappingState; parsed: ReturnType<typeof parseCsv> } {
  const parsed = parseCsv(text)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.error)
  return {
    state: {
      fileName: 'nv3.csv',
      headers: parsed.table.headers,
      rows: parsed.table.rows,
      destinations: parsed.table.headers.map((h) => HEADER_DESTINATION[h] ?? null),
      fixedUnits: {},
    },
    parsed,
  }
}

function buildFromExport(source: DrugLibraryLike): CsvBuildResult {
  return buildCsvImport(mappingState(libraryToCsv(source)).state, CONTEXT)
}

type DrugLibraryLike = Parameters<typeof libraryToCsv>[0]

function expectOkDocument(result: CsvBuildResult): NpslDocument {
  expect(result.errors).toEqual([])
  expect(result.ok).toBe(true)
  if (result.document === null) throw new Error('expected a document')
  return result.document
}

/* ------------------------------------------------------------------ */
/* A. Header contract                                                  */
/* ------------------------------------------------------------------ */

describe('CSV column contract — header (57 columns, pinned order)', () => {
  it('pins the full ordered header — every name, every position', () => {
    expect(CSV_HEADERS).toEqual(EXPECTED_HEADERS)
  })

  it('has exactly 57 columns, all unique, and none empty', () => {
    expect(CSV_HEADERS).toHaveLength(57)
    expect(new Set(CSV_HEADERS).size).toBe(57)
    for (const header of CSV_HEADERS) expect(header).not.toBe('')
  })

  it('emits the same 57 names as the CSV text header line', () => {
    const text = libraryToCsv(library)
    expect(text.split('\r\n')[0]).toBe(EXPECTED_HEADERS.join(','))
  })

  it('gives every data row exactly 57 cells in header order', () => {
    expect(rows).toHaveLength(3) // 2 targets of drug 1 + targetless drug 2
    for (const row of rows) expect(row).toHaveLength(57)
  })

  it('accounts for every header in the value matrix — no untested column', () => {
    expect(Object.keys(EXPECTED_MARKER_ROW).sort()).toEqual([...EXPECTED_HEADERS].sort())
  })
})

/* ------------------------------------------------------------------ */
/* B. Export-field matrix                                              */
/* ------------------------------------------------------------------ */

describe('CSV column contract — export matrix (all 57 columns)', () => {
  it('exports every column of the fully populated row to its intended value', () => {
    const row = rows[0]!
    for (const header of EXPECTED_HEADERS) {
      expect(cell(row, header), `column "${header}"`).toBe(EXPECTED_MARKER_ROW[header])
    }
  })

  it('repeats drug-level and PK values on the second target row and empties the other params', () => {
    const row = rows[1]!
    for (const header of [
      'drug_id',
      'origin',
      'name',
      'synonyms',
      'description',
      'cas_number',
      'tags',
      'notes',
      'created_at',
      'updated_at',
      'pk_notes',
      'half_life',
      'half_life_unit',
      'half_life_provenance_type',
      'half_life_provenance_source',
      'half_life_provenance_json',
      'clearance',
      'clearance_unit',
      'clearance_provenance_type',
      'clearance_provenance_source',
      'clearance_provenance_json',
      'volume_of_distribution',
      'volume_of_distribution_unit',
      'volume_of_distribution_provenance_type',
      'volume_of_distribution_provenance_source',
      'volume_of_distribution_provenance_json',
      'bioavailability',
      'bioavailability_unit',
      'bioavailability_provenance_type',
      'bioavailability_provenance_source',
      'bioavailability_provenance_json',
    ]) {
      expect(cell(row, header), `repeated column "${header}"`).toBe(EXPECTED_MARKER_ROW[header])
    }
    expect(cell(row, 'target_id')).toBe('nv3-target-2')
    expect(cell(row, 'target_name')).toBe('NV3 Target Two')
    expect(cell(row, 'kd')).toBe('7')
    expect(cell(row, 'kd_provenance_json')).toBe('{"notes":"NV3 unknown-provenance note"}')
    for (const header of [
      'target_gene',
      'target_action',
      'target_species',
      'target_notes',
      'ki',
      'ki_unit',
      'ki_provenance_type',
      'ki_provenance_source',
      'ki_provenance_json',
      'ec50',
      'ec50_unit',
      'ec50_provenance_type',
      'ec50_provenance_source',
      'ec50_provenance_json',
      'ic50',
      'ic50_unit',
      'ic50_provenance_type',
      'ic50_provenance_source',
      'ic50_provenance_json',
    ]) {
      expect(cell(row, header), `absent column "${header}"`).toBe('')
    }
  })

  it('gives a targetless drug one row: identity present, all target and param cells empty', () => {
    const row = rows[2]!
    expect(cell(row, 'drug_id')).toBe('nv3-drug-2')
    expect(cell(row, 'origin')).toBe('imported')
    expect(cell(row, 'pk_notes')).toBe("'\t=pk|calc")
    for (const header of EXPECTED_HEADERS) {
      if (
        [
          'drug_id',
          'origin',
          'name',
          'synonyms',
          'description',
          'cas_number',
          'tags',
          'notes',
          'created_at',
          'updated_at',
          'pk_notes',
        ].includes(header)
      ) {
        continue
      }
      expect(cell(row, header), `targetless column "${header}"`).toBe('')
    }
  })

  it('guards every hostile text cell and keeps hostile-adjacent text exact', () => {
    const row = rows[2]!
    expect(cell(row, 'name')).toBe("'=1+1 hostile name")
    expect(cell(row, 'cas_number')).toBe("'@CAS-TRIGGER")
    expect(cell(row, 'tags')).toBe("'-tag-trigger; tag,with,commas")
    expect(cell(row, 'notes')).toBe("'+1-900 host notes")
    expect(cell(row, 'pk_notes')).toBe("'\t=pk|calc")
    // Not triggers → byte-identical (join/quote/newline/leading-space).
    expect(cell(row, 'synonyms')).toBe('comma, synonym; quote"synonym; line\nbreak')
    expect(cell(row, 'description')).toBe(' leading space and "quotes", plus\na newline')
    // The hostile file still parses back cell-for-cell.
    const parsed = parseCsv(libraryToCsv(library))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.table.rows[2]).toEqual(row)
  })

  it('keeps every numeric cell unguarded and byte-exact (negative, scientific notation)', () => {
    const row = rows[0]!
    expect(cell(row, 'kd')).toBe('-2.5')
    expect(cell(row, 'ec50')).toBe('1e-9')
    expect(cell(row, 'ic50')).toBe('42')
    expect(cell(row, 'half_life')).toBe('5.5')
    expect(cell(row, 'clearance')).toBe('12.5')
    expect(cell(row, 'volume_of_distribution')).toBe('3.3')
    expect(cell(row, 'bioavailability')).toBe('0.85')
    for (const header of EXPECTED_HEADERS.filter((h) => PARAM_KEY_BY_COLUMN[h] !== undefined)) {
      expect(cell(row, header)).not.toMatch(/^'/)
    }
  })
})

/* ------------------------------------------------------------------ */
/* C. Import mapping and round trip                                    */
/* ------------------------------------------------------------------ */

describe('CSV column contract — import destinations', () => {
  it('offers 56 unique destinations; every non-origin header maps bijectively onto them', () => {
    const ids = CSV_DESTINATIONS.map((d) => d.id)
    expect(new Set(ids).size).toBe(56)
    expect(ids).toHaveLength(56)
    const mapped = EXPECTED_HEADERS.filter((h) => h !== 'origin').map((h) => {
      const destination = HEADER_DESTINATION[h]
      expect(destination, `header "${h}" has no destination`).toBeDefined()
      return destination!
    })
    expect(new Set(mapped).size).toBe(56)
    expect([...mapped].sort()).toEqual([...ids].sort())
  })

  it('has no destination for "origin" — a deliberate, tested policy', () => {
    expect(HEADER_DESTINATION['origin']).toBeUndefined()
    expect(CSV_DESTINATIONS.map((d) => d.id)).not.toContain('origin')
  })
})

describe('CSV column contract — full-library round trip (export → parse → map → NPSL)', () => {
  it('rebuilds the marker drug exactly, with storage origin stamped "imported"', () => {
    const document = expectOkDocument(buildFromExport(library))
    const preview = previewNpslImport(serializeNpslDocument(document), [], CONTEXT.now)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.drugs).toHaveLength(2)
    // Every mapped column landed on its destination: descriptors, all four
    // parameters with their distinct provenance variants, PK block, notes
    // and both timestamps — deep equality against the source record.
    expect(preview.drugs[0]).toEqual({ ...MARKER_DRUG, origin: 'imported' })
    // Literature source, user/calculated/derived/unknown provenance and
    // their JSON remainders all survived the split/rejoin.
    const target = preview.drugs[0]!.targets[0]!
    expect(target.kd?.provenance).toEqual(MARKER_DRUG.targets[0]!.kd!.provenance)
    expect(target.ki?.provenance).toEqual(MARKER_DRUG.targets[0]!.ki!.provenance)
    expect(target.ec50?.provenance).toEqual(MARKER_DRUG.targets[0]!.ec50!.provenance)
    expect(target.ic50?.provenance).toEqual(MARKER_DRUG.targets[0]!.ic50!.provenance)
    expect(preview.drugs[0]!.pharmacokinetics.volumeOfDistribution?.provenance).toEqual({
      type: 'unknown',
    })
  })

  it('keeps the targetless drug targetless and preserves its bookkeeping columns', () => {
    const document = expectOkDocument(buildFromExport(library))
    const hostile = document.drugs[1]!
    expect(hostile.targets).toEqual([])
    expect(hostile.createdAt).toBe('2026-02-01T00:00:00.000Z')
    expect(hostile.updatedAt).toBe('2026-02-02T00:00:00.000Z')
  })

  it('applies the documented text transformations on re-import (guard apostrophes, trim, list split)', () => {
    const document = expectOkDocument(buildFromExport(library))
    const hostile = document.drugs[1]!
    // Formula-guard apostrophes are kept verbatim — a lossy boundary.
    expect(hostile.identifiers.name).toBe("'=1+1 hostile name")
    expect(hostile.identifiers.casNumber).toBe("'@CAS-TRIGGER")
    expect(hostile.notes).toBe("'+1-900 host notes")
    expect(hostile.pharmacokinetics.notes).toBe("'\t=pk|calc")
    expect(hostile.tags).toEqual(["'-tag-trigger", 'tag,with,commas'])
    // Cells are trimmed at the edges; interior newlines/quotes/commas stay.
    expect(hostile.identifiers.description).toBe('leading space and "quotes", plus\na newline')
    expect(hostile.identifiers.synonyms).toEqual([
      'comma, synonym',
      'quote"synonym',
      'line\nbreak',
    ])
  })

  it('turns empty cells into ABSENT optionals — never empty-string fields', () => {
    const document = expectOkDocument(buildFromExport(library))
    const marker = document.drugs[0]!
    const sparseTarget = marker.targets[1]!
    expect('gene' in sparseTarget).toBe(false)
    expect('action' in sparseTarget).toBe(false)
    expect('species' in sparseTarget).toBe(false)
    expect('notes' in sparseTarget).toBe(false)
    expect(sparseTarget.ki).toBeUndefined()
    expect(sparseTarget.ec50).toBeUndefined()
    expect(sparseTarget.ic50).toBeUndefined()
    // The empty provenance-JSON cell of `{type:'unknown'}` rejoins exactly.
    expect(sparseTarget.kd?.provenance).toEqual({
      type: 'unknown',
      notes: 'NV3 unknown-provenance note',
    })
  })

  it('stamps library metadata as the current library with dataStatus "user" and updatedAt = now', () => {
    const document = expectOkDocument(buildFromExport(library))
    expect(document.libraryMetadata).toEqual({
      id: 'nv3-library',
      name: 'NV3 Synthetic Library',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: CONTEXT.now,
      dataStatus: 'user',
    })
  })

  it('declares the origin policy and lists "origin" as the only unmapped column', () => {
    const result = buildFromExport(library)
    const notes = result.notes.join('\n')
    expect(notes).toContain('origin "imported"')
    expect(notes).toContain('Not imported (columns left unmapped): "origin".')
  })

  it('commits the CSV-built document through the real repository and reads the records back', async () => {
    const document = expectOkDocument(buildFromExport(library))
    const db = new SandboxDatabase(`nv3-contract-${Date.now()}`)
    try {
      const repo = new DexieDrugRepository(db)
      const report = await repo.importLibrary(serializeNpslDocument(document), {
        mode: 'replace',
      })
      expect(report).toBeDefined()
      const { drugs, quarantine } = await repo.getAllDrugs()
      expect(quarantine).toEqual([])
      expect(drugs).toHaveLength(2)
      expect(drugs[0]).toEqual({ ...MARKER_DRUG, origin: 'imported', revision: 1 })
      // Raw stored rows carry the imported identity verbatim.
      const raw = await db.drugs.get('nv3-drug-1')
      expect(raw?.id).toBe('nv3-drug-1')
      expect(raw?.origin).toBe('imported')
    } finally {
      await db.delete()
    }
  })
})

/* ------------------------------------------------------------------ */
/* D. Policy boundaries and blocking behavior                          */
/* ------------------------------------------------------------------ */

/** Build a CSV data row from header→cell fields (positions cannot drift). */
function csvRow(fields: Record<string, string>): string {
  return EXPECTED_HEADERS.map((h) => fields[h] ?? '').join(',')
}

describe('CSV column contract — transformation and loss policy', () => {
  it('loses the sign of negative zero: CSV emits "0" (NPSL sidecar remains the lossless path)', () => {
    const minusZero: Drug = {
      id: 'nv3-negzero',
      origin: 'user',
      identifiers: { name: 'NV3 NegZero', synonyms: [] },
      tags: [],
      targets: [
        {
          id: 'nv3-nz-target',
          name: 'NV3 NZ',
          kd: { value: -0, unit: 'nM', provenance: { type: 'user' } },
        },
      ],
      pharmacokinetics: {},
    }
    const row = libraryToCsvRows(syntheticLibrary([minusZero]))[0]!
    expect(cell(row, 'kd')).toBe('0') // String(-0) === '0' — sign not representable
    expect(Object.is(Number(cell(row, 'kd')), -0)).toBe(false)
  })

  it('never exports unknown forward-compatible fields — only the 57 columns exist', () => {
    const extended = {
      ...MARKER_DRUG,
      id: 'nv3-drug-extended',
      identifiers: { ...MARKER_DRUG.identifiers, name: 'NV3 Extended Drug' },
      nv3Extension: { future: true },
    } as Drug
    const row = libraryToCsvRows(syntheticLibrary([extended]))[0]!
    expect(row).toHaveLength(57)
    expect(JSON.stringify(row)).not.toContain('nv3Extension')
    const document = expectOkDocument(buildFromExport(syntheticLibrary([extended])))
    expect(JSON.stringify(document)).not.toContain('nv3Extension')
  })

  it('blocks the whole import when one row of a repeated drug id conflicts', () => {
    const text = [
      EXPECTED_HEADERS.join(','),
      csvRow({
        drug_id: 'nv3-x',
        origin: 'user',
        name: 'Same Drug',
        target_id: 't1',
        target_name: 'Target One',
        kd: '4.2',
        kd_unit: 'nM',
      }),
      csvRow({
        drug_id: 'nv3-x',
        origin: 'user',
        name: 'Different Drug',
        target_id: 't2',
        target_name: 'Target Two',
        kd: '9.9',
        kd_unit: 'nM',
      }),
    ].join('\r\n')
    const result = buildCsvImport(mappingState(text).state, CONTEXT)
    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.errors.join(' ')).toContain('share the drug id "nv3-x"')
  })

  it('blocks duplicate target ids inside one drug and names both rows', () => {
    const text = [
      EXPECTED_HEADERS.join(','),
      csvRow({
        drug_id: 'nv3-y',
        origin: 'user',
        name: 'Same Drug',
        target_id: 'dup',
        target_name: 'First Dup',
        kd: '4.2',
        kd_unit: 'nM',
      }),
      csvRow({
        drug_id: 'nv3-y',
        origin: 'user',
        name: 'Same Drug',
        target_id: 'dup',
        target_name: 'Second Dup',
        kd: '9.9',
        kd_unit: 'nM',
      }),
    ].join('\r\n')
    const result = buildCsvImport(mappingState(text).state, CONTEXT)
    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.errors.join(' ')).toContain('repeat the target id "dup"')
  })

  it('rejects an unknown target action and an invalid provenance type with blocking messages', () => {
    const badAction = [
      EXPECTED_HEADERS.join(','),
      csvRow({
        drug_id: 'nv3-z',
        origin: 'user',
        name: 'Drug',
        target_id: 't1',
        target_name: 'Target',
        target_action: 'not-an-action',
        kd: '4.2',
        kd_unit: 'nM',
      }),
    ].join('\r\n')
    const actionResult = buildCsvImport(mappingState(badAction).state, CONTEXT)
    expect(actionResult.ok).toBe(false)
    expect(actionResult.document).toBeNull()
    expect(actionResult.errors.join(' ')).toContain('is not one of')

    const badProvenance = [
      EXPECTED_HEADERS.join(','),
      csvRow({
        drug_id: 'nv3-z',
        origin: 'user',
        name: 'Drug',
        target_id: 't1',
        target_name: 'Target',
        kd: '4.2',
        kd_unit: 'nM',
        kd_provenance_type: 'verified',
      }),
    ].join('\r\n')
    const provenanceResult = buildCsvImport(mappingState(badProvenance).state, CONTEXT)
    expect(provenanceResult.ok).toBe(false)
    expect(provenanceResult.document).toBeNull()
    expect(provenanceResult.errors.join(' ')).toContain('provenance type')
  })

  it('stamps unmapped provenance as {type:"user"} — provenance is never invented', () => {
    const minimal = [
      EXPECTED_HEADERS.join(','),
      csvRow({
        drug_id: 'nv3-w',
        origin: 'user',
        name: 'Minimal',
        target_name: 'NV3 Minimal Target',
        kd: '4.2',
        kd_unit: 'nM',
      }),
    ].join('\r\n')
    const result = buildCsvImport(mappingState(minimal).state, CONTEXT)
    const drug = expectOkDocument(result).drugs[0]!
    expect(drug.targets[0]?.kd?.provenance).toEqual({
      type: 'user',
      recordedAt: CONTEXT.now,
    })
  })
})
