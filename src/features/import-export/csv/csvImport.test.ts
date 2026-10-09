/**
 * CSV mapping and conversion tests — explicit destination mapping,
 * ambiguity handling (a `Kd/Ki` column is never inferred), unit-source
 * policy, row-level validation, grouping rules, provenance serialization
 * and the hand-off into the shared NPSL preview pipeline.
 * All values are synthetic test data, never pharmacological information.
 */
import { describe, expect, it } from 'vitest'
import { previewNpslImport } from '@/data/import/importPipeline'
import { serializeNpslDocument } from '@/data/mappers/npslDocument'
import type { LibraryMetadata } from '@/domain/library/library'
import {
  buildCsvImport,
  CSV_DESTINATIONS,
  mappingWarnings,
  validateMapping,
  type CsvBuildResult,
  type CsvImportContext,
  type CsvMappingState,
} from './csvImport'

const CONTEXT: CsvImportContext = {
  now: '2026-02-01T00:00:00.000Z',
  metadata: {
    id: 'local-library',
    name: 'Synthetic test library',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    dataStatus: 'user',
  } satisfies LibraryMetadata,
}

function state(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  destinations: readonly (string | null)[],
  fixedUnits: CsvMappingState['fixedUnits'] = {},
): CsvMappingState {
  return { fileName: 'synthetic.csv', headers, rows, destinations, fixedUnits }
}

/** Result asserted as ok — fails loudly with the blocking errors. */
function expectOk(result: CsvBuildResult): CsvBuildResult {
  expect(result.errors).toEqual([])
  expect(result.ok).toBe(true)
  expect(result.document).not.toBeNull()
  return result
}

function firstDrug(result: CsvBuildResult) {
  const document = result.document
  if (document === null) throw new Error('expected a document')
  return document.drugs[0]!
}

describe('CSV_DESTINATIONS — catalog', () => {
  it('offers identity, target and per-parameter destinations without duplicates', () => {
    const ids = CSV_DESTINATIONS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('drug.name')
    expect(ids).toContain('target.name')
    expect(ids).toContain('kd.value')
    expect(ids).toContain('ki.value')
    expect(ids).toContain('kd.prov.json')
    expect(ids).toContain('volumeOfDistribution.unit')
    // every destination is grouped
    expect(CSV_DESTINATIONS.every((d) => d.group !== '')).toBe(true)
  })
})

