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
  // Phase 50C: the archive is a raw row snapshot, so a new optional field must
  // survive the round-trip without a `.npsb` version change.
  administration: {
    route: 'iv-bolus',
    regimen: 'repeated-dose-steady-state',
    timeReference: 'dose-time',
    dose: { value: 50, unit: 'mg' },
    doseBasis: 'per-administration',
    dosingInterval: { value: 8, unit: 'h' },
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
        administration?: { doseBasis?: string; dosingInterval?: { value: number; unit: string } }
      }
      expect(dataset.measurements.map((entry) => entry.sourceRow)).toEqual([1, 2, 3])
      expect(dataset.measurements[0]?.time).toBe(0)
      expect(dataset.measurements[1]?.time).toBe(0)
      // The dose basis and τ are preserved verbatim by the raw snapshot.
      expect(dataset.administration?.doseBasis).toBe('per-administration')
      expect(dataset.administration?.dosingInterval).toEqual({ value: 8, unit: 'h' })
    } finally {
      await db.delete()
    }
  })

  it('restores a genuine 1.0.0 archive with every additive store absent and empties all four', async () => {
    const db = freshDb()
    try {
      await seedAllStores(db)
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))

      // A genuine historical archive declares 1.0.0 and predates all four
      // additive stores. Removing fields from a 1.1.0 document would not be a
      // historical archive and is rejected separately below.
      const doc = JSON.parse(exported.text) as Record<string, unknown>
      doc['backupVersion'] = '1.0.0'
      const counts = doc['counts'] as Record<string, unknown>
      for (const store of ['compounds', 'observations', 'scenarios', 'experimentDatasets']) {
        delete doc[store]
      }
      for (const count of [
        'compoundRows',
        'observationRows',
        'scenarioRows',
        'experimentDatasetRows',
      ]) {
        delete counts[count]
      }
      const legacy = JSON.stringify(doc)

      const preview = await repo.previewRecoveryArchive(legacy)
      if (!preview.ok) throw new Error(JSON.stringify(preview.issues))
      const absentWarnings = preview.report.warnings.filter(
        (entry) => entry.code === 'ARCHIVE_STORE_ABSENT',
      )
      expect(absentWarnings).toHaveLength(4)
      expect(absentWarnings.map((entry) => entry.message).join('\n')).toContain(
        'experimentDatasets',
      )
      for (const warning of absentWarnings) {
        expect(warning.message).toContain('Full replacement will leave the local')
      }
      expect(preview.report.counts.compoundRows).toBeUndefined()
      expect(preview.report.counts.observationRows).toBeUndefined()
      expect(preview.report.counts.scenarioRows).toBeUndefined()
      expect(preview.report.counts.experimentDatasetRows).toBeUndefined()

      const restored = await repo.restoreRecoveryArchive(legacy)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      // Full replacement leaves all four absent stores empty.
      expect(await db.compounds.count()).toBe(0)
      expect(await db.observations.count()).toBe(0)
      expect(await db.scenarios.count()).toBe(0)
      expect(await db.experimentDatasets.count()).toBe(0)
      // The stores the archive did carry are still restored.
      expect(await db.drugs.count()).toBe(1)
      expect(await db.meta.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })

  it('rejects malformed current archives before writing and changes no store', async () => {
    const db = freshDb()
    try {
      await seedAllStores(db)
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      const original = JSON.parse(exported.text) as Record<string, unknown>

      const missingPair = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
      delete missingPair['experimentDatasets']
      delete (missingPair['counts'] as Record<string, unknown>)['experimentDatasetRows']

      const mismatchedPair = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
      ;(mismatchedPair['counts'] as Record<string, number>)['compoundRows'] = 2

      const cases = [
        {
          label: 'missing experimentDatasets pair at 1.1.0',
          text: JSON.stringify(missingPair),
          code: 'ARCHIVE_ENVELOPE_SHAPE',
        },
        {
          label: 'compounds array/count mismatch at 1.1.0',
          text: JSON.stringify(mismatchedPair),
          code: 'ARCHIVE_COUNT_MISMATCH',
        },
      ] as const

      for (const invalid of cases) {
        const before = await allRows(db)
        const preview = await repo.previewRecoveryArchive(invalid.text)
        expect(preview.ok, invalid.label).toBe(false)
        if (!preview.ok) {
          expect(preview.issues.map((entry) => entry.code)).toContain(invalid.code)
        }
        expect(await allRows(db), `${invalid.label}: preview wrote data`).toEqual(before)

        const restored = await repo.restoreRecoveryArchive(invalid.text)
        expect(restored.ok, invalid.label).toBe(false)
        if (!restored.ok) {
          expect(restored.issues.map((entry) => entry.code)).toContain(invalid.code)
        }
        expect(await allRows(db), `${invalid.label}: restore wrote data`).toEqual(before)
      }
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
