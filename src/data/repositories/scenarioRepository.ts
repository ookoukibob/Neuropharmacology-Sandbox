/**
 * Scenario repository contract (phase 45).
 *
 * Same doorway pattern as the drug repository (ADR-14): the UI depends on
 * this interface only, so the feature is testable with an in-memory double
 * and the storage schema stays replaceable.
 *
 * Every operation returns a typed outcome. A write is never reported as a
 * success unless it committed, and no operation silently overwrites a record
 * the caller did not name by id.
 */
import type {
  SavedScenario,
  SavedScenarioSummary,
  ScenarioId,
} from '../../domain/simulation/saved-scenario'
import type { SimulationDraft } from '../../features/simulation/draft'

export type ScenarioRepositoryErrorCode =
  /** The requested id does not exist (another tab may have deleted it). */
  | 'NOT_FOUND'
  /** The supplied data is not valid (empty name, malformed draft). */
  | 'VALIDATION'
  /** IndexedDB read/write failure (quota, blocked, aborted transaction). */
  | 'STORAGE'
  /** The stored record exists but does not satisfy the storage schema. */
  | 'CORRUPT'

/** One unreadable stored row, reported instead of being trusted or deleted. */
export interface CorruptScenario {
  readonly id: string
  readonly message: string
}

export interface ScenarioListResult {
  readonly scenarios: readonly SavedScenarioSummary[]
  /** Stored rows that failed validation; kept in storage, never offered as editable. */
  readonly corrupt: readonly CorruptScenario[]
}

export type ScenarioOperationOutcome =
  | { readonly ok: true; readonly scenario: SavedScenario }
  | {
      readonly ok: false
      readonly code: ScenarioRepositoryErrorCode
      readonly message: string
    }

export type ScenarioDeleteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ScenarioRepositoryErrorCode; readonly message: string }

/** A raw stored row captured for the `.npsb` backup. */
export interface ScenarioRawRow {
  readonly key: string
  readonly value: unknown
}

export interface ScenarioRepository {
  /** Saved scenarios (summaries), most recently modified first, plus unreadable rows. */
  list(): Promise<ScenarioListResult>
  /** One complete record, or NOT_FOUND / CORRUPT. */
  get(id: ScenarioId): Promise<ScenarioOperationOutcome>
  /** Create a new record; always a new id, so an existing row is never replaced. */
  create(name: string, draft: SimulationDraft): Promise<ScenarioOperationOutcome>
  /** Rename by id; the draft is untouched. */
  rename(id: ScenarioId, name: string): Promise<ScenarioOperationOutcome>
  /** Copy a record into a new record (new id, independent timestamps). */
  duplicate(id: ScenarioId, name?: string): Promise<ScenarioOperationOutcome>
  /** Delete by id (never by name). */
  delete(id: ScenarioId): Promise<ScenarioDeleteOutcome>
  /** Replace a record's draft by id, keeping its name unless another is given. */
  saveOver(id: ScenarioId, draft: SimulationDraft, name?: string): Promise<ScenarioOperationOutcome>
  /** Raw rows for the `.npsb` backup (read-only, verbatim). */
  exportRows(): Promise<readonly ScenarioRawRow[]>
  /**
   * Replace every stored scenario atomically (restore). Rows are written
   * verbatim inside one read-write transaction; any failure rolls back and
   * leaves the previous library intact.
   */
  replaceAll(rows: readonly { readonly key: string; readonly value: Record<string, unknown> }[]): Promise<void>
}
