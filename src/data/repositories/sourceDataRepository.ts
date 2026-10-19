/**
 * Source-data repository — the storage doorway for the three-layer data
 * model's Layer A (compounds) and Layer B (experimental observations).
 *
 * Deliberately separate from `DrugRepository`: source records are
 * acquired on demand and are *not* simulation inputs. Importing them
 * never touches drug records, and nothing here ever writes a model
 * parameter (Layer C links are created only through an explicit user
 * selection on a drug record).
 *
 * Contract highlights (validated inside one transaction — a preview never
 * substitutes for this boundary):
 * - every incoming record is schema- and identity-validated before any
 *   write;
 * - an observation whose compound is neither in the batch nor already
 *   stored as a VALID record is rejected (no orphan measurements, and no
 *   measurement validated against a malformed stored compound row);
 * - records that already exist are never overwritten — existing VALID
 *   rows win and the import reports them as skipped;
 * - an id that collides with a stored row which fails source-record
 *   validation (quarantined on hydration) is a blocking
 *   `QUARANTINE_CONFLICT` raised before any write: the quarantined row is
 *   preserved byte-identical and nothing from the request is written;
 * - any rejection means nothing was written (all-or-nothing).
 *
 * Deletion (phase 39) follows the same "protection wins" policy as import:
 * it removes ONE valid compound row and exactly the observations whose
 * `compoundId` equals that compound's deterministic id, in one transaction.
 * It never touches the drug library — an imported `Drug.sourceRecords`
 * snapshot is an independent, durable copy, so removing the local
 * acquisition record can never alter, degrade or orphan a library record,
 * its parameters or its provenance.
 */
import type { Compound } from '../../domain/sources/compound'
import type { ExperimentalObservation } from '../../domain/sources/observation'
import type { QuarantinedRecord } from './repository'

export type SourceImportIssueCode =
  | 'INVALID_RECORD'
  | 'ORPHAN_OBSERVATION'
  /** Collision with (or reference to) a stored row that fails validation. */
  | 'QUARANTINE_CONFLICT'

export interface SourceImportIssue {
  readonly code: SourceImportIssueCode
  /** Location in the request, e.g. 'compounds.0'. */
  readonly path: string
  readonly message: string
}

export type SourceImportReport =
  | {
      readonly ok: true
      /** Records newly written. */
      readonly createdCompounds: number
      readonly createdObservations: number
      /** Already stored (or duplicated in the batch) — kept unchanged. */
      readonly skippedCompounds: number
      readonly skippedObservations: number
    }
  | {
      readonly ok: false
      /** Rejected inside the transaction — nothing was written. */
      readonly errors: readonly SourceImportIssue[]
    }

export interface SourceImportRequest {
  readonly compounds: readonly Compound[]
  readonly observations: readonly ExperimentalObservation[]
}

/** Hydration result: valid records plus a report of invalid stored rows. */
export interface SourceLoadResult<T> {
  readonly records: readonly T[]
  /** Rows that failed schema validation — reported, never silently dropped. */
  readonly quarantine: readonly QuarantinedRecord[]
}

/**
 * Why a source-record deletion did not happen. Every code names a distinct,
 * actionable situation — a deletion never fails silently and never reports
 * partial success:
 *
 * - `NOT_FOUND` — no compound row with that id exists (already deleted,
 *   or a stale UI reference);
 * - `QUARANTINE_CONFLICT` — the row (or an observation it owns) fails
 *   source-record validation and is quarantined. The raw data is preserved
 *   byte-identical and NOTHING is deleted: the established policy is that a
 *   malformed row is reported and kept for recovery, never discarded by a
 *   path that cannot prove what it is removing. This is the case a
 *   hand-edited or half-written row produces;
 * - `ORPHAN_OBSERVATION` — an observation referencing this compound is
 *   itself unreadable, so the compound cannot be removed without either
 *   deleting unvalidated data or leaving a dangling measurement;
 * - `STORAGE` — the transaction threw (I/O, quota, abort) and Dexie rolled
 *   it back: the tables are exactly as they were.
 */
export type SourceDeleteFailureCode =
  | 'NOT_FOUND'
  | 'QUARANTINE_CONFLICT'
  | 'ORPHAN_OBSERVATION'
  | 'STORAGE'

export interface SourceDeleteFailure {
  readonly code: SourceDeleteFailureCode
  readonly message: string
  /**
   * Ids of stored rows that blocked the deletion and were preserved
   * unchanged (quarantine/orphan cases only).
   */
  readonly preservedIds?: readonly string[]
}

/**
 * Result of deleting one stored compound identity record.
 *
 * `ok: true` reports exactly what was removed, so the UI can state an
 * accurate count instead of a generic "deleted". `ok: false` guarantees
 * that NOTHING was written — the transaction returned before the first
 * `delete` (or rolled back on a storage failure).
 */
export type SourceDeleteReport =
  | {
      readonly ok: true
      /** The compound identity record that was removed. */
      readonly deletedCompoundId: string
      /**
       * Observations removed with it — exactly those whose validated
       * `compoundId` equalled this compound's id. Observations of every
       * other compound are untouched and are not counted here.
       */
      readonly deletedObservations: number
    }
  | {
      readonly ok: false
      readonly failure: SourceDeleteFailure
    }

export interface SourceDataRepository {
  /** All stored compounds (Layer A) plus a quarantine report. */
  listCompounds(): Promise<SourceLoadResult<Compound>>
  /** Stored observations (Layer B), optionally for one compound. */
  listObservations(filter?: {
    readonly compoundId?: string
  }): Promise<SourceLoadResult<ExperimentalObservation>>
  /**
   * Atomic import: validate → duplicate/orphan classification → write,
   * all inside one transaction. A `ok: false` report or a thrown storage
   * error means the tables were left exactly as they were.
   */
  importSourceRecords(request: SourceImportRequest): Promise<SourceImportReport>
  /**
   * Delete ONE stored compound identity record together with exactly the
   * observations that reference it (`observation.compoundId === compound.id`),
   * atomically.
   *
   * Guarantees:
   * - both tables are covered by ONE read-write transaction, so a failure
   *   leaves the store exactly as it was (no half-deleted compound, no
   *   orphaned measurement);
   * - only the named compound is removed — observations of any other
   *   compound are never touched, and a measurement is matched by its
   *   validated `compoundId`, never by a display name;
   * - the compound row is validated with the SAME authoritative parser
   *   hydration uses; a row that fails validation is quarantined and is
   *   preserved byte-identical (deletion refused, nothing removed);
   * - the drug library is never touched: an imported `Drug.sourceRecords`
   *   snapshot is an independent copy, so a Library record keeps its
   *   source data, parameters, targets and notes after this deletion.
   */
  deleteCompound(id: string): Promise<SourceDeleteReport>
}
