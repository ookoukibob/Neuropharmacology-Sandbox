/**
 * Repository abstraction — the single doorway between the application and
 * its storage (ADR-14, ADR-15).
 *
 * The interface speaks *domain objects* only: `Drug`, `DrugLibrary`,
 * `LibraryMetadata`. Persistence records (and Dexie, IndexedDB, migrations)
 * never appear in feature/UI code — React, Zustand and the engine depend on
 * this interface, the Dexie implementation depends on it too. That is what
 * keeps the store testable with an in-memory double and the storage schema
 * replaceable without touching the UI.
 */
import type {
  Drug,
  DrugId,
  DrugIdentifiers,
  Pharmacokinetics,
  ReceptorTarget,
} from '../../domain/drug/drug'
import type { DrugLibrary, LibraryMetadata } from '../../domain/library/library'
import type { ImportIssue, ImportWarning } from '../import/importPipeline'
import type { RecoveryCounts, RecoveryIssue, RecoveryWarning } from '../recovery/format'

export type RepositoryErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'STORAGE' | 'CONFLICT'

/** Typed failure for repository operations (never a silent no-op). */
export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode

  constructor(code: RepositoryErrorCode, message: string) {
    super(message)
    this.name = 'RepositoryError'
    this.code = code
  }
}

/** A stored record that failed schema validation — kept, reported, not deleted. */
export interface QuarantinedRecord {
  /** Storage key of the raw record (string form; '(missing id)' if unusable). */
  readonly id: string
  readonly errors: readonly string[]
  readonly record: unknown
}

export interface LibraryLoadResult {
  readonly drugs: readonly Drug[]
  /** Invalid records found during hydration — never silently emptied. */
  readonly quarantine: readonly QuarantinedRecord[]
}

/**
 * Target row as accepted by create/update: `id` optional — the repository
 * assigns a stable UUID to rows that arrive without one (the UI never
 * invents identity; see newId).
 */
export type TargetInput = Omit<ReceptorTarget, 'id'> & { readonly id?: string }

/** Everything the UI may set on creation; id/origin/timestamps are assigned here. */
export interface DrugInput {
  readonly identifiers: DrugIdentifiers
  readonly tags?: readonly string[]
  readonly targets?: readonly TargetInput[]
  readonly pharmacokinetics?: Pharmacokinetics
  /** Explicit `undefined` means "no notes" (create) / "clear" (update). */
  readonly notes?: string | undefined
}

/**
 * Partial update. Absent keys keep their current value. `notes` is the one
 * optional scalar and may be explicitly `undefined` to *clear* it (the
 * form submits it always); required structures (identifiers, tags, targets,
 * pharmacokinetics) are replaced wholesale when present.
 */
export interface DrugChanges {
  readonly identifiers?: DrugIdentifiers
  readonly tags?: readonly string[]
  readonly targets?: readonly TargetInput[]
  readonly pharmacokinetics?: Pharmacokinetics
  readonly notes?: string | undefined
}

export type ImportMode =
  /**
   * Incoming records win per id; the rest of the library is untouched.
   * Exception (audit GAP-3): an id whose stored row is quarantined never
   * overwrites that row — the whole document is rejected with
   * `QUARANTINE_CONFLICT` before any write.
   */
  | 'merge'
  /** The file replaces the whole library (drugs and metadata). */
  | 'replace'

export type ImportReport =
  | {
      readonly ok: true
      readonly mode: ImportMode
      readonly total: number
      readonly created: number
      readonly updated: number
      readonly warnings: readonly ImportWarning[]
    }
  | {
      readonly ok: false
      readonly errors: readonly ImportIssue[]
      readonly warnings: readonly ImportWarning[]
    }

/**
 * Recovery archive (`.npsb`, ADR-18) outcomes. Export and preview/restore
 * validation never throw for data problems — they report structured
 * issues so the UI can show exactly what to fix; only genuine storage
 * failures inside the restore transaction throw (→ `failed`).
 */