describe('validateMapping — structural rules', () => {
  const withName = state(
    ['compound'],
    [['Synthetic A']],
    ['drug.name'],
  )

  it('accepts a minimal valid mapping', () => {
    expect(validateMapping(withName)).toEqual([])
  })

  it('requires the drug name destination', () => {
    const errors = validateMapping(state(['compound'], [['Synthetic A']], [null]))
    expect(errors).toContain('Drug name must be mapped to a column.')
  })

  it('rejects two columns mapped to the same meaning', () => {
    const errors = validateMapping(
      state(['a', 'b'], [['x', 'y']], ['drug.name', 'drug.name']),
    )
    expect(errors.join(' ')).toContain('both map to')
    expect(errors.join(' ')).toContain('only once')
  })

  it('rejects a value without any unit source', () => {
    const errors = validateMapping(
      state(
        ['compound', 'kd'],
        [['Synthetic A', '4.2']],
        ['drug.name', 'kd.value'],
      ),
    )
    expect(errors.join(' ')).toContain('Kd has no unit source')
  })

  it('accepts a value with a declared fixed unit', () => {
    const errors = validateMapping(
      state(
        ['compound', 'target', 'kd'],
        [['Synthetic A', 'SITE-1', '4.2']],
        ['drug.name', 'target.name', 'kd.value'],
        { kd: 'nM' },
      ),
    )
    expect(errors).toEqual([])
  })

  it('accepts a value with a unit column', () => {
    const errors = validateMapping(
      state(
        ['compound', 'target', 'kd', 'kd_unit'],
        [['Synthetic A', 'SITE-1', '4.2', 'nM']],
        ['drug.name', 'target.name', 'kd.value', 'kd.unit'],
      ),
    )
    expect(errors).toEqual([])
  })

  it('rejects a unit column without its value column', () => {
    const errors = validateMapping(
      state(['compound', 'kd_unit'], [['Synthetic A', 'nM']], ['drug.name', 'kd.unit']),
    )
    expect(errors.join(' ')).toContain('unit column is mapped but the Kd value column is not')
  })

  it('rejects both a unit column and a fixed unit at once', () => {
    const errors = validateMapping(
      state(
        ['compound', 'kd', 'kd_unit'],
        [['Synthetic A', '4.2', 'nM']],
        ['drug.name', 'kd.value', 'kd.unit'],
        { kd: 'nM' },
      ),
    )
    expect(errors.join(' ')).toContain('exactly one unit source')
  })

  it('rejects a fixed unit without a mapped value column', () => {
    const errors = validateMapping(
      state(['compound'], [['Synthetic A']], ['drug.name'], { kd: 'nM' }),
    )
    expect(errors.join(' ')).toContain('fixed unit is chosen for Kd but its value column is not mapped')
  })

  it('rejects target fields without a target name destination', () => {
    const errors = validateMapping(
      state(
        ['compound', 'kd'],
        [['Synthetic A', '4.2']],
        ['drug.name', 'kd.value'],
        { kd: 'nM' },
      ),
    )
    expect(errors.join(' ')).toContain('target fields are mapped but the target name column is not')
  })

  it('rejects provenance source/JSON without a provenance type column', () => {
    const errors = validateMapping(
      state(
        ['compound', 'kd', 'kd_src'],
        [['Synthetic A', '4.2', 'Synthetic source']],
        ['drug.name', 'kd.value', 'kd.prov.source'],
        { kd: 'nM' },
      ),
    )
    expect(errors.join(' ')).toContain('provenance type column is not')
  })

  it('rejects provenance columns without their value column', () => {
    const errors = validateMapping(
      state(['compound', 'kd_type'], [['Synthetic A', 'literature']], ['drug.name', 'kd.prov.type']),
    )
    expect(errors.join(' ')).toContain('provenance columns are mapped for Kd but its value column is not')
  })

  it('rejects a file with no data rows', () => {
    const errors = validateMapping(state(['compound'], [], ['drug.name']))
    expect(errors).toContain('the file has no data rows — nothing to import.')
  })

  it('rejects a mapping table that does not match the columns', () => {
    const errors = validateMapping(state(['a', 'b'], [['x']], ['drug.name']))
    expect(errors.join(' ')).toContain('does not match the file columns')
  })
})

