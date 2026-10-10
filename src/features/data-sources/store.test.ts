/**
 * Data-sources store tests (jsdom + fake-indexeddb, real Dexie
 * repositories): the full search → fetch → select → preview → import
 * lifecycle including cancellation and stale-result guards, atomic
 * import outcomes, and every Layer C application rule (endpoint mapping,
 * qualifiers, units, explicit overwrite).
 *
 * HTTP is never live: the store is built with scripted fake adapters, and
 * one dedicated test builds it with the REAL adapters plus a fetch spy to
 * prove startup/hydration performs no network calls and seeds nothing.
 * All record content is synthetic test data — not pharmacological
 * information.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syntheticCompound, syntheticObservation, syntheticDrug, syntheticLibrary } from '../../tests/fixtures'
import { SandboxDatabase } from '../../data/db/database'
import { DexieDrugRepository } from '../../data/repositories/dexieDrugRepository'
import { DexieSourceDataRepository } from '../../data/repositories/dexieSourceDataRepository'
import { createSourceAdapters } from '../../data/sources/registry'
import {
  SourceRequestError,
  type ObservationPage,
  type ObservationRequestOptions,
  type RequestOptions,
  type SourceAdapter,
} from '../../data/sources/types'
import type { RemoteCompound } from '../../domain/sources/compound'
import type { RemoteObservation } from '../../domain/sources/observation'
import { createDataSourcesStore, importPreviewOf, type DataSourcesState } from './store'

// --- fixtures --------------------------------------------------------------

const COMPOUND_A = syntheticCompound()
const COMPOUND_B: RemoteCompound = {
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
const OBSERVATION_A = syntheticObservation()
const OBSERVATION_B: RemoteObservation = {
  ...syntheticObservation(),
  id: 'chembl:99000007',
  compoundId: 'chembl:CHEMBL99990002',
  compoundSourceId: 'CHEMBL99990002',
  compoundName: 'Synthetic Fixture Compound B',
}

function emptyPage(items: readonly RemoteObservation[] = []): ObservationPage {
  return { items, total: items.length, nextOffset: null, omitted: 0 }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A record with a given key removed (negative-testing variants). */
function without(key: 'parameterKind' | 'unit', base = syntheticObservation()): RemoteObservation {
  const clone: Record<string, unknown> = { ...base }
  delete clone[key]
  return clone as unknown as RemoteObservation
}

// --- harness ---------------------------------------------------------------

let sequence = 0
function freshName(): string {
  sequence += 1
  return `data-sources-store-${Date.now()}-${sequence}`
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

function makeAdapter(overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    id: 'fake',
    name: 'Fake Source',
    description: 'synthetic test adapter',
    capabilities: { searchScopes: ['compounds', 'targets'], observations: true },
    searchCompounds: async () => [],
    searchTargets: async () => [],
    fetchObservations: async () => emptyPage(),
    fetchObservationsByTarget: async () => emptyPage(),
    fetchCompounds: async () => [],
    ...overrides,
  }
}

function makeStore(adapters: readonly SourceAdapter[] = [makeAdapter()]): Store {
  return createDataSourcesStore({
    sourceRepository: sourceRepo,
    drugRepository: drugRepo,
    adapters,
  })
}

/** Hydrate a store whose source already holds the given records. */
async function seedAndHydrate(
  store: Store,
  records: {
    compounds?: readonly RemoteCompound[]
    observations?: readonly RemoteObservation[]
    withLibrary?: boolean
  } = {},
): Promise<void> {
  const report = await sourceRepo.importSourceRecords({
    compounds: records.compounds ?? [COMPOUND_A],
    observations: records.observations ?? [OBSERVATION_A],
  })
  expect(report.ok).toBe(true)
  if (records.withLibrary === true) {
    await drugRepo.replaceLibrary(syntheticLibrary([syntheticDrug()]))
  }
  await store.getState().hydrateStored()
}

// --- tests -----------------------------------------------------------------

