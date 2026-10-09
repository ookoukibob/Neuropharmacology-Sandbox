/**
 * Drug-library session store (ADR-17): a factory bound to a repository.
 *
 * Zustand holds *session state only* — the hydrated working set, selection,
 * UI flags and error text. IndexedDB remains the source of truth: every
 * mutation goes through the repository and re-reads the affected list, so a
 * reload re-derives the same state from storage. Nothing is cached here
 * without a matching record on disk, and no scientific value is ever
 * computed or defaulted in this layer.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { Drug, DrugId } from '../../domain/drug/drug'
import type { LibraryMetadata } from '../../domain/library/library'
import type { ImportIssue, ImportWarning } from '../../data/import/importPipeline'
import type {
  DrugChanges,
  DrugInput,
  DrugRepository,
  ImportMode,
  ImportReport,
  QuarantinedRecord,
} from '../../data/repositories/repository'

export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Result of an import attempt, normalized for UI feedback:
 * - `ok` — committed by the repository (report carries created/updated counts);
 * - `invalid` — rejected by validation; nothing was written, so the session
 *   state still mirrors storage and no refresh happens;
 * - `failed` — the storage layer threw (I/O, quota) *before* the commit
 *   point; the transaction aborted and the store surfaces the message like
 *   every other mutation failure;
 * - `committed-refresh-failed` — the transaction COMMITTED, but re-reading
 *   the session afterwards threw. The database contains the imported
 *   records while the session may be stale; this is never reported as a
 *   rolled-back import, and recovery is a hydrate retry or a reload — the
 *   import itself is never re-run automatically.
 */
export type LibraryImportOutcome =
  | { readonly status: 'ok'; readonly report: Extract<ImportReport, { readonly ok: true }> }
  | {
      readonly status: 'invalid'
      readonly errors: readonly ImportIssue[]
      readonly warnings: readonly ImportWarning[]
    }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'committed-refresh-failed'
      readonly report: Extract<ImportReport, { readonly ok: true }>
      /** The original post-commit refresh error (the commit succeeded). */
      readonly message: string
    }

export interface LibraryState {
  readonly status: LibraryStatus
  readonly drugs: readonly Drug[]
  readonly metadata: LibraryMetadata | undefined
  /** Invalid records reported at hydration — never dropped silently. */
  readonly quarantine: readonly QuarantinedRecord[]
  readonly selectedDrugId: DrugId | null
  readonly error: string | null
  /** Simple case-insensitive name filter (no search feature). */
  readonly filter: string

  hydrate(): Promise<void>
  selectDrug(id: DrugId | null): void
  setFilter(filter: string): void
  createDrug(input: DrugInput): Promise<Drug | null>
  updateDrug(id: DrugId, changes: DrugChanges): Promise<Drug | null>
  deleteDrug(id: DrugId): Promise<boolean>
  /**
   * Transactional NPSL import. `ok` and `committed-refresh-failed` both
   * mean the database commit succeeded (the latter with a stale session);
   * `invalid` and `failed` mean nothing was written.
   */
  importLibrary(text: string, mode: ImportMode): Promise<LibraryImportOutcome>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createLibraryStore(
  repo: DrugRepository,
): UseBoundStore<StoreApi<LibraryState>> {
  /** Re-read storage after a mutation so session state mirrors the DB. */
  async function refresh(set: (partial: Partial<LibraryState>) => void): Promise<void> {
    const loaded = await repo.getAllDrugs()
    const metadata = await repo.getLibraryMetadata()
    set({
      drugs: loaded.drugs,
      quarantine: loaded.quarantine,
      metadata,
      error: null,
    })
  }

  return create<LibraryState>()((set, get) => ({
    status: 'idle',
    drugs: [],
    metadata: undefined,
    quarantine: [],
    selectedDrugId: null,
    error: null,
    filter: '',

    async hydrate() {
      // In-flight guard: React StrictMode double-mounts must not race two
      // reads of the same database.
      if (get().status === 'loading') return
      set({ status: 'loading', error: null })
      try {
        await refresh(set)
        set({ status: 'ready' })
      } catch (error) {
        set({ status: 'error', error: messageOf(error) })
      }
    },

    selectDrug(id) {
      set({ selectedDrugId: id })
    },

    setFilter(filter) {
      set({ filter })
    },

    async createDrug(input) {
      try {
        const drug = await repo.createDrug(input)
        await refresh(set)
        return drug
      } catch (error) {
        set({ error: messageOf(error) })
        return null
      }
    },

    async updateDrug(id, changes) {
      try {
        const drug = await repo.updateDrug(id, changes)
        await refresh(set)
        return drug
      } catch (error) {
        set({ error: messageOf(error) })
        return null
      }
    },

    async deleteDrug(id) {
      try {
        await repo.deleteDrug(id)
        await refresh(set)
        if (get().selectedDrugId === id) set({ selectedDrugId: null })
        return true
      } catch (error) {
        set({ error: messageOf(error) })
        return false
      }
    },

    async importLibrary(text, mode) {
      // Phase 1 — the database transaction. Throwing here means the
      // transaction aborted: a genuine failure with nothing committed.
      let committed: Extract<ImportReport, { readonly ok: true }>
      try {
        const report = await repo.importLibrary(text, { mode })
        if (!report.ok) {
          // Rejected inside the repository's transaction: nothing was
          // written, so storage still matches the session — no refresh.
          return { status: 'invalid', errors: report.errors, warnings: report.warnings }
        }
        committed = report
      } catch (error) {
        const message = messageOf(error)
        set({ error: message })
        return { status: 'failed', message }
      }
      // Phase 2 — post-commit session refresh. A failure here must NEVER
      // be reported as a rolled-back import: the records are already in
      // the database. The session keeps its previous (now stale) contents
      // and gets an explicit error instead of a false "unchanged" claim;
      // the UI offers a hydrate retry or a reload, never an automatic
      // re-run of the import.
      try {
        await refresh(set)
        return { status: 'ok', report: committed }
      } catch (error) {
        const message = messageOf(error)
        set({
          error: `Import committed, but the session refresh failed: ${message} — the database contains the imported records. Retry the session refresh or reload the page.`,
        })
        return { status: 'committed-refresh-failed', report: committed, message }
      }
    },
  }))
}
