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
 *   other than an exact reported value, missing/non-concentration units,
 *   occupied slots without an explicit `overwrite`, and target rows whose
 *   name/species contradict the observation or whose stored source
 *   reference carries a different same-source target id (phase 18I)
 *   without an explicit `confirmTargetMismatch` acknowledgement.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type {
  Drug,
  DrugId,
  ReceptorTarget,
  TargetId,
  TargetSourceReference,
} from '../../domain/drug/drug'
import { findSourceReference, mergeSourceReferences } from '../../domain/drug/drug'
import type { ScientificValue } from '../../domain/pharmacology/scientific-value'
import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import { compoundId, type Compound, type RemoteCompound } from '../../domain/sources/compound'
import type {
  ExperimentalObservation,
  ParameterKind,
  RemoteObservation,
} from '../../domain/sources/observation'
import type { DrugSourceRecord } from '../../domain/drug/source-data'
import { findSourceRecord, mergeSourceRecord } from '../../domain/drug/source-data'
import type { DrugRepository, DrugInput, TargetInput } from '../../data/repositories/repository'
import type {
  SourceDataRepository,
  SourceDeleteFailureCode,
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

/**
 * Outcome of adding a stored compound to the drug library (phase 36).
 *
 * The import is a *complete* one — the record's identifiers, chemical
 * properties, source attribution, license terms and every measurement
 * stored for exactly that external compound are attached as a typed
 * snapshot (`Drug.sourceRecords`) — so the result distinguishes the three
 * cases a user must be able to tell apart:
 *
 * - `created` — a new drug record was created and the snapshot attached;
 * - `linked` — an EXISTING drug record was explicitly chosen and the
 *   snapshot attached to it. Nothing else about that record changed: its
 *   targets, model parameters, target metadata and notes are preserved
 *   verbatim, and a name match alone never selects it;
 * - `already-linked` — this exact external record (same source + source
 *   id) is already attached to the chosen record; nothing was written. Any
 *   measurements stored since the last import were added, and
 *   `addedObservations` reports how many.
 *
 * Failures are reported as a typed `conflict` (same source, different
 * record id — never merged or overwritten) or `failed` (validation or
 * storage; nothing was written). No path reports success for a partial
 * operation.
 */
export type AddToLibraryOutcome =
  | {
      readonly status: 'created' | 'linked' | 'already-linked'
      readonly drug: Drug
      /** The snapshot attached (or already attached) to the record. */
      readonly sourceRecord: DrugSourceRecord
      /** Measurements newly attached by this call (0 for a repeat import). */
      readonly addedObservations: number
      /** Every measurement the record now carries for this source record. */
      readonly observationCount: number
    }
  | {
      readonly status: 'conflict'
      /** The stored snapshot that already occupies this source. */
      readonly existing: DrugSourceRecord
      readonly drug: Drug
      readonly message: string
    }
  | { readonly status: 'failed'; readonly message: string }

/**
 * Outcome of deleting one stored compound identity record (phase 39).
 *
 * Mirrors `SourceDeleteReport` at the session boundary but adds the
 * human-readable summary the panel shows, so a success states exactly what
 * was removed instead of a generic "deleted".
 *
 * A failed deletion wrote nothing — the stored panel keeps its current
 * contents and the message names the reason (missing row, quarantined row,
 * unreadable measurement, or a rolled-back storage failure).
 */
export type DeleteCompoundOutcome =
  | {
      readonly status: 'deleted'
      readonly compoundId: string
      readonly deletedObservations: number
      readonly message: string
    }
  | {
      readonly status: 'failed'
      readonly code: SourceDeleteFailureCode
      readonly message: string
    }

export interface ApplyObservationRequest {
  readonly observationId: string
  readonly drugId: DrugId
  /** Existing target row, or null to create one named from the observation. */
  readonly targetId: TargetId | null
  /** Explicit acknowledgement required when the slot is already occupied. */
  readonly overwrite: boolean
  /**
   * Explicit acknowledgement required when the observation's reported
   * target does not verifiably match the chosen existing target row
   * (see `findTargetMismatch`). Without it the application is refused —
   * a differing association is never silently presented as verified.
   */
  readonly confirmTargetMismatch?: boolean
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

/**
 * The four measurement endpoints the retrieval filter offers as
 * independent choices (phase 40): the endpoints that map onto a model
 * parameter slot. They are not a catalogue of every ChEMBL activity
 * endpoint — `'All reported endpoints'` remains the way to retrieve
 * everything the source reports.
 */
export const ENDPOINT_FILTER_OPTIONS = ['Ki', 'Kd', 'IC50', 'EC50'] as const
export type EndpointFilterOption = (typeof ENDPOINT_FILTER_OPTIONS)[number]

/**
 * Endpoint retrieval filter chosen in the measurements panel: an explicit
 * user-selected subset, or every endpoint the source reports. An empty
 * `selected` list is a valid, explicit state — retrieval stays disabled
 * until at least one endpoint (or `all`) is chosen, and an empty
 * selection is never sent as "all".
 */
export type EndpointSelection =
  | { readonly mode: 'selected'; readonly endpoints: readonly EndpointFilterOption[] }
  | { readonly mode: 'all' }

/** The default filter — all four parameter endpoints (previous behaviour). */
export const DEFAULT_ENDPOINT_SELECTION: EndpointSelection = {
  mode: 'selected',
  endpoints: ENDPOINT_FILTER_OPTIONS,
}

/** Canonical order, deduplicated — deterministic filter strings and state. */
function normalizeEndpointSelection(selection: EndpointSelection): EndpointSelection {
  if (selection.mode === 'all') return selection
  const chosen = new Set(selection.endpoints)
  return { mode: 'selected', endpoints: ENDPOINT_FILTER_OPTIONS.filter((e) => chosen.has(e)) }
}

/** Same filter (after normalization) — a no-op change must not clear data. */
function sameEndpointSelection(a: EndpointSelection, b: EndpointSelection): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode !== 'selected' || b.mode !== 'selected') return true
  return (
    a.endpoints.length === b.endpoints.length &&
    a.endpoints.every((endpoint, index) => endpoint === b.endpoints[index])
  )
}

