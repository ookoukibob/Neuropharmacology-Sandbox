/**
 * Repository tests (ADR-14/15): CRUD with validation, metadata stamping,
 * quarantine reporting, atomic replace/import (rollback on failure),
 * unknown-field preservation across edits, reload persistence, and the
 * NPSL export → import round trip.
 *
 * All fixtures are synthetic test data, labeled as such.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import {
  syntheticDrug,
  syntheticDrugB,
  syntheticLibrary,
  syntheticMetadata,
  syntheticNpslText,
} from '../../tests/fixtures'
import { SandboxDatabase } from '../db/database'
import { serializeNpslDocument, toNpslDocument } from '../mappers/npslDocument'
import { toRecord } from '../mappers/records'
import { DexieDrugRepository } from './dexieDrugRepository'
import { RepositoryError } from './repository'

let sequence = 0
function freshDb(): SandboxDatabase {
  sequence += 1
  return new SandboxDatabase(`repo-test-${Date.now()}-${sequence}`)
}

async function expectRejected(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('DexieDrugRepository — CRUD', () => {
  it('creates, reads and lists user drugs with assigned identity', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const created = await repo.createDrug({
        identifiers: { name: 'Fixture Compound C', synonyms: ['FCC'] },
        tags: ['fixture'],
        targets: [{ name: 'TEST-R', kd: { value: 5, unit: 'nM', provenance: { type: 'user' } } }],
        notes: 'Synthetic test fixture — not pharmacological information.',
      })

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/) // stable UUID, not a name
      expect(created.origin).toBe('user')
      expect(created.createdAt).toBeDefined()
      expect(created.updatedAt).toBe(created.createdAt)
      // Target rows get stable ids assigned by the repository.
      expect(created.targets[0]?.id).toMatch(/^[0-9a-f-]{36}$/)

      expect(await repo.getDrug(created.id)).toEqual(created)
      const list = await repo.getAllDrugs()
      expect(list.drugs).toHaveLength(1)
      expect(list.quarantine).toEqual([])
    } finally {
      await db.delete()
    }
  })

  it('rejects an invalid creation without storing anything', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await expectRejected(
        repo.createDrug({ identifiers: { name: '', synonyms: [] } }),
        'VALIDATION',
      )
      // A scientific value without provenance is also rejected — provenance
      // is never invented by the storage layer.
      await expectRejected(
        repo.createDrug({
          identifiers: { name: 'X', synonyms: [] },
          targets: [{ name: 'T', kd: { value: 1, unit: 'nM' } as never }],
        }),
        'VALIDATION',
      )
      expect(await db.drugs.count()).toBe(0)
    } finally {
      await db.delete()
    }
  })

  it('updates fields, clears notes explicitly, and keeps origin/createdAt', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const created = await repo.createDrug({
        identifiers: { name: 'Fixture Compound D', synonyms: [] },
        notes: 'initial note',
      })
      const updated = await repo.updateDrug(created.id, {
        identifiers: { name: 'Fixture Compound D-1', synonyms: ['FCD'] },
        notes: undefined, // explicit clear
        tags: ['edited'],
      })
      expect(updated.identifiers.name).toBe('Fixture Compound D-1')
      expect(updated.notes).toBeUndefined()
      expect(updated.tags).toEqual(['edited'])
      expect(updated.id).toBe(created.id)
      expect(updated.origin).toBe('user')
      expect(updated.createdAt).toBe(created.createdAt)
      expect(updated.updatedAt).toBeDefined()

      await expectRejected(repo.updateDrug('missing-id', { tags: [] }), 'NOT_FOUND')
    } finally {
      await db.delete()
    }
  })

  it('preserves storage origin on edit (origin is storage, not provenance)', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put({ ...toRecord(syntheticDrug({ origin: 'imported' })) })
      const edited = await repo.updateDrug('fixture-drug-1', { tags: ['edited'] })
      expect(edited.origin).toBe('imported')
      expect((await repo.getDrug('fixture-drug-1'))?.origin).toBe('imported')
    } finally {
      await db.delete()
    }
  })

  it('keeps unknown record fields across an edit', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      // Deliberately out-of-contract record: a future field the current
      // build does not know — exactly what the preservation rule must keep.
      type FutureRecord = ReturnType<typeof toRecord> & {
        futureField: { keep: string }
      }
      const withFuture: FutureRecord = {
        ...toRecord(syntheticDrug()),
        futureField: { keep: 'me' },
      }
      await db.drugs.put(withFuture)
      await repo.updateDrug('fixture-drug-1', { notes: 'edited' })
      const raw = (await db.drugs.get('fixture-drug-1')) as unknown as Record<string, unknown>
      expect(raw['futureField']).toEqual({ keep: 'me' })
      expect(raw['notes']).toBe('edited')
    } finally {
      await db.delete()
    }
  })

  it('deletes records and reports missing ids as NOT_FOUND', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      await repo.deleteDrug('fixture-drug-1')
      expect(await db.drugs.count()).toBe(0)
      await expectRejected(repo.deleteDrug('fixture-drug-1'), 'NOT_FOUND')
    } finally {
      await db.delete()
    }
  })
})

describe('DexieDrugRepository — library metadata', () => {
  it('creates one documented default entry on first run', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const first = await repo.getLibraryMetadata()
      const second = await repo.getLibraryMetadata()
      expect(first.id).toBe('local-library')
      expect(first.dataStatus).toBe('unspecified') // empty: nothing claimed
      expect(second).toEqual(first)
      expect(await db.meta.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })

  it('CRUD stamps library updatedAt but never createdAt', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.meta.put({
        id: 'local-library',
        name: 'L',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        dataStatus: 'unspecified',
      })
      await repo.createDrug({ identifiers: { name: 'Fixture Compound E', synonyms: [] } })
      const meta = await repo.getLibraryMetadata()
      expect(meta.createdAt).toBe('2020-01-01T00:00:00.000Z')
      expect(meta.updatedAt).not.toBe('2020-01-01T00:00:00.000Z')
    } finally {
      await db.delete()
    }
  })
})

describe('DexieDrugRepository — quarantine (never silently empty the DB)', () => {
  it('reports invalid records and keeps them stored untouched', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      await db.drugs.put({ id: 'bad-1', origin: 'bogus' } as never)

      const loaded = await repo.getAllDrugs()
      expect(loaded.drugs.map((d) => d.id)).toEqual(['fixture-drug-1'])
      expect(loaded.quarantine).toHaveLength(1)
      expect(loaded.quarantine[0]?.id).toBe('bad-1')
      expect(loaded.quarantine[0]?.errors.length).toBeGreaterThan(0)
      expect(loaded.quarantine[0]?.record).toMatchObject({ id: 'bad-1' })

      // Still stored — hydration never deletes.
      expect(await db.drugs.count()).toBe(2)
      // Reading it individually fails loudly instead of returning garbage.
      await expectRejected(repo.getDrug('bad-1'), 'VALIDATION')
      // Exports contain only readable records; the broken one stays put.
      const exported = await repo.exportLibrary()
      expect(exported.drugs).toHaveLength(1)
      expect(await db.drugs.count()).toBe(2)
    } finally {
      await db.delete()
    }
  })
})

describe('DexieDrugRepository — replaceLibrary (atomic, all-or-nothing)', () => {
  it('replaces drugs and metadata wholesale', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      await repo.replaceLibrary(syntheticLibrary([syntheticDrugB()]))
      const list = await repo.getAllDrugs()
      expect(list.drugs.map((d) => d.id)).toEqual(['fixture-drug-2'])
      expect((await repo.getLibraryMetadata()).name).toBe('Synthetic fixture library')
    } finally {
      await db.delete()
    }
  })

  it('rejects duplicate ids inside the transaction — current data survives', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      await db.meta.put({
        id: 'local-library',
        name: 'Original',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        dataStatus: 'unspecified',
      })

      await expectRejected(
        repo.replaceLibrary(syntheticLibrary([syntheticDrugB(), syntheticDrugB()])),
        'VALIDATION',
      )

      // Nothing was cleared, nothing was written.
      expect((await repo.getDrug('fixture-drug-1'))?.identifiers.name).toBe('Fixture Compound A')
      expect(await db.drugs.count()).toBe(1)
      expect((await repo.getLibraryMetadata()).name).toBe('Original')
    } finally {
      await db.delete()
    }
  })

  it('rejects an invalid drug before the first write', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      const broken = syntheticDrug({ id: 'fixture-drug-broken', identifiers: { name: '', synonyms: [] } })
      await expectRejected(repo.replaceLibrary(syntheticLibrary([broken])), 'VALIDATION')
      expect(await db.drugs.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })
})

describe('DexieDrugRepository — importLibrary', () => {
  it('returns PARSE errors without opening a write transaction', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      const report = await repo.importLibrary('{broken', { mode: 'merge' })
      expect(report.ok).toBe(false)
      if (!report.ok) expect(report.errors[0]?.code).toBe('PARSE')
      expect(await db.drugs.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })

  it('rolls back: schema-invalid files change nothing', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      const broken = syntheticDrug({ id: 'fixture-drug-broken' }) as unknown as Record<string, unknown>
      delete broken['identifiers']
      const text = JSON.stringify({
        formatVersion: '1.0.0',
        schemaVersion: '1.0.0',
        libraryMetadata: syntheticMetadata(),
        drugs: [syntheticDrugB(), broken],
      })
      const report = await repo.importLibrary(text, { mode: 'replace' })
      expect(report.ok).toBe(false)
      if (!report.ok) expect(report.errors[0]?.code).toBe('SCHEMA')
      // The valid drug in the same file was not committed either.
      expect((await repo.getDrug('fixture-drug-1'))?.identifiers.name).toBe('Fixture Compound A')
      expect(await db.drugs.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })

  it('rolls back: duplicate ids are validated inside the transaction', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      const report = await repo.importLibrary(
        syntheticNpslText([syntheticDrugB(), syntheticDrugB()]),
        { mode: 'merge' },
      )
      expect(report.ok).toBe(false)
      if (!report.ok) expect(report.errors.map((e) => e.code)).toEqual(['DUPLICATE_ID'])
      expect(await db.drugs.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })

  it('merge: updates matching ids, adds new ones, preserves file-declared origin', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      // The file declares an origin of its own — import must not rewrite it.
      const incoming = [
        { ...syntheticDrug(), notes: 'updated by import' },
        { ...syntheticDrugB(), origin: 'built-in-demo' as const },
      ]
      const report = await repo.importLibrary(syntheticNpslText(incoming), { mode: 'merge' })
      expect(report.ok).toBe(true)
      if (report.ok) {
        expect(report).toMatchObject({ total: 2, created: 1, updated: 1 })
        expect(report.warnings).toEqual([])
      }
      expect((await repo.getDrug('fixture-drug-1'))?.notes).toBe('updated by import')
      expect((await repo.getDrug('fixture-drug-2'))?.origin).toBe('built-in-demo')
      expect(await db.drugs.count()).toBe(2)
    } finally {
      await db.delete()
    }
  })

  it('merge: does not stamp library metadata (CRUD alone does)', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.meta.put({
        id: 'local-library',
        name: 'Original',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        dataStatus: 'unspecified',
      })
      const report = await repo.importLibrary(syntheticNpslText([syntheticDrug()]), {
        mode: 'merge',
      })
      expect(report.ok).toBe(true)
      const meta = await repo.getLibraryMetadata()
      expect(meta.updatedAt).toBe('2020-01-01T00:00:00.000Z')
      expect(meta.name).toBe('Original')
    } finally {
      await db.delete()
    }
  })

  it('replace: the file becomes the library (drugs and metadata)', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      const report = await repo.importLibrary(syntheticNpslText([syntheticDrugB()]), {
        mode: 'replace',
      })
      expect(report.ok).toBe(true)
      const list = await repo.getAllDrugs()
      expect(list.drugs.map((d) => d.id)).toEqual(['fixture-drug-2'])
      expect((await repo.getLibraryMetadata()).name).toBe('Synthetic fixture library')
    } finally {
      await db.delete()
    }
  })

  it('propagates semantic warnings (duplicate names) in the report', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const sameName = syntheticDrug({ id: 'fixture-drug-3' })
      const report = await repo.importLibrary(syntheticNpslText([syntheticDrug(), sameName]), {
        mode: 'merge',
      })
      expect(report.ok).toBe(true)
      if (report.ok) expect(report.warnings.map((w) => w.code)).toContain('DUPLICATE_NAME')
    } finally {
      await db.delete()
    }
  })
})

describe('DexieDrugRepository — round trip and reload', () => {
  it('export → NPSL → import → export is identity (metadata, origin, provenance)', async () => {
    const dbA = freshDb()
    const dbB = freshDb()
    try {
      const repoA = new DexieDrugRepository(dbA)
      await repoA.replaceLibrary(syntheticLibrary([syntheticDrug(), syntheticDrugB()]))
      const original = await repoA.exportLibrary()

      const text = serializeNpslDocument(toNpslDocument(original))

      const repoB = new DexieDrugRepository(dbB)
      const report = await repoB.importLibrary(text, { mode: 'replace' })
      expect(report.ok).toBe(true)
      const reimported = await repoB.exportLibrary()

      expect(reimported).toEqual(original)
      // Provenance triples survived whole.
      expect(reimported.drugs[0]?.targets[0]?.kd?.provenance).toEqual(
        original.drugs[0]?.targets[0]?.kd?.provenance,
      )
      expect(reimported.drugs[1]?.origin).toBe(original.drugs[1]?.origin)
    } finally {
      await dbA.delete()
      await dbB.delete()
    }
  })

  it('data survives close/reopen (the reload case)', async () => {
    const name = `repo-test-reload-${Date.now()}`
    const first = new SandboxDatabase(name)
    try {
      const repo = new DexieDrugRepository(first)
      const created = await repo.createDrug({
        identifiers: { name: 'Fixture Compound R', synonyms: [] },
        notes: 'Synthetic test fixture — not pharmacological information.',
      })
      first.close()

      const second = new SandboxDatabase(name)
      try {
        const repo2 = new DexieDrugRepository(second)
        expect((await repo2.getDrug(created.id))?.identifiers.name).toBe('Fixture Compound R')
        expect((await repo2.getAllDrugs()).drugs).toHaveLength(1)
      } finally {
        await second.delete()
      }
    } finally {
      await first.close()
    }
  })
})

describe('RepositoryError', () => {
  it('is a typed Error (name and code)', () => {
    const error = new RepositoryError('NOT_FOUND', 'gone')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('RepositoryError')
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toBe('gone')
  })
})
