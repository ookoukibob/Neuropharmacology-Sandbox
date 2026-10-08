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

export type RepositoryErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'STORAGE'

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
  /** Incoming records win per id; the rest of the library is untouched. */
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

export interface DrugRepository {
  /** All valid records plus a quarantine report of invalid ones. */
  getAllDrugs(): Promise<LibraryLoadResult>
  getDrug(id: DrugId): Promise<Drug | undefined>
  createDrug(input: DrugInput): Promise<Drug>
  updateDrug(id: DrugId, changes: DrugChanges): Promise<Drug>
  deleteDrug(id: DrugId): Promise<void>
  /** Single metadata entry; created with documented defaults on first run. */
  getLibraryMetadata(): Promise<LibraryMetadata>
  /** Atomic, all-or-nothing replacement (duplicate ids reject inside the transaction). */
  replaceLibrary(next: DrugLibrary): Promise<void>
  /** NPSL text → parse/schema/semantic validation → transactional commit. */
  importLibrary(text: string, options: { readonly mode: ImportMode }): Promise<ImportReport>
  exportLibrary(): Promise<DrugLibrary>
}
