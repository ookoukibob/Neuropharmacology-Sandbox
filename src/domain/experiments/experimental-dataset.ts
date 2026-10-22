/**
 * Experimental concentration–time datasets (phase 47A).
 *
 * This is a DISTINCT domain model. It deliberately does not reuse
 * `ExperimentalObservation` (the source-data Layer B record): an observation
 * describes a reported potency/affinity measurement at a target, while a
 * dataset here is an ordered set of measured time/concentration pairs. One is
 * never converted into the other implicitly.
 *
 * Scientific-integrity rules encoded by the types and helpers here:
 * - every dataset declares its time unit and concentration unit explicitly;
 *   units come from the existing catalog and are never inferred;
 * - measurements are stored in source row order, and duplicate timestamps,
 *   duplicate sample ids and exact replicates are legitimate data — nothing is
 *   averaged, deduplicated, interpolated or normalized;
 * - time and concentration are finite, non-negative numbers (zero is valid);
 * - `sourceRow` is the 1-based data row in the supplied source. It is NOT the
 *   measurement's database identity: `ExperimentalMeasurement.id` is the
 *   stable local identity used by storage.
 *
 * Pure domain module: no React, no I/O, no storage imports.
 */
import { unitCatalog } from '../pharmacology/unit-catalog'
import type { DimensionId } from '../pharmacology/units'

export type ExperimentalDatasetId = string
export type ExperimentalMeasurementId = string

/** Where the dataset's content came from. */
export type DatasetSourceKind = 'csv' | 'npex'

/**
 * Provenance as supplied by the import the dataset came from. `fileName` is
 * optional because a future non-file creation path has no file; this phase
 * only creates datasets from uploaded files.
 */
export interface DatasetProvenance {
  readonly source: DatasetSourceKind
  readonly fileName?: string
  /** ISO 8601 timestamp at which this content was imported. */
  readonly importedAt: string
}

/** One measured time/concentration pair in source order. */
export interface ExperimentalMeasurement {
  /** Stable local identity (storage only; never a source row id). */
  readonly id: ExperimentalMeasurementId
  /** 1-based data row in the source file (header excluded). */
  readonly sourceRow: number
  /** Measured time in the dataset's declared time unit. */
  readonly time: number
  /** Measured concentration in the dataset's declared concentration unit. */
  readonly concentration: number
  /** Optional replicate/sample identifier, preserved verbatim. */
  readonly sampleId?: string
  /** Optional measurement-level note, preserved verbatim. */
  readonly note?: string
}

/** A complete stored dataset. */
export interface ExperimentalDataset {
  readonly id: ExperimentalDatasetId
  /** Display name, trimmed and non-empty. Names are not unique. */
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Explicit unit symbol, accepted by the existing unit catalog. */
  readonly timeUnit: string
  /** Explicit unit symbol (molar or mass concentration), from the catalog. */
  readonly concentrationUnit: string
  /** Source order is array order; it is never sorted. */
  readonly measurements: readonly ExperimentalMeasurement[]
  readonly provenance: DatasetProvenance
  /** Optional descriptive notes. */
  readonly notes?: string
}

/** A measurement before storage assigns its local identity. */
export interface ExperimentalMeasurementInput {
  readonly sourceRow: number
  readonly time: number
  readonly concentration: number
  readonly sampleId?: string
  readonly note?: string
}

/** Everything a caller supplies when creating a dataset. */
export interface ExperimentalDatasetInput {
  readonly name: string
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly measurements: readonly ExperimentalMeasurementInput[]
  readonly provenance: DatasetProvenance
  readonly notes?: string
}

/** List row: metadata only, no measurements. */
export interface ExperimentalDatasetSummary {
  readonly id: ExperimentalDatasetId
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly measurementCount: number
  readonly provenance: DatasetProvenance
}

/** Resource limits (shared by CSV, `.npex` and storage). */
export const MAX_DATASET_NAME_LENGTH = 120
export const MAX_DATASET_NOTES_LENGTH = 10_000
export const MAX_SAMPLE_ID_LENGTH = 200
export const MAX_MEASUREMENT_NOTE_LENGTH = 1_000
export const MAX_DATASET_MEASUREMENTS = 25_000

