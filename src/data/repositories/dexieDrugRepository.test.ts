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
  FIXTURE_NOTE,
  syntheticDrug,
  syntheticDrugB,
  syntheticLibrary,
  syntheticMetadata,
  syntheticNpslText,
} from '../../tests/fixtures'
import { fieldAt } from '../../tests/runtimeFields'
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

  it('rolls back: duplicate target ids inside one drug leave every stored row byte-identical', async () => {
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
      const rowsBefore = structuredClone(await db.drugs.toArray())
      const metaBefore = structuredClone((await db.meta.toArray())[0])

      // Mixed document: one perfectly valid, new record plus one whose
      // two targets collide on `fixture-target-1` — partial application
      // would have added the valid one (audit DI-02).
      const donor = syntheticDrug().targets
      const invalid = syntheticDrug({
        id: 'fixture-drug-3',
        identifiers: { name: 'Fixture Compound C', synonyms: [] },
        targets: [donor[0]!, { ...donor[1]!, id: donor[0]!.id }],
      })
      const report = await repo.importLibrary(
        syntheticNpslText([syntheticDrugB(), invalid]),
        { mode: 'merge' },
      )
      expect(report.ok).toBe(false)
      if (!report.ok) {
        expect(report.errors.map((e) => e.code)).toEqual(['DUPLICATE_ID'])
        expect(report.errors[0]?.message).toContain('fixture-target-1')
      }

      // Zero persistent mutation: raw rows byte-identical (target-level
      // notes and whole parameter provenance included), library metadata
      // untouched, and the valid record from the rejected file absent.
      expect(await db.drugs.toArray()).toEqual(rowsBefore)
      expect((await db.meta.toArray())[0]).toEqual(metaBefore)
      expect(await db.drugs.count()).toBe(1)
      const stored = await db.drugs.get('fixture-drug-1')
      expect(stored?.targets[0]?.kd?.provenance).toEqual({
        type: 'literature',
        source: 'Synthetic fixture source',
        citation: 'Invented for tests, 2026',
      })
      expect(stored?.targets[0]?.notes).toBe(FIXTURE_NOTE)
      expect(await db.drugs.get('fixture-drug-2')).toBeUndefined()
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

// ---------------------------------------------------------------------------
// Extension fields: the loose-schema contract exercised through the real
// repository path (file → validation → transaction → storage → hydration →
// export → re-import). Synthetic test data only — never pharmacological
// information.
// ---------------------------------------------------------------------------

/**
 * A synthetic NPSL file whose record carries unknown extension fields at
 * every nesting level the schema accepts, optionally with extensions on the
 * library metadata and the envelope itself.
 */
const EXTENSION_DRUG = {
  id: 'fixture-drug-1',
  origin: 'user',
  identifiers: {
    name: 'Fixture Compound A',
    synonyms: ['Synthetic'],
    identifierExtension: 'id-ext',
  },
  tags: ['fixture'],
  rootExtension: { nested: 'root-ext' },
  targets: [
    {
      id: 'fixture-target-1',
      name: 'TEST-R',
      targetExtension: 'target-ext',
      kd: {
        value: 12.4,
        unit: 'nM',
        parameterExtension: 'param-ext',
        provenance: {
          type: 'literature',
          source: 'Synthetic fixture source',
          citation: 'Invented for tests, 2026',
          provenanceExtension: 'prov-ext',
        },
      },
    },
  ],
  pharmacokinetics: {
    pkExtension: 'pk-ext',
    halfLife: {
      value: 8,
      unit: 'h',
      provenance: { type: 'user', recordedAt: '2026-01-01T00:00:00.000Z' },
    },
  },
  notes: 'Synthetic fixture — not pharmacological information.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function extendedNpslText(
  drugs: readonly unknown[],
  metadataExtras: Record<string, unknown> = {},
  envelopeExtras: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    formatVersion: '1.0.0',
    schemaVersion: '1.0.0',
    libraryMetadata: {
      id: 'fixture-library',
      name: 'Synthetic fixture library',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dataStatus: 'example',
      ...metadataExtras,
    },
    drugs,
    ...envelopeExtras,
  })
}

