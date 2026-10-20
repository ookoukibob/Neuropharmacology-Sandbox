import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SandboxDatabase } from '../db/database'
import { DexieScenarioRepository } from './dexieScenarioRepository'
import { DexieDrugRepository } from './dexieDrugRepository'
import { demoDraft, type SimulationDraft } from '../../features/simulation/draft'

/**
 * Saved-scenario repository (phase 45): CRUD, draft fidelity, name policy,
 * stale-record handling, corruption reporting, and inclusion in the .npsb
 * backup/restore. Every test uses its own in-memory database.
 */

let db: SandboxDatabase
let repo: DexieScenarioRepository
let tick = 0
const now = (): string => {
  tick += 1
  return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
}
let idCounter = 0
const ids = (): string => {
  idCounter += 1
  return `scenario-${idCounter}`
}

beforeEach(() => {
  tick = 0
  idCounter = 0
  db = new SandboxDatabase(`test-scenarios-${Math.random().toString(36).slice(2)}`)
  repo = new DexieScenarioRepository(db, now, ids)
})

afterEach(async () => {
  await db.delete()
})

/** A draft that is deliberately INCOMPLETE: blank fields must survive. */
const incompleteDraft = (): SimulationDraft => ({
  ...demoDraft(),
  clearance: { value: '', unit: 'L/h' },
  endTime: '',
  events: [
    { kind: 'bolus', key: 7, time: '', amount: { value: '', unit: 'g' } },
    { kind: 'infusion', key: 9, startTime: '2', stopTime: 'abc', rate: { value: '5', unit: 'µg/min' } },
  ],
})

describe('create and list', () => {
  it('saves a new draft and lists it with timestamps', async () => {
    const outcome = await repo.create('  My scenario  ', demoDraft())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.scenario.name).toBe('My scenario')
    expect(outcome.scenario.id).toBe('scenario-1')
    const listed = await repo.list()
    expect(listed.corrupt).toEqual([])
    expect(listed.scenarios).toEqual([
      { id: 'scenario-1', name: 'My scenario', createdAt: now.call(null) === '' ? '' : listed.scenarios[0]?.createdAt, updatedAt: listed.scenarios[0]?.updatedAt },
    ].map((row) => ({ ...row, createdAt: listed.scenarios[0]?.createdAt, updatedAt: listed.scenarios[0]?.updatedAt })))
  })

  it('rejects an empty or whitespace-only name with VALIDATION', async () => {
    for (const name of ['', '   ']) {
      const outcome = await repo.create(name, demoDraft())
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.code).toBe('VALIDATION')
    }
    expect((await repo.list()).scenarios).toHaveLength(0)
  })

  it('allows duplicate display names but keeps records addressable by id', async () => {
    const a = await repo.create('Same name', demoDraft())
    const b = await repo.create('Same name', demoDraft())
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.scenario.id).not.toBe(b.scenario.id)
    const listed = await repo.list()
    expect(listed.scenarios).toHaveLength(2)
    expect(new Set(listed.scenarios.map((s) => s.id)).size).toBe(2)
  })

  it('stores an incomplete draft faithfully (blank stays blank, no coercion)', async () => {
    const draft = incompleteDraft()
    const created = await repo.create('Incomplete', draft)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const loaded = await repo.get(created.scenario.id)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.scenario.draft).toEqual(draft)
    expect(loaded.scenario.draft.clearance.value).toBe('')
    expect(loaded.scenario.draft.endTime).toBe('')
    expect(loaded.scenario.draft.events[0]).toMatchObject({ key: 7, time: '', amount: { value: '', unit: 'g' } })
    expect(loaded.scenario.draft.events[1]).toMatchObject({ stopTime: 'abc', rate: { unit: 'µg/min' } })
  })
})

describe('rename, duplicate, saveOver and delete', () => {
  it('rename updates only the selected record and bumps updatedAt', async () => {
    const a = await repo.create('First', demoDraft())
    const b = await repo.create('Second', demoDraft())
    if (!a.ok || !b.ok) throw new Error('setup')
    const renamed = await repo.rename(a.scenario.id, '  Renamed  ')
    expect(renamed.ok).toBe(true)
    if (!renamed.ok) return
    expect(renamed.scenario.name).toBe('Renamed')
    expect(renamed.scenario.updatedAt >= a.scenario.updatedAt).toBe(true)
    const other = await repo.get(b.scenario.id)
    expect(other.ok && other.scenario.name).toBe('Second')
  })

  it('rename rejects an empty name and leaves the record unchanged', async () => {
    const a = await repo.create('Keep me', demoDraft())
    if (!a.ok) throw new Error('setup')
    const outcome = await repo.rename(a.scenario.id, '   ')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('VALIDATION')
    const reloaded = await repo.get(a.scenario.id)
    expect(reloaded.ok && reloaded.scenario.name).toBe('Keep me')
  })

  it('duplicate creates an independent record (new id, same draft)', async () => {
    const a = await repo.create('Original', demoDraft())
    if (!a.ok) throw new Error('setup')
    const copy = await repo.duplicate(a.scenario.id)
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(copy.scenario.id).not.toBe(a.scenario.id)
    expect(copy.scenario.name).toBe('Original (copy)')
    expect(copy.scenario.draft).toEqual(a.scenario.draft)
    // Editing the copy never touches the original.
    const edited = await repo.saveOver(copy.scenario.id, { ...demoDraft(), clearance: { value: '99', unit: 'L/h' } })
    expect(edited.ok).toBe(true)
    const original = await repo.get(a.scenario.id)
    expect(original.ok && original.scenario.draft.clearance.value).toBe('2')
  })

  it('saveOver replaces the draft by id and keeps the name', async () => {
    const a = await repo.create('Named', demoDraft())
    if (!a.ok) throw new Error('setup')
    const saved = await repo.saveOver(a.scenario.id, { ...demoDraft(), clearance: { value: '7', unit: 'L/h' } })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.scenario.name).toBe('Named')
    expect(saved.scenario.draft.clearance.value).toBe('7')
  })

  it('delete removes only the selected record', async () => {
    const a = await repo.create('A', demoDraft())
    const b = await repo.create('B', demoDraft())
    if (!a.ok || !b.ok) throw new Error('setup')
    const deleted = await repo.delete(a.scenario.id)
    expect(deleted.ok).toBe(true)
    expect((await repo.get(a.scenario.id)).ok).toBe(false)
    expect((await repo.get(b.scenario.id)).ok).toBe(true)
  })

  it('reports NOT_FOUND for a record another tab deleted (never resurrects it)', async () => {
    const a = await repo.create('Gone elsewhere', demoDraft())
    if (!a.ok) throw new Error('setup')
    await repo.delete(a.scenario.id)
    for (const outcome of [
      await repo.rename(a.scenario.id, 'x'),
      await repo.saveOver(a.scenario.id, demoDraft()),
      await repo.duplicate(a.scenario.id),
    ]) {
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.code).toBe('NOT_FOUND')
    }
    expect((await repo.list()).scenarios).toHaveLength(0)
  })
})

