/**
 * Repository-level persistence for imported source data (phase 36), against
 * the real Dexie repositories and fake-indexeddb:
 *
 * - the snapshot survives a page reload (a fresh repository instance), an
 *   ordinary edit, an `.npsl` export/import round trip and a `.npsb`
 *   recovery round trip;
 * - a legacy record without the field keeps loading, and an old export file
 *   keeps importing;
 * - invalid data is rejected inside the transaction with nothing written;
 * - attaching a snapshot never disturbs the record's targets, parameters,
 *   target metadata or notes, and the concurrency token still guards the
 *   attach path.
 *
 * All fixture values are synthetic test data — not pharmacological
 * information.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FIXTURE_TIMESTAMP,
  syntheticDrug,
  syntheticLibrary,
  syntheticObservation,
} from '../../tests/fixtures'
import type { Drug } from '../../domain/drug/drug'
import type { DrugSourceRecord } from '../../domain/drug/source-data'
import { mergeSourceRecord } from '../../domain/drug/source-data'
import { SandboxDatabase } from '../db/database'
import { serializeNpslDocument, toNpslDocument } from '../mappers/npslDocument'
import { PERSISTENCE_VERSION, toRecord } from '../mappers/records'
import { DexieDrugRepository } from './dexieDrugRepository'
import { RepositoryError } from './repository'

let sequence = 0
function freshName(): string {
  sequence += 1
  return `source-records-repo-${Date.now()}-${sequence}`
}

let db: SandboxDatabase
let repo: DexieDrugRepository

beforeEach(async () => {
  db = new SandboxDatabase(freshName())
  repo = new DexieDrugRepository(db)
})

const CHEMBL_ATTRIBUTION = {
  source: 'chembl',
  sourceName: 'ChEMBL',
  recordId: 'CHEMBL99990001',
  url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
  retrievedAt: FIXTURE_TIMESTAMP,
  licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
}

function snapshot(overrides: Partial<DrugSourceRecord> = {}): DrugSourceRecord {
  return {
    source: 'chembl',
    sourceId: 'CHEMBL99990001',
    name: 'Synthetic Fixture Compound',
    synonyms: ['SFC-1'],
    identifiers: {
      chemblId: 'CHEMBL99990001',
      inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
      molecularFormula: 'C12H14N2O',
      molecularWeight: 202.25,
    },
    provenance: CHEMBL_ATTRIBUTION,
    observations: [syntheticObservation()],
    importedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

async function createWithSnapshot(records: readonly DrugSourceRecord[] = [snapshot()]): Promise<Drug> {
  return await repo.createDrug({
    identifiers: { name: 'Synthetic Fixture Compound', synonyms: ['SFC-1'] },
    sourceRecords: records,
  })
}

describe('createDrug — imported source data is stored structured', () => {
  it('persists the snapshot as a first-class row field, not as notes', async () => {
    const created = await createWithSnapshot()
    const raw = (await db.drugs.get(created.id)) as unknown as Record<string, unknown>
    expect(raw['sourceRecords']).toEqual([snapshot()])
    expect(raw['notes']).toBeUndefined()
    expect(created.sourceRecords).toEqual([snapshot()])
  })

  it('survives a reload: a fresh repository reads the same data', async () => {
    const created = await createWithSnapshot()
    const fresh = new DexieDrugRepository(db)
    const reread = await fresh.getDrug(created.id)
    expect(reread?.sourceRecords).toEqual([snapshot()])
    const all = await fresh.getAllDrugs()
    expect(all.drugs[0]?.sourceRecords?.[0]?.identifiers.molecularFormula).toBe('C12H14N2O')
  })

  it('omits the key for a record created without source data', async () => {
    const created = await repo.createDrug({ identifiers: { name: 'No source', synonyms: [] } })
    const raw = (await db.drugs.get(created.id)) as unknown as Record<string, unknown>
    expect('sourceRecords' in raw).toBe(false)
    expect(created.sourceRecords).toBeUndefined()
  })

  it('rejects an invalid snapshot before writing anything', async () => {
    const broken = { ...snapshot(), provenance: { ...CHEMBL_ATTRIBUTION, url: 'not-a-url' } }
    await expect(
      repo.createDrug({ identifiers: { name: 'Broken', synonyms: [] }, sourceRecords: [broken] }),
    ).rejects.toBeInstanceOf(RepositoryError)
    expect(await db.drugs.count()).toBe(0)
  })
})

describe('updateDrug — attaching and preserving source data', () => {
  it('attaches a snapshot without touching targets, parameters or notes', async () => {
    const existing = syntheticDrug()
    await repo.replaceLibrary(syntheticLibrary([existing]))
    const stored = await repo.getDrug(existing.id)
    if (stored === undefined) throw new Error('fixture record missing')

    const updated = await repo.updateDrug(
      stored.id,
      { sourceRecords: [snapshot()] },
      stored.revision ?? 0,
    )
    expect(updated.sourceRecords).toHaveLength(1)
    // Everything the attach never mentioned is preserved verbatim.
    expect(updated.targets).toEqual(stored.targets)
    expect(updated.identifiers).toEqual(stored.identifiers)
    expect(updated.notes).toBe(stored.notes)
    expect(updated.tags).toEqual(stored.tags)
    expect(updated.pharmacokinetics).toEqual(stored.pharmacokinetics)
  })

  it('keeps source data across an ordinary edit that omits the field', async () => {
    const created = await createWithSnapshot()
    const updated = await repo.updateDrug(
      created.id,
      { notes: 'User note', identifiers: { name: 'Renamed', synonyms: ['SFC-1'] } },
      created.revision ?? 0,
    )
    expect(updated.identifiers.name).toBe('Renamed')
    expect(updated.notes).toBe('User note')
    expect(updated.sourceRecords).toEqual([snapshot()])

    // …and after a reload the source data is still there.
    const fresh = new DexieDrugRepository(db)
    const reread = await fresh.getDrug(created.id)
    expect(reread?.sourceRecords?.[0]?.observations).toHaveLength(1)
  })

  it('appends a second source system without replacing the first', async () => {
    const created = await createWithSnapshot()
    const pubchem = snapshot({
      source: 'pubchem',
      sourceId: '90000001',
      provenance: {
        ...CHEMBL_ATTRIBUTION,
        source: 'pubchem',
        sourceName: 'PubChem',
        recordId: '90000001',
        url: 'https://pubchem.ncbi.nlm.nih.gov/compound/90000001',
        licenseNotice: 'PubChem aggregates contributions from many data providers.',
      },
      identifiers: { pubchemCid: '90000001' },
      observations: [],
    })
    const merged = mergeSourceRecord(created.sourceRecords, pubchem)
    const updated = await repo.updateDrug(
      created.id,
      { sourceRecords: merged.records },
      created.revision ?? 0,
    )
    expect(updated.sourceRecords?.map((record) => record.source)).toEqual(['chembl', 'pubchem'])
    expect(updated.sourceRecords?.[0]?.identifiers.chemblId).toBe('CHEMBL99990001')
  })

  it('rejects an attach based on a stale revision, leaving the row untouched', async () => {
    const created = await createWithSnapshot()
    const stale = created.revision ?? 0
    await repo.updateDrug(created.id, { notes: 'first edit' }, stale)
    await expect(
      repo.updateDrug(created.id, { sourceRecords: [snapshot()] }, stale),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const current = await repo.getDrug(created.id)
    expect(current?.notes).toBe('first edit')
    expect(current?.sourceRecords).toEqual([snapshot()]) // unchanged by the rejected write
  })

  it('rejects a duplicate same-source snapshot at the write boundary', async () => {
    const created = await createWithSnapshot()
    const duplicated = [snapshot(), snapshot()]
    await expect(
      repo.updateDrug(created.id, { sourceRecords: duplicated }, created.revision ?? 0),
    ).rejects.toBeInstanceOf(RepositoryError)
    const current = await repo.getDrug(created.id)
    expect(current?.sourceRecords).toHaveLength(1)
  })
})

describe('NPSL interchange — source data travels with the record', () => {
  it('survives an export → import round trip, license and observations included', async () => {
    const created = await createWithSnapshot()
    const text = serializeNpslDocument(toNpslDocument(await repo.exportLibrary()))
    const report = await repo.importLibrary(text, { mode: 'replace' })
    expect(report.ok).toBe(true)

    const reread = await repo.getDrug(created.id)
    expect(reread?.sourceRecords).toEqual([snapshot()])
    expect(reread?.sourceRecords?.[0]?.provenance.licenseNotice).toContain('CC BY-SA 3.0')
    expect(reread?.sourceRecords?.[0]?.observations[0]?.provenance.recordId).toBe('99000001')
  })

  it('keeps a legacy file without the field importable', async () => {
    const legacy = JSON.stringify({
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: {
        id: 'legacy-library',
        name: 'Legacy',
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
        dataStatus: 'user',
      },
      drugs: [toRecord(syntheticDrug())],
    })
    const report = await repo.importLibrary(legacy, { mode: 'replace' })
    expect(report.ok).toBe(true)
    const drug = await repo.getDrug('fixture-drug-1')
    expect(drug?.identifiers.name).toBe('Fixture Compound A')
    expect(drug?.sourceRecords).toBeUndefined()
  })

  it('rejects a file whose snapshot links a measurement to another compound', async () => {
    const document = JSON.parse(
      serializeNpslDocument(toNpslDocument(await repo.exportLibrary())),
    ) as Record<string, unknown>
    // Build a document by hand so the malformed snapshot is what is tested.
    const malformed = {
      ...document,
      drugs: [
        {
          ...toRecord(syntheticDrug()),
          sourceRecords: [
            {
              ...snapshot(),
              observations: [
                {
                  ...syntheticObservation(),
                  compoundId: 'chembl:CHEMBL99990002',
                },
              ],
            },
          ],
        },
      ],
    }
    const report = await repo.importLibrary(JSON.stringify(malformed), { mode: 'replace' })
    expect(report.ok).toBe(false)
    if (!report.ok) {
      const joined = report.errors.map((error) => error.message).join(' ')
      expect(joined).toContain('belongs to compound')
      // The offending path names the field, so the conflict is actionable.
      expect(report.errors.map((error) => error.path ?? '').join(' ')).toContain(
        'sourceRecords.0.observations.0.compoundId',
      )
    }
    // Nothing was written: the library is still the empty one from before.
    expect(await db.drugs.count()).toBe(0)
  })
})

describe('.npsb recovery — source data is preserved verbatim', () => {
  it('round-trips a record carrying a snapshot', async () => {
    const created = await createWithSnapshot()
    const exported = await repo.exportRecoveryArchive()
    expect(exported.ok).toBe(true)
    if (!exported.ok) throw new Error(exported.issues.map((i) => i.message).join('; '))

    // Replace the library with something else, then restore.
    await repo.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    expect(await repo.getDrug(created.id)).toBeUndefined()

    const restored = await repo.restoreRecoveryArchive(exported.text)
    expect(restored.ok).toBe(true)
    const reread = await repo.getDrug(created.id)
    expect(reread?.sourceRecords).toEqual([snapshot()])
  })

  it('preserves unknown fields inside a snapshot through export and restore', async () => {
    const created = await createWithSnapshot()
    // Simulate a future build's extension written straight to the row.
    const raw = (await db.drugs.get(created.id)) as unknown as {
      sourceRecords: Record<string, unknown>[]
    }
    const first = raw.sourceRecords[0]
    if (first !== undefined) first['futureSnapshotField'] = { keep: 'me' }
    await db.drugs.put(raw as never)

    const exported = await repo.exportRecoveryArchive()
    expect(exported.ok).toBe(true)
    if (!exported.ok) throw new Error('export failed')
    await repo.restoreRecoveryArchive(exported.text)

    const reread = (await db.drugs.get(created.id)) as unknown as {
      sourceRecords: Record<string, unknown>[]
    }
    expect(reread.sourceRecords[0]?.['futureSnapshotField']).toEqual({ keep: 'me' })
  })

  it('keeps a pre-phase-36 archive restorable', async () => {
    // A legacy row written before the field existed.
    const legacyRecord = toRecord(syntheticDrug())
    await db.drugs.put(legacyRecord)
    const exported = await repo.exportRecoveryArchive()
    expect(exported.ok).toBe(true)
    if (!exported.ok) throw new Error('export failed')
    await db.drugs.clear()
    const restored = await repo.restoreRecoveryArchive(exported.text)
    expect(restored.ok).toBe(true)
    const drug = await repo.getDrug('fixture-drug-1')
    expect(drug?.sourceRecords).toBeUndefined()
    expect((legacyRecord as unknown as { persistenceVersion: number }).persistenceVersion).toBe(
      PERSISTENCE_VERSION,
    )
  })
})
