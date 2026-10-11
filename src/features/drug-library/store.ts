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
import type { RecoveryIssue } from '../../data/recovery/format'
import { RepositoryError } from '../../data/repositories/repository'
import type {
  DrugChanges,
  DrugInput,
  DrugRepository,
  ImportMode,
  ImportReport,
  QuarantinedRecord,
  RecoveryReport,
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

/**
 * Result of a `.npsb` recovery restore (ADR-18), normalized for UI
 * feedback with the same commit-aware semantics as `LibraryImportOutcome`:
 * - `ok` — committed AND the session refreshed (report carries counts);
 * - `rejected` — archive validation failed before any write transaction
 *   opened; the library was not modified;
 * - `failed` — the restore transaction threw and rolled back; the previous
 *   library is intact;
 * - `committed-refresh-failed` — the transaction COMMITTED, but re-reading
 *   the session afterwards threw. The database contains the restored
 *   records while the session may be stale; never reported as a rollback,
 *   and recovery is a hydrate retry or a reload — the restore itself is
 *   never re-run automatically.
 */
export type LibraryRestoreOutcome =
  | { readonly status: 'ok'; readonly report: RecoveryReport }
  | { readonly status: 'rejected'; readonly issues: readonly RecoveryIssue[] }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'committed-refresh-failed'
      readonly report: RecoveryReport
      /** The original post-commit refresh error (the commit succeeded). */
      readonly message: string
    }

/**
 * Result of one guarded record update (phase 20, audit GAP-4):
 * - `ok` — committed by the repository and the session re-read;
 * - `conflict` — the record changed elsewhere since this edit session's
 *   draft was based on it. The repository rejected the write inside its
 *   transaction: NOTHING was modified (record, scientific values and
 *   revision untouched) and the session is deliberately NOT refreshed —
 *   the caller keeps its unsaved draft and can reload/reopen to review
 *   the other change and re-apply. Never retried automatically;
 * - `error` — not found, validation or storage failure; nothing was
 *   committed (the transaction aborted) and the message is surfaced like
 *   every other mutation failure.
 */
export type UpdateDrugResult =
  | { readonly status: 'ok'; readonly drug: Drug }
  | { readonly status: 'conflict'; readonly message: string }
  | { readonly status: 'error'; readonly message: string }

/**
 * Outcome of a revision-guarded delete (phase 20 review fix):
 * - `ok` — the record was deleted (the session was refreshed);
 * - `conflict` — the record changed since the token the delete action was
 *   based on: NOTHING was deleted, the session is deliberately NOT
 *   refreshed (it still mirrors storage) and the error banner is
 *   untouched — the delete-confirmation UI owns the recovery flow and
 *   must send the user back through reload/review. Never retried
 *   automatically;
 * - `error` — not found (already deleted elsewhere) or storage failure;
 *   nothing was committed and the message is surfaced like every other
 *   mutation failure.
 */
export type DeleteDrugResult =
  | { readonly status: 'ok' }
  | { readonly status: 'conflict'; readonly message: string }
  | { readonly status: 'error'; readonly message: string }

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
  /**
   * Guarded partial update (phase 20): `expectedRevision` is the
   * `Drug.revision` token the edit form captured when it mounted — the
   * state its draft is based on. A conflict is a typed, per-session
   * outcome (the draft stays with its caller; the session error state is
   * untouched); every other failure sets `error` like all mutations.
   */
  updateDrug(
    id: DrugId,
    changes: DrugChanges,
    expectedRevision: number,
  ): Promise<UpdateDrugResult>
  /**
   * Revision-guarded delete (phase 20 review fix): `expectedRevision` is
   * the `Drug.revision` token the delete action is based on — the record
   * state the user reviewed before confirming. A conflict is a typed,
   * per-session outcome (nothing deleted, session untouched); every
   * other failure sets `error` like all mutations.
   */
  deleteDrug(id: DrugId, expectedRevision: number): Promise<DeleteDrugResult>
  /**
   * Transactional NPSL import. `ok` and `committed-refresh-failed` both
   * mean the database commit succeeded (the latter with a stale session);
   * `invalid` and `failed` mean nothing was written.
   */
  importLibrary(text: string, mode: ImportMode): Promise<LibraryImportOutcome>
  /**
   * Transactional `.npsb` recovery restore (full snapshot replacement).
   * `ok` and `committed-refresh-failed` both mean the commit succeeded
   * (the latter with a stale session); `rejected` and `failed` mean the
   * library was not modified.
   */
  restoreArchive(text: string): Promise<LibraryRestoreOutcome>
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

    async updateDrug(id, changes, expectedRevision) {
      try {
        const drug = await repo.updateDrug(id, changes, expectedRevision)
        await refresh(set)
        return { status: 'ok', drug }
      } catch (error) {
        // Phase 20: a conflict is a typed, per-edit-session outcome. The
        // repository rejected the write inside its transaction (nothing
        // changed anywhere), so the session still mirrors storage and
        // needs no refresh — and the shared error banner is deliberately
        // left alone: the edit form that owns the recovery flow surfaces
        // it, keeping the draft-visible lifetime of the message tied to
        // the draft itself.
        if (error instanceof RepositoryError && error.code === 'CONFLICT') {
          return { status: 'conflict', message: error.message }
        }
        const message = messageOf(error)
        set({ error: message })
        return { status: 'error', message }
      }
    },

    async deleteDrug(id, expectedRevision) {
      try {
        await repo.deleteDrug(id, expectedRevision)
        await refresh(set)
        if (get().selectedDrugId === id) set({ selectedDrugId: null })
        return { status: 'ok' }
      } catch (error) {
        // Phase 20 review fix: same conflict taxonomy as updateDrug — a
        // stale delete is a typed, per-session outcome. The repository
        // rejected it inside its transaction (nothing was deleted), so
        // the session still mirrors storage: no refresh, and the shared
        // error banner stays untouched — the delete-confirmation UI owns
        // the reload/review recovery flow.
        if (error instanceof RepositoryError && error.code === 'CONFLICT') {
          return { status: 'conflict', message: error.message }
        }
        const message = messageOf(error)
        set({ error: message })
        return { status: 'error', message }
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

    async restoreArchive(text) {
      // Phase 1 — validation (read-only, in the repository) then the
      // database transaction. `rejected` returns before any write path;
      // a throw here means the transaction aborted: nothing committed.
      let committed: RecoveryReport
      try {
        const outcome = await repo.restoreRecoveryArchive(text)
        if (!outcome.ok) {
          return { status: 'rejected', issues: outcome.issues }
        }
        committed = outcome.report
      } catch (error) {
        const message = messageOf(error)
        set({ error: message })
        return { status: 'failed', message }
      }
      // Phase 2 — post-commit session refresh. Same contract as the NPSL
      // import: a failure here is NEVER reported as a rolled-back restore
      // (the records are already in the database), the session keeps its
      // stale contents with an explicit committed-state error, and the UI
      // offers a refresh retry or a reload — never an automatic re-run of
      // the restore transaction itself.
      try {
        await refresh(set)
        return { status: 'ok', report: committed }
      } catch (error) {
        const message = messageOf(error)
        set({
          error: `Restore committed, but the session refresh failed: ${message} — the database contains the restored records. Retry the session refresh or reload the page.`,
        })
        return { status: 'committed-refresh-failed', report: committed, message }
      }
    },
  }))
}