describe('data sources — startup and hydration', () => {
  it('hydrates stored records with zero network requests and no seeding', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    // Real adapters (default transport = globalThis.fetch): if hydration
    // or store construction reached out to a source, the spy would see it.
    const store = makeStore(createSourceAdapters())
    await store.getState().hydrateStored()
    const stored = store.getState().stored
    expect(stored.status).toBe('ready')
    expect(stored.compounds).toEqual([])
    expect(stored.observations).toEqual([])
    expect(stored.drugs).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('loads stored compounds, observations and drugs after an import', async () => {
    const store = makeStore()
    await seedAndHydrate(store, { withLibrary: true })
    const stored = store.getState().stored
    expect(stored.compounds.map((c) => c.id)).toEqual(['chembl:CHEMBL99990001'])
    expect(stored.observations.map((o) => o.id)).toEqual(['chembl:99000001'])
    expect(stored.drugs.map((d) => d.identifiers.name)).toEqual(['Fixture Compound A'])
    expect(stored.quarantinedCompounds).toBe(0)
    expect(stored.quarantinedObservations).toBe(0)
  })
})

describe('data sources — search lifecycle', () => {
  it('walks idle → searching → results, and empty for no matches', async () => {
    const queries: string[] = []
    const gate = deferred<readonly RemoteCompound[]>()
    let call = 0
    const store = makeStore([
      makeAdapter({
        searchCompounds: async (query) => {
          queries.push(query)
          call += 1
          return call === 1 ? await gate.promise : []
        },
      }),
    ])
    expect(store.getState().search.status).toBe('idle')

    store.getState().setQuery('synthetic')
    const pending = store.getState().runSearch()
    expect(store.getState().search.status).toBe('searching')
    gate.resolve([COMPOUND_A])
    await pending
    expect(store.getState().search.status).toBe('results')
    expect(store.getState().search.compounds).toEqual([COMPOUND_A])
    expect(queries).toEqual(['synthetic'])

    store.getState().setQuery('zzz no match')
    await store.getState().runSearch()
    expect(store.getState().search.status).toBe('empty')
    expect(store.getState().search.compounds).toEqual([])
    expect(queries).toEqual(['synthetic', 'zzz no match'])
  })

  it('explains a network failure with its code instead of a generic message', async () => {
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () => {
          throw new SourceRequestError('network', 'connection reset')
        },
      }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    expect(store.getState().search.status).toBe('error')
    expect(store.getState().search.errorCode).toBe('network')
    expect(store.getState().search.error).toContain('Network error')
  })

  it('discards a stale response when a newer query supersedes it', async () => {
    const gates = [deferred<readonly RemoteCompound[]>(), deferred<readonly RemoteCompound[]>()]
    let calls = 0
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () => {
          const gate = gates[calls]
          calls += 1
          if (gate === undefined) throw new Error('unexpected search call')
          return await gate.promise
        },
      }),
    ])

    store.getState().setQuery('first')
    const first = store.getState().runSearch()
    store.getState().setQuery('second')
    const second = store.getState().runSearch()

    gates[0]?.resolve([COMPOUND_A]) // the superseded query answers late
    await first
    expect(store.getState().search.status).toBe('searching') // stale result discarded
    expect(store.getState().search.compounds).toEqual([])

    gates[1]?.resolve([COMPOUND_B])
    await second
    expect(store.getState().search.status).toBe('results')
    expect(store.getState().search.compounds).toEqual([COMPOUND_B])
  })

  it('cancelSearch aborts the in-flight request and keeps an idle state', async () => {
    const gate = deferred<readonly RemoteCompound[]>()
    let captured: RequestOptions | undefined
    const store = makeStore([
      makeAdapter({
        searchCompounds: async (_query, options) => {
          captured = options
          return await gate.promise
        },
      }),
    ])
    store.getState().setQuery('synthetic')
    const pending = store.getState().runSearch()
    store.getState().cancelSearch()
    expect(store.getState().search.status).toBe('idle')
    expect(captured?.signal?.aborted).toBe(true)

    gate.resolve([COMPOUND_A])
    await pending
    expect(store.getState().search.status).toBe('idle') // late answer stays discarded
    expect(store.getState().search.compounds).toEqual([])
  })

  it('switching source resets results, selections and the observation list', async () => {
    const alpha = makeAdapter({ id: 'alpha', searchCompounds: async () => [COMPOUND_A] })
    const beta = makeAdapter({ id: 'beta' })
    const store = makeStore([alpha, beta])
    expect(store.getState().sourceId).toBe('alpha')

    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)
    expect(store.getState().selectedCompoundIds).toEqual([COMPOUND_A.id])

    store.getState().setSource('beta')
    const state = store.getState()
    expect(state.sourceId).toBe('beta')
    expect(state.search.status).toBe('idle')
    expect(state.selectedCompoundIds).toEqual([])
    expect(state.observations.status).toBe('idle')
  })

  it('scope switch invalidates results from the previous scope', async () => {
    const store = makeStore()
    store.getState().setScope('targets')
    expect(store.getState().scope).toBe('targets')
    expect(store.getState().search.status).toBe('idle')
    store.getState().setScope('compounds')
    expect(store.getState().scope).toBe('compounds')
  })
})