/**
 * The adapter filter for a selection: the explicit endpoint list, or the
 * intentional `'all'` (no endpoint filter). An empty list is passed
 * through as an empty list — adapters must never interpret it as "all".
 */
function endpointTypesFor(selection: EndpointSelection): readonly string[] | 'all' {
  return selection.mode === 'all' ? 'all' : [...selection.endpoints]
}

export interface DataSourcesState {
  readonly sourceId: string
  /** Static picker options — the UI never hardcodes source names. */
  readonly sources: readonly SourceSummary[]
  readonly scope: SearchScope
  readonly query: string
  /** Endpoint filter for observation retrieval (chosen in the UI). */
  readonly endpointSelection: EndpointSelection
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
  setEndpointSelection(selection: EndpointSelection): void
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
  /**
   * Add a stored compound to the drug library, preserving its complete
   * source data (phase 36).
   *
   * `options.drugId` is the explicit link target: when supplied, the
   * snapshot is attached to THAT record instead of creating a new one —
   * the only way an existing manually-created drug acquires source data,
   * and it never replaces anything the record already holds. Without it a
   * new record is created. Neither path guesses a target by name.
   */
  addToLibrary(
    compoundId: string,
    options?: { readonly drugId?: DrugId },
  ): Promise<AddToLibraryOutcome>
  /**
   * Delete ONE stored compound identity record and exactly its associated
   * measurements (phase 39), then re-read the stored panel from IndexedDB.
   *
   * This removes only the local Data Sources acquisition copy. It never
   * touches the drug library: a `Drug.sourceRecords` snapshot imported
   * earlier is an independent, durable copy, so the Library record keeps
   * its source data, parameters, targets and notes. Cascading deletion into
   * the library is deliberately not implemented.
   */
  deleteCompound(compoundId: string): Promise<DeleteCompoundOutcome>
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
      case 'http': {
        // Keep transport failures distinguishable where the status says
        // something specific: throttling and temporary unavailability are
        // not the same as "the source rejected the request".
        if (error.status === 429) {
          return {
            code: 'http',
            message:
              'The source is limiting request rate (HTTP 429). Wait a moment, then retry.',
          }
        }
        if (error.status === 503 || error.status === 504) {
          return {
            code: 'http',
            message: `The source is temporarily unavailable (HTTP ${error.status}). Try again later.`,
          }
        }
        return {
          code: 'http',
          message: `The source answered with an error (${error.message}). Try again later.`,
        }
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

/** Structured detail of a same-source external-identity conflict. */
export interface TargetSourceIdConflict {
  /** Adapter id whose reported target id conflicts. */
  readonly source: string
  /** Display name of that source. */
  readonly sourceName: string
  /** Target id the observation reports from that source. */
  readonly observationTargetId: string
  /** Target id the selected row ALREADY stores from that same source. */
  readonly storedTargetId: string
  /** The stored reference's target-record URL, when one was recorded. */
  readonly storedUrl?: string
}

export interface TargetMismatch {
  /** What the observation reports as its target (name, or an honest placeholder). */
  readonly observationTarget: string
  /** Species/organism the observation reports, or null when unreported. */
  readonly observationSpecies: string | null
  /** Display name of the chosen existing target row. */
  readonly selectedTarget: string
  /** Species recorded on the chosen row, or null when unrecorded. */
  readonly selectedSpecies: string | null
  /** Which reported fields do not line up with the chosen row. */
  readonly differences: readonly ('name' | 'species' | 'source-id')[]
  /** Present exactly when `differences` contains `'source-id'`. */
  readonly sourceIdConflict?: TargetSourceIdConflict
}

function compared(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function sameText(a: string, b: string): boolean {
  // Comparison only decides whether a warning is required; the labels are
  // always shown verbatim so the user judges the identity themselves.
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Compare an observation's reported target against a chosen EXISTING
 * target row (Layer C selection safety).
 *
 * A differing reported name or species means the two records do not
 * verifiably describe the same target — name-only matching never
 * establishes biological identity, so the caller must show both sides and
 * require an explicit acknowledgement before linking. A field the
 * observation does not report is missing information, not a difference:
 * only reported contradictions count. Returns null when nothing reported
 * contradicts the row.
 *
 * Phase 18I adds source-identity awareness: when the observation carries
 * an external target id (e.g. a ChEMBL target) and the selected row
 * ALREADY stores a reference from that same source with a DIFFERENT
 * target id, that is reported as a `'source-id'` conflict even when the
 * displayed names and species match — the two records identify different
 * authoritative targets in the same source system. Conversely, a missing
 * reference (on either side) is missing information, never a fabricated
 * conflict, and a reference from a *different* source never creates a
 * false same-source conflict. An exact source + id match is an identity
 * match on that dimension (the name/species policy above is unchanged).
 */
export function findTargetMismatch(
  observation: ExperimentalObservation,
  target: ReceptorTarget,
): TargetMismatch | null {
  const reportedName = compared(observation.target.name)
  const reportedSpecies = compared(observation.species ?? observation.target.organism)
  const rowSpecies = compared(target.species)
  const differences: ('name' | 'species' | 'source-id')[] = []
  if (reportedName !== null && !sameText(reportedName, target.name)) differences.push('name')
  if (reportedSpecies !== null && rowSpecies !== null && !sameText(reportedSpecies, rowSpecies)) {
    differences.push('species')
  }
  const sourceIdConflict = findSourceIdConflict(observation, target)
  if (sourceIdConflict !== null) differences.push('source-id')
  if (differences.length === 0) return null
  return {
    observationTarget: reportedName ?? '(no target name reported)',
    observationSpecies: reportedSpecies,
    selectedTarget: target.name,
    selectedSpecies: rowSpecies,
    differences,
    ...(sourceIdConflict !== null ? { sourceIdConflict } : {}),
  }
}

/** Same-source external-identity conflict, or null when there is none. */
function findSourceIdConflict(
  observation: ExperimentalObservation,
  target: ReceptorTarget,
): TargetSourceIdConflict | null {
  const observationTargetId = compared(observation.target.sourceTargetId)
  if (observationTargetId === null) return null // no external id reported
  const stored = findSourceReference(target.sourceReferences, observation.provenance.source)
  if (stored === undefined) return null // no reference to contradict
  if (stored.sourceTargetId === observationTargetId) return null // exact identity match
  return {
    source: observation.provenance.source,
    sourceName: observation.provenance.sourceName,
    observationTargetId,
    storedTargetId: stored.sourceTargetId,
    ...(stored.url !== undefined ? { storedUrl: stored.url } : {}),
  }
}

/** Failure message that names both sides of a target mismatch. */
function mismatchMessage(mismatch: TargetMismatch): string {
  const parts: string[] = []
  if (mismatch.differences.includes('name')) {
    parts.push(
      `the observation reports target "${mismatch.observationTarget}" while the selected row is "${mismatch.selectedTarget}"`,
    )
  }
  if (mismatch.differences.includes('species')) {
    parts.push(
      `the observation reports species "${mismatch.observationSpecies ?? '(unreported)'}" while the row records "${mismatch.selectedSpecies ?? '(unrecorded)'}"`,
    )
  }
  if (mismatch.differences.includes('source-id') && mismatch.sourceIdConflict !== undefined) {
    const conflict = mismatch.sourceIdConflict
    parts.push(
      `the observation identifies the target as ${conflict.sourceName} id "${conflict.observationTargetId}" while the row already stores ${conflict.sourceName} target id "${conflict.storedTargetId}"`,
    )
  }
  return `Target mismatch: ${parts.join('; ')} — differing reports do not establish that these are the same target. Confirm the mismatch explicitly to link this measurement to the existing row (the stored source identity is never overwritten by the acknowledgement), or create a new target from the observation instead.`
}

/**
 * The target-source reference an observation can honestly supply — null
 * when it reports no external target id (nothing is invented). License
 * terms travel with the identity: a source that requires attribution
 * (e.g. ChEMBL, CC BY-SA) keeps its notice on the reference so the
 * obligation survives alongside the id.
 */
function referenceFromObservation(
  observation: ExperimentalObservation,
): TargetSourceReference | null {
  const sourceTargetId = compared(observation.target.sourceTargetId)
  if (sourceTargetId === null) return null
  const provenance = observation.provenance
  return {
    source: provenance.source,
    sourceName: provenance.sourceName,
    sourceTargetId,
    ...(observation.target.name !== undefined ? { name: observation.target.name } : {}),
    ...(observation.target.organism !== undefined
      ? { organism: observation.target.organism }
      : {}),
    ...(observation.target.sourceTargetUrl !== undefined
      ? { url: observation.target.sourceTargetUrl }
      : {}),
    ...(provenance.licenseNotice !== undefined ? { licenseNotice: provenance.licenseNotice } : {}),
    ...(provenance.licenseUrl !== undefined ? { licenseUrl: provenance.licenseUrl } : {}),
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

/**
 * Typed failure for the add-to-library flow: the session message is set (so
 * the panel shows it) and the caller receives the `failed` outcome instead
 * of a success-shaped value.
 */
function failAdd(
  set: (partial: Partial<DataSourcesState>) => void,
  message: string,
): AddToLibraryOutcome {
  set({ actionError: message, actionNotice: null })
  return { status: 'failed', message }
}

/** Observation count phrasing shared by the add-to-library notices. */
function describeObservations(count: number): string {
  if (count === 0) return ' (no stored measurements were reported for it)'
  return ` and ${count} stored measurement${count === 1 ? '' : 's'}`
}

/**
 * Attach an imported snapshot to an EXISTING drug record (phase 36).
 *
 * Explicit and non-destructive by construction:
 * - the caller names the record; nothing is matched by name, and a name
 *   match never selects a record on its own;
 * - only `sourceRecords` is submitted — the record's targets, model
 *   parameters, target metadata, identifiers, tags and notes are never part
 *   of the change, so they cannot be overwritten by the attach;
 * - `mergeSourceRecord` decides what happens: a different source is
 *   appended, the same external record only appends measurements it does
 *   not already hold, and a same-source DIFFERENT record id is reported as
 *   a conflict with the stored snapshot untouched (nothing merged);
 * - the write carries the record's current revision token, so an attach
 *   computed from a superseded session is rejected (CONFLICT) instead of
 *   silently reviving stale data.
 */
async function attachToDrug(
  drugRepository: DrugRepository,
  drug: Drug,
  snapshot: DrugSourceRecord,
): Promise<AddToLibraryOutcome> {
  const merged = mergeSourceRecord(drug.sourceRecords, snapshot)
  if (merged.conflict !== undefined) {
    return {
      status: 'conflict',
      existing: merged.conflict,
      drug,
      message: `"${drug.identifiers.name}" is already linked to a different ${snapshot.provenance.sourceName} record (id "${merged.conflict.sourceId}", not "${snapshot.sourceId}"). The stored source data was left exactly as it is — nothing was merged or overwritten. Link this compound to another drug record, or resolve the existing link first.`,
    }
  }
  const sameRecord = findSourceRecord(drug.sourceRecords, snapshot.source)
  if (sameRecord !== undefined && merged.addedObservations === 0) {
    return {
      status: 'already-linked',
      drug,
      sourceRecord: sameRecord,
      addedObservations: 0,
      observationCount: sameRecord.observations.length,
    }
  }
  let updated: Drug
  try {
    updated = await drugRepository.updateDrug(
      drug.id,
      { sourceRecords: merged.records },
      drug.revision ?? 0,
    )
  } catch (error) {
    return {
      status: 'failed',
      message: `Could not attach the source record to "${drug.identifiers.name}" (${messageOf(error)}) — nothing was changed.`,
    }
  }
  const attached = findSourceRecord(merged.records, snapshot.source)
  return {
    status: sameRecord !== undefined ? 'already-linked' : 'linked',
    drug: updated,
    sourceRecord: attached ?? snapshot,
    addedObservations: merged.addedObservations,
    observationCount: (attached ?? snapshot).observations.length,
  }
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
    endpointSelection: DEFAULT_ENDPOINT_SELECTION,
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

    setEndpointSelection(selection) {
      const next = normalizeEndpointSelection(selection)
      if (sameEndpointSelection(get().endpointSelection, next)) return
      // Changing the retrieval filter invalidates already-fetched data so
      // the list header can never describe records fetched under another.
      observationsSeq += 1
      observationsController?.abort()
      observationsController = null
      set({
        endpointSelection: next,
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

      if (
        state.endpointSelection.mode === 'selected' &&
        state.endpointSelection.endpoints.length === 0
      ) {
        // An explicit empty selection is never an implicit "all" — the
        // request is refused until at least one endpoint is chosen.
        set({
          observations: {
            ...emptyObservations(),
            status: 'error',
            error: 'Select at least one measurement endpoint, or choose all reported endpoints.',
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
          endpointTypes: endpointTypesFor(state.endpointSelection),
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
      const endpointTypes = endpointTypesFor(state.endpointSelection)
      // Unreachable through the UI (changing the selection clears the
      // list, so `nextOffset` is null), but an empty selection must never
      // page an unfiltered request just because the list looked ready.
      if (endpointTypes !== 'all' && endpointTypes.length === 0) return
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
          endpointTypes,
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

      // Resolve the target selection first: every refusal (missing row,
      // occupied slot, unacknowledged target mismatch, unnamed new target)
      // happens before a parameter value is even constructed.
      let existingTarget: ReceptorTarget | undefined
      let mismatch: TargetMismatch | null = null
      let targetName: string
      if (request.targetId !== null) {
        existingTarget = drug.targets.find((candidate) => candidate.id === request.targetId)
        if (existingTarget === undefined) {
          return fail('The selected target is not part of that drug record.')
        }
        const occupied = existingTarget[kind]
        if (occupied !== undefined && !request.overwrite) {
          return fail(
            `The ${kind.toUpperCase()} slot of "${existingTarget.name}" already holds a value — confirm an explicit overwrite to replace it.`,
          )
        }
        targetName = existingTarget.name
        mismatch = findTargetMismatch(observation, existingTarget)
        if (mismatch !== null && request.confirmTargetMismatch !== true) {
          // Never present a differing association as verified: the user
          // must explicitly acknowledge the mismatch (or create a new row).
          return fail(mismatchMessage(mismatch))
        }
      } else {
        const name = observation.target.name
        if (name === undefined || name.length === 0) {
          return fail(
            'The observation reports no target name — add a target to the drug record and select it instead.',
          )
        }
        targetName = name
      }

      const attribution = observation.provenance
      const baseNotes = `Applied from stored observation (endpoint ${observation.endpoint}${observation.qualifier !== undefined ? `, reported '${observation.qualifier}'` : ''}).`
      const conflictNote =
        mismatch?.sourceIdConflict !== undefined
          ? ` Source identity conflict acknowledged: ${mismatch.sourceIdConflict.sourceName} reports target id "${mismatch.sourceIdConflict.observationTargetId}" while the row keeps its stored ${mismatch.sourceIdConflict.sourceName} target id "${mismatch.sourceIdConflict.storedTargetId}" — the stored reference was not overwritten.`
          : ''
      const parameter: ScientificValue = {
        value: observation.value,
        unit,
        provenance: {
          type: 'literature',
          source: attribution.sourceName,
          // Portable attribution: the external record id, record URL,
          // retrieval time and license notice travel with the value so the
          // citation survives a library export without the source-data
          // stores (observationId keeps the local Layer B link).
          sourceRecordId: attribution.recordId,
          url: attribution.url,
          accessedAt: attribution.retrievedAt,
          ...(attribution.licenseNotice !== undefined
            ? { licenseNotice: attribution.licenseNotice }
            : {}),
          ...(attribution.licenseUrl !== undefined ? { licenseUrl: attribution.licenseUrl } : {}),
          observationId: observation.id,
          notes:
            mismatch !== null
              ? `${baseNotes} Target mismatch acknowledged: the observation reports target "${mismatch.observationTarget}"${mismatch.observationSpecies !== null ? ` (species "${mismatch.observationSpecies}")` : ''}, linked to the existing row "${targetName}".${conflictNote}`
              : baseNotes,
        },
      }

      // The target-source reference the observation can honestly supply
      // (null when it reports no external target id).
      const observationReference = referenceFromObservation(observation)
      let nextTargets: readonly TargetInput[]
      if (existingTarget !== undefined) {
        const selected = existingTarget
        nextTargets = drug.targets.map((candidate) => {
          if (candidate.id !== selected.id) return candidate
          const withValue = { ...candidate, ...withParameter(kind, parameter) }
          if (observationReference === null) return withValue
          const merged = mergeSourceReferences(candidate.sourceReferences, observationReference)
          // A conflicting same-source identity (already acknowledged as a
          // mismatch above) is NEVER merged, overwritten or relabelled —
          // the stored reference stays exactly as it was.
          if (merged.conflict !== undefined) return withValue
          // Idempotent attach: an identical reference is a no-op, so
          // repeated applications never create duplicates.
          return { ...withValue, sourceReferences: merged.references }
        })
      } else {
        const species = observation.species
        nextTargets = [
          ...drug.targets,
          {
            // No id: the repository assigns one, as for any created target.
            name: targetName,
            ...(species !== undefined ? { species } : {}),
            // Phase 18I: a target created from a sourced observation keeps
            // the source's own target identity (id, URL, license terms).
            ...(observationReference !== null ? { sourceReferences: [observationReference] } : {}),
            ...withParameter(kind, parameter),
          },
        ]
      }

      try {
        // Phase 20: this apply path carries the same optimistic token as
        // the edit form — the revision of the session-hydrated drug the
        // user acted on — so an apply computed from a stale session is
        // rejected (nothing written) instead of overwriting a newer
        // record. `?? 0` is the documented "never revised" token: rows
        // hydrated through `getAllDrugs` always carry a revision, and 0
        // only matches a record no write has touched since hydration.
        await drugRepository.updateDrug(drug.id, { targets: nextTargets }, drug.revision ?? 0)
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

    async addToLibrary(id, options) {
      const state = get()
      const compound = state.stored.compounds.find((candidate) => candidate.id === id)
      if (compound === undefined) {
        return failAdd(set, 'That compound is not in the stored records.')
      }

      // Measurements are linked by VALIDATED source identity — the stored
      // observation's `compoundId` must equal `${source}:${sourceId}` — and
      // never by a matching display name. The repository enforces the same
      // rule on write, so an observation that belongs to a different
      // source compound id can never be attached here.
      const compoundKey = compoundId(compound.source, compound.sourceId)
      const observations = state.stored.observations.filter(
        (observation) => observation.compoundId === compoundKey,
      )
      const snapshot: DrugSourceRecord = {
        source: compound.source,
        sourceId: compound.sourceId,
        ...(compound.name !== undefined ? { name: compound.name } : {}),
        synonyms: [...compound.synonyms],
        identifiers: { ...compound.identifiers },
        provenance: { ...compound.provenance },
        observations: observations.map((observation) => ({ ...observation })),
        importedAt: new Date().toISOString(),
      }

      const target = options?.drugId
      if (target !== undefined) {
        const existing = state.stored.drugs.find((candidate) => candidate.id === target)
        if (existing === undefined) {
          return failAdd(set, 'That drug record is no longer in the library — reload and try again.')
        }
        const attached = await attachToDrug(drugRepository, existing, snapshot)
        if (attached.status === 'conflict') {
          set({ actionError: attached.message, actionNotice: null })
          return attached
        }
        if (attached.status === 'failed') return failAdd(set, attached.message)
        await get().hydrateStored()
        set({
          actionError: null,
          actionNotice:
            attached.status === 'linked'
              ? `Linked the ${compound.provenance.sourceName} source record ${compound.sourceId} to "${existing.identifiers.name}"${describeObservations(attached.addedObservations)} — its targets, parameters and notes were preserved.`
              : `"${existing.identifiers.name}" already carried this ${compound.provenance.sourceName} source record — ${attached.addedObservations === 0 ? 'nothing was written' : `${attached.addedObservations} new measurement${attached.addedObservations === 1 ? '' : 's'} added`}.`,
        })
        return attached
      }

      const input: DrugInput = {
        identifiers: {
          name: compound.name ?? compound.sourceId,
          synonyms: [...compound.synonyms],
          ...(compound.identifiers.casNumber !== undefined
            ? { casNumber: compound.identifiers.casNumber }
            : {}),
        },
        sourceRecords: [snapshot],
      }
      let created: Drug
      try {
        created = await drugRepository.createDrug(input)
      } catch (error) {
        return failAdd(
          set,
          `Could not add the compound to the library (${messageOf(error)}) — nothing was written.`,
        )
      }
      await get().hydrateStored()
      set({
        actionError: null,
        actionNotice: `Added "${input.identifiers.name}" to the drug library with its complete ${compound.provenance.sourceName} source record${describeObservations(snapshot.observations.length)} — no model parameter was set (use "Use as parameter…" for that).`,
      })
      return {
        status: 'created',
        drug: created,
        sourceRecord: snapshot,
        addedObservations: snapshot.observations.length,
        observationCount: snapshot.observations.length,
      }
    },

    async deleteCompound(compoundId) {
      // Resolve what the user is about to lose BEFORE deleting, so the
      // success message reports real counts rather than a guess. The
      // repository re-resolves and re-validates everything inside its own
      // transaction — this is display information, never the safety
      // boundary.
      const state = get()
      const compound = state.stored.compounds.find((candidate) => candidate.id === compoundId)
      const label = compound === undefined ? compoundId : (compound.name ?? compound.sourceId)

      let report: Awaited<ReturnType<SourceDataRepository['deleteCompound']>>
      try {
        report = await sourceRepository.deleteCompound(compoundId)
      } catch (error) {
        // The repository reports storage failures as a typed result; a throw
        // here means something outside that contract failed. Either way
        // nothing is assumed to have been written.
        const message = `Could not delete "${label}" (${messageOf(error)}) — nothing was deleted.`
        set({ actionError: message, actionNotice: null })
        return { status: 'failed', code: 'STORAGE', message }
      }

      if (!report.ok) {
        set({ actionError: report.failure.message, actionNotice: null })
        // A failed deletion wrote nothing, so the panel keeps its contents;
        // the refresh below is a cheap re-read that also keeps the panel
        // honest if another tab changed the store meanwhile.
        await get().hydrateStored()
        return { status: 'failed', code: report.failure.code, message: report.failure.message }
      }

      // Success: re-read the stored panel so the list, the counts and the
      // empty states all reflect IndexedDB rather than a local guess.
      await get().hydrateStored()
      // The applying/selected row may have belonged to the deleted compound.
      const remainingObservationIds = new Set(
        get().stored.observations.map((observation) => observation.id),
      )
      set((current) => ({
        actionError: null,
        actionNotice: `Deleted "${label}" (${report.deletedCompoundId}) and ${report.deletedObservations} associated measurement record${
          report.deletedObservations === 1 ? '' : 's'
        }. The drug library was not changed — any imported source data stays on its drug record.`,
        selectedObservationIds: current.selectedObservationIds.filter((id) =>
          remainingObservationIds.has(id),
        ),
      }))
      return {
        status: 'deleted',
        compoundId: report.deletedCompoundId,
        deletedObservations: report.deletedObservations,
        message: `Deleted "${label}" and ${report.deletedObservations} measurement record${
          report.deletedObservations === 1 ? '' : 's'
        }.`,
      }
    },

    clearActionMessages() {
      set({ actionError: null, actionNotice: null })
    },
  }))
}
