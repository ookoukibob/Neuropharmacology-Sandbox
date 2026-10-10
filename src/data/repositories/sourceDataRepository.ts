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
 * - every incoming record is schema-validated before any write;
 * - an observation whose compound is neither in the batch nor already
 *   stored is rejected (no orphan measurements);
 * - records that already exist are never overwritten — existing rows win
 *   and the import reports them as skipped;
 * - any rejection means nothing was written (all-or-nothing).
 */
import type { Compound } from '../../domain/sources/compound'
import type { ExperimentalObservation } from '../../domain/sources/observation'
import type { QuarantinedRecord } from './repository'

export type SourceImportIssueCode = 'INVALID_RECORD' | 'ORPHAN_OBSERVATION'

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
}
