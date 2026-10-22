/**
 * Phase 47A recovery integration: experimental datasets are part of the
 * `.npsb` full snapshot, an older archive without the store restores it empty
 * with an explicit warning, and a write failure rolls back every store.
 *
 * All fixtures are synthetic test data — not pharmacological information.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { ExperimentalDatasetInput } from '../../domain/experiments/experimental-dataset'
import { SandboxDatabase } from '../db/database'
import { toRecord } from '../mappers/records'
import { DexieDrugRepository } from './dexieDrugRepository'
import { DexieExperimentalDatasetRepository } from './dexieExperimentalDatasetRepository'
import { syntheticDrug, syntheticMetadata } from '../../tests/fixtures'

let sequence = 0

function freshDb(): SandboxDatabase {
  sequence += 1
  return new SandboxDatabase(`experiment-recovery-test-${Date.now()}-${sequence}`)
}

const DATASET_INPUT: ExperimentalDatasetInput = {
  name: 'Synthetic measured dataset',
  timeUnit: 'h',
  concentrationUnit: 'mg/L',
  notes: 'Synthetic recovery fixture',
  provenance: {
    source: 'csv',
    fileName: 'synthetic.csv',
    importedAt: '2026-01-01T00:00:00.000Z',
  },
  measurements: [
    { sourceRow: 1, time: 0, concentration: 0, sampleId: 'A', note: 'baseline' },
    { sourceRow: 2, time: 0, concentration: 0, sampleId: 'A', note: 'exact replicate' },
    { sourceRow: 3, time: 2, concentration: 1.5 },
  ],
}

/**
 * One row in every archive-backed store. The non-dataset stores are raw
 * records (the archive is a raw snapshot and validates their key/id only).
 */