describe('corruption and ordering', () => {
  it('reports a malformed stored row instead of trusting it', async () => {
    const good = await repo.create('Good', demoDraft())
    if (!good.ok) throw new Error('setup')
    // A row written by a foreign/faulty build: draft not an object.
    await db.scenarios.put({ id: 'broken', name: 'Broken', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), draft: 42 } as never)
    const listed = await repo.list()
    expect(listed.scenarios.map((s) => s.id)).toEqual(['scenario-1'])
    expect(listed.corrupt).toHaveLength(1)
    expect(listed.corrupt[0]?.id).toBe('broken')
    expect(listed.corrupt[0]?.message.length ?? 0).toBeGreaterThan(0)
    const single = await repo.get('broken')
    expect(single.ok).toBe(false)
    if (!single.ok) expect(single.code).toBe('CORRUPT')
    // A corrupt row is never modified by an operation aimed elsewhere.
    expect(await db.scenarios.get('broken')).toMatchObject({ draft: 42 })
  })

  it('lists most recently modified first', async () => {
    const a = await repo.create('A', demoDraft())
    const b = await repo.create('B', demoDraft())
    if (!a.ok || !b.ok) throw new Error('setup')
    await repo.rename(a.scenario.id, 'A renamed')
    const listed = await repo.list()
    expect(listed.scenarios[0]?.id).toBe(a.scenario.id)
  })
})

describe('backup integration', () => {
  it('includes saved scenarios in a recovery archive and restores them', async () => {
    const drugs = new DexieDrugRepository(db)
    const saved = await repo.create('Backed up', incompleteDraft())
    if (!saved.ok) throw new Error('setup')

    const exported = await drugs.exportRecoveryArchive()
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    const doc = JSON.parse(exported.text) as { scenarios?: { key: string }[]; counts: { scenarioRows?: number } }
    expect(doc.scenarios?.map((row) => row.key)).toEqual([saved.scenario.id])
    expect(doc.counts.scenarioRows).toBe(1)

    // Delete locally, then restore: the scenario comes back verbatim.
    await repo.delete(saved.scenario.id)
    expect((await repo.list()).scenarios).toHaveLength(0)
    const restored = await drugs.restoreRecoveryArchive(exported.text)
    expect(restored.ok).toBe(true)
    const after = await repo.get(saved.scenario.id)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.scenario.draft).toEqual(incompleteDraft())
    expect(after.scenario.name).toBe('Backed up')
  })

  it('restores a pre-phase-45 archive (no scenarios key) as an empty scenario store', async () => {
    const drugs = new DexieDrugRepository(db)
    const kept = await repo.create('Will be cleared', demoDraft())
    if (!kept.ok) throw new Error('setup')
    const exported = await drugs.exportRecoveryArchive()
    if (!exported.ok) throw new Error('export failed')
    // Simulate a legacy archive: drop the additive key and its count.
    const doc = JSON.parse(exported.text) as Record<string, unknown>
    delete doc['scenarios']
    delete (doc['counts'] as Record<string, unknown>)['scenarioRows']
    const legacy = JSON.stringify(doc)
    const preview = await drugs.previewRecoveryArchive(legacy)
    expect(preview.ok).toBe(true)
    const restored = await drugs.restoreRecoveryArchive(legacy)
    expect(restored.ok).toBe(true)
    expect((await repo.list()).scenarios).toHaveLength(0)
  })

  it('does not invent a scenarios key when the store is empty', async () => {
    const drugs = new DexieDrugRepository(db)
    const exported = await drugs.exportRecoveryArchive()
    if (!exported.ok) throw new Error('export failed')
    const doc = JSON.parse(exported.text) as Record<string, unknown>
    expect(Object.keys(doc).sort()).toEqual([
      'backupVersion',
      'counts',
      'drugs',
      'exportedAt',
      'formatId',
      'meta',
      'storage',
    ])
    expect((doc['counts'] as Record<string, unknown>)['scenarioRows']).toBeUndefined()
  })
})