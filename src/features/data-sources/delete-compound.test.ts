/**
 * Deleting stored compound identity records (phase 39), at the session
 * boundary against the real Dexie repositories:
 *
 * - a compound with measurements is deleted with exactly its own
 *   observations, and the panel re-reads IndexedDB;
 * - a compound without measurements deletes cleanly;
 * - other compounds and their measurements survive untouched;
 * - the counts in the success message are the ones actually deleted;
 * - missing ids, quarantined rows and storage failures report a typed
 *   failure with nothing written;
 * - a compound already imported into the Library leaves that record's
 *   snapshot, parameters and notes completely intact.
 *
 * All record content is synthetic test data — not pharmacological
 * information.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIXTURE_TIMESTAMP,
  syntheticCompound,
  syntheticObservation,
} from '../../tests/fixtures'
import { SandboxDatabase } from '../../data/db/database'
import { DexieDrugRepository } from '../../data/repositories/dexieDrugRepository'
import { DexieSourceDataRepository } from '../../data/repositories/dexieSourceDataRepository'
import type { Compound } from '../../domain/sources/compound'
import type { ExperimentalObservation } from '../../domain/sources/observation'
import type { SourceAdapter } from '../../data/sources/types'
import { createDataSourcesStore } from './store'

let sequence = 0
function freshName(): string {
  sequence += 1
  return `source-delete-${Date.now()}-${sequence}`
}

type Store = ReturnType<typeof createDataSourcesStore>

let db: SandboxDatabase
let sourceRepo: DexieSourceDataRepository
let drugRepo: DexieDrugRepository

beforeEach(() => {
  db = new SandboxDatabase(freshName())
  sourceRepo = new DexieSourceDataRepository(db)
  drugRepo = new DexieDrugRepository(db)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await db.delete()
})

function makeStore(): Store {
  const adapters: readonly SourceAdapter[] = [
    {
      id: 'fake',
      name: 'Fake Source',
      description: 'synthetic test adapter',
      capabilities: { searchScopes: ['compounds'], observations: false },
      searchCompounds: async () => [],
    },
  ]
  return createDataSourcesStore({
    sourceRepository: sourceRepo,
    drugRepository: drugRepo,
    adapters,
  })
}

const OTHER_COMPOUND: Compound = {
  ...syntheticCompound(),
  id: 'chembl:CHEMBL99990002',
  sourceId: 'CHEMBL99990002',
  name: 'Synthetic Fixture Compound B',
  identifiers: { chemblId: 'CHEMBL99990002' },
  provenance: {
    ...syntheticCompound().provenance,
    recordId: 'CHEMBL99990002',
    url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990002',
  },
}

const OTHER_OBSERVATION: ExperimentalObservation = {
  ...syntheticObservation(),
  id: 'chembl:99000007',
  compoundId: 'chembl:CHEMBL99990002',
  compoundSourceId: 'CHEMBL99990002',
  compoundName: 'Synthetic Fixture Compound B',
  provenance: { ...syntheticObservation().provenance, recordId: '99000007' },
}

/** Seed the real repositories, then reflect them into the session. */
async function seed(
  store: Store,
  compounds: readonly Compound[] = [syntheticCompound()],
  observations: readonly ExperimentalObservation[] = [syntheticObservation()],
): Promise<void> {
  const report = await sourceRepo.importSourceRecords({ compounds, observations })
  expect(report.ok).toBe(true)
  await store.getState().hydrateStored()
}

