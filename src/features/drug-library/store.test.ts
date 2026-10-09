/**
 * Session-store tests (ADR-17): hydration (including in-flight guard and
 * quarantine reporting), CRUD refresh back from storage, error surfaces,
 * selection and filter session state. Runs against the real Dexie
 * repository on fake-indexeddb — session state must mirror the database.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SandboxDatabase } from '../../data/db/database'
import { DexieDrugRepository } from '../../data/repositories/dexieDrugRepository'
import type { DrugRepository } from '../../data/repositories/repository'
import { syntheticDrug, syntheticNpslText } from '../../tests/fixtures'
import { createLibraryStore } from './store'

let sequence = 0
async function makeStore() {
  sequence += 1
  const db = new SandboxDatabase(`store-test-${Date.now()}-${sequence}`)
  const repo = new DexieDrugRepository(db)
  const store = createLibraryStore(repo)
  return { db, repo, store }
}

describe('createLibraryStore — hydration', () => {
  it('loads drugs, metadata and marks the session ready', async () => {
    const { db, repo, store } = await makeStore()
    try {
      await repo.createDrug({ identifiers: { name: 'Fixture Compound H', synonyms: [] } })
      await store.getState().hydrate()

      const state = store.getState()
      expect(state.status).toBe('ready')
      expect(state.drugs.map((d) => d.identifiers.name)).toEqual(['Fixture Compound H'])
      expect(state.metadata?.id).toBe('local-library')
      expect(state.quarantine).toEqual([])
      expect(state.error).toBeNull()
    } finally {
      await db.delete()
    }
  })

  it('reports quarantined records instead of emptying the database', async () => {
    const { db, repo, store } = await makeStore()
    try {
      await repo.createDrug({ identifiers: { name: 'Fixture Compound H2', synonyms: [] } })
      await db.drugs.put({ id: 'bad-1', origin: 'bogus' } as never)

      await store.getState().hydrate()
      const state = store.getState()
      expect(state.status).toBe('ready')
      expect(state.drugs).toHaveLength(1)
      expect(state.quarantine.map((q) => q.id)).toEqual(['bad-1'])
      // The invalid record is still on disk.
      expect(await db.drugs.count()).toBe(2)
    } finally {
      await db.delete()
    }
  })

  it('ignores a second hydrate while the first is in flight', async () => {
    const { db } = await makeStore()
    let calls = 0
    // Count reads through a proxy over the real repository.
    const guardedRepo = new Proxy(new DexieDrugRepository(db), {
      get(target, prop, receiver) {
        if (prop === 'getAllDrugs') {
          return async () => {
            calls += 1
            await new Promise((resolve) => setTimeout(resolve, 5))
            return target.getAllDrugs()
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const guarded = createLibraryStore(guardedRepo)
    try {
      const first = guarded.getState().hydrate()
      const second = guarded.getState().hydrate()
      await Promise.all([first, second])
      expect(calls).toBe(1)
      expect(guarded.getState().status).toBe('ready')
    } finally {
      await db.delete()
    }
  })

  it('surfaces repository failures as an error state', async () => {
    const failing: DrugRepository = {
      getAllDrugs: async () => {
        throw new Error('storage unavailable')
      },
      getDrug: async () => undefined,
      createDrug: async () => {
        throw new Error('unused')
      },
      updateDrug: async () => {
        throw new Error('unused')
      },
      deleteDrug: async () => {},
      getLibraryMetadata: async () => {
        throw new Error('unused')
      },
      replaceLibrary: async () => {},
      importLibrary: async () => {
        throw new Error('unused')
      },
      exportLibrary: async () => {
        throw new Error('unused')
      },
    }
    const store = createLibraryStore(failing)
    await store.getState().hydrate()
    const state = store.getState()
    expect(state.status).toBe('error')
    expect(state.error).toContain('storage unavailable')
  })
})

describe('createLibraryStore — CRUD refreshes from storage', () => {
  it('create adds to the session and returns the new record', async () => {
    const { db, store } = await makeStore()
    try {
      const created = await store.getState().createDrug({
        identifiers: { name: 'Fixture Compound C', synonyms: ['FCC'] },
        notes: 'Synthetic test fixture — not pharmacological information.',
      })
      expect(created).not.toBeNull()
      const state = store.getState()
      expect(state.drugs.map((d) => d.identifiers.name)).toEqual(['Fixture Compound C'])
      expect(state.metadata?.updatedAt).toBeDefined()
      expect(state.error).toBeNull()
    } finally {
      await db.delete()
    }
  })

  it('an invalid creation reports the error and leaves session state untouched', async () => {
    const { db, repo, store } = await makeStore()
    try {
      await repo.createDrug({ identifiers: { name: 'Fixture Compound D', synonyms: [] } })
      await store.getState().hydrate()

      const result = await store.getState().createDrug({ identifiers: { name: '', synonyms: [] } })
      expect(result).toBeNull()
      expect(store.getState().error).toBeTruthy()
      expect(store.getState().drugs.map((d) => d.identifiers.name)).toEqual([
        'Fixture Compound D',
      ])
    } finally {
      await db.delete()
    }
  })

  it('update and delete mirror back into the session', async () => {
    const { db, repo, store } = await makeStore()
    try {
      const created = await repo.createDrug({
        identifiers: { name: 'Fixture Compound E', synonyms: [] },
      })
      await store.getState().hydrate()
      store.getState().selectDrug(created.id)

      const updated = await store.getState().updateDrug(created.id, { tags: ['edited'] })
      expect(updated?.tags).toEqual(['edited'])
      expect(store.getState().drugs[0]?.tags).toEqual(['edited'])

      const removed = await store.getState().deleteDrug(created.id)
      expect(removed).toBe(true)
      expect(store.getState().drugs).toEqual([])
      expect(store.getState().selectedDrugId).toBeNull()
    } finally {
      await db.delete()
    }
  })

  it('a failed delete reports false and the error message', async () => {
    const { db, store } = await makeStore()
    try {
      const removed = await store.getState().deleteDrug('missing-id')
      expect(removed).toBe(false)
      expect(store.getState().error).toBeTruthy()
    } finally {
      await db.delete()
    }
  })

  it('the fixture drug round-trips through hydrate (provenance intact)', async () => {
    const { db, repo, store } = await makeStore()
    try {
      await repo.replaceLibrary({
        metadata: {
          id: 'fixture-library',
          name: 'Synthetic fixture library',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          dataStatus: 'example',
        },
        drugs: [syntheticDrug()],
      })
      await store.getState().hydrate()
      expect(store.getState().drugs[0]?.targets[0]?.kd?.provenance).toEqual({
        type: 'literature',
        source: 'Synthetic fixture source',
        citation: 'Invented for tests, 2026',
      })
    } finally {
      await db.delete()
    }
  })
})

describe('createLibraryStore — session-only state', () => {
  it('setFilter stores the string; clear selectDrug resets selection', async () => {
    const { db, store } = await makeStore()
    try {
      store.getState().setFilter('  Compound ')
      expect(store.getState().filter).toBe('  Compound ')
      store.getState().selectDrug('some-id')
      expect(store.getState().selectedDrugId).toBe('some-id')
      store.getState().selectDrug(null)
      expect(store.getState().selectedDrugId).toBeNull()
    } finally {
      await db.delete()
    }
  })
})

describe('createLibraryStore — importLibrary', () => {
  it('commits a valid NPSL import and refreshes the session from storage', async () => {
    const { db, repo, store } = await makeStore()
    try {
      await store.getState().hydrate()
      expect(store.getState().drugs).toEqual([])

      const outcome = await store
        .getState()
        .importLibrary(syntheticNpslText([syntheticDrug()]), 'merge')
      expect(outcome.status).toBe('ok')
      if (outcome.status !== 'ok') throw new Error('expected a committed import')
      expect(outcome.report.mode).toBe('merge')
      expect(outcome.report.created).toBe(1)
      expect(outcome.report.updated).toBe(0)

      // session mirrors the database (the repository re-read happened)
      expect(store.getState().drugs).toHaveLength(1)
      const stored = await repo.getAllDrugs()
      expect(stored.drugs).toHaveLength(1)
      expect(stored.drugs[0]?.targets[0]?.kd?.provenance).toEqual({
        type: 'literature',
        source: 'Synthetic fixture source',
        citation: 'Invented for tests, 2026',
      })
    } finally {
      await db.delete()
    }
  })

  it('reports malformed input as invalid without writing anything', async () => {
    const { db, repo, store } = await makeStore()
    try {
      await store.getState().hydrate()
      const outcome = await store.getState().importLibrary('{broken', 'merge')
      expect(outcome.status).toBe('invalid')
      if (outcome.status !== 'invalid') throw new Error('expected a rejected import')
      expect(outcome.errors[0]?.code).toBe('PARSE')

      const stored = await repo.getAllDrugs()
      expect(stored.drugs).toEqual([])
      expect(store.getState().drugs).toEqual([])
    } finally {
      await db.delete()
    }
  })

  it('rejects duplicate ids inside the file and leaves the library unchanged', async () => {
    const { db, repo, store } = await makeStore()
    try {
      await store.getState().hydrate()
      await store.getState().importLibrary(syntheticNpslText([syntheticDrug()]), 'merge')

      const duplicate = syntheticNpslText([
        syntheticDrug(),
        syntheticDrug({ identifiers: { name: 'Synthetic duplicate', synonyms: [] } }),
      ])
      const outcome = await store.getState().importLibrary(duplicate, 'merge')
      expect(outcome.status).toBe('invalid')
      if (outcome.status !== 'invalid') throw new Error('expected a rejected import')
      expect(outcome.errors.some((e) => e.code === 'DUPLICATE_ID')).toBe(true)

      const stored = await repo.getAllDrugs()
      expect(stored.drugs).toHaveLength(1)
      expect(stored.drugs[0]?.identifiers.name).toBe('Fixture Compound A')
      expect(store.getState().drugs).toHaveLength(1)
    } finally {
      await db.delete()
    }
  })

  it('surfaces a storage failure as failed and keeps the session intact', async () => {
    const { db, repo, store } = await makeStore()
    try {
      await store.getState().hydrate()
      repo.importLibrary = async () => {
        throw new Error('storage failure')
      }

      const outcome = await store.getState().importLibrary(
        syntheticNpslText([syntheticDrug()]),
        'merge',
      )
      expect(outcome).toEqual({ status: 'failed', message: 'storage failure' })
      expect(store.getState().error).toBe('storage failure')
      expect(store.getState().drugs).toEqual([])
      // A genuine transaction failure really did roll back.
      expect(await db.drugs.count()).toBe(0)
    } finally {
      await db.delete()
    }
  })

  it('reports a committed import when the post-commit refresh fails (never as a rollback)', async () => {
    const { db, repo } = await makeStore()
    // Failure injection against the REAL Dexie repository: the import
    // transaction commits, then the refresh read throws deterministically.
    let failReads = false
    const proxied = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'getAllDrugs') {
          return async () => {
            if (failReads) throw new Error('post-commit read failure')
            return target.getAllDrugs()
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const session = createLibraryStore(proxied)
    try {
      await session.getState().hydrate()
      expect(session.getState().drugs).toHaveLength(0)

      failReads = true
      const outcome = await session
        .getState()
        .importLibrary(syntheticNpslText([syntheticDrug()]), 'merge')
      expect(outcome.status).toBe('committed-refresh-failed')
      if (outcome.status !== 'committed-refresh-failed') {
        throw new Error('expected committed-refresh-failed')
      }
      // The report proves the commit happened; the message is the ORIGINAL
      // refresh error, not a rolled-back-transaction claim.
      expect(outcome.report.ok).toBe(true)
      expect(outcome.report.created).toBe(1)
      expect(outcome.message).toBe('post-commit read failure')

      // The store surfaces commit + refresh failure together.
      expect(session.getState().error).toContain('Import committed')
      expect(session.getState().error).toContain('post-commit read failure')
      expect(session.getState().error).toContain('database contains the imported records')

      // The session is NOT marked synchronized — contents stay stale and
      // visibly flagged instead of being silently refreshed or cleared.
      expect(session.getState().drugs).toHaveLength(0)

      // The database DOES contain the imported record.
      const stored = await repo.getAllDrugs()
      expect(stored.drugs).toHaveLength(1)
      expect(stored.drugs[0]?.identifiers.name).toBe('Fixture Compound A')

      // Recovery is a hydrate retry — never an automatic re-import: the
      // session catches up and the record count does not double.
      failReads = false
      await session.getState().hydrate()
      expect(session.getState().drugs).toHaveLength(1)
      expect(session.getState().error).toBeNull()
      expect(await db.drugs.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })
})
