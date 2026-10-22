/**
 * Experimental-dataset repository contract (phase 47A).
 *
 * Same doorway pattern as the drug/scenario repositories: the UI depends on
 * this interface only. Every operation is typed; a write is never reported as
 * successful unless it committed. Records are addressed by stable `id`, and
 * mutable operations require the `updatedAt` token the caller's view is based
 * on. The token is compared inside the same read-write transaction as the
 * write, so a stale screen cannot overwrite newer changes silently.
 */
import type {
  ExperimentalDataset,
  ExperimentalDatasetId,
  ExperimentalDatasetInput,
  ExperimentalDatasetSummary,
} from '../../domain/experiments/experimental-dataset'

export type ExperimentalDatasetErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'STORAGE'
  | 'CORRUPT'
  | 'CONFLICT'

/** One unreadable stored row, reported instead of trusted or deleted. */
export interface CorruptExperimentalDataset {
  readonly id: string
  readonly message: string
}

export interface ExperimentalDatasetListResult {
  readonly datasets: readonly ExperimentalDatasetSummary[]
  readonly corrupt: readonly CorruptExperimentalDataset[]
}

export type ExperimentalDatasetOutcome =
  | { readonly ok: true; readonly dataset: ExperimentalDataset }
  | {
      readonly ok: false
      readonly code: ExperimentalDatasetErrorCode
      readonly message: string
    }

export type ExperimentalDatasetDeleteOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: ExperimentalDatasetErrorCode
      readonly message: string
    }

/**
 * Partial metadata update. Absent `name` keeps the current name; `notes`
 * distinguishes absent (keep) from explicit `undefined` (clear).
 */
export interface ExperimentalDatasetChanges {
  readonly name?: string
  readonly notes?: string | undefined
}

export interface ExperimentalDatasetRepository {
  /** Summaries, most recently modified first, plus unreadable rows. */
  list(): Promise<ExperimentalDatasetListResult>
  /** One complete dataset, or NOT_FOUND / CORRUPT. */
  get(id: ExperimentalDatasetId): Promise<ExperimentalDatasetOutcome>
  /**
   * Create a new dataset: always a new local id, timestamps and per-measurement
   * ids. The input is validated before any write.
   */
  create(input: ExperimentalDatasetInput): Promise<ExperimentalDatasetOutcome>
  /**
   * Update name and/or notes by id under the optimistic `updatedAt` token.
   * Measurements, units and provenance are never touched by this operation.
   */
  update(
    id: ExperimentalDatasetId,
    changes: ExperimentalDatasetChanges,
    expectedUpdatedAt: string,
  ): Promise<ExperimentalDatasetOutcome>
  /** Delete by id under the optimistic `updatedAt` token. */
  delete(
    id: ExperimentalDatasetId,
    expectedUpdatedAt: string,
  ): Promise<ExperimentalDatasetDeleteOutcome>
}
