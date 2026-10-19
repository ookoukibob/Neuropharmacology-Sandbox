/**
 * Domain rules for imported source data (phase 36): the merge policy that
 * makes repeat imports idempotent and keeps same-source identity conflicts
 * explicit, and the identity helper that mirrors `compoundId`.
 *
 * All fixture values are synthetic test data — not pharmacological
 * information.
 */
import { describe, expect, it } from 'vitest'
import { syntheticObservation } from '../../tests/fixtures'
import type { DrugSourceRecord } from './source-data'
import { findSourceRecord, mergeSourceRecord, sourceRecordIdentity } from './source-data'

const ATTRIBUTION = {
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
    synonyms: ['SFC-1'],
    identifiers: { chemblId: 'CHEMBL99990001', inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N' },
    provenance: ATTRIBUTION,
    observations: [syntheticObservation()],
    importedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

describe('sourceRecordIdentity', () => {
  it('is the deterministic source:sourceId form used by compoundId', () => {
    expect(sourceRecordIdentity({ source: 'pubchem', sourceId: '2244' })).toBe('pubchem:2244')
  })
})

describe('findSourceRecord', () => {
  it('matches on the exact source identifier, never the record name', () => {
    const records = [snapshot()]
    expect(findSourceRecord(records, 'chembl')?.sourceId).toBe('CHEMBL99990001')
    expect(findSourceRecord(records, 'ChEMBL')).toBeUndefined() // exact, no case folding
    expect(findSourceRecord(records, 'pubchem')).toBeUndefined()
    expect(findSourceRecord(undefined, 'chembl')).toBeUndefined()
  })
})

describe('mergeSourceRecord — identity-aware attach', () => {
  it('appends the first snapshot for a source', () => {
    const merged = mergeSourceRecord(undefined, snapshot())
    expect(merged.records).toHaveLength(1)
    expect(merged.conflict).toBeUndefined()
    expect(merged.addedObservations).toBe(1)
  })

  it('keeps a different source system side by side — nothing replaces anything', () => {
    const existing = [snapshot()]
    const pubchem = snapshot({
      source: 'pubchem',
      sourceId: '90000001',
      provenance: {
        ...ATTRIBUTION,
        source: 'pubchem',
        sourceName: 'PubChem',
        recordId: '90000001',
        url: 'https://pubchem.ncbi.nlm.nih.gov/compound/90000001',
      },
      identifiers: { pubchemCid: '90000001' },
      observations: [],
    })
    const merged = mergeSourceRecord(existing, pubchem)
    expect(merged.records.map((record) => record.source)).toEqual(['chembl', 'pubchem'])
    expect(merged.conflict).toBeUndefined()
    expect(merged.records[0]).toBe(existing[0]) // untouched, same object
  })

  it('is idempotent for the same external record: no duplicate, no rewrite', () => {
    const existing = [snapshot()]
    const merged = mergeSourceRecord(existing, snapshot())
    expect(merged.records).toHaveLength(1)
    expect(merged.addedObservations).toBe(0)
    expect(merged.records[0]).toBe(existing[0]) // identical import is a no-op
  })

  it('appends only measurements it does not already hold, preserving order', () => {
    const second = syntheticObservation({
      id: 'chembl:99000002',
      endpoint: 'Ki',
      parameterKind: 'ki',
      value: 12,
      qualifier: '>',
      provenance: { ...syntheticObservation().provenance, recordId: '99000002' },
    })
    const existing = [snapshot()]
    const merged = mergeSourceRecord(existing, snapshot({ observations: [second] }))
    expect(merged.addedObservations).toBe(1)
    const mergedRecord = merged.records[0]
    expect(mergedRecord?.observations.map((observation) => observation.id)).toEqual([
      'chembl:99000001',
      'chembl:99000002',
    ])
    // The already-stored measurement object is reused verbatim.
    expect(mergedRecord?.observations[0]).toBe(existing[0]?.observations[0])
  })

  it('never duplicates a measurement already stored, even inside one batch', () => {
    const existing = [snapshot()]
    const merged = mergeSourceRecord(
      existing,
      snapshot({ observations: [syntheticObservation(), syntheticObservation()] }),
    )
    expect(merged.addedObservations).toBe(0)
    expect(merged.records[0]?.observations).toHaveLength(1)
  })

  it('reports a same-source identity conflict and leaves the list unchanged', () => {
    const existing = [snapshot()]
    const different = snapshot({
      sourceId: 'CHEMBL99990002',
      provenance: { ...ATTRIBUTION, recordId: 'CHEMBL99990002' },
      identifiers: { chemblId: 'CHEMBL99990002' },
    })
    const merged = mergeSourceRecord(existing, different)
    expect(merged.records).toBe(existing) // untouched, same reference
    expect(merged.conflict?.sourceId).toBe('CHEMBL99990001')
    expect(merged.addedObservations).toBe(0)
  })

  it('keeps disagreeing measurements of the same endpoint side by side', () => {
    const disagreeing = syntheticObservation({
      id: 'chembl:99000003',
      value: 9.1,
      provenance: { ...syntheticObservation().provenance, recordId: '99000003' },
    })
    const merged = mergeSourceRecord(
      [snapshot()],
      snapshot({ observations: [disagreeing] }),
    )
    const values = merged.records[0]?.observations.map((observation) => observation.value)
    expect(values).toEqual([3.5, 9.1]) // neither averaged nor dropped
  })
})
