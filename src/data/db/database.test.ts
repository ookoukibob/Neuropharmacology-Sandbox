/**
 * Schema migration demo (ADR-14): a database written by the v1 build is
 * upgraded in place — scientific data survives byte-for-byte, unknown
 * (future) fields are never destroyed, only bookkeeping is backfilled,
 * and the newer indexes/tables become usable. Two chains are covered:
 *
 * - v1 → v2 → v3 (the historical path): bookkeeping backfill runs, then
 *   the additive v3 schema adds the source-data tables;
 * - v2 → v3 (what an existing install actually performs): drugs and meta
 *   are untouched, the new `compounds`/`observations` tables open empty,
 *   and startup never seeds them.
 *
 * fake-indexeddb provides the storage; the legacy databases are declared
 * here exactly as the old builds declared them (a second version() in
 * this file would not exercise Dexie's real upgrade path).
 */
import 'fake-indexeddb/auto'
import Dexie, { type EntityTable } from 'dexie'
import { describe, expect, it } from 'vitest'
import { FIXTURE_NOTE, FIXTURE_TIMESTAMP, syntheticDrug } from '../../tests/fixtures'
import { fromRecord, toRecord } from '../mappers/records'
import { SandboxDatabase } from './database'

let sequence = 0
function freshName(): string {
  sequence += 1
  return `migration-test-${Date.now()}-${sequence}`
}

/** The v1 build's schema, declared verbatim for the upgrade test. */
class LegacyDatabaseV1 extends Dexie {
  drugs!: EntityTable<Record<string, unknown>, 'id'>
  meta!: EntityTable<Record<string, unknown>, 'id'>

  constructor(name: string) {
    super(name)
    this.version(1).stores({ drugs: 'id', meta: 'id' })
  }
}

/** The immediately previous build's schema, declared verbatim. */
class LegacyDatabaseV2 extends Dexie {
  drugs!: EntityTable<Record<string, unknown>, 'id'>
  meta!: EntityTable<Record<string, unknown>, 'id'>

  constructor(name: string) {
    super(name)
    this.version(1).stores({ drugs: 'id', meta: 'id' })
    this.version(2).stores({ drugs: 'id, origin, updatedAt', meta: 'id' })
  }
}

describe('SandboxDatabase — fresh database', () => {
  it('opens empty at the current schema version, with empty source tables', async () => {
    const db = new SandboxDatabase(freshName())
    try {
      expect(db.verno).toBe(3)
      expect(await db.drugs.count()).toBe(0)
      expect(await db.meta.count()).toBe(0)
      // The on-demand source tables exist but are never seeded at startup.
      expect(await db.compounds.count()).toBe(0)
      expect(await db.observations.count()).toBe(0)
    } finally {
      await db.delete()
    }
  })
})

