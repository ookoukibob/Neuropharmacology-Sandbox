/**
 * Source-data repository tests (jsdom + fake-indexeddb, real Dexie
 * transaction): atomic import, duplicate/conflict handling that never
 * overwrites stored records, orphan-observation rejection, unknown-field
 * round-trip, and quarantine reporting on read. All record content is
 * synthetic test data — not pharmacological information.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Compound } from '../../domain/sources/compound'
import type { ExperimentalObservation } from '../../domain/sources/observation'
import { syntheticCompound, syntheticObservation } from '../../tests/fixtures'
import { SandboxDatabase } from '../db/database'
import { DexieSourceDataRepository } from './dexieSourceDataRepository'

let sequence = 0
function freshName(): string {
  sequence += 1
  return `source-repo-test-${Date.now()}-${sequence}`
}

describe('DexieSourceDataRepository', () => {
  let db: SandboxDatabase
  let repo: DexieSourceDataRepository

  beforeEach(() => {
    db = new SandboxDatabase(freshName())
    repo = new DexieSourceDataRepository(db)
  })

  afterEach(async () => {
    await db.delete()
  })

  it('imports a compound with its observation and lists them back', async () => {
    const compound = syntheticCompound()
    const observation = syntheticObservation()
    const report = await repo.importSourceRecords({
      compounds: [compound],
      observations: [observation],
    })
    expect(report).toEqual({
      ok: true,
      createdCompounds: 1,
      createdObservations: 1,
      skippedCompounds: 0,
      skippedObservations: 0,
    })

    const compounds = await repo.listCompounds()
    expect(compounds.quarantine).toEqual([])
    expect(compounds.records).toEqual([compound])

    const observations = await repo.listObservations()
    expect(observations.quarantine).toEqual([])
    expect(observations.records).toEqual([observation])
  })

  it('never overwrites a stored record: existing rows win and are reported as skipped', async () => {
    const original = syntheticCompound()
    await repo.importSourceRecords({ compounds: [original], observations: [] })

    const changed = syntheticCompound({
      name: 'Different Name',
      identifiers: { chemblId: 'CHEMBL99990001', molecularFormula: 'C9H8O4' },
      provenance: { ...original.provenance, retrievedAt: '2026-11-01T00:00:00.000Z' },
    })
    const report = await repo.importSourceRecords({ compounds: [changed], observations: [] })
    expect(report).toEqual({
      ok: true,
      createdCompounds: 0,
      createdObservations: 0,
      skippedCompounds: 1,
      skippedObservations: 0,
    })

    const stored = await repo.listCompounds()
    expect(stored.records).toEqual([original]) // byte-identical to first import
  })

  it('rejects an invalid record and writes nothing — not even valid siblings', async () => {
    const validCompound = syntheticCompound()
    const broken = {
      ...syntheticObservation(),
      value: 'not-a-number',
    } as unknown as ExperimentalObservation
    const beforeCompounds = structuredClone(await db.compounds.toArray())
    const beforeObservations = structuredClone(await db.observations.toArray())

    const report = await repo.importSourceRecords({
      compounds: [validCompound],
      observations: [broken],
    })
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.errors[0]?.code).toBe('INVALID_RECORD')
      expect(report.errors[0]?.path).toBe('observations.0')
      expect(report.errors[0]?.message).toContain('value')
    }
    expect(await db.compounds.toArray()).toEqual(beforeCompounds)
    expect(await db.observations.toArray()).toEqual(beforeObservations)
  })

  it('rejects an orphan observation (compound not in batch nor stored)', async () => {
    const orphan = syntheticObservation({
      compoundId: 'chembl:CHEMBL00000000',
      compoundSourceId: 'CHEMBL00000000',
    })
    const report = await repo.importSourceRecords({ compounds: [], observations: [orphan] })
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.errors[0]?.code).toBe('ORPHAN_OBSERVATION')
      expect(report.errors[0]?.message).toContain('chembl:CHEMBL00000000')
    }
    expect(await db.compounds.count()).toBe(0)
    expect(await db.observations.count()).toBe(0)
  })

  it('accepts an observation whose compound is already stored', async () => {
    await repo.importSourceRecords({ compounds: [syntheticCompound()], observations: [] })
    const report = await repo.importSourceRecords({
      compounds: [],
      observations: [syntheticObservation()],
    })
    expect(report).toEqual({
      ok: true,
      createdCompounds: 0,
      createdObservations: 1,
      skippedCompounds: 0,
      skippedObservations: 0,
    })
  })

  it('collapses in-batch duplicates onto their first occurrence', async () => {
    const first = syntheticObservation()
    const second = syntheticObservation({ value: 99, unit: 'uM' })
    const report = await repo.importSourceRecords({
      compounds: [syntheticCompound(), syntheticCompound()],
      observations: [first, second],
    })
    expect(report).toEqual({
      ok: true,
      createdCompounds: 1,
      createdObservations: 1,
      skippedCompounds: 1,
      skippedObservations: 1,
    })
    const observations = await repo.listObservations()
    expect(observations.records).toEqual([first])
  })

  it('preserves unknown (future) fields through import and read', async () => {
    const extended = {
      ...syntheticCompound(),
      futureField: { keep: 'me' },
      identifiers: { ...syntheticCompound().identifiers, futureIdentifierField: 'keep-me-too' },
    } as Compound
    const report = await repo.importSourceRecords({ compounds: [extended], observations: [] })
    expect(report.ok).toBe(true)
    const stored = await repo.listCompounds()
    const raw = stored.records[0] as unknown as Record<string, unknown>
    expect(raw['futureField']).toEqual({ keep: 'me' })
    expect((raw['identifiers'] as Record<string, unknown>)['futureIdentifierField']).toBe(
      'keep-me-too',
    )
  })

  it('reports an invalid stored row as quarantined without dropping valid rows', async () => {
    await db.compounds.put({ id: 'broken-row' } as unknown as Compound)
    await db.compounds.put(syntheticCompound())

    const result = await repo.listCompounds()
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.id).toBe('chembl:CHEMBL99990001')
    expect(result.quarantine).toHaveLength(1)
    expect(result.quarantine[0]?.id).toBe('broken-row')
    expect(result.quarantine[0]?.errors.length).toBeGreaterThan(0)
    // The row itself is kept exactly as stored.
    expect(await db.compounds.get('broken-row')).toEqual({ id: 'broken-row' })
  })

  it('filters observations by compound', async () => {
    const otherCompound: Compound = {
      ...syntheticCompound(),
      id: 'chembl:CHEMBL99990002',
      sourceId: 'CHEMBL99990002',
      identifiers: { chemblId: 'CHEMBL99990002' },
      provenance: {
        ...syntheticCompound().provenance,
        recordId: 'CHEMBL99990002',
        url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990002',
      },
    }
    const otherObservation: ExperimentalObservation = {
      ...syntheticObservation(),
      id: 'chembl:99000007',
      compoundId: 'chembl:CHEMBL99990002',
      compoundSourceId: 'CHEMBL99990002',
      provenance: { ...syntheticObservation().provenance, recordId: '99000007' },
    }
    await repo.importSourceRecords({
      compounds: [syntheticCompound(), otherCompound],
      observations: [syntheticObservation(), otherObservation],
    })

    const filtered = await repo.listObservations({ compoundId: 'chembl:CHEMBL99990002' })
    expect(filtered.records).toHaveLength(1)
    expect(filtered.records[0]?.id).toBe('chembl:99000007')
  })

  // --- quarantine collisions (import vs malformed stored rows) --------------

  it('rejects a compound-id collision with a malformed stored row — nothing written', async () => {
    const rawRow = { id: 'chembl:CHEMBL99990001', source: 'chembl', futureField: 'keep-me' }
    await db.compounds.put(rawRow as unknown as Compound)
    const beforeCompounds = structuredClone(await db.compounds.toArray())
    const beforeObservations = structuredClone(await db.observations.toArray())

    // A perfectly valid second compound in the same batch: still nothing
    // may be written — the collision refuses the WHOLE import.
    const other: Compound = {
      ...syntheticCompound(),
      id: 'chembl:CHEMBL99990003',
      sourceId: 'CHEMBL99990003',
      identifiers: { chemblId: 'CHEMBL99990003' },
      provenance: {
        ...syntheticCompound().provenance,
        recordId: 'CHEMBL99990003',
        url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990003',
      },
    }
    const report = await repo.importSourceRecords({
      compounds: [syntheticCompound(), other],
      observations: [],
    })
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.errors[0]?.code).toBe('QUARANTINE_CONFLICT')
      expect(report.errors[0]?.path).toBe('compounds.0')
      expect(report.errors[0]?.message).toContain('chembl:CHEMBL99990001')
    }
    // Atomicity and byte-for-byte preservation of the raw row.
    expect(await db.compounds.toArray()).toEqual(beforeCompounds)
    expect(await db.observations.toArray()).toEqual(beforeObservations)
    expect(await db.compounds.get('chembl:CHEMBL99990001')).toEqual(rawRow)
    // The quarantined row is still reported on read — never repaired,
    // deleted or silently skipped as an ordinary duplicate.
    const listed = await repo.listCompounds()
    expect(listed.records).toEqual([])
    expect(listed.quarantine.map((entry) => entry.id)).toEqual(['chembl:CHEMBL99990001'])
  })

  it('rejects an observation-id collision with a malformed stored row — nothing written', async () => {
    const rawRow = { id: 'chembl:99000001', unit: 'nM' }
    await db.observations.put(rawRow as unknown as ExperimentalObservation)
    const before = structuredClone(await db.observations.toArray())

    const report = await repo.importSourceRecords({
      compounds: [syntheticCompound()],
      observations: [syntheticObservation()],
    })
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.errors[0]?.code).toBe('QUARANTINE_CONFLICT')
      expect(report.errors[0]?.path).toBe('observations.0')
      expect(report.errors[0]?.message).toContain('chembl:99000001')
    }
    expect(await db.observations.toArray()).toEqual(before)
    expect(await db.compounds.count()).toBe(0) // not even the valid sibling
    const listed = await repo.listObservations()
    expect(listed.quarantine.map((entry) => entry.id)).toEqual(['chembl:99000001'])
  })

  it('never imports an observation whose compound exists only as a malformed row', async () => {
    const rawRow = { id: 'chembl:CHEMBL99990001', source: 'chembl' }
    await db.compounds.put(rawRow as unknown as Compound)
    const before = structuredClone(await db.compounds.toArray())

    const report = await repo.importSourceRecords({
      compounds: [],
      observations: [syntheticObservation()],
    })
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.errors[0]?.code).toBe('QUARANTINE_CONFLICT')
      expect(report.errors[0]?.path).toBe('observations.0')
      expect(report.errors[0]?.message).toContain('chembl:CHEMBL99990001')
    }
    expect(await db.compounds.toArray()).toEqual(before)
    expect(await db.observations.count()).toBe(0)
  })

  // --- cross-field identity invariants at the boundary ----------------------

  it('rejects a compound whose deterministic id contradicts source/sourceId', async () => {
    const report = await repo.importSourceRecords({
      compounds: [syntheticCompound({ id: 'pubchem:99000001' })],
      observations: [],
    })
    expect(report.ok).toBe(false)
    if (!report.ok) {
      expect(report.errors[0]?.code).toBe('INVALID_RECORD')
      expect(report.errors[0]?.message).toContain('does not match source')
      expect(report.errors[0]?.message).toContain('chembl:CHEMBL99990001')
    }
    expect(await db.compounds.count()).toBe(0)
  })

  it('rejects a compound whose provenance points at a different source or record', async () => {
    const wrongRecord = syntheticCompound({
      provenance: { ...syntheticCompound().provenance, recordId: 'CHEMBL00000009' },
    })
    const first = await repo.importSourceRecords({ compounds: [wrongRecord], observations: [] })
    expect(first.ok).toBe(false)
    if (!first.ok) {
      expect(first.errors[0]?.code).toBe('INVALID_RECORD')
      expect(first.errors[0]?.message).toContain('provenance.recordId')
    }

    const wrongSource = syntheticCompound({
      provenance: { ...syntheticCompound().provenance, source: 'pubchem' },
    })
    const second = await repo.importSourceRecords({ compounds: [wrongSource], observations: [] })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.errors[0]?.message).toContain('provenance.source')
    }
    expect(await db.compounds.count()).toBe(0)
  })

  it('rejects an observation with a mismatched id or an inconsistent compound reference', async () => {
    const wrongId = syntheticObservation({
      provenance: { ...syntheticObservation().provenance, recordId: '99000002' },
    })
    const first = await repo.importSourceRecords({ compounds: [], observations: [wrongId] })
    expect(first.ok).toBe(false)
    if (!first.ok) {
      expect(first.errors[0]?.code).toBe('INVALID_RECORD')
      expect(first.errors[0]?.message).toContain('does not match provenance.source')
    }

    // compoundId that does not encode (provenance.source, compoundSourceId).
    const wrongReference = syntheticObservation({ compoundId: 'pubchem:CHEMBL99990001' })
    const second = await repo.importSourceRecords({
      compounds: [],
      observations: [wrongReference],
    })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.errors[0]?.code).toBe('INVALID_RECORD')
      expect(second.errors[0]?.message).toContain('compoundId')
    }
    expect(await db.observations.count()).toBe(0)
  })

  it('quarantines a stored row with contradictory identity fields on read', async () => {
    const rawRow = {
      ...syntheticCompound(),
      provenance: { ...syntheticCompound().provenance, recordId: 'CHEMBL00000009' },
    }
    await db.compounds.put(rawRow)

    const result = await repo.listCompounds()
    expect(result.records).toEqual([])
    expect(result.quarantine).toHaveLength(1)
    expect(result.quarantine[0]?.errors.join(' ')).toContain('provenance.recordId')
    expect(await db.compounds.get(rawRow.id)).toEqual(rawRow) // unchanged
  })

  it('still imports identity-consistent PubChem and ChEMBL records', async () => {
    const pubchem: Compound = {
      id: 'pubchem:90000001',
      source: 'pubchem',
      sourceId: '90000001',
      name: 'Synthetic PubChem Fixture',
      synonyms: [],
      identifiers: { pubchemCid: '90000001', inchiKey: 'PUBCHEMKEYSXYZ-UHFFFAOYSA-N' },
      provenance: {
        source: 'pubchem',
        sourceName: 'PubChem',
        recordId: '90000001',
        url: 'https://pubchem.ncbi.nlm.nih.gov/compound/90000001',
        retrievedAt: '2026-01-01T00:00:00.000Z',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const report = await repo.importSourceRecords({
      compounds: [pubchem, syntheticCompound()],
      observations: [syntheticObservation()],
    })
    expect(report).toEqual({
      ok: true,
      createdCompounds: 2,
      createdObservations: 1,
      skippedCompounds: 0,
      skippedObservations: 0,
    })
  })
})