describe('data sources — observation retrieval', () => {
  it('fetches a page for the selected compound with the endpoint scope', async () => {
    const requests: ObservationRequestOptions[] = []
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () => [COMPOUND_A],
        fetchObservations: async (_id, options) => {
          requests.push(options ?? {})
          return { items: [OBSERVATION_A], total: 7, nextOffset: 25, omitted: 1 }
        },
      }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)
    await store.getState().fetchObservations()

    const state = store.getState()
    expect(state.observations.status).toBe('ready')
    expect(state.observations.items).toEqual([OBSERVATION_A])
    expect(state.observations.total).toBe(7)
    expect(state.observations.nextOffset).toBe(25)
    expect(state.observations.omitted).toBe(1)
    expect(state.observations.pageSource).toEqual({
      kind: 'compound',
      sourceId: 'CHEMBL99990001',
    })
    expect(state.observations.fetchedFor).toContain('Synthetic Fixture Compound')
    expect(requests[0]?.endpointScope).toBe('parameters')
    expect(requests[0]?.limit).toBe(25)
  })

  it('refuses to fetch without a selection (and without a target in target scope)', async () => {
    let calls = 0
    const store = makeStore([
      makeAdapter({
        fetchObservations: async () => {
          calls += 1
          return emptyPage()
        },
      }),
    ])
    await store.getState().fetchObservations()
    expect(store.getState().observations.status).toBe('error')
    expect(store.getState().observations.error).toContain('Select at least one compound')
    expect(calls).toBe(0)

    store.getState().setScope('targets')
    await store.getState().fetchObservations()
    expect(store.getState().observations.error).toContain('Select a target first')
    expect(calls).toBe(0)
  })

  it('merges pages for multi-compound selection without a misleading pager', async () => {
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () => [COMPOUND_A, COMPOUND_B],
        fetchObservations: async (sourceId) =>
          sourceId === 'CHEMBL99990001'
            ? { items: [OBSERVATION_A], total: 5, nextOffset: 25, omitted: 0 }
            : { items: [OBSERVATION_B], total: 3, nextOffset: 25, omitted: 2 },
      }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)
    store.getState().toggleCompound(COMPOUND_B.id)
    await store.getState().fetchObservations()

    const state = store.getState()
    expect(state.observations.items).toHaveLength(2)
    expect(state.observations.total).toBe(8)
    expect(state.observations.omitted).toBe(2)
    // A merged list pages two source queries — a single offset would lie.
    expect(state.observations.nextOffset).toBeNull()
    expect(state.observations.pageSource).toBeNull()
    expect(state.observations.fetchedFor).toBe('2 compounds')
  })

  it('pages the ORIGINAL query even if the selection changed after fetching', async () => {
    const paged: string[] = []
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () => [COMPOUND_A, COMPOUND_B],
        fetchObservations: async (sourceId, options) => {
          paged.push(sourceId)
          return (options?.offset ?? 0) === 0
            ? { items: [OBSERVATION_A], total: 50, nextOffset: 25, omitted: 0 }
            : { items: [OBSERVATION_B], total: 50, nextOffset: null, omitted: 0 }
        },
      }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)
    await store.getState().fetchObservations()
    expect(store.getState().observations.nextOffset).toBe(25)

    // Selection changes must not redirect paging to a different query.
    store.getState().toggleCompound(COMPOUND_A.id)
    store.getState().toggleCompound(COMPOUND_B.id)
    await store.getState().loadMoreObservations()

    expect(paged).toEqual(['CHEMBL99990001', 'CHEMBL99990001'])
    const items = store.getState().observations.items
    expect(items.map((item) => item.id)).toEqual(['chembl:99000001', 'chembl:99000007'])
    expect(store.getState().observations.nextOffset).toBeNull()
  })

  it('reports observation-fetch failures with the code-specific message', async () => {
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () => [COMPOUND_A],
        fetchObservations: async () => {
          throw new SourceRequestError('timeout', 'too slow')
        },
      }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)
    await store.getState().fetchObservations()
    expect(store.getState().observations.status).toBe('error')
    expect(store.getState().observations.errorCode).toBe('timeout')
    expect(store.getState().observations.error).toContain('time limit')
  })

  it('discards a stale observation page when a newer fetch supersedes it', async () => {
    const gates = [deferred<ObservationPage>(), deferred<ObservationPage>()]
    let calls = 0
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () => [COMPOUND_A],
        fetchObservations: async () => {
          const gate = gates[calls]
          calls += 1
          if (gate === undefined) throw new Error('unexpected observations call')
          return await gate.promise
        },
      }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)

    const first = store.getState().fetchObservations()
    const second = store.getState().fetchObservations()
    gates[0]?.resolve({ items: [OBSERVATION_A], total: 1, nextOffset: null, omitted: 0 })
    await first
    expect(store.getState().observations.items).toEqual([]) // stale page discarded
    gates[1]?.resolve({ items: [OBSERVATION_B], total: 1, nextOffset: null, omitted: 0 })
    await second
    expect(store.getState().observations.items).toEqual([OBSERVATION_B])
  })

  it('changing the endpoint scope invalidates already-fetched records', async () => {
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () => [COMPOUND_A],
        fetchObservations: async () => ({ items: [OBSERVATION_A], total: 1, nextOffset: null, omitted: 0 }),
      }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)
    await store.getState().fetchObservations()
    expect(store.getState().observations.status).toBe('ready')

    store.getState().setEndpointScope('all')
    expect(store.getState().observations.status).toBe('idle')
    expect(store.getState().observations.items).toEqual([])
    expect(store.getState().endpointScope).toBe('all')
  })
})

