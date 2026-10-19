/**
 * Persistence contract for imported source data (phase 36): the snapshot
 * round-trips through the record mapper, absent fields stay absent, an
 * ordinary edit cannot erase it, unknown fields inside it survive, and
 * malformed data is rejected at the shared NPSL boundary instead of being
 * stored.
 *
 * All fixture values are synthetic test data — not pharmacological
 * information.
 */
import { describe, expect, it } from 'vitest'
import { syntheticDrug, syntheticObservation } from '../../tests/fixtures'
import { fieldAt } from '../../tests/runtimeFields'
import type { Drug } from '../../domain/drug/drug'
import type { DrugSourceRecord } from '../../domain/drug/source-data'
import { fromRecord, toRecord, toStoredRecord, type DrugRecord } from './records'

const CHEMBL_ATTRIBUTION = {
  source: 'chembl',
  sourceName: 'ChEMBL',
  recordId: 'CHEMBL99990001',
  url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
  retrievedAt: '2026-01-01T00:00:00.000Z',
  licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
}

function snapshot(overrides: Partial<DrugSourceRecord> = {}): DrugSourceRecord {
  return {
    source: 'chembl',
    sourceId: 'CHEMBL99990001',
    name: 'Synthetic Fixture Compound',
    synonyms: ['SFC-1', 'Fixture Alias'],
    identifiers: {
      chemblId: 'CHEMBL99990001',
      inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
      molecularFormula: 'C12H14N2O',
      molecularWeight: 202.25,
      casNumber: 'SYNTH-CAS-0001',
      pubchemCid: '90000001',
    },
    provenance: CHEMBL_ATTRIBUTION,
    observations: [syntheticObservation()],
    importedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

function drugWithSource(records: readonly DrugSourceRecord[] = [snapshot()]): Drug {
  return { ...syntheticDrug(), sourceRecords: records }
}

function drugOf(raw: unknown) {
  const result = fromRecord(raw)
  if (!result.ok) throw new Error(`expected valid record, got: ${result.errors.join('; ')}`)
  return result.drug
}

describe('toRecord / fromRecord — imported source data', () => {
  it('round-trips the complete snapshot without loss', () => {
    const drug = drugWithSource()
    const record = toRecord(drug)
    expect(record.sourceRecords).toHaveLength(1)
    expect(drugOf(record)).toEqual(drug)
  })

  it('keeps every identifier and chemical property in structured fields', () => {
    const record = toRecord(drugWithSource())
    expect(record.sourceRecords?.[0]?.identifiers).toEqual({
      pubchemCid: '90000001',
      chemblId: 'CHEMBL99990001',
      inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
      molecularFormula: 'C12H14N2O',
      molecularWeight: 202.25,
      casNumber: 'SYNTH-CAS-0001',
    })
  })

  it('keeps the whole measurement, context and provenance intact', () => {
    const record = toRecord(drugWithSource())
    const observation = record.sourceRecords?.[0]?.observations[0]
    expect(observation).toMatchObject({
      id: 'chembl:99000001',
      compoundId: 'chembl:CHEMBL99990001',
      compoundSourceId: 'CHEMBL99990001',
      endpoint: 'IC50',
      parameterKind: 'ic50',
      value: 3.5,
      unit: 'nM',
      qualifier: '=',
      species: 'Homo sapiens',
      target: {
        name: 'Synthetic Target A',
        sourceTargetId: 'CHEMBL99991001',
        organism: 'Homo sapiens',
      },
      provenance: {
        source: 'chembl',
        recordId: '99000001',
        licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
      },
    })
  })

  it('never copies source data into the user notes', () => {
    const drug = drugWithSource()
    const record = toRecord(drug)
    expect(record.notes).toBe(drug.notes) // untouched, and not a source dump
    expect(record.notes).not.toContain('CHEMBL99990001')
  })

  it('omits absent optional fields instead of writing undefined', () => {
    const { name: _noName, ...base } = snapshot({
      identifiers: { chemblId: 'CHEMBL99990001' },
      observations: [],
    })
    const record = toRecord(drugWithSource([base]))
    const written = record.sourceRecords?.[0]
    expect(written !== undefined && 'name' in written).toBe(false)
    expect(written?.identifiers).toEqual({ chemblId: 'CHEMBL99990001' })
    expect('casNumber' in (written?.identifiers ?? {})).toBe(false)
    expect('molecularWeight' in (written?.identifiers ?? {})).toBe(false)
  })

  it('writes an empty snapshot list as absent, never as []', () => {
    const record = toRecord({ ...syntheticDrug(), sourceRecords: [] })
    expect('sourceRecords' in record).toBe(false)
    // …and a record that never imported anything keeps the key absent.
    expect('sourceRecords' in toRecord(syntheticDrug())).toBe(false)
  })
})

describe('toStoredRecord — source data survives ordinary edits', () => {
  it('keeps the snapshot when an edit never mentions it (the form path)', () => {
    const drug = drugWithSource()
    const existing = toRecord(drug)
    // A form edit submits identifiers/tags/targets/pharmacokinetics/notes —
    // never sourceRecords.
    const edited: Drug = {
      ...drug,
      identifiers: { ...drug.identifiers, name: 'Renamed' },
      notes: 'Edited by the user',
    }
    const stored = toStoredRecord(existing, edited)
    expect(stored.identifiers.name).toBe('Renamed')
    expect(stored.notes).toBe('Edited by the user')
    expect(stored.sourceRecords).toEqual(existing.sourceRecords)
  })

  it('matches snapshots by source, not position, when preserving unknown fields', () => {
    const existing = toRecord(drugWithSource()) as unknown as {
      sourceRecords: Record<string, unknown>[]
    }
    const first = existing.sourceRecords[0]
    if (first !== undefined) first['futureSnapshotField'] = 'kept-with-chembl'
    // The domain value now lists a different source first.
    const pubchem = snapshot({
      source: 'pubchem',
      sourceId: '90000001',
      provenance: { ...CHEMBL_ATTRIBUTION, source: 'pubchem', sourceName: 'PubChem' },
      identifiers: { pubchemCid: '90000001' },
      observations: [],
    })
    const stored = toStoredRecord(existing as unknown as DrugRecord, {
      ...syntheticDrug(),
      sourceRecords: [pubchem, snapshot()],
    }) as unknown as { sourceRecords: Record<string, unknown>[] }
    expect(stored.sourceRecords.map((record) => record['source'])).toEqual(['pubchem', 'chembl'])
    expect(stored.sourceRecords[0]?.['futureSnapshotField']).toBeUndefined()
    expect(stored.sourceRecords[1]?.['futureSnapshotField']).toBe('kept-with-chembl')
  })

  it('matches observations by their deterministic id when preserving extensions', () => {
    const second = syntheticObservation({
      id: 'chembl:99000002',
      provenance: { ...syntheticObservation().provenance, recordId: '99000002' },
    })
    const existing = toRecord(
      drugWithSource([snapshot({ observations: [syntheticObservation(), second] })]),
    ) as unknown as { sourceRecords: { observations: Record<string, unknown>[] }[] }
    const firstObservation = existing.sourceRecords[0]?.observations[0]
    if (firstObservation !== undefined) firstObservation['futureObservationField'] = 'kept'
    // The domain value lists them in the opposite order.
    const stored = toStoredRecord(existing as unknown as DrugRecord, {
      ...syntheticDrug(),
      sourceRecords: [snapshot({ observations: [second, syntheticObservation()] })],
    }) as unknown as { sourceRecords: { observations: Record<string, unknown>[] }[] }
    const observations = stored.sourceRecords[0]?.observations ?? []
    expect(observations.map((observation) => observation['id'])).toEqual([
      'chembl:99000002',
      'chembl:99000001',
    ])
    expect(observations[0]?.['futureObservationField']).toBeUndefined()
    expect(observations[1]?.['futureObservationField']).toBe('kept')
  })

  it('carries unknown fields of an incoming snapshot through a fresh import', () => {
    const incoming = {
      ...drugWithSource(),
      sourceRecords: [
        {
          ...snapshot(),
          futureSnapshotField: 'from-file',
          identifiers: { ...snapshot().identifiers, futureIdentifierField: 'from-file' },
          provenance: { ...CHEMBL_ATTRIBUTION, futureProvenanceField: 'from-file' },
          observations: [
            {
              ...syntheticObservation(),
              futureObservationField: 'from-file',
              target: { ...syntheticObservation().target, futureTargetField: 'from-file' },
            },
          ],
        },
      ],
    } as unknown as Drug
    const stored = toStoredRecord(undefined, incoming)
    expect(fieldAt(stored, 'sourceRecords', '0', 'futureSnapshotField')).toBe('from-file')
    expect(fieldAt(stored, 'sourceRecords', '0', 'identifiers', 'futureIdentifierField')).toBe(
      'from-file',
    )
    expect(fieldAt(stored, 'sourceRecords', '0', 'provenance', 'futureProvenanceField')).toBe(
      'from-file',
    )
    expect(fieldAt(stored, 'sourceRecords', '0', 'observations', '0', 'futureObservationField')).toBe(
      'from-file',
    )
    expect(fieldAt(stored, 'sourceRecords', '0', 'observations', '0', 'target', 'futureTargetField')).toBe(
      'from-file',
    )
  })
})

describe('fromRecord — imported source data is validated, never repaired', () => {
  function mutated(mutate: (records: Record<string, unknown>[]) => void): unknown {
    const record = toRecord(drugWithSource()) as unknown as {
      sourceRecords: Record<string, unknown>[]
    }
    mutate(record.sourceRecords)
    return record
  }

  it('rejects two snapshots from the same source (even with the same record id)', () => {
    const result = fromRecord(
      mutated((records) => {
        const first = records[0]
        if (first !== undefined) records.push(structuredClone(first))
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const joined = result.errors.join(' ')
      expect(joined).toContain('duplicate source record')
      expect(joined).toContain('sourceRecords.1.source')
    }
  })

  it('rejects an observation whose compoundId names a different compound', () => {
    const result = fromRecord(
      mutated((records) => {
        const observation = records[0]?.['observations'] as Record<string, unknown>[] | undefined
        const first = observation?.[0]
        if (first !== undefined) first['compoundId'] = 'chembl:CHEMBL99990002'
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('observations.0.compoundId')
  })

  it('rejects an observation whose id contradicts its provenance', () => {
    const result = fromRecord(
      mutated((records) => {
        const observation = records[0]?.['observations'] as Record<string, unknown>[] | undefined
        const first = observation?.[0]
        if (first !== undefined) first['id'] = 'chembl:12345678'
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('observations.0.id')
  })

  it('rejects a duplicated observation inside one snapshot', () => {
    const result = fromRecord(
      mutated((records) => {
        const observation = records[0]?.['observations'] as Record<string, unknown>[] | undefined
        const first = observation?.[0]
        if (first !== undefined) observation?.push(structuredClone(first))
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('duplicate observation')
  })

  it('rejects a non-finite reported value', () => {
    const result = fromRecord(
      mutated((records) => {
        const observation = records[0]?.['observations'] as Record<string, unknown>[] | undefined
        const first = observation?.[0]
        if (first !== undefined) first['value'] = Number.NaN
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('value')
  })

  it('rejects a non-HTTPS record URL', () => {
    const result = fromRecord(
      mutated((records) => {
        const provenance = records[0]?.['provenance'] as Record<string, unknown> | undefined
        if (provenance !== undefined) provenance['url'] = 'http://insecure.example/x'
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('provenance.url')
  })

  it('accepts a legacy record with no source data at all', () => {
    const legacy = toRecord(syntheticDrug())
    expect('sourceRecords' in legacy).toBe(false)
    expect(fromRecord(legacy).ok).toBe(true)
  })
})