describe('mappingWarnings — cross-parameter consistency', () => {
  it('stays silent for a single mapped binding parameter', () => {
    expect(
      mappingWarnings(
        state(
          ['compound', 'target', 'kd', 'unit'],
          [['Synthetic A', 'SITE-1', '4.2', 'nM']],
          ['drug.name', 'target.name', 'kd.value', 'kd.unit'],
        ),
      ),
    ).toEqual([])
  })

  it('warns when both Kd and Ki are mapped for one target', () => {
    const warnings = mappingWarnings(
      state(
        ['compound', 'target', 'kd', 'ki', 'unit'],
        [['Synthetic A', 'SITE-1', '4.2', '9.9', 'nM']],
        ['drug.name', 'target.name', 'kd.value', 'ki.value', 'kd.unit'],
      ),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('never substituted')
    expect(warnings[0]).toContain('different measurements')
  })

  it('is a warning, not a blocker — mapping validation still passes', () => {
    const s = state(
      ['compound', 'target', 'kd', 'ki', 'unit', 'ki_unit'],
      [['Synthetic A', 'SITE-1', '4.2', '9.9', 'nM', 'nM']],
      ['drug.name', 'target.name', 'kd.value', 'ki.value', 'kd.unit', 'ki.unit'],
    )
    expect(validateMapping(s)).toEqual([])
    expect(mappingWarnings(s)).toHaveLength(1)
  })
})

describe('buildCsvImport — conversion', () => {
  it('converts mapped rows into a valid, previewable NPSL document', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'target', 'kd', 'kd_unit'],
          [['Synthetic A', 'SITE-1', '4.2', 'nM']],
          ['drug.name', 'target.name', 'kd.value', 'kd.unit'],
        ),
        CONTEXT,
      ),
    )
    expect(result.rowCount).toBe(1)
    expect(result.drugCount).toBe(1)
    const drug = firstDrug(result)
    expect(drug.origin).toBe('imported')
    expect(drug.identifiers.name).toBe('Synthetic A')
    expect(drug.targets).toHaveLength(1)
    expect(drug.targets[0]?.name).toBe('SITE-1')
    expect(drug.targets[0]?.kd).toEqual({
      value: 4.2,
      unit: 'nM',
      provenance: { type: 'user', recordedAt: CONTEXT.now },
    })
    // ids are generated identity bookkeeping, not pharmacological data
    expect(drug.id).not.toBe('')
    expect(drug.targets[0]?.id).not.toBe('')

    // the document survives the shared preview pipeline
    const preview = previewNpslImport(serializeNpslDocument(result.document!))
    expect(preview.ok).toBe(true)
    expect(preview.ok && preview.stats.total).toBe(1)
  })

  it('never infers meaning from an ambiguous Kd/Ki column left unmapped', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'Kd/Ki'],
          [['Synthetic A', '4.2']],
          ['drug.name', null],
        ),
        CONTEXT,
      ),
    )
    const drug = firstDrug(result)
    expect(drug.targets).toEqual([])
    expect(result.notes.join(' ')).toContain('Not imported (columns left unmapped): "Kd/Ki"')
  })

  it('imports an explicitly mapped Kd/Ki column as Kd only (never Ki)', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'target', 'Kd/Ki'],
          [['Synthetic A', 'SITE-1', '4.2']],
          ['drug.name', 'target.name', 'kd.value'],
          { kd: 'nM' },
        ),
        CONTEXT,
      ),
    )
    const drug = firstDrug(result)
    expect(drug.targets[0]?.kd).toEqual({
      value: 4.2,
      unit: 'nM',
      provenance: { type: 'user', recordedAt: CONTEXT.now },
    })
    expect(drug.targets[0]?.ki).toBeUndefined()
    expect(drug.targets[0]?.ec50).toBeUndefined()
    expect(drug.targets[0]?.ic50).toBeUndefined()
    expect(result.notes.join(' ')).toContain('Kd unit: fixed "nM"')
  })

  it('declares a column-based unit policy in the preview notes', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'target', 'kd', 'unit'],
          [['Synthetic A', 'SITE-1', '4.2', 'nM']],
          ['drug.name', 'target.name', 'kd.value', 'kd.unit'],
        ),
        CONTEXT,
      ),
    )
    expect(result.notes.join(' ')).toContain('Kd unit: from column "unit"')
  })

  it('imports PK parameters at drug level', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'half_life', 'half_life_unit'],
          [['Synthetic A', '8', 'h']],
          ['drug.name', 'halfLife.value', 'halfLife.unit'],
        ),
        CONTEXT,
      ),
    )
    const drug = firstDrug(result)
    expect(drug.targets).toEqual([])
    expect(drug.pharmacokinetics.halfLife).toEqual({
      value: 8,
      unit: 'h',
      provenance: { type: 'user', recordedAt: CONTEXT.now },
    })
  })
})

describe('buildCsvImport — row errors (blocking)', () => {
  it('requires a drug name in every row', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd'],
        [['', 'SITE-1', '4.2']],
        ['drug.name', 'target.name', 'kd.value'],
        { kd: 'nM' },
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.errors.join(' ')).toContain('data row 1: the drug name is required')
  })

  it('rejects non-finite numeric values', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd'],
        [['Synthetic A', 'SITE-1', 'abc']],
        ['drug.name', 'target.name', 'kd.value'],
        { kd: 'nM' },
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('value "abc" is not a finite number')
  })

  it('rejects an empty unit cell in a mapped unit column', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd', 'unit'],
        [['Synthetic A', 'SITE-1', '4.2', '']],
        ['drug.name', 'target.name', 'kd.value', 'kd.unit'],
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('Kd has no unit value in its unit column')
  })

  it('rejects a unit without a value', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd', 'unit'],
        [['Synthetic A', 'SITE-1', '', 'nM']],
        ['drug.name', 'target.name', 'kd.value', 'kd.unit'],
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('Kd has a unit but no value')
  })

  it('requires a target name when target values are present', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd'],
        [['Synthetic A', '', '4.2']],
        ['drug.name', 'target.name', 'kd.value'],
        { kd: 'nM' },
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('target name is empty')
  })

  it('rejects an unknown target action and lists the allowed values', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'action'],
        [['Synthetic A', 'SITE-1', 'binding']],
        ['drug.name', 'target.name', 'target.action'],
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('target action "binding" is not one of agonist')
  })

  it('reports every failing row, not just the first', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd'],
        [
          ['', 'SITE-1', '4.2'],
          ['Synthetic B', 'SITE-2', 'abc'],
        ],
        ['drug.name', 'target.name', 'kd.value'],
        { kd: 'nM' },
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('data row 1')
    expect(result.errors[1]).toContain('data row 2')
  })
})