async function seedAllStores(db: SandboxDatabase): Promise<{
  readonly datasetId: string
}> {
  await db.drugs.put(toRecord(syntheticDrug()))
  await db.meta.put(syntheticMetadata({ name: 'Synthetic recovery library' }))
  await db.compounds.put({ id: 'fixture-compound-1', name: 'Synthetic compound' } as never)
  await db.observations.put({
    id: 'fixture-observation-1',
    compoundId: 'fixture-compound-1',
  } as never)
  await db.scenarios.put({
    id: 'fixture-scenario-1',
    name: 'Synthetic scenario',
    draft: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as never)
  const datasets = new DexieExperimentalDatasetRepository(db)
  const created = await datasets.create(DATASET_INPUT)
  if (!created.ok) throw new Error(created.message)
  return { datasetId: created.dataset.id }
}

interface AllRows {
  readonly drugs: unknown[]
  readonly meta: unknown[]
  readonly compounds: unknown[]
  readonly observations: unknown[]
  readonly scenarios: unknown[]
  readonly experimentDatasets: unknown[]
  readonly revisions: unknown[]
}

async function allRows(db: SandboxDatabase): Promise<AllRows> {
  return {
    drugs: await db.drugs.toArray(),
    meta: await db.meta.toArray(),
    compounds: await db.compounds.toArray(),
    observations: await db.observations.toArray(),
    scenarios: await db.scenarios.toArray(),
    experimentDatasets: await db.experimentDatasets.toArray(),
    revisions: await db.revisions.toArray(),
  }
}

describe('experimental datasets in .npsb recovery', () => {
  it('round-trips all six archive stores including ordered duplicate measurements', async () => {
    const db = freshDb()
    try {
      await seedAllStores(db)
      const before = await allRows(db)
      const repo = new DexieDrugRepository(db)

      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      expect(exported.counts).toMatchObject({
        drugRows: 1,
        metaRows: 1,
        compoundRows: 1,
        observationRows: 1,
        scenarioRows: 1,
        experimentDatasetRows: 1,
      })
      const doc = JSON.parse(exported.text) as Record<string, unknown>
      expect(doc['experimentDatasets']).toHaveLength(1)

      await db.compounds.clear()
      await db.observations.clear()
      await db.scenarios.clear()
      await db.experimentDatasets.clear()
      await db.drugs.clear()
      await db.meta.clear()

      const restored = await repo.restoreRecoveryArchive(exported.text)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      const after = await allRows(db)
      expect(after.drugs).toEqual(before.drugs)
      expect(after.meta).toEqual(before.meta)
      expect(after.compounds).toEqual(before.compounds)
      expect(after.observations).toEqual(before.observations)
      expect(after.scenarios).toEqual(before.scenarios)
      expect(after.experimentDatasets).toEqual(before.experimentDatasets)
      const dataset = after.experimentDatasets[0] as {
        measurements: { sourceRow: number; time: number; concentration: number }[]
      }
      expect(dataset.measurements.map((entry) => entry.sourceRow)).toEqual([1, 2, 3])
      expect(dataset.measurements[0]?.time).toBe(0)
      expect(dataset.measurements[1]?.time).toBe(0)
    } finally {
      await db.delete()
    }
  })

  it('warns about an absent experimental-dataset store and empties it on full replacement', async () => {
    const db = freshDb()
    try {
      await seedAllStores(db)
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))

      // A supported archive written before phase 47A: the array and its
      // count are both omitted (an array without its count is rejected).
      const doc = JSON.parse(exported.text) as Record<string, unknown>
      delete doc['experimentDatasets']
      delete (doc['counts'] as Record<string, unknown>)['experimentDatasetRows']
      const legacy = JSON.stringify(doc)

      const preview = await repo.previewRecoveryArchive(legacy)
      if (!preview.ok) throw new Error(JSON.stringify(preview.issues))
      const warning = preview.report.warnings.find(
        (entry) =>
          entry.code === 'ARCHIVE_STORE_ABSENT' && entry.message.includes('experimentDatasets'),
      )
      expect(warning).toBeDefined()
      expect(warning?.message).toContain('Full replacement will leave the local')
      expect(preview.report.counts.experimentDatasetRows).toBeUndefined()

      const restored = await repo.restoreRecoveryArchive(legacy)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      expect(await db.experimentDatasets.count()).toBe(0)
      // The stores the archive did carry are still restored.
      expect(await db.compounds.count()).toBe(1)
      expect(await db.observations.count()).toBe(1)
      expect(await db.scenarios.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })

  it('rolls back every store when writing an experimental dataset fails mid-restore', async () => {
    const db = freshDb()
    try {
      const { datasetId } = await seedAllStores(db)
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))

      // Make the current state differ from the archive so a partial
      // replacement would be observable.
      const datasets = new DexieExperimentalDatasetRepository(db)
      const extra = await datasets.create({
        ...DATASET_INPUT,
        name: 'Local only dataset',
        provenance: { source: 'npex', importedAt: '2026-01-02T00:00:00.000Z' },
      })
      if (!extra.ok) throw new Error(extra.message)
      await db.compounds.put({ id: 'local-only-compound' } as never)
      const before = await allRows(db)

      const putSpy = vi.spyOn(db.experimentDatasets, 'put').mockImplementationOnce(() => {
        throw new Error('simulated dataset write failure')
      })
      try {
        await expect(repo.restoreRecoveryArchive(exported.text)).rejects.toThrow(
          'simulated dataset write failure',
        )
      } finally {
        putSpy.mockRestore()
      }

      // The transaction aborted: no store lost rows and no plural/singular
      // mix of archive and local state survived.
      const after = await allRows(db)
      expect(after).toEqual(before)
      expect(await db.experimentDatasets.get(datasetId)).toBeDefined()
      expect(await db.experimentDatasets.get(extra.dataset.id)).toBeDefined()
      expect(await db.compounds.get('local-only-compound')).toBeDefined()
    } finally {
      await db.delete()
    }
  })
})
