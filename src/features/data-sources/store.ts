/**
 * Data-sources session store (ADR-17): a factory bound to the source-data
 * repository, the drug repository and the configured source adapters.
 *
 * Zustand holds *session state only* — search/observation lifecycle
 * (loading / empty / error / cancelled / stale), explicit selections, the
 * stored-record view and the outcome of the last import or parameter
 * application. IndexedDB remains the source of truth: every write goes
 * through a repository and is followed by a re-read, so a reload re-derives
 * the same state from storage.
 *
 * Rules encoded here (never in the UI layer alone):
 * - no request ever runs at startup — retrieval happens only through
 *   `runSearch` / `fetchObservations`, which the user invokes;
 * - a superseded search is discarded (sequence guard) and a cancelled one
 *   aborts its in-flight fetch — stale results can never land in the UI;
 * - importing is explicit: preview data is computed, then the repository
 *   re-validates atomically; existing records are never overwritten;
 * - a stored observation becomes a model parameter only through
 *   `applyObservation`, which refuses endpoint substitution, qualifiers
 *   other than an exact reported value, missing/non-concentration units
 *   and occupied slots without an explicit `overwrite`.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { Drug, DrugId, TargetId } from '../../domain/drug/drug'
import type { ScientificValue } from '../../domain/pharmacology/scientific-value'
import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import type { Compound, RemoteCompound } from '../../domain/sources/compound'
import type {
  ExperimentalObservation,
  ParameterKind,
  RemoteObservation,
} from '../../domain/sources/observation'
import type { DrugRepository, DrugInput, TargetInput } from '../../data/repositories/repository'
import type {
  SourceDataRepository,
  SourceImportIssue,
} from '../../data/repositories/sourceDataRepository'
import {
  SourceRequestError,
  type ObservationPage,
  type RemoteTarget,
  type SearchScope,
  type SourceAdapter,
  type SourceErrorCode,
} from '../../data/sources/types'

/** Page size for observation retrieval (a user-visible, bounded request). */
export const PAGE_SIZE = 25

export type SearchStatus = 'idle' | 'searching' | 'results' | 'empty' | 'error'
export type ObservationsStatus = 'idle' | 'loading' | 'ready' | 'error'
export type StoredStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SearchState {
  readonly status: SearchStatus
  readonly error: string | null
  readonly errorCode: SourceErrorCode | null
  readonly compounds: readonly RemoteCompound[]
  readonly targets: readonly RemoteTarget[]
}

/** Where the current observation list came from (enables safe paging). */
export type PageSource =
  | { readonly kind: 'target'; readonly sourceId: string }
  | { readonly kind: 'compound'; readonly sourceId: string }

export interface ObservationsState {
  readonly status: ObservationsStatus
  readonly error: string | null
  readonly errorCode: SourceErrorCode | null
  readonly items: readonly RemoteObservation[]
  /** Total matching records at the source, when the source supplies one. */
  readonly total: number | null
  /** Next page offset, or null when no further page is available. */
  readonly nextOffset: number | null
  /** Supplied rows that carried no usable measurement (counted, shown). */
  readonly omitted: number
  /** What the current list was fetched for — drives the honest header. */
  readonly fetchedFor: string | null
  /** The single query this list pages — null for merged multi-source lists. */
  readonly pageSource: PageSource | null
}

export interface StoredState {
  readonly status: StoredStatus
  readonly error: string | null
  readonly compounds: readonly Compound[]
  readonly observations: readonly ExperimentalObservation[]
  readonly drugs: readonly Drug[]
  readonly quarantinedCompounds: number
  readonly quarantinedObservations: number
}

export type ImportOutcome =
  | { readonly status: 'ok'; readonly report: ImportOkReport }
  | { readonly status: 'rejected'; readonly errors: readonly SourceImportIssue[] }
  | { readonly status: 'failed'; readonly message: string }

interface ImportOkReport {
  readonly createdCompounds: number
  readonly createdObservations: number
  readonly skippedCompounds: number
  readonly skippedObservations: number
}

export interface ApplyObservationRequest {
  readonly observationId: string
  readonly drugId: DrugId
  /** Existing target row, or null to create one named from the observation. */
  readonly targetId: TargetId | null
  /** Explicit acknowledgement required when the slot is already occupied. */
  readonly overwrite: boolean
}