describe('buildCsvImport — provenance', () => {
  it('preserves literature provenance from type, source and JSON columns', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'target', 'kd', 'unit', 'ptype', 'psource', 'pjson'],
          [
            [
              'Synthetic A',
              'SITE-1',
              '4.2',
              'nM',
              'literature',
              'Synthetic fixture source',
              '{"citation":"Synthetic 2026","doi":"10.0000/synthetic"}',
            ],
          ],
          [
            'drug.name',
            'target.name',
            'kd.value',
            'kd.unit',
            'kd.prov.type',
            'kd.prov.source',
            'kd.prov.json',
          ],
        ),
        CONTEXT,
      ),
    )
    expect(firstDrug(result).targets[0]?.kd?.provenance).toEqual({
      type: 'literature',
      source: 'Synthetic fixture source',
      citation: 'Synthetic 2026',
      doi: '10.0000/synthetic',
    })
  })

  it('takes a literature source from the JSON cell when no source column is mapped', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'target', 'kd', 'unit', 'ptype', 'pjson'],
          [
            [
              'Synthetic A',
              'SITE-1',
              '4.2',
              'nM',
              'literature',
              '{"source":"Synthetic fixture source"}',
            ],
          ],
          ['drug.name', 'target.name', 'kd.value', 'kd.unit', 'kd.prov.type', 'kd.prov.json'],
        ),
        CONTEXT,
      ),
    )
    expect(firstDrug(result).targets[0]?.kd?.provenance).toEqual({
      type: 'literature',
      source: 'Synthetic fixture source',
    })
  })

  it('does not upgrade user provenance without columns (stamped user)', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'target', 'kd', 'unit'],
          [['Synthetic A', 'SITE-1', '4.2', 'nM']],
          ['drug.name', 'target.name', 'kd.value', 'kd.unit'],
        ),
        CONTEXT,
      ),
    )
    expect(firstDrug(result).targets[0]?.kd?.provenance).toEqual({
      type: 'user',
      recordedAt: CONTEXT.now,
    })
  })

  it('rejects literature provenance without a source', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd', 'unit', 'ptype'],
        [['Synthetic A', 'SITE-1', '4.2', 'nM', 'literature']],
        ['drug.name', 'target.name', 'kd.value', 'kd.unit', 'kd.prov.type'],
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('literature provenance requires a source')
  })

  it('rejects a provenance source on non-literature provenance', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd', 'unit', 'ptype', 'psource'],
        [['Synthetic A', 'SITE-1', '4.2', 'nM', 'user', 'Synthetic source']],
        ['drug.name', 'target.name', 'kd.value', 'kd.unit', 'kd.prov.type', 'kd.prov.source'],
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('only applies to literature provenance')
  })

  it('rejects malformed provenance JSON', () => {
    const result = buildCsvImport(
      state(
        ['compound', 'target', 'kd', 'unit', 'ptype', 'pjson'],
        [['Synthetic A', 'SITE-1', '4.2', 'nM', 'user', '{broken']],
        ['drug.name', 'target.name', 'kd.value', 'kd.unit', 'kd.prov.type', 'kd.prov.json'],
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('provenance JSON is not valid JSON')
  })

  it('lets the NPSL preview reject incomplete provenance with a dotted path', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'target', 'kd', 'unit', 'ptype'],
          [['Synthetic A', 'SITE-1', '4.2', 'nM', 'calculated']],
          ['drug.name', 'target.name', 'kd.value', 'kd.unit', 'kd.prov.type'],
        ),
        CONTEXT,
      ),
    )
    const preview = previewNpslImport(serializeNpslDocument(result.document!))
    expect(preview.ok).toBe(false)
    if (preview.ok) throw new Error('expected failure')
    expect(preview.errors[0]?.path).toContain('provenance')
  })
})

