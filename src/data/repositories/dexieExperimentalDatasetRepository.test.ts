import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AdministrationMetadata,
  ExperimentalDataset,
  ExperimentalDatasetInput,
} from '../../domain/experiments/experimental-dataset'
import { SandboxDatabase } from '../db/database'
import { DexieExperimentalDatasetRepository } from './dexieExperimentalDatasetRepository'

let db: SandboxDatabase
let repo: DexieExperimentalDatasetRepository
let nowValue: string
let idCounter: number

const now = (): string => nowValue
const ids = (): string => {
  idCounter += 1
  return `id-${String(idCounter)}`
}

function input(overrides: Partial<ExperimentalDatasetInput> = {}): ExperimentalDatasetInput {
  return {
    name: 'Study A',
    timeUnit: 'h',
    concentrationUnit: 'mg/L',
    notes: 'Imported study',
    provenance: {
      source: 'csv',
      fileName: 'study.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    },
    measurements: [
      { sourceRow: 1, time: 0, concentration: 0, sampleId: 'A', note: 'baseline' },
      { sourceRow: 2, time: 0, concentration: 0, sampleId: 'A', note: 'replicate' },
      { sourceRow: 3, time: 2, concentration: 1.5, sampleId: 'B' },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  nowValue = '2026-02-01T00:00:00.000Z'
  idCounter = 0
  db = new SandboxDatabase(`test-experiment-datasets-${Math.random().toString(36).slice(2)}`)
  repo = new DexieExperimentalDatasetRepository(db, now, ids)
})

afterEach(async () => {
  await db.delete()
})

describe('DexieExperimentalDatasetRepository', () => {
  it('creates with local ids and preserves order, duplicates and replicate ids', async () => {
    const outcome = await repo.create(input())
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.dataset.id).toBe('id-1')
    expect(outcome.dataset.createdAt).toBe(nowValue)
    expect(outcome.dataset.updatedAt).toBe(nowValue)
    expect(outcome.dataset.measurements.map((measurement) => measurement.id)).toEqual([
      'id-2',
      'id-3',
      'id-4',
    ])
    expect(outcome.dataset.measurements.map((measurement) => measurement.sourceRow)).toEqual([
      1, 2, 3,
    ])
    expect(outcome.dataset.measurements[0]?.time).toBe(0)
    expect(outcome.dataset.measurements[1]?.time).toBe(0)
    expect(outcome.dataset.measurements[1]?.sampleId).toBe('A')

    const stored = await db.experimentDatasets.get('id-1')
    expect(stored?.measurements).toHaveLength(3)

    const listed = await repo.list()
    expect(listed.corrupt).toEqual([])
    expect(listed.datasets).toEqual([
      expect.objectContaining({
        id: 'id-1',
        name: 'Study A',
        measurementCount: 3,
        timeUnit: 'h',
        concentrationUnit: 'mg/L',
      }),
    ])
  })

  it('stores accepted dataset notes, sample ids and measurement notes exactly', async () => {
    const exact = input({
      notes: ' dataset-level note ',
      measurements: [
        {
          sourceRow: 1,
          time: 0,
          concentration: 1,
          sampleId: ' S-01 ',
          note: ' measured at 5 min ',
        },
      ],
    })
    const outcome = await repo.create(exact)
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.dataset.notes).toBe(' dataset-level note ')
    expect(outcome.dataset.measurements[0]?.sampleId).toBe(' S-01 ')
    expect(outcome.dataset.measurements[0]?.note).toBe(' measured at 5 min ')

    const stored = await db.experimentDatasets.get(outcome.dataset.id)
    expect(stored?.notes).toBe(' dataset-level note ')
    expect(stored?.measurements[0]?.sampleId).toBe(' S-01 ')
    expect(stored?.measurements[0]?.note).toBe(' measured at 5 min ')

    const read = await repo.get(outcome.dataset.id)
    if (!read.ok) throw new Error(read.message)
    expect(read.dataset.notes).toBe(' dataset-level note ')
    expect(read.dataset.measurements[0]?.sampleId).toBe(' S-01 ')
    expect(read.dataset.measurements[0]?.note).toBe(' measured at 5 min ')
  })

  it('rejects invalid fields and writes nothing', async () => {
    const cases: Partial<ExperimentalDatasetInput>[] = [
      { name: '   ' },
      { timeUnit: 'mg/L' },
      { concentrationUnit: 'fortnight' },
      {
        measurements: [{ sourceRow: 1, time: -1, concentration: 1 }],
      },
      {
        measurements: [{ sourceRow: 0, time: 1, concentration: 1 }],
      },
    ]
    for (const overrides of cases) {
      const outcome = await repo.create(input(overrides))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(['VALIDATION']).toContain(outcome.code)
    }
    expect(await db.experimentDatasets.count()).toBe(0)
  })

  it('updates the name under an optimistic token without touching measurements', async () => {
    const created = await repo.create(input())
    if (!created.ok) throw new Error('setup')
    const before = created.dataset

    const updated = await repo.update(
      before.id,
      { name: '  Renamed study  ', notes: 'New notes' },
      before.updatedAt,
    )
    if (!updated.ok) throw new Error(updated.message)
    expect(updated.dataset.name).toBe('Renamed study')
    expect(updated.dataset.notes).toBe('New notes')
    expect(updated.dataset.measurements).toEqual(before.measurements)
    expect(updated.dataset.timeUnit).toBe(before.timeUnit)
    expect(updated.dataset.provenance).toEqual(before.provenance)
    expect(updated.dataset.updatedAt).not.toBe(before.updatedAt)

    const stale = await repo.update(before.id, { name: 'Stale overwrite' }, before.updatedAt)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('CONFLICT')
    expect((await db.experimentDatasets.get(before.id))?.name).toBe('Renamed study')
  })

  it('clears notes explicitly and keeps them when the field is absent', async () => {
    const created = await repo.create(input())
    if (!created.ok) throw new Error('setup')
    const renamed = await repo.update(created.dataset.id, { name: 'No notes change' }, created.dataset.updatedAt)
    if (!renamed.ok) throw new Error(renamed.message)
    expect(renamed.dataset.notes).toBe('Imported study')

    const cleared = await repo.update(
      created.dataset.id,
      { notes: undefined },
      renamed.dataset.updatedAt,
    )
    if (!cleared.ok) throw new Error(cleared.message)
    expect(cleared.dataset.notes).toBeUndefined()
  })

  it('keeps updatedAt tokens strictly increasing even when the clock is frozen', async () => {
    const created = await repo.create(input())
    if (!created.ok) throw new Error('setup')
    const first = await repo.update(created.dataset.id, { name: 'One' }, created.dataset.updatedAt)
    if (!first.ok) throw new Error(first.message)
    expect(first.dataset.updatedAt).toBe('2026-02-01T00:00:00.001Z')

    const second = await repo.update(created.dataset.id, { name: 'Two' }, first.dataset.updatedAt)
    if (!second.ok) throw new Error(second.message)
    expect(second.dataset.updatedAt).toBe('2026-02-01T00:00:00.002Z')

    const stale = await repo.update(created.dataset.id, { name: 'Stale' }, first.dataset.updatedAt)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('CONFLICT')
  })

  it('creates with administration metadata and loads datasets without it unchanged', async () => {
    const admin = {
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
      dose: { value: 100, unit: 'mg' },
    } as const
    const withAdmin = await repo.create(input({ administration: admin }))
    if (!withAdmin.ok) throw new Error(withAdmin.message)
    expect(withAdmin.dataset.administration).toEqual(admin)

    const withoutAdmin = await repo.create(input())
    if (!withoutAdmin.ok) throw new Error(withoutAdmin.message)
    expect(withoutAdmin.dataset.administration).toBeUndefined()
    const read = await repo.get(withoutAdmin.dataset.id)
    if (!read.ok) throw new Error(read.message)
    expect(read.dataset.administration).toBeUndefined()
  })

  it('rejects invalid administration metadata and writes nothing', async () => {
    const bad = await repo.create(
      input({
        administration: {
          route: 'iv-bolus',
          regimen: 'single-dose',
          timeReference: 'dose-time',
          dose: { value: 100, unit: 'mg/L' },
        } as unknown as AdministrationMetadata,
      }),
    )
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('VALIDATION')
    expect(await db.experimentDatasets.count()).toBe(0)
  })

  it('updates and clears administration without touching measurements', async () => {
    const created = await repo.create(input())
    if (!created.ok) throw new Error('setup')
    const before = created.dataset

    const admin = {
      route: 'iv-infusion',
      regimen: 'single-dose',
      timeReference: 'infusion-start',
      infusion: { duration: { value: 2, unit: 'h' } },
    } as const
    const updated = await repo.update(before.id, { administration: admin }, before.updatedAt)
    if (!updated.ok) throw new Error(updated.message)
    expect(updated.dataset.administration).toEqual(admin)
    expect(updated.dataset.measurements).toEqual(before.measurements)
    expect(updated.dataset.provenance).toEqual(before.provenance)

    const cleared = await repo.update(
      before.id,
      { administration: undefined },
      updated.dataset.updatedAt,
    )
    if (!cleared.ok) throw new Error(cleared.message)
    expect(cleared.dataset.administration).toBeUndefined()
    expect(cleared.dataset.measurements).toEqual(before.measurements)
  })

  it('persists the dose basis and rejects one that describes nothing', async () => {
    const admin = {
      route: 'iv-bolus',
      regimen: 'repeated-dose-steady-state',
      timeReference: 'dose-time',
      dose: { value: 50, unit: 'mg' },
      doseBasis: 'per-administration',
      dosingInterval: { value: 8, unit: 'h' },
    } as const
    const created = await repo.create(input({ administration: admin }))
    if (!created.ok) throw new Error(created.message)
    expect(created.dataset.administration?.doseBasis).toBe('per-administration')

    const read = await repo.get(created.dataset.id)
    if (!read.ok) throw new Error(read.message)
    expect(read.dataset.administration?.doseBasis).toBe('per-administration')
    expect(read.dataset.administration?.dosingInterval).toEqual({ value: 8, unit: 'h' })

    // A basis with no amount is refused before anything is written.
    const before = await repo.list()
    const invalid = await repo.update(
      created.dataset.id,
      {
        administration: {
          route: 'iv-bolus',
          regimen: 'single-dose',
          timeReference: 'dose-time',
          doseBasis: 'per-administration',
        },
      },
      created.dataset.updatedAt,
    )
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.code).toBe('VALIDATION')
    const after = await repo.list()
    expect(after).toEqual(before)
  })

  it('keeps administration unchanged when the update does not mention it', async () => {    const admin = {
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
      dose: { value: 100, unit: 'mg' },
    } as const
    const created = await repo.create(input({ administration: admin }))
    if (!created.ok) throw new Error('setup')
    const renamed = await repo.update(created.dataset.id, { name: 'Only renamed' }, created.dataset.updatedAt)
    if (!renamed.ok) throw new Error(renamed.message)
    expect(renamed.dataset.administration).toEqual(admin)
  })

  it('deletes only under the current token and reports a stale delete', async () => {
    const created = await repo.create(input())
    if (!created.ok) throw new Error('setup')
    const renamed = await repo.update(created.dataset.id, { name: 'Current' }, created.dataset.updatedAt)
    if (!renamed.ok) throw new Error('setup')

    const stale = await repo.delete(created.dataset.id, created.dataset.updatedAt)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('CONFLICT')
    expect(await db.experimentDatasets.get(created.dataset.id)).toBeDefined()

    const removed = await repo.delete(created.dataset.id, renamed.dataset.updatedAt)
    expect(removed.ok).toBe(true)
    expect(await db.experimentDatasets.get(created.dataset.id)).toBeUndefined()
    expect(await repo.list().then((result) => result.datasets)).toEqual([])
  })

  it('reports corrupt rows instead of trusting, editing or deleting them', async () => {
    const created = await repo.create(input())
    if (!created.ok) throw new Error('setup')
    const firstMeasurement = created.dataset.measurements[0]
    if (firstMeasurement === undefined) throw new Error('setup')
    const corruptRow: ExperimentalDataset = {
      ...created.dataset,
      measurements: [{ ...firstMeasurement, time: -5 }],
    }
    await db.experimentDatasets.put(corruptRow)

    const listed = await repo.list()
    expect(listed.datasets).toEqual([])
    expect(listed.corrupt).toHaveLength(1)
    expect(listed.corrupt[0]?.id).toBe(created.dataset.id)

    const get = await repo.get(created.dataset.id)
    expect(get.ok).toBe(false)
    if (!get.ok) expect(get.code).toBe('CORRUPT')

    const update = await repo.update(
      created.dataset.id,
      { name: 'Should not write' },
      created.dataset.updatedAt,
    )
    expect(update.ok).toBe(false)
    if (!update.ok) expect(update.code).toBe('CORRUPT')

    const deleted = await repo.delete(created.dataset.id, created.dataset.updatedAt)
    expect(deleted.ok).toBe(false)
    if (!deleted.ok) expect(deleted.code).toBe('CORRUPT')
    expect(await db.experimentDatasets.get(created.dataset.id)).toBeDefined()
  })

  it('does not silently overwrite a change made through another repository instance', async () => {
    const other = new DexieExperimentalDatasetRepository(db, () => '2026-02-02T00:00:00.000Z', () => 'other')
    const created = await repo.create(input())
    if (!created.ok) throw new Error('setup')
    const otherUpdate = await other.update(
      created.dataset.id,
      { name: 'Other tab' },
      created.dataset.updatedAt,
    )
    if (!otherUpdate.ok) throw new Error(otherUpdate.message)

    const stale = await repo.update(
      created.dataset.id,
      { name: 'This tab' },
      created.dataset.updatedAt,
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('CONFLICT')
    expect((await db.experimentDatasets.get(created.dataset.id))?.name).toBe('Other tab')
  })

  it('lists most recently updated datasets first', async () => {
    const first = await repo.create(input({ name: 'First' }))
    if (!first.ok) throw new Error('setup')
    nowValue = '2026-02-02T00:00:00.000Z'
    const second = await repo.create(input({ name: 'Second' }))
    if (!second.ok) throw new Error('setup')
    nowValue = '2026-02-03T00:00:00.000Z'
    const renamed = await repo.update(second.dataset.id, { name: 'Second updated' }, second.dataset.updatedAt)
    if (!renamed.ok) throw new Error(renamed.message)

    const listed = await repo.list()
    expect(listed.datasets.map((dataset) => dataset.name)).toEqual(['Second updated', 'First'])
  })

  it('returns NOT_FOUND for missing ids', async () => {
    const get = await repo.get('missing')
    expect(get.ok).toBe(false)
    if (!get.ok) expect(get.code).toBe('NOT_FOUND')
    const update = await repo.update('missing', { name: 'x' }, nowValue)
    expect(update.ok).toBe(false)
    if (!update.ok) expect(update.code).toBe('NOT_FOUND')
    const deleted = await repo.delete('missing', nowValue)
    expect(deleted.ok).toBe(false)
    if (!deleted.ok) expect(deleted.code).toBe('NOT_FOUND')
  })
})