/** One entry of the source picker, derived once from the adapters. */
export interface SourceSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly searchScopes: readonly SearchScope[]
  readonly offersObservations: boolean
  readonly licenseNotice?: string
  readonly licenseUrl?: string
}

export interface DataSourcesState {
  readonly sourceId: string
  /** Static picker options — the UI never hardcodes source names. */
  readonly sources: readonly SourceSummary[]
  readonly scope: SearchScope
  readonly query: string
  /** Endpoint filter for observation retrieval (labelled in the UI). */
  readonly endpointScope: 'parameters' | 'all'
  readonly search: SearchState
  readonly activeTarget: RemoteTarget | null
  readonly observations: ObservationsState
  readonly selectedCompoundIds: readonly string[]
  readonly selectedObservationIds: readonly string[]
  readonly importOutcome: ImportOutcome | null
  readonly stored: StoredState
  /** Error from a storage-side action (apply / add to library). */
  readonly actionError: string | null
  /** Success notice from a storage-side action. */
  readonly actionNotice: string | null

  setSource(id: string): void
  setScope(scope: SearchScope): void
  setQuery(query: string): void
  setEndpointScope(scope: 'parameters' | 'all'): void
  /** User-initiated retrieval of the current query (never runs at startup). */
  runSearch(): Promise<void>
  cancelSearch(): void
  toggleCompound(id: string): void
  toggleObservation(id: string): void
  setActiveTarget(target: RemoteTarget | null): void
  fetchObservations(): Promise<void>
  loadMoreObservations(): Promise<void>
  clearObservations(): void
  importSelected(): Promise<void>
  clearImportOutcome(): void
  hydrateStored(): Promise<void>
  applyObservation(request: ApplyObservationRequest): Promise<boolean>
  addToLibrary(compoundId: string): Promise<Drug | null>
  clearActionMessages(): void
}