describe('SandboxDatabase — v1 → v2 → v3 migration', () => {
  it('backfills bookkeeping only; scientific and unknown fields survive verbatim', async () => {
    const name = freshName()

    // 1. Write a v1-era database the way the old build did: no
    //    persistenceVersion, one record without timestamps, one record with
    //    a future field the current build does not know.
    const legacy = new LegacyDatabaseV1(name)
    const legacyDrug: Record<string, unknown> = { ...toRecord(syntheticDrug()) }
    delete legacyDrug['persistenceVersion']
    const legacyNoTimestamps: Record<string, unknown> = {
      ...toRecord(syntheticDrug({ id: 'fixture-drug-no-times' })),
    }
    delete legacyNoTimestamps['persistenceVersion']
    delete legacyNoTimestamps['createdAt']
    delete legacyNoTimestamps['updatedAt']
    const withFutureField: Record<string, unknown> = {
      ...toRecord(syntheticDrug({ id: 'fixture-drug-future' })),
      futureField: { keep: 'me' },
      identifiers: {
        name: 'Fixture Compound A',
        synonyms: ['FCA'],
        description: FIXTURE_NOTE,
        futureIdentifierField: 'keep-me-too',
      },
    }
    await legacy.drugs.bulkPut([legacyDrug, legacyNoTimestamps, withFutureField])
    await legacy.meta.put({ id: 'legacy-library', name: 'Legacy library' })
    legacy.close()

    // 2. Open with the current build — Dexie runs the version(2) and
    //    version(3) upgrades.
    const db = new SandboxDatabase(name)
    try {
      expect(db.verno).toBe(3)

      // Bookkeeping was backfilled…
      const plain = await db.drugs.get('fixture-drug-1')
      expect(plain?.persistenceVersion).toBe(2)
      const noTimes = await db.drugs.get('fixture-drug-no-times')
      expect(noTimes?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(noTimes?.updatedAt).toBe(noTimes?.createdAt) // one stamp, both keys

      // …scientific data survived unchanged…
      const upgraded = await db.drugs.get('fixture-drug-1')
      expect(fromRecord(upgraded).ok).toBe(true)
      const parsed = fromRecord(upgraded)
      if (parsed.ok) {
        expect(parsed.drug.targets[0]?.kd).toEqual({
          value: 12.4,
          unit: 'nM',
          provenance: {
            type: 'literature',
            source: 'Synthetic fixture source',
            citation: 'Invented for tests, 2026',
          },
        })
        expect(parsed.drug.createdAt).toBe(FIXTURE_TIMESTAMP)
        expect(parsed.drug.updatedAt).toBe(FIXTURE_TIMESTAMP)
      }

      // …and unknown fields at both levels were never touched.
      const future = (await db.drugs.get('fixture-drug-future')) as unknown as Record<
        string,
        unknown
      > & { identifiers: Record<string, unknown> }
      expect(future['futureField']).toEqual({ keep: 'me' })
      expect(future.identifiers['futureIdentifierField']).toBe('keep-me-too')

      // The v2 indexes are live: queries by origin/updatedAt now work.
      expect(await db.drugs.where('origin').equals('user').count()).toBe(3)
      expect(await db.drugs.where('updatedAt').above('2000-01-01').count()).toBe(3)

      // Metadata survived the upgrade untouched as well.
      const meta = await db.meta.get('legacy-library')
      expect(meta?.name).toBe('Legacy library')
    } finally {
      await db.delete()
    }
  })

  it('is stable across close/reopen after the upgrade (no second rewrite)', async () => {
    const name = freshName()
    const legacy = new LegacyDatabaseV1(name)
    await legacy.drugs.put(toRecord(syntheticDrug()))
    legacy.close()

    const first = new SandboxDatabase(name)
    const afterUpgrade = structuredClone(await first.drugs.get('fixture-drug-1'))
    expect(afterUpgrade).toBeDefined()
    first.close()

    const second = new SandboxDatabase(name)
    try {
      expect(await second.drugs.get('fixture-drug-1')).toEqual(afterUpgrade)
    } finally {
      await second.delete()
    }
  })
})

describe('SandboxDatabase — v2 → v3 migration', () => {
  it('adds empty source tables without touching stored data, and never seeds them', async () => {
    const name = freshName()

    // A v2-era database with a real drug record and library metadata.
    const legacy = new LegacyDatabaseV2(name)
    const legacyDrug = { ...toRecord(syntheticDrug()), futureField: { keep: 'me' } }
    await legacy.drugs.put(legacyDrug)
    await legacy.meta.put({ id: 'v2-library', name: 'V2 library' })
    legacy.close()

    const db = new SandboxDatabase(name)
    try {
      expect(db.verno).toBe(3)

      // Existing data is untouched — record shape, bookkeeping and the
      // unknown future field all survive byte-for-byte.
      const upgraded = await db.drugs.get('fixture-drug-1')
      expect(upgraded).toEqual(legacyDrug)
      expect(fromRecord(upgraded).ok).toBe(true)
      const meta = await db.meta.get('v2-library')
      expect(meta?.name).toBe('V2 library')

      // The new tables are present and empty: opening an existing
      // database never creates, fetches or seeds source records.
      expect(await db.compounds.count()).toBe(0)
      expect(await db.observations.count()).toBe(0)

      // …and they are immediately usable (id + compoundId indexes live).
      const compound = {
        id: 'chembl:CHEMBL99990001',
        source: 'chembl',
        sourceId: 'CHEMBL99990001',
        synonyms: [],
        identifiers: { chemblId: 'CHEMBL99990001' },
        provenance: {
          source: 'chembl',
          sourceName: 'ChEMBL',
          recordId: 'CHEMBL99990001',
          url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
          retrievedAt: FIXTURE_TIMESTAMP,
        },
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
      }
      await db.compounds.put(compound)
      const observation = {
        id: 'chembl:99000001',
        compoundId: 'chembl:CHEMBL99990001',
        compoundSourceId: 'CHEMBL99990001',
        target: {},
        endpoint: 'IC50',
        value: 3.5,
        unit: 'nM',
        qualifier: '=' as const,
        provenance: {
          source: 'chembl',
          sourceName: 'ChEMBL',
          recordId: '99000001',
          url: 'https://www.ebi.ac.uk/chembl/api/data/activity.json?activity_id=99000001',
          retrievedAt: FIXTURE_TIMESTAMP,
        },
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
      }
      await db.observations.put(observation)
      expect(
        await db.observations.where('compoundId').equals('chembl:CHEMBL99990001').count(),
      ).toBe(1)
      expect(await db.compounds.get('chembl:CHEMBL99990001')).toEqual(compound)
    } finally {
      await db.delete()
    }
  })
})