describe('buildCsvImport — grouping', () => {
  it('groups rows sharing an explicit drug id into one record with two targets', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['id', 'compound', 'target', 'kd', 'unit'],
          [
            ['row-id-1', 'Synthetic A', 'SITE-1', '4.2', 'nM'],
            ['row-id-1', 'Synthetic A', 'SITE-2', '7.7', 'nM'],
          ],
          ['drug.id', 'drug.name', 'target.name', 'kd.value', 'kd.unit'],
        ),
        CONTEXT,
      ),
    )
    expect(result.drugCount).toBe(1)
    const drug = firstDrug(result)
    expect(drug.id).toBe('row-id-1')
    expect(drug.targets.map((t) => t.name)).toEqual(['SITE-1', 'SITE-2'])
    expect(result.notes[0]).toContain('share the same drug id')
  })

  it('rejects rows sharing an id with differing drug-level fields', () => {
    const result = buildCsvImport(
      state(
        ['id', 'compound'],
        [
          ['row-id-1', 'Synthetic A'],
          ['row-id-1', 'Synthetic B'],
        ],
        ['drug.id', 'drug.name'],
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('share the drug id "row-id-1" but their drug-level fields differ')
  })

  it('never merges distinct records that merely share a name', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound'],
          [['Synthetic A'], ['Synthetic A']],
          ['drug.name'],
        ),
        CONTEXT,
      ),
    )
    expect(result.drugCount).toBe(2)
    expect(result.notes[0]).toContain('never merged')
    const [a, b] = result.document!.drugs
    expect(a?.id).not.toBe(b?.id)
  })

  it('gives each row its own record when id cells are empty', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['id', 'compound'],
          [
            ['', 'Synthetic A'],
            ['', 'Synthetic B'],
          ],
          ['drug.id', 'drug.name'],
        ),
        CONTEXT,
      ),
    )
    expect(result.drugCount).toBe(2)
    const [a, b] = result.document!.drugs
    expect(a?.id).not.toBe('')
    expect(a?.id).not.toBe(b?.id)
  })

  it('rejects repeated target ids inside one drug record', () => {
    const result = buildCsvImport(
      state(
        ['id', 'compound', 'tid', 'target'],
        [
          ['row-id-1', 'Synthetic A', 't-1', 'SITE-1'],
          ['row-id-1', 'Synthetic A', 't-1', 'SITE-2'],
        ],
        ['drug.id', 'drug.name', 'target.id', 'target.name'],
      ),
      CONTEXT,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('target ids must be unique inside one record')
  })
})

describe('buildCsvImport — declarations', () => {
  it('keeps synthesized metadata, records the current library id', () => {
    const result = expectOk(
      buildCsvImport(state(['compound'], [['Synthetic A']], ['drug.name']), CONTEXT),
    )
    expect(result.document?.libraryMetadata).toEqual({
      id: 'local-library',
      name: 'Synthetic test library',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: CONTEXT.now,
      dataStatus: 'user',
    })
    expect(result.notes.join(' ')).toContain('no library metadata')
  })

  it('declares the storage origin policy and lists unmapped columns', () => {
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'origin', 'extra'],
          [['Synthetic A', 'user', 'ignored']],
          ['drug.name', null, null],
        ),
        CONTEXT,
      ),
    )
    expect(result.notes.join(' ')).toContain('origin "imported"')
    expect(result.notes.join(' ')).toContain('Not imported (columns left unmapped): "origin", "extra"')
  })

  it('declares the provenance stamping policy when values are mapped', () => {
    // PK parameter (no target needed) proves any mapped value triggers the note.
    const result = expectOk(
      buildCsvImport(
        state(
          ['compound', 'half_life', 'half_life_unit'],
          [['Synthetic A', '8', 'h']],
          ['drug.name', 'halfLife.value', 'halfLife.unit'],
        ),
        CONTEXT,
      ),
    )
    expect(result.notes.join(' ')).toContain('"type": "user"')
    expect(result.notes.join(' ')).toContain('never invented or upgraded')
  })
})