export interface DataSourcesDeps {
  readonly sourceRepository: SourceDataRepository
  readonly drugRepository: DrugRepository
  /** In configured order — the first entry is the default source. */
  readonly adapters: readonly SourceAdapter[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Friendly, code-specific explanation for every retrieval failure. */
export function describeRequestError(error: unknown): {
  readonly code: SourceErrorCode | null
  readonly message: string
} {
  if (error instanceof SourceRequestError) {
    switch (error.code) {
      case 'network':
        return {
          code: 'network',
          message: 'Network error — the source could not be reached. Check your connection and retry.',
        }
      case 'timeout':
        return {
          code: 'timeout',
          message: 'The source did not answer within the time limit. Try again.',
        }
      case 'aborted':
        return { code: 'aborted', message: 'Request cancelled.' }
      case 'http':
        return {
          code: 'http',
          message: `The source answered with an error (${error.message}). Try again later.`,
        }
      case 'invalid-response':
        return {
          code: 'invalid-response',
          message:
            'The source returned a response this app could not read — nothing was imported from it.',
        }
    }
  }
  return { code: null, message: `Unexpected error: ${messageOf(error)}` }
}

function emptySearch(): SearchState {
  return { status: 'idle', error: null, errorCode: null, compounds: [], targets: [] }
}

function emptyObservations(fetchedFor: string | null = null): ObservationsState {
  return {
    status: 'idle',
    error: null,
    errorCode: null,
    items: [],
    total: null,
    nextOffset: null,
    omitted: 0,
    fetchedFor,
    pageSource: null,
  }
}

export interface ImportPreview {
  readonly compounds: number
  readonly observations: number
  readonly existingCompounds: number
  readonly existingObservations: number
}

/**
 * Advisory preview of what `importSelected` would do. The repository
 * re-classifies everything atomically at commit time — this number is a
 * communication aid, never the integrity boundary.
 */
export function importPreviewOf(state: DataSourcesState): ImportPreview {
  const selectedObservations = state.observations.items.filter((observation) =>
    state.selectedObservationIds.includes(observation.id),
  )
  const selectedCompounds = state.search.compounds.filter((compound) =>
    state.selectedCompoundIds.includes(compound.id),
  )
  const compoundIds = new Set<string>([
    ...selectedCompounds.map((compound) => compound.id),
    ...selectedObservations.map((observation) => observation.compoundId),
  ])
  const storedCompoundIds = new Set(state.stored.compounds.map((compound) => compound.id))
  const storedObservationIds = new Set(
    state.stored.observations.map((observation) => observation.id),
  )
  return {
    compounds: compoundIds.size,
    observations: selectedObservations.length,
    existingCompounds: [...compoundIds].filter((id) => storedCompoundIds.has(id)).length,
    existingObservations: selectedObservations.filter((observation) =>
      storedObservationIds.has(observation.id),
    ).length,
  }
}

/** Parameter slot assignment without ever substituting one kind for another. */
function withParameter(
  kind: ParameterKind,
  value: ScientificValue,
): { readonly [K in ParameterKind]?: ScientificValue } {
  return kind === 'kd'
    ? { kd: value }
    : kind === 'ki'
      ? { ki: value }
      : kind === 'ec50'
        ? { ec50: value }
        : { ic50: value }
}

export function createDataSourcesStore(
  deps: DataSourcesDeps,
): UseBoundStore<StoreApi<DataSourcesState>> {
  const { sourceRepository, drugRepository, adapters } = deps
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]))
  const sources: readonly SourceSummary[] = adapters.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    searchScopes: adapter.capabilities.searchScopes,
    offersObservations: adapter.capabilities.observations,
    ...(adapter.licenseNotice !== undefined ? { licenseNotice: adapter.licenseNotice } : {}),
    ...(adapter.licenseUrl !== undefined ? { licenseUrl: adapter.licenseUrl } : {}),
  }))

  /** Monotonic sequences: only the latest request may write state. */
  let searchSeq = 0
  let searchController: AbortController | null = null
  let observationsSeq = 0
  let observationsController: AbortController | null = null

  const adapterOf = (id: string): SourceAdapter | null => adapterById.get(id) ?? null

  return create<DataSourcesState>()((set, get) => ({
    sourceId: adapters[0]?.id ?? '',
    sources,
    scope: 'compounds',
    query: '',
    endpointScope: 'parameters',
    search: emptySearch(),
    activeTarget: null,
    observations: emptyObservations(),
    selectedCompoundIds: [],
    selectedObservationIds: [],
    importOutcome: null,
    stored: {
      status: 'idle',
      error: null,
      compounds: [],
      observations: [],
      drugs: [],
      quarantinedCompounds: 0,
      quarantinedObservations: 0,
    },
    actionError: null,
    actionNotice: null,

    setSource(id) {
      if (id === get().sourceId) return
      // A different source invalidates every result and selection.
      searchSeq += 1
      searchController?.abort()
      searchController = null
      observationsSeq += 1
      observationsController?.abort()
      observationsController = null
      const adapter = adapterById.get(id)
      set({
        sourceId: id,
        scope: adapter?.capabilities.searchScopes.includes(get().scope) === true ? get().scope : 'compounds',
        search: emptySearch(),
        activeTarget: null,
        observations: emptyObservations(),
        selectedCompoundIds: [],
        selectedObservationIds: [],
        importOutcome: null,
        actionError: null,
        actionNotice: null,
      })
    },

    setScope(scope) {
      if (scope === get().scope) return
      if (adapterOf(get().sourceId)?.capabilities.searchScopes.includes(scope) !== true) return
      observationsSeq += 1
      observationsController?.abort()
      observationsController = null
      set({
        scope,
        activeTarget: null,
        search: emptySearch(),
        observations: emptyObservations(),
        selectedCompoundIds: [],
        selectedObservationIds: [],
        importOutcome: null,
      })
    },

    setQuery(query) {
      set({ query })
    },

    setEndpointScope(scope) {
      if (scope === get().endpointScope) return
      // Changing the retrieval filter invalidates already-fetched data so
      // the list header can never describe records fetched under another.
      observationsSeq += 1
      observationsController?.abort()
      observationsController = null
      set({
        endpointScope: scope,
        observations: emptyObservations(),
        selectedObservationIds: [],
        importOutcome: null,
      })
    },

    async runSearch() {
      const query = get().query.trim()
      searchSeq += 1
      const seq = searchSeq
      searchController?.abort()
      if (query.length === 0) {
        searchController = null
        set({
          search: emptySearch(),
          activeTarget: null,
          observations: emptyObservations(),
          selectedCompoundIds: [],
          selectedObservationIds: [],
        })
        return
      }
      const controller = new AbortController()
      searchController = controller
      // A new query supersedes the previous result set and its selections.
      set({
        search: {
          status: 'searching',
          error: null,
          errorCode: null,
          compounds: [],
          targets: [],
        },
        activeTarget: null,
        observations: emptyObservations(),
        selectedCompoundIds: [],
        selectedObservationIds: [],
        importOutcome: null,
      })

      const adapter = adapterOf(get().sourceId)
      if (adapter === null) {
        set({
          search: {
            status: 'error',
            error: 'No data source is configured.',
            errorCode: null,
            compounds: [],
            targets: [],
          },
        })
        return
      }

      const scope = get().scope
      try {
        if (scope === 'targets' && adapter.searchTargets !== undefined) {
          const targets = await adapter.searchTargets(query, { signal: controller.signal })
          if (seq !== searchSeq) return // superseded — stale result discarded
          set({
            search: {
              status: targets.length > 0 ? 'results' : 'empty',
              error: null,
              errorCode: null,
              compounds: [],
              targets,
            },
          })
        } else {
          const compounds = await adapter.searchCompounds(query, {
            signal: controller.signal,
          })
          if (seq !== searchSeq) return // superseded — stale result discarded
          set({
            search: {
              status: compounds.length > 0 ? 'results' : 'empty',
              error: null,
              errorCode: null,
              compounds,
              targets: [],
            },
          })
        }
      } catch (error) {
        if (seq !== searchSeq) return // superseded while failing — ignore
        if (error instanceof SourceRequestError && error.code === 'aborted') {
          return // explicit cancellation already settled the state
        }
        const { code, message } = describeRequestError(error)
        set({
          search: {
            status: 'error',
            error: message,
            errorCode: code,
            compounds: [],
            targets: [],
          },
        })
      } finally {
        if (seq === searchSeq) searchController = null
      }
    },

    cancelSearch() {
      searchSeq += 1 // invalidates any in-flight search
      searchController?.abort()
      searchController = null
      if (get().search.status === 'searching') {
        set({ search: emptySearch() })
      }
    },

    toggleCompound(id) {
      const current = get().selectedCompoundIds
      set({
        selectedCompoundIds: current.includes(id)
          ? current.filter((candidate) => candidate !== id)
          : [...current, id],
      })
    },

    toggleObservation(id) {
      const current = get().selectedObservationIds
      set({
        selectedObservationIds: current.includes(id)
          ? current.filter((candidate) => candidate !== id)
          : [...current, id],
      })
    },

    setActiveTarget(target) {
      if (target?.sourceTargetId === get().activeTarget?.sourceTargetId) return
      observationsSeq += 1
      observationsController?.abort()
      observationsController = null
      set({
        activeTarget: target,
        observations: emptyObservations(),
        selectedObservationIds: [],
        importOutcome: null,
      })
    },

    clearObservations() {
      observationsSeq += 1
      observationsController?.abort()
      observationsController = null
      set({ observations: emptyObservations(), selectedObservationIds: [] })
    },

    async fetchObservations() {
      const state = get()
      const adapter = adapterOf(state.sourceId)
      const supportsCompound = adapter?.fetchObservations !== undefined
      const supportsTarget = adapter?.fetchObservationsByTarget !== undefined
      const byTarget = state.scope === 'targets'

      if (
        adapter === null ||
        (byTarget ? !supportsTarget : !supportsCompound) ||
        (byTarget && state.activeTarget === null) ||
        (!byTarget && state.selectedCompoundIds.length === 0)
      ) {
        set({
          observations: {
            ...emptyObservations(),
            status: 'error',
            error: byTarget
              ? 'Select a target first, then fetch its measurements.'
              : 'Select at least one compound first, then fetch its measurements.',
          },
        })
        return
      }

      observationsSeq += 1
      const seq = observationsSeq
      observationsController?.abort()
      const controller = new AbortController()
      observationsController = controller
      set({
        observations: { ...emptyObservations(), status: 'loading' },
        selectedObservationIds: [],
        importOutcome: null,
      })

      try {
        const request = {
          signal: controller.signal,
          limit: PAGE_SIZE,
          offset: 0,
          endpointScope: state.endpointScope,
        }
        let page: ObservationPage
        let fetchedFor: string
        let pageSource: PageSource | null
        if (byTarget) {
          const target = state.activeTarget
          if (target === null || adapter.fetchObservationsByTarget === undefined) {
            throw new Error('target fetch unavailable') // unreachable: validated above
          }
          page = await adapter.fetchObservationsByTarget(target.sourceTargetId, request)
          if (seq !== observationsSeq) return // superseded — stale page discarded
          fetchedFor = `target ${target.name ?? target.sourceTargetId}`
          pageSource = { kind: 'target', sourceId: target.sourceTargetId }
          set({
            observations: {
              status: 'ready',
              error: null,
              errorCode: null,
              items: page.items,
              total: page.total,
              nextOffset: page.nextOffset,
              omitted: page.omitted,
              fetchedFor,
              pageSource,
            },
          })
        } else {
          if (adapter.fetchObservations === undefined) {
            throw new Error('compound fetch unavailable') // unreachable: validated above
          }
          const compounds = state.search.compounds.filter((compound) =>
            state.selectedCompoundIds.includes(compound.id),
          )
          const items: RemoteObservation[] = []
          let total = 0
          let omitted = 0
          let nextOffset: number | null = null
          for (const compound of compounds) {
            const result = await adapter.fetchObservations(compound.sourceId, request)
            if (seq !== observationsSeq) return // superseded — stale pages discarded
            items.push(...result.items)
            total += result.total ?? result.items.length
            omitted += result.omitted
            // Pagination stays available only for a single-source page so
            // the "load more" offset always refers to one source query.
            nextOffset = compounds.length === 1 ? result.nextOffset : null
          }
          if (seq !== observationsSeq) return
          fetchedFor =
            compounds.length === 1
              ? `compound ${compounds[0]?.name ?? compounds[0]?.sourceId ?? ''}`
              : `${compounds.length} compounds`
          pageSource =
            compounds.length === 1 && compounds[0] !== undefined
              ? { kind: 'compound', sourceId: compounds[0].sourceId }
              : null
          set({
            observations: {
              status: 'ready',
              error: null,
              errorCode: null,
              items,
              total,
              nextOffset,
              omitted,
              fetchedFor,
              pageSource,
            },
          })
        }
      } catch (error) {
        if (seq !== observationsSeq) return
        if (error instanceof SourceRequestError && error.code === 'aborted') return
        const { code, message } = describeRequestError(error)
        set({
          observations: {
            ...emptyObservations(),
            status: 'error',
            error: message,
            errorCode: code,
          },
        })
      } finally {
        if (seq === observationsSeq) observationsController = null
      }
    },

    async loadMoreObservations() {
      const state = get()
      const offset = state.observations.nextOffset
      const source = state.observations.pageSource
      if (offset === null || source === null || state.observations.status !== 'ready') return
      const adapter = adapterOf(state.sourceId)
      if (adapter === null) return
      // Resolve the page fetcher BEFORE touching state, so a capability
      // gap can never leave the list stuck in `loading`.
      const pageFetcher = (
        options: Parameters<NonNullable<SourceAdapter['fetchObservations']>>[1],
      ): Promise<ObservationPage> => {
        if (source.kind === 'target') {
          if (adapter.fetchObservationsByTarget === undefined) {
            throw new Error('target fetch unavailable')
          }
          return adapter.fetchObservationsByTarget(source.sourceId, options)
        }
        if (adapter.fetchObservations === undefined) {
          throw new Error('compound fetch unavailable')
        }
        return adapter.fetchObservations(source.sourceId, options)
      }

      observationsSeq += 1
      const seq = observationsSeq
      observationsController?.abort()
      const controller = new AbortController()
      observationsController = controller
      set({
        observations: { ...state.observations, status: 'loading' },
        importOutcome: null,
      })

      try {
        const page = await pageFetcher({
          signal: controller.signal,
          limit: PAGE_SIZE,
          offset,
          endpointScope: state.endpointScope,
        })
        if (seq !== observationsSeq) return
        const previous = state.observations
        const seen = new Set(previous.items.map((item) => item.id))
        const appended = page.items.filter((item) => !seen.has(item.id)) // no duplicate rows
        set({
          observations: {
            status: 'ready',
            error: null,
            errorCode: null,
            items: [...previous.items, ...appended],
            total: page.total ?? previous.total,
            nextOffset: page.nextOffset,
            omitted: previous.omitted + page.omitted,
            fetchedFor: previous.fetchedFor,
            pageSource: previous.pageSource,
          },
        })
      } catch (error) {
        if (seq !== observationsSeq) return
        if (error instanceof SourceRequestError && error.code === 'aborted') return
        const { code, message } = describeRequestError(error)
        set({
          observations: {
            ...state.observations,
            status: 'error',
            error: message,
            errorCode: code,
          },
        })
      } finally {
        if (seq === observationsSeq) observationsController = null
      }
    },

    async importSelected() {
      const state = get()
      const selectedObservations = state.observations.items.filter((observation) =>
        state.selectedObservationIds.includes(observation.id),
      )
      const selectedCompounds = state.search.compounds.filter((compound) =>
        state.selectedCompoundIds.includes(compound.id),
      )
      if (selectedCompounds.length === 0 && selectedObservations.length === 0) return // nothing selected

      const adapter = adapterOf(state.sourceId)

      // Observations whose compound is neither selected nor stored need a
      // full identity record before import (no synthesized records).
      const knownIds = new Set<string>([
        ...selectedCompounds.map((compound) => compound.id),
        ...state.stored.compounds.map((compound) => compound.id),
      ])
      const needed = [
        ...new Set(
          selectedObservations
            .map((observation) => observation.compoundId)
            .filter((id) => !knownIds.has(id)),
        ),
      ]
      let resolved: RemoteCompound[] = []
      if (needed.length > 0) {
        if (adapter?.fetchCompounds === undefined) {
          set({
            importOutcome: {
              status: 'failed',
              message: `This source cannot resolve compound records for ${needed.join(', ')} — nothing was imported.`,
            },
          })
          return
        }
        try {
          resolved = [...(await adapter.fetchCompounds(needed, {}))]
        } catch (error) {
          set({
            importOutcome: {
              status: 'failed',
              message: `Could not fetch the compound records (${describeRequestError(error).message}) — nothing was imported.`,
            },
          })
          return
        }
        const resolvedIds = new Set(resolved.map((compound) => compound.id))
        const missing = needed.filter((id) => !resolvedIds.has(id))
        if (missing.length > 0) {
          set({
            importOutcome: {
              status: 'failed',
              message: `The source did not return compound records for ${missing.join(', ')} — nothing was imported.`,
            },
          })
          return
        }
      }

      try {
        const report = await sourceRepository.importSourceRecords({
          compounds: [...selectedCompounds, ...resolved],
          observations: selectedObservations,
        })
        set({
          importOutcome: report.ok
            ? {
                status: 'ok',
                report: {
                  createdCompounds: report.createdCompounds,
                  createdObservations: report.createdObservations,
                  skippedCompounds: report.skippedCompounds,
                  skippedObservations: report.skippedObservations,
                },
              }
            : { status: 'rejected', errors: report.errors },
        })
      } catch (error) {
        set({
          importOutcome: {
            status: 'failed',
            message: `Import failed (${messageOf(error)}) — no records were written.`,
          },
        })
        return
      }
      await get().hydrateStored()
    },

    clearImportOutcome() {
      set({ importOutcome: null })
    },

    async hydrateStored() {
      if (get().stored.status === 'loading') return // in-flight guard
      set({ stored: { ...get().stored, status: 'loading', error: null } })
      try {
        const [compounds, observations, drugs] = await Promise.all([
          sourceRepository.listCompounds(),
          sourceRepository.listObservations(),
          drugRepository.getAllDrugs(),
        ])
        set({
          stored: {
            status: 'ready',
            error: null,
            compounds: compounds.records,
            observations: observations.records,
            drugs: drugs.drugs,
            quarantinedCompounds: compounds.quarantine.length,
            quarantinedObservations: observations.quarantine.length,
          },
        })
      } catch (error) {
        set({
          stored: {
            ...get().stored,
            status: 'error',
            error: `Could not read stored records: ${messageOf(error)}`,
          },
        })
      }
    },

    async applyObservation(request) {
      const state = get()
      const observation = state.stored.observations.find(
        (candidate) => candidate.id === request.observationId,
      )
      const fail = (message: string): false => {
        set({ actionError: message, actionNotice: null })
        return false
      }
      if (observation === undefined) {
        return fail('That observation is not in the stored records — reload and try again.')
      }
      const kind = observation.parameterKind
      if (kind === undefined) {
        return fail(
          `Endpoint "${observation.endpoint}" does not map onto Kd, Ki, IC50 or EC50 — values are never substituted into a different parameter.`,
        )
      }
      if (observation.qualifier !== undefined && observation.qualifier !== '=') {
        return fail(
          `The source reports this measurement with qualifier "${observation.qualifier}" — only a reported exact value can supply a parameter.`,
        )
      }
      const unit = observation.unit
      if (unit === undefined) {
        return fail('The source reported no unit for this measurement — a parameter needs one.')
      }
      if (unitCatalog.dimensionOf(unit) !== 'molar-concentration') {
        return fail(
          `Unit "${unit}" is not a molar concentration — ${kind.toUpperCase()} parameters are molar concentrations, so this value cannot supply one.`,
        )
      }

      const drug = state.stored.drugs.find((candidate) => candidate.id === request.drugId)
      if (drug === undefined) {
        return fail('Choose a drug record from the library first.')
      }

      const parameter: ScientificValue = {
        value: observation.value,
        unit,
        provenance: {
          type: 'literature',
          source: observation.provenance.sourceName,
          url: observation.provenance.url,
          accessedAt: observation.provenance.retrievedAt,
          observationId: observation.id,
          notes: `Applied from stored observation (endpoint ${observation.endpoint}${observation.qualifier !== undefined ? `, reported '${observation.qualifier}'` : ''}).`,
        },
      }

      let nextTargets: readonly TargetInput[]
      let targetName: string
      if (request.targetId !== null) {
        const target = drug.targets.find((candidate) => candidate.id === request.targetId)
        if (target === undefined) return fail('The selected target is not part of that drug record.')
        const occupied = target[kind]
        if (occupied !== undefined && !request.overwrite) {
          return fail(
            `The ${kind.toUpperCase()} slot of "${target.name}" already holds a value — confirm an explicit overwrite to replace it.`,
          )
        }
        targetName = target.name
        nextTargets = drug.targets.map((candidate) =>
          candidate.id === target.id
            ? { ...candidate, ...withParameter(kind, parameter) }
            : candidate,
        )
      } else {
        const name = observation.target.name
        if (name === undefined || name.length === 0) {
          return fail(
            'The observation reports no target name — add a target to the drug record and select it instead.',
          )
        }
        targetName = name
        const species = observation.species
        nextTargets = [
          ...drug.targets,
          {
            // No id: the repository assigns one, as for any created target.
            name,
            ...(species !== undefined ? { species } : {}),
            ...withParameter(kind, parameter),
          },
        ]
      }

      try {
        await drugRepository.updateDrug(drug.id, { targets: nextTargets })
      } catch (error) {
        return fail(`Could not update the drug record (${messageOf(error)}) — nothing was changed.`)
      }
      await get().hydrateStored()
      set({
        actionError: null,
        actionNotice: `Applied ${observation.endpoint} from ${observation.provenance.sourceName} observation ${observation.provenance.recordId} to "${drug.identifiers.name}" › "${targetName}" (${kind.toUpperCase()}).`,
      })
      return true
    },

    async addToLibrary(id) {
      const compound = get().stored.compounds.find((candidate) => candidate.id === id)
      if (compound === undefined) {
        set({ actionError: 'That compound is not in the stored records.', actionNotice: null })
        return null
      }
      const attribution = compound.provenance
      const input: DrugInput = {
        identifiers: {
          name: compound.name ?? compound.sourceId,
          synonyms: [...compound.synonyms],
          ...(compound.identifiers.casNumber !== undefined
            ? { casNumber: compound.identifiers.casNumber }
            : {}),
        },
        notes: `Compound identity imported from ${attribution.sourceName} (record ${attribution.recordId}) on ${attribution.retrievedAt}. Source: ${attribution.url}.${attribution.licenseNotice !== undefined ? ` ${attribution.licenseNotice}` : ''}`,
      }
      try {
        const drug = await drugRepository.createDrug(input)
        await get().hydrateStored()
        set({
          actionError: null,
          actionNotice: `Added "${input.identifiers.name}" to the drug library (identity only — no pharmacological parameters).`,
        })
        return drug
      } catch (error) {
        set({
          actionError: `Could not add the compound to the library (${messageOf(error)}).`,
          actionNotice: null,
        })
        return null
      }
    },

    clearActionMessages() {
      set({ actionError: null, actionNotice: null })
    },
  }))
}