export type RecoveryExportOutcome =
  | { readonly ok: true; readonly text: string; readonly counts: RecoveryCounts }
  | { readonly ok: false; readonly issues: readonly RecoveryIssue[] }

/** Report shared by a preview and a committed restore. */
export interface RecoveryReport {
  /** Counts recorded IN the archive (validated, §4.1). */
  readonly counts: RecoveryCounts
  /** This build's classification of the archive's drug rows (§8.6). */
  readonly currentBuild: { readonly readable: number; readonly quarantined: number }
  /** Non-blocking §8.3 warnings — informational, never gating. */
  readonly warnings: readonly RecoveryWarning[]
}

export type RecoveryPreviewOutcome =
  | { readonly ok: true; readonly report: RecoveryReport }
  | { readonly ok: false; readonly issues: readonly RecoveryIssue[] }

export type RecoveryRestoreOutcome =
  | { readonly ok: true; readonly report: RecoveryReport }
  | { readonly ok: false; readonly issues: readonly RecoveryIssue[] }

export interface DrugRepository {
  /** All valid records plus a quarantine report of invalid ones. */
  getAllDrugs(): Promise<LibraryLoadResult>
  getDrug(id: DrugId): Promise<Drug | undefined>
  createDrug(input: DrugInput): Promise<Drug>
  /**
   * Partial update guarded by optimistic concurrency (phase 20, ADR-21).
   * `expectedRevision` is the `Drug.revision` value the caller's draft
   * is based on (captured when its edit session started). The revision
   * comparison and the record write run inside ONE read-write
   * transaction, so a write based on a superseded record state is
   * rejected with `RepositoryError('CONFLICT')` *before* anything is
   * written: the stored record, its scientific values and its revision
   * stay untouched. `DrugChanges` merge semantics are unchanged — an
   * omitted group keeps the freshly read value, a supplied group
   * replaces wholesale, and `notes` distinguishes absent from explicit
   * `undefined`. Failure codes are distinct: `CONFLICT` (stale token),
   * `NOT_FOUND` (no row), `VALIDATION` (schema/uniqueness), `STORAGE`.
   * Successful commits advance the stored revision, so a stale token
   * can never be replayed. Bulk paths (import/replace/restore) are
   * separate full-snapshot transactions that bump every written id's
   * revision instead of taking a token.
   */
  updateDrug(id: DrugId, changes: DrugChanges, expectedRevision: number): Promise<Drug>
  deleteDrug(id: DrugId): Promise<void>
  /** Single metadata entry; created with documented defaults on first run. */
  getLibraryMetadata(): Promise<LibraryMetadata>
  /** Atomic, all-or-nothing replacement (duplicate ids reject inside the transaction). */
  replaceLibrary(next: DrugLibrary): Promise<void>
  /** NPSL text → parse/schema/semantic validation → transactional commit. */
  importLibrary(text: string, options: { readonly mode: ImportMode }): Promise<ImportReport>
  exportLibrary(): Promise<DrugLibrary>
  /**
   * Read-only full-storage snapshot of BOTH stores (quarantined and
   * unknown-field rows included) as verified `.npsb` text (ADR-18). A
   * `ok: false` outcome means NO file should be produced.
   */
  exportRecoveryArchive(): Promise<RecoveryExportOutcome>
  /** Validate an archive read-only and classify its rows under this build. */
  previewRecoveryArchive(text: string): Promise<RecoveryPreviewOutcome>
  /**
   * Full snapshot replacement: complete §8.2 validation BEFORE opening
   * one `rw` transaction, then raw writes of every entry. Throws only on
   * a genuine transaction failure (rolled back — previous library
   * intact); validation problems return `ok: false` with no writes.
   */
  restoreRecoveryArchive(text: string): Promise<RecoveryRestoreOutcome>
}