/** Every extension level a preserved record must expose. */
function expectDrugExtensions(drug: unknown): void {
  expect(fieldAt(drug, 'rootExtension')).toEqual({ nested: 'root-ext' })
  expect(fieldAt(drug, 'identifiers', 'identifierExtension')).toBe('id-ext')
  expect(fieldAt(drug, 'targets', '0', 'targetExtension')).toBe('target-ext')
  expect(fieldAt(drug, 'targets', '0', 'kd', 'parameterExtension')).toBe('param-ext')
  expect(fieldAt(drug, 'targets', '0', 'kd', 'provenance', 'provenanceExtension')).toBe('prov-ext')
  expect(fieldAt(drug, 'pharmacokinetics', 'pkExtension')).toBe('pk-ext')
  // Known scientific values ride along untouched alongside the extensions.
  expect(fieldAt(drug, 'targets', '0', 'kd', 'value')).toBe(12.4)
  expect(fieldAt(drug, 'targets', '0', 'kd', 'unit')).toBe('nM')
}

describe('DexieDrugRepository — extension fields (unknown-field preservation)', () => {
  it('replace import carries extensions through storage, hydration, metadata and export', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const report = await repo.importLibrary(
        extendedNpslText([EXTENSION_DRUG], { customMetadataField: 'meta-ext' }),
        { mode: 'replace' },
      )
      expect(report.ok).toBe(true)

      // 1. storage
      const stored: unknown = await db.drugs.get('fixture-drug-1')
      expect(stored).toBeDefined()
      expectDrugExtensions(stored)

      // 2. hydration (domain objects carry the loose parse result)
      const loaded = await repo.getAllDrugs()
      expect(loaded.quarantine).toEqual([])
      expect(loaded.drugs).toHaveLength(1)
      expectDrugExtensions(loaded.drugs[0])

      // 3. library metadata extension (replace stores resolved metadata)
      const metadata: unknown = await repo.getLibraryMetadata()
      expect(fieldAt(metadata, 'customMetadataField')).toBe('meta-ext')
      expect(fieldAt(metadata, 'name')).toBe('Synthetic fixture library')

      // 4. export
      const exported = await repo.exportLibrary()
      expectDrugExtensions(exported.drugs[0])
      expect(fieldAt(exported.metadata, 'customMetadataField')).toBe('meta-ext')
    } finally {
      await db.delete()
    }
  })

  it('merge import of a new id preserves extensions and does not touch library metadata', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const metadataBefore: unknown = await repo.getLibraryMetadata()
      const report = await repo.importLibrary(
        extendedNpslText([EXTENSION_DRUG], { customMetadataField: 'file-meta' }),
        { mode: 'merge' },
      )
      expect(report.ok).toBe(true)
      if (report.ok) expect(report).toMatchObject({ created: 1, updated: 0 })

      const stored: unknown = await db.drugs.get('fixture-drug-1')
      expectDrugExtensions(stored)

      // Merge keeps the current library metadata (established contract) —
      // the file's metadata (known *and* extension fields) is not adopted.
      const metadataAfter: unknown = await repo.getLibraryMetadata()
      expect(metadataAfter).toEqual(metadataBefore)
      expect(fieldAt(metadataAfter, 'customMetadataField')).toBeUndefined()

      // The extensions also survive a storage→domain→export crossing.
      const exported = await repo.exportLibrary()
      expectDrugExtensions(exported.drugs[0])
    } finally {
      await db.delete()
    }
  })

  it('merge of an existing id: incoming wins a key collision, stored-only extensions are kept', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      // A stored record that already carries extensions.
      await db.drugs.put({
        ...toRecord(syntheticDrug()),
        futureField: 'stored',
        onlyStored: 'keep-me',
      } as never)
      const incoming = {
        ...EXTENSION_DRUG,
        futureField: 'incoming',
        onlyIncoming: 'added',
        notes: 'updated by merge',
      }
      const report = await repo.importLibrary(extendedNpslText([incoming]), { mode: 'merge' })
      expect(report.ok).toBe(true)
      if (report.ok) expect(report).toMatchObject({ updated: 1, created: 0 })

      const stored: unknown = await db.drugs.get('fixture-drug-1')
      // Deterministic collision policy: the incoming file wins.
      expect(fieldAt(stored, 'futureField')).toBe('incoming')
      // Extensions the file never mentioned are not silently discarded.
      expect(fieldAt(stored, 'onlyStored')).toBe('keep-me')
      // Extensions only the file has are added.
      expect(fieldAt(stored, 'onlyIncoming')).toBe('added')
      // Known fields are governed by the file.
      expect(fieldAt(stored, 'notes')).toBe('updated by merge')
      // Every level of extension carried by the incoming file survives.
      expectDrugExtensions(stored)
    } finally {
      await db.delete()
    }
  })

  it('editing an unrelated known field keeps extensions at every level', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const imported = await repo.importLibrary(extendedNpslText([EXTENSION_DRUG]), {
        mode: 'replace',
      })
      expect(imported.ok).toBe(true)

      const updated = await repo.updateDrug('fixture-drug-1', { notes: 'edited' })
      expect(updated.notes).toBe('edited')
      expectDrugExtensions(updated)

      const stored: unknown = await db.drugs.get('fixture-drug-1')
      expectDrugExtensions(stored)
      expect(fieldAt(stored, 'notes')).toBe('edited')
    } finally {
      await db.delete()
    }
  })

  it('export → re-import → export preserves accepted extensions', async () => {
    const dbA = freshDb()
    const dbB = freshDb()
    try {
      const repoA = new DexieDrugRepository(dbA)
      const first = await repoA.importLibrary(
        extendedNpslText([EXTENSION_DRUG], { customMetadataField: 'meta-ext' }),
        { mode: 'replace' },
      )
      expect(first.ok).toBe(true)
      const text1 = serializeNpslDocument(toNpslDocument(await repoA.exportLibrary()))

      const repoB = new DexieDrugRepository(dbB)
      const second = await repoB.importLibrary(text1, { mode: 'replace' })
      expect(second.ok).toBe(true)
      const export2 = await repoB.exportLibrary()
      const text2 = serializeNpslDocument(toNpslDocument(export2))

      // The re-imported library round-trips to an identical envelope —
      // extensions at every level included.
      expectDrugExtensions(export2.drugs[0])
      expect(fieldAt(export2.metadata, 'customMetadataField')).toBe('meta-ext')
      expect(JSON.parse(text2)).toEqual(JSON.parse(text1))
    } finally {
      await dbA.delete()
      await dbB.delete()
    }
  })

  it('a failed import leaves existing records and their extensions untouched', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const first = await repo.importLibrary(extendedNpslText([EXTENSION_DRUG]), {
        mode: 'replace',
      })
      expect(first.ok).toBe(true)

      // Duplicate id inside the file → blocking error → rollback.
      const failed = await repo.importLibrary(
        extendedNpslText([EXTENSION_DRUG, EXTENSION_DRUG]),
        { mode: 'replace' },
      )
      expect(failed.ok).toBe(false)

      const stored: unknown = await db.drugs.get('fixture-drug-1')
      expectDrugExtensions(stored)
      expect(await db.drugs.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })

  it('reports unknown envelope fields as a non-blocking warning', async () => {
    const db = freshDb()
    try {
      const repo = new DexieDrugRepository(db)
      const report = await repo.importLibrary(
        extendedNpslText([EXTENSION_DRUG], {}, { futureEnvelopeField: { x: 1 } }),
        { mode: 'replace' },
      )
      expect(report.ok).toBe(true)
      if (report.ok) {
        const warning = report.warnings.find((w) => w.code === 'ENVELOPE_FIELDS_DROPPED')
        expect(warning).toBeDefined()
        expect(warning?.message).toContain('futureEnvelopeField')
      }
      // The warning never blocks: the record is committed as usual.
      expect(await db.drugs.count()).toBe(1)
      expectDrugExtensions(await db.drugs.get('fixture-drug-1'))
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

/**
 * Negative-zero NPSL preservation (data-integrity audit DI-04). The
 * document text below is a hand-written template literal: the numeric
 * token `-0` appears verbatim — never built through `JSON.stringify`,
 * which would canonicalize `-0` to `0` before the fixture reached the
 * implementation. Sign assertions use `Object.is`. Synthetic data only.
 */
const NEG_ZERO_NPSL_TEXT = `{
  "formatVersion": "1.0.0",
  "schemaVersion": "1.0.0",
  "libraryMetadata": {
    "id": "fixture-library",
    "name": "Synthetic negative-zero library",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "dataStatus": "example"
  },
  "drugs": [
    {
      "id": "negzero-drug-1",
      "origin": "imported",
      "identifiers": {
        "name": "Synthetic Negative-Zero Fixture",
        "synonyms": [],
        "description": "Synthetic string containing 0 and -0 tokens."
      },
      "tags": [],
      "targets": [
        {
          "id": "negzero-target-1",
          "name": "NZ-R",
          "kd": {
            "value": -0,
            "unit": "nM",
            "syntheticExtension": "neg-zero-ext",
            "provenance": {
              "type": "literature",
              "source": "Synthetic fixture source",
              "citation": "Invented for tests, 2026",
              "syntheticProvenanceExtension": "neg-zero-prov-ext"
            }
          }
        }
      ],
      "pharmacokinetics": {
        "halfLife": {
          "value": -0,
          "unit": "h",
          "provenance": { "type": "user", "recordedAt": "2026-01-01T00:00:00.000Z" }
        }
      }
    }
  ]
}`

describe('DexieDrugRepository — negative-zero NPSL preservation (audit DI-04)', () => {
  it('imports literal -0 tokens, exports them verbatim and re-imports them exactly', async () => {
    const dbA = freshDb()
    const dbB = freshDb()
    try {
      const repoA = new DexieDrugRepository(dbA)
      const report = await repoA.importLibrary(NEG_ZERO_NPSL_TEXT, { mode: 'replace' })
      expect(report.ok).toBe(true)

      // Raw stored row — before any mapper — holds the exact negative zero
      // for both scientific values, with the extension fields intact.
      const raw: unknown = await dbA.drugs.get('negzero-drug-1')
      expect(Object.is(fieldAt(raw, 'targets', '0', 'kd', 'value'), -0)).toBe(true)
      expect(Object.is(fieldAt(raw, 'pharmacokinetics', 'halfLife', 'value'), -0)).toBe(true)
      expect(fieldAt(raw, 'targets', '0', 'kd', 'syntheticExtension')).toBe('neg-zero-ext')
      expect(fieldAt(raw, 'targets', '0', 'kd', 'provenance', 'syntheticProvenanceExtension')).toBe(
        'neg-zero-prov-ext',
      )
      expect(fieldAt(raw, 'identifiers', 'description')).toBe(
        'Synthetic string containing 0 and -0 tokens.',
      )

      // A fresh repository read hydrates the same values and provenance.
      const drug = await repoA.getDrug('negzero-drug-1')
      expect(Object.is(drug?.targets[0]?.kd?.value, -0)).toBe(true)
      expect(Object.is(drug?.pharmacokinetics?.halfLife?.value, -0)).toBe(true)
      expect(drug?.targets[0]?.kd?.provenance).toEqual(
        fieldAt(raw, 'targets', '0', 'kd', 'provenance'),
      )

      // Export emits the numeric token `-0` twice (kd + halfLife) — not
      // `0`, not the string "-0" — and the look-alike description stays
      // a quoted string.
      const text = serializeNpslDocument(toNpslDocument(await repoA.exportLibrary()))
      expect(text.match(/"value": -0/g) ?? []).toHaveLength(2)
      expect(text).toContain('"Synthetic string containing 0 and -0 tokens."')

      // Re-importing the exported text preserves the exact values again,
      // with the parameter's whole provenance unchanged.
      const repoB = new DexieDrugRepository(dbB)
      const second = await repoB.importLibrary(text, { mode: 'replace' })
      expect(second.ok).toBe(true)
      const reimported = await repoB.getDrug('negzero-drug-1')
      expect(Object.is(reimported?.targets[0]?.kd?.value, -0)).toBe(true)
      expect(Object.is(reimported?.pharmacokinetics?.halfLife?.value, -0)).toBe(true)
      expect(reimported?.targets[0]?.kd?.provenance).toEqual(drug?.targets[0]?.kd?.provenance)
      const rawB: unknown = await dbB.drugs.get('negzero-drug-1')
      expect(Object.is(fieldAt(rawB, 'targets', '0', 'kd', 'value'), -0)).toBe(true)
      expect(Object.is(fieldAt(rawB, 'pharmacokinetics', 'halfLife', 'value'), -0)).toBe(true)
    } finally {
      await dbA.delete()
      await dbB.delete()
    }
  })
})