describe('deleting a stored compound', () => {
  it('deletes the compound and exactly its measurements, then refreshes the panel', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound(), OTHER_COMPOUND], [
      syntheticObservation(),
      OTHER_OBSERVATION,
    ])
    expect(store.getState().stored.compounds).toHaveLength(2)

    const outcome = await store.getState().deleteCompound('chembl:CHEMBL99990001')
    expect(outcome).toEqual({
      status: 'deleted',
      compoundId: 'chembl:CHEMBL99990001',
      deletedObservations: 1,
      message: 'Deleted "Synthetic Fixture Compound" and 1 measurement record.',
    })

    // The session was re-read from IndexedDB, not patched locally.
    const stored = store.getState().stored
    expect(stored.compounds.map((compound) => compound.id)).toEqual(['chembl:CHEMBL99990002'])
    expect(stored.observations.map((observation) => observation.id)).toEqual(['chembl:99000007'])
    expect(stored.quarantinedCompounds).toBe(0)
    expect(stored.quarantinedObservations).toBe(0)

    // …and storage agrees.
    expect((await sourceRepo.listCompounds()).records.map((record) => record.id)).toEqual([
      'chembl:CHEMBL99990002',
    ])
  })

  it('deletes a compound without measurements and states the count honestly', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound()], [])
    const outcome = await store.getState().deleteCompound('chembl:CHEMBL99990001')
    expect(outcome.status).toBe('deleted')
    if (outcome.status !== 'deleted') throw new Error('expected deleted')
    expect(outcome.deletedObservations).toBe(0)
    expect(outcome.message).toContain('0 measurement records')
    expect(store.getState().stored.compounds).toEqual([])
    expect(store.getState().stored.observations).toEqual([])
  })

  it('sets a success notice naming the compound and the real count', async () => {
    const store = makeStore()
    await seed(store)
    await store.getState().deleteCompound('chembl:CHEMBL99990001')
    const notice = store.getState().actionNotice ?? ''
    expect(notice).toContain('Synthetic Fixture Compound')
    expect(notice).toContain('1 associated measurement record')
    // The library was not part of the operation, and the message says so.
    expect(notice).toContain('drug library was not changed')
    expect(store.getState().actionError).toBeNull()
  })

  it('leaves other compounds and their measurements untouched', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound(), OTHER_COMPOUND], [
      syntheticObservation(),
      OTHER_OBSERVATION,
    ])
    const beforeCompound = structuredClone(await db.compounds.get('chembl:CHEMBL99990002'))
    const beforeObservation = structuredClone(await db.observations.get('chembl:99000007'))

    await store.getState().deleteCompound('chembl:CHEMBL99990001')

    expect(await db.compounds.get('chembl:CHEMBL99990002')).toEqual(beforeCompound)
    expect(await db.observations.get('chembl:99000007')).toEqual(beforeObservation)
  })

  it('drops deleted observation ids from the session selection', async () => {
    const store = makeStore()
    await seed(store)
    store.getState().toggleObservation('chembl:99000001')
    expect(store.getState().selectedObservationIds).toEqual(['chembl:99000001'])

    await store.getState().deleteCompound('chembl:CHEMBL99990001')
    expect(store.getState().selectedObservationIds).toEqual([])
  })

  it('reports a missing compound as a failure and writes nothing', async () => {
    const store = makeStore()
    await seed(store)
    const before = structuredClone(await db.compounds.toArray())

    const outcome = await store.getState().deleteCompound('chembl:CHEMBL00000000')
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('expected failed')
    expect(outcome.code).toBe('NOT_FOUND')
    expect(store.getState().actionError).toContain('chembl:CHEMBL00000000')
    expect(store.getState().actionNotice).toBeNull()
    expect(await db.compounds.toArray()).toEqual(before)
  })

  it('refuses a quarantined compound row, preserving it and reporting the conflict', async () => {
    const store = makeStore()
    const rawRow = { id: 'chembl:CHEMBL99990001', source: 'chembl', futureField: 'keep-me' }
    await db.compounds.put(rawRow as unknown as Compound)
    await store.getState().hydrateStored()
    // The row is quarantined, so it is not listed — but a direct id must
    // still be refused rather than silently ignored.
    expect(store.getState().stored.quarantinedCompounds).toBe(1)

    const outcome = await store.getState().deleteCompound('chembl:CHEMBL99990001')
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('expected failed')
    expect(outcome.code).toBe('QUARANTINE_CONFLICT')
    expect(store.getState().actionError).toContain('quarantined')
    expect(await db.compounds.get('chembl:CHEMBL99990001')).toEqual(rawRow)
  })

  it('reports a storage failure without claiming success or partial deletion', async () => {
    const store = makeStore()
    await seed(store)
    const beforeCompounds = structuredClone(await db.compounds.toArray())
    const beforeObservations = structuredClone(await db.observations.toArray())

    const originalBulkDelete = db.observations.bulkDelete.bind(db.observations)
    db.observations.bulkDelete = (() => {
      throw new Error('simulated storage failure')
    }) as typeof db.observations.bulkDelete
    try {
      const outcome = await store.getState().deleteCompound('chembl:CHEMBL99990001')
      expect(outcome.status).toBe('failed')
      if (outcome.status !== 'failed') throw new Error('expected failed')
      expect(outcome.code).toBe('STORAGE')
      expect(store.getState().actionError).toContain('nothing was deleted')
      expect(store.getState().actionNotice).toBeNull()
    } finally {
      db.observations.bulkDelete = originalBulkDelete
    }

    // Rolled back: storage and the session are unchanged.
    expect(await db.compounds.toArray()).toEqual(beforeCompounds)
    expect(await db.observations.toArray()).toEqual(beforeObservations)
    expect(store.getState().stored.compounds).toHaveLength(1)
    expect(store.getState().stored.observations).toHaveLength(1)
  })
})