describe('data sources — import (explicit, atomic)', () => {
  it('imports the explicit selection and refreshes the stored view', async () => {
    const store = makeStore([
      makeAdapter({ searchCompounds: async () => [COMPOUND_A] }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)
    await store.getState().importSelected()

    expect(store.getState().importOutcome).toEqual({
      status: 'ok',
      report: {
        createdCompounds: 1,
        createdObservations: 0,
        skippedCompounds: 0,
        skippedObservations: 0,
      },
    })
    expect(store.getState().stored.compounds.map((c) => c.id)).toEqual(['chembl:CHEMBL99990001'])
  })

  it('resolves missing compound identity records via the source batch lookup', async () => {
    const resolvedFor: string[][] = []
    const store = makeStore([
      makeAdapter({
        searchTargets: async () => [
          { sourceTargetId: 'CHEMBL99991001', name: 'Synthetic Target A' },
        ],
        fetchObservationsByTarget: async () => ({
          items: [OBSERVATION_B],
          total: 1,
          nextOffset: null,
          omitted: 0,
        }),
        fetchCompounds: async (ids) => {
          resolvedFor.push([...ids])
          return [COMPOUND_B]
        },
      }),
    ])
    store.getState().setScope('targets')
    store.getState().setQuery('synthetic target')
    await store.getState().runSearch()
    store.getState().setActiveTarget({ sourceTargetId: 'CHEMBL99991001', name: 'Synthetic Target A' })
    await store.getState().fetchObservations()
    store.getState().toggleObservation(OBSERVATION_B.id)
    await store.getState().importSelected()

    expect(resolvedFor).toEqual([['chembl:CHEMBL99990002']])
    expect(store.getState().importOutcome).toEqual({
      status: 'ok',
      report: {
        createdCompounds: 1,
        createdObservations: 1,
        skippedCompounds: 0,
        skippedObservations: 0,
      },
    })
    expect(store.getState().stored.observations.map((o) => o.id)).toEqual(['chembl:99000007'])
  })

  it('fails the whole import when identity resolution fails (nothing written)', async () => {
    const store = makeStore([
      makeAdapter({
        searchTargets: async () => [
          { sourceTargetId: 'CHEMBL99991001', name: 'Synthetic Target A' },
        ],
        fetchObservationsByTarget: async () => ({
          items: [OBSERVATION_B],
          total: 1,
          nextOffset: null,
          omitted: 0,
        }),
        fetchCompounds: async () => {
          throw new SourceRequestError('network', 'connection reset')
        },
      }),
    ])
    store.getState().setScope('targets')
    store.getState().setQuery('synthetic target')
    await store.getState().runSearch()
    store.getState().setActiveTarget({ sourceTargetId: 'CHEMBL99991001' })
    await store.getState().fetchObservations()
    store.getState().toggleObservation(OBSERVATION_B.id)
    await store.getState().importSelected()

    const outcome = store.getState().importOutcome
    expect(outcome?.status).toBe('failed')
    if (outcome?.status === 'failed') expect(outcome.message).toContain('nothing was imported')
    expect(store.getState().stored.compounds).toEqual([])
    expect(store.getState().stored.observations).toEqual([])
  })

  it('fails when the source cannot return a referenced compound record', async () => {
    const store = makeStore([
      makeAdapter({
        searchTargets: async () => [
          { sourceTargetId: 'CHEMBL99991001', name: 'Synthetic Target A' },
        ],
        fetchObservationsByTarget: async () => ({
          items: [OBSERVATION_B],
          total: 1,
          nextOffset: null,
          omitted: 0,
        }),
        fetchCompounds: async () => [], // silent no-result is not enough
      }),
    ])
    store.getState().setScope('targets')
    store.getState().setQuery('synthetic target')
    await store.getState().runSearch()
    store.getState().setActiveTarget({ sourceTargetId: 'CHEMBL99991001' })
    await store.getState().fetchObservations()
    store.getState().toggleObservation(OBSERVATION_B.id)
    await store.getState().importSelected()

    const outcome = store.getState().importOutcome
    expect(outcome?.status).toBe('failed')
    if (outcome?.status === 'failed') expect(outcome.message).toContain('CHEMBL99990002')
    expect(store.getState().stored.observations).toEqual([])
  })

  it('surfaces repository rejection and writes nothing on invalid records', async () => {
    const store = makeStore([
      makeAdapter({
        searchCompounds: async () =>
          [{ id: 'fake:BOGUS1', source: 'fake', sourceId: 'BOGUS1', bogus: true }] as unknown as RemoteCompound[],
      }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound('fake:BOGUS1')
    await store.getState().importSelected()

    const outcome = store.getState().importOutcome
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status === 'rejected') {
      expect(outcome.errors[0]?.code).toBe('INVALID_RECORD')
      expect(outcome.errors[0]?.path).toBe('compounds.0')
    }
    expect(store.getState().stored.compounds).toEqual([])
  })

  it('is a no-op when nothing is selected', async () => {
    const store = makeStore([
      makeAdapter({ searchCompounds: async () => [COMPOUND_A] }),
    ])
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    await store.getState().importSelected()
    expect(store.getState().importOutcome).toBeNull()
    expect(store.getState().stored.compounds).toEqual([])
  })

  it('previews selection counts including records that already exist', async () => {
    const store = makeStore([
      makeAdapter({ searchCompounds: async () => [COMPOUND_A] }),
    ])
    await seedAndHydrate(store) // COMPOUND_A + OBSERVATION_A already stored
    store.getState().setQuery('synthetic')
    await store.getState().runSearch()
    store.getState().toggleCompound(COMPOUND_A.id)

    const preview = importPreviewOf(store.getState())
    expect(preview).toEqual({
      compounds: 1,
      observations: 0,
      existingCompounds: 1,
      existingObservations: 0,
    })
  })
})

describe('data sources — applying an observation to a parameter (Layer C)', () => {
  async function storeWithLibrary(): Promise<Store> {
    const store = makeStore()
    await seedAndHydrate(store, { withLibrary: true })
    return store
  }

  function applyRequest(
    overrides: Partial<Parameters<DataSourcesState['applyObservation']>[0]> = {},
  ): Parameters<DataSourcesState['applyObservation']>[0] {
    return {
      observationId: OBSERVATION_A.id,
      drugId: 'fixture-drug-1',
      targetId: null,
      overwrite: false,
      ...overrides,
    }
  }

  it('creates a new target carrying the value, species and observation link', async () => {
    const store = await storeWithLibrary()
    const ok = await store.getState().applyObservation(applyRequest())
    expect(ok).toBe(true)

    const drug = await drugRepo.getDrug('fixture-drug-1')
    const created = drug?.targets.find((target) => target.name === 'Synthetic Target A')
    expect(created?.species).toBe('Homo sapiens')
    expect(created?.ic50).toEqual({
      value: 3.5,
      unit: 'nM',
      provenance: {
        type: 'literature',
        source: 'ChEMBL',
        url: 'https://www.ebi.ac.uk/chembl/api/data/activity.json?activity_id=99000001',
        accessedAt: '2026-01-01T00:00:00.000Z',
        observationId: 'chembl:99000001',
        notes: expect.stringContaining('endpoint IC50'),
      },
    })
    expect(store.getState().actionNotice).toContain('Applied IC50')
    expect(store.getState().actionError).toBeNull()
    // The stored view re-read the updated drug.
    expect(store.getState().stored.drugs[0]?.targets).toHaveLength(3)
  })

  it('fills an empty slot on an existing target without touching other slots', async () => {
    const store = await storeWithLibrary()
    const ok = await store
      .getState()
      .applyObservation(applyRequest({ targetId: 'fixture-target-1' }))
    expect(ok).toBe(true)
    const drug = await drugRepo.getDrug('fixture-drug-1')
    const target = drug?.targets.find((candidate) => candidate.id === 'fixture-target-1')
    expect(target?.ic50?.value).toBe(3.5)
    expect(target?.kd).toEqual({ // unrelated slot untouched
      value: 12.4,
      unit: 'nM',
      provenance: {
        type: 'literature',
        source: 'Synthetic fixture source',
        citation: 'Invented for tests, 2026',
      },
    })
  })

  it('requires an explicit overwrite for an occupied slot, then replaces only it', async () => {
    const store = await storeWithLibrary()
    const refused = await store
      .getState()
      .applyObservation(applyRequest({ targetId: 'fixture-target-2' }))
    expect(refused).toBe(false)
    expect(store.getState().actionError).toContain('already holds a value')
    const before = await drugRepo.getDrug('fixture-drug-1')
    expect(before?.targets.find((t) => t.id === 'fixture-target-2')?.ic50?.value).toBe(88)

    const accepted = await store
      .getState()
      .applyObservation(applyRequest({ targetId: 'fixture-target-2', overwrite: true }))
    expect(accepted).toBe(true)
    const after = await drugRepo.getDrug('fixture-drug-1')
    expect(after?.targets.find((t) => t.id === 'fixture-target-2')?.ic50?.value).toBe(3.5)
    expect(after?.targets.find((t) => t.id === 'fixture-target-2')?.ic50?.provenance).toMatchObject({
      observationId: 'chembl:99000001',
    })
  })

  it('refuses endpoints that do not map onto a parameter slot (no substitution)', async () => {
    const store = makeStore()
    const unmapped = without('parameterKind', { ...OBSERVATION_A, endpoint: "Log K'" })
    await sourceRepo.importSourceRecords({ compounds: [COMPOUND_A], observations: [unmapped] })
    await drugRepo.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    await store.getState().hydrateStored()

    const ok = await store
      .getState()
      .applyObservation(applyRequest({ observationId: unmapped.id }))
    expect(ok).toBe(false)
    expect(store.getState().actionError).toContain('does not map')
    const drug = await drugRepo.getDrug('fixture-drug-1')
    expect(drug?.targets.find((t) => t.id === 'fixture-target-2')?.ic50?.value).toBe(88) // untouched
  })

  it('refuses qualifiers other than an exact reported value', async () => {
    const store = makeStore()
    const limited: RemoteObservation = { ...OBSERVATION_A, qualifier: '<' }
    await sourceRepo.importSourceRecords({ compounds: [COMPOUND_A], observations: [limited] })
    await drugRepo.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    await store.getState().hydrateStored()

    const ok = await store.getState().applyObservation(applyRequest())
    expect(ok).toBe(false)
    expect(store.getState().actionError).toContain('"<"')
  })

  it('refuses a measurement without a unit or without a molar-concentration unit', async () => {
    const store = makeStore()
    await sourceRepo.importSourceRecords({ compounds: [COMPOUND_A], observations: [without('unit')] })
    await drugRepo.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    await store.getState().hydrateStored()
    const missing = await store.getState().applyObservation(applyRequest())
    expect(missing).toBe(false)
    expect(store.getState().actionError).toContain('no unit')

    const percent: RemoteObservation = { ...OBSERVATION_A, id: 'chembl:99000009', unit: '%' }
    await sourceRepo.importSourceRecords({ compounds: [], observations: [percent] })
    await store.getState().hydrateStored()
    const wrongUnit = await store
      .getState()
      .applyObservation(applyRequest({ observationId: 'chembl:99000009' }))
    expect(wrongUnit).toBe(false)
    expect(store.getState().actionError).toContain('not a molar concentration')
  })

  it('refuses unknown observations, unknown drugs and unnamed new targets', async () => {
    const store = await storeWithLibrary()
    const unknownObservation = await store
      .getState()
      .applyObservation(applyRequest({ observationId: 'chembl:00000000' }))
    expect(unknownObservation).toBe(false)
    expect(store.getState().actionError).toContain('not in the stored records')

    const unknownDrug = await store
      .getState()
      .applyObservation(applyRequest({ drugId: 'no-such-drug' }))
    expect(unknownDrug).toBe(false)
    expect(store.getState().actionError).toContain('Choose a drug')

    const unnamed = makeStore()
    await sourceRepo.importSourceRecords({
      compounds: [COMPOUND_A],
      observations: [{ ...OBSERVATION_A, id: 'chembl:99000011', target: {} }],
    })
    await drugRepo.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    await unnamed.getState().hydrateStored()
    const result = await unnamed
      .getState()
      .applyObservation(applyRequest({ observationId: 'chembl:99000011' }))
    expect(result).toBe(false)
    expect(unnamed.getState().actionError).toContain('reports no target name')
  })
})

describe('data sources — adding a compound to the drug library', () => {
  it('creates an identity-only drug record with full source attribution', async () => {
    const store = makeStore()
    await seedAndHydrate(store)
    const drug = await store.getState().addToLibrary(COMPOUND_A.id)

    expect(drug?.identifiers.name).toBe('Synthetic Fixture Compound')
    expect(drug?.identifiers.synonyms).toEqual(['SFC-1'])
    expect(drug?.targets).toEqual([]) // identity only — no parameters invented
    expect(drug?.notes).toContain('https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001')
    expect(drug?.notes).toContain('CC BY-SA 3.0')
    expect(store.getState().stored.drugs.map((d) => d.id)).toContain(drug?.id)
    expect(store.getState().actionNotice).toContain('identity only')
  })

  it('reports a missing compound instead of creating anything', async () => {
    const store = makeStore()
    await seedAndHydrate(store)
    const drug = await store.getState().addToLibrary('chembl:CHEMBL00000000')
    expect(drug).toBeNull()
    expect(store.getState().actionError).toContain('not in the stored records')
    expect(store.getState().stored.drugs).toEqual([])
  })
})