/** Molar concentration and mass concentration are different dimensions. */
export const CONCENTRATION_DIMENSIONS: readonly DimensionId[] = [
  'molar-concentration',
  'mass-concentration',
]

/**
 * Dataset name policy (shared by UI and repository): surrounding whitespace is
 * trimmed, an empty name is rejected, and names are not unique — ids identify
 * records.
 */
export function normalizeDatasetName(
  raw: string,
):
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string } {
  const name = raw.trim()
  if (name === '') return { ok: false, message: 'A dataset name is required.' }
  if (name.length > MAX_DATASET_NAME_LENGTH) {
    return {
      ok: false,
      message: `A dataset name may be at most ${MAX_DATASET_NAME_LENGTH} characters.`,
    }
  }
  return { ok: true, name }
}

/**
 * Notes policy: a whitespace-only note is absent, but every non-empty note is
 * returned exactly as supplied — surrounding whitespace included — so storing
 * and re-exporting the dataset cannot alter the text.
 */
export function normalizeDatasetNotes(
  raw: string | undefined,
): { readonly ok: true; readonly notes: string | undefined } | { readonly ok: false; readonly message: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, notes: undefined }
  if (raw.length > MAX_DATASET_NOTES_LENGTH) {
    return {
      ok: false,
      message: `Dataset notes may be at most ${MAX_DATASET_NOTES_LENGTH} characters.`,
    }
  }
  return { ok: true, notes: raw }
}

/** Same exact-text policy for an optional measurement note. */
export function normalizeMeasurementNote(
  raw: string | undefined,
): { readonly ok: true; readonly note: string | undefined } | { readonly ok: false; readonly message: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, note: undefined }
  if (raw.length > MAX_MEASUREMENT_NOTE_LENGTH) {
    return {
      ok: false,
      message: `A measurement note may be at most ${MAX_MEASUREMENT_NOTE_LENGTH} characters.`,
    }
  }
  return { ok: true, note: raw }
}

/** Same exact-text policy for an optional replicate/sample identifier. */
export function normalizeSampleId(
  raw: string | undefined,
): { readonly ok: true; readonly sampleId: string | undefined } | { readonly ok: false; readonly message: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, sampleId: undefined }
  if (raw.length > MAX_SAMPLE_ID_LENGTH) {
    return {
      ok: false,
      message: `A sample id may be at most ${MAX_SAMPLE_ID_LENGTH} characters.`,
    }
  }
  return { ok: true, sampleId: raw }
}

/** Time must resolve to the catalog's `time` dimension. */
export function timeUnitIssue(unit: string): string | null {
  const trimmed = unit.trim()
  if (trimmed === '') return 'A time unit is required.'
  const def = unitCatalog.get(trimmed)
  if (def === undefined) return `Time unit "${trimmed}" is not in the unit catalog.`
  if (def.dimension !== 'time') {
    return `Time unit "${trimmed}" is a ${def.dimension} unit, not a time unit.`
  }
  return null
}

/** Concentration must be molar or mass concentration — never converted. */
export function concentrationUnitIssue(unit: string): string | null {
  const trimmed = unit.trim()
  if (trimmed === '') return 'A concentration unit is required.'
  const def = unitCatalog.get(trimmed)
  if (def === undefined) return `Concentration unit "${trimmed}" is not in the unit catalog.`
  if (!CONCENTRATION_DIMENSIONS.includes(def.dimension)) {
    return `Concentration unit "${trimmed}" is a ${def.dimension} unit, not a concentration unit.`
  }
  return null
}

/** Store the unit exactly as declared, without surrounding whitespace. */
export function declaredUnit(unit: string): string {
  return unit.trim()
}

export function toDatasetSummary(dataset: ExperimentalDataset): ExperimentalDatasetSummary {
  return {
    id: dataset.id,
    name: dataset.name,
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt,
    timeUnit: dataset.timeUnit,
    concentrationUnit: dataset.concentrationUnit,
    measurementCount: dataset.measurements.length,
    provenance: dataset.provenance,
  }
}