describe('deleting a compound already imported into the Library', () => {
  it('leaves the Library snapshot, parameters and notes completely intact', async () => {
    const store = makeStore()
    await seed(store)

    // Import into the library through the real phase-36 path.
    const imported = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    expect(imported.status).toBe('created')
    if (imported.status !== 'created') throw new Error('expected created')
    const drugId = imported.drug.id

    // Give the record a hand-entered parameter and a user note, so the
    // "preserved" assertion covers more than the snapshot.
    const withParameter = await drugRepo.updateDrug(
      drugId,
      {
        notes: 'User note that must survive the source deletion.',
        targets: [
          {
            id: 'fixture-target-1',
            name: 'TEST-R',
            kd: {
              value: 12.4,
              unit: 'nM',
              provenance: { type: 'user', recordedAt: FIXTURE_TIMESTAMP },
            },
          },
        ],
      },
      imported.drug.revision ?? 0,
    )
    expect(withParameter.sourceRecords).toHaveLength(1)

    // Delete the acquisition copy.
    const outcome = await store.getState().deleteCompound('chembl:CHEMBL99990001')
    expect(outcome.status).toBe('deleted')
    expect(store.getState().stored.compounds).toEqual([])

    // The Library record is byte-identical to what it was before deletion.
    const reread = await drugRepo.getDrug(drugId)
    expect(reread).toEqual(withParameter)
    expect(reread?.sourceRecords?.[0]?.observations).toHaveLength(1)
    expect(reread?.sourceRecords?.[0]?.identifiers.inchiKey).toBe(
      'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
    )
    expect(reread?.sourceRecords?.[0]?.provenance.licenseNotice).toContain('CC BY-SA 3.0')
    expect(reread?.targets[0]?.kd?.value).toBe(12.4)
    expect(reread?.notes).toBe('User note that must survive the source deletion.')
    // The library session still shows the record.
    expect((await drugRepo.getAllDrugs()).drugs).toHaveLength(1)
  })

  it('keeps the "Use as parameter…" flow working after the source copy is deleted', async () => {
    const store = makeStore()
    await seed(store)
    const imported = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (imported.status !== 'created') throw new Error('expected created')

    // Apply the measurement to the drug BEFORE deleting the source copy.
    const applied = await store.getState().applyObservation({
      observationId: 'chembl:99000001',
      drugId: imported.drug.id,
      targetId: null,
      overwrite: false,
    })
    expect(applied).toBe(true)

    const beforeDeletion = await drugRepo.getDrug(imported.drug.id)
    await store.getState().deleteCompound('chembl:CHEMBL99990001')
    const afterDeletion = await drugRepo.getDrug(imported.drug.id)

    // The promoted parameter, its provenance and its target all survive.
    expect(afterDeletion).toEqual(beforeDeletion)
    expect(afterDeletion?.targets[0]?.ic50?.value).toBe(3.5)
    expect(afterDeletion?.targets[0]?.ic50?.provenance).toMatchObject({
      type: 'literature',
      observationId: 'chembl:99000001',
    })
  })

  it('no longer offers the deleted compound for a new library import', async () => {
    const store = makeStore()
    await seed(store)
    const imported = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (imported.status !== 'created') throw new Error('expected created')

    await store.getState().deleteCompound('chembl:CHEMBL99990001')

    // The acquisition store no longer holds it, so a repeat import cannot
    // re-read it — and it must fail rather than invent a record.
    const again = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    expect(again.status).toBe('failed')
    expect((await drugRepo.getAllDrugs()).drugs).toHaveLength(1)
  })
})

describe('no unexpected network traffic', () => {
  it('deletion performs zero external requests', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = makeStore()
    await seed(store)
    const outcome = await store.getState().deleteCompound('chembl:CHEMBL99990001')
    expect(outcome.status).toBe('deleted')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
