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

// ---------------------------------------------------------------------------
// Administration metadata (phase 50A)
// ---------------------------------------------------------------------------

/**
 * How the drug was administered. `other` covers any administration not listed;
 * `unknown` is the honest value when the route is not recorded — it is never a
 * fallback that assumes a route.
 */
export type AdministrationRoute =
  | 'iv-bolus'
  | 'iv-infusion'
  | 'extravascular'
  | 'other'
  | 'unknown'

/**
 * The study regimen. `repeated-dose` means repeated dosing NOT at steady
 * state; `repeated-dose-steady-state` means repeated dosing at steady state.
 * A visually flat-looking curve never implies steady state — it must be stated.
 */
export type AdministrationRegimen =
  | 'single-dose'
  | 'repeated-dose'
  | 'repeated-dose-steady-state'
  | 'unknown'

/**
 * What the recorded measurement times are relative to. A dataset's time zero
 * is NOT assumed to be a dose time or the first observation without evidence.
 * `first-observation`, `dose-time` and `infusion-start` are explicit claims
 * about the source time axis; `other`/`unknown` decline to claim a standard
 * anchor. For repeated dosing, the specific reference dose/interval must be
 * documented in the dataset notes or source metadata; this enum alone does
 * not identify a dose number.
 */
export type AdministrationTimeReference =
  | 'dose-time'
  | 'infusion-start'
  | 'first-observation'
  | 'other'
  | 'unknown'

/**
 * What the recorded `dose` amount actually refers to (phase 50C).
 *
 * - `per-administration` — the amount given at EACH administration, so it is
 *   the dose that belongs to one dosing interval τ;
 * - `total-regimen` — the cumulative amount of the whole recorded regimen,
 *   which must never be divided by a single interval's AUCτ;
 * - `unknown` — the basis was not established.
 *
 * Absent means "not recorded". A pre-50C dataset without this field is NEVER
 * defaulted to `per-administration`: that would silently turn a cumulative or
 * unstated amount into a per-dose amount and fabricate a clearance.
 */
export type AdministrationDoseBasis = 'per-administration' | 'total-regimen' | 'unknown'

/** A quantity as the analyst stated it: number + explicit unit, never bare. */
export interface AdministrationQuantity {
  readonly value: number
  readonly unit: string
}

/**
 * Infusion specifics for an IV-infusion dataset. At most one of `duration` and
 * `rate` may be present; both absent means "route is infusion but no
 * duration/rate was recorded". Neither value is derived from the other.
 */
export interface AdministrationInfusion {
  readonly duration?: AdministrationQuantity
  readonly rate?: AdministrationQuantity
}

/**
 * Optional administration context for a dataset. If this record exists, the
 * route, regimen and time reference must be explicitly supplied (including an
 * explicit `unknown` where necessary). Optional quantities are absent when
 * they were not recorded. Nothing is inferred from measurements. Dose-dependent
 * parameters (CL, CL/F, Vz, Vz/F) are NOT computed from this metadata in this phase.
 */
export interface AdministrationMetadata {
  readonly route: AdministrationRoute
  /** Dose amount with a mass unit, present only when known. */
  readonly dose?: AdministrationQuantity
  /**
   * What `dose` refers to (phase 50C). Absent means not recorded; it is never
   * assumed to be a per-administration amount for a repeated regimen.
   */
  readonly doseBasis?: AdministrationDoseBasis
  /** Infusion duration or rate, present only for an IV infusion. */
  readonly infusion?: AdministrationInfusion
  readonly regimen: AdministrationRegimen
  /** Dosing interval τ with a time unit, present only when applicable. */
  readonly dosingInterval?: AdministrationQuantity
  readonly timeReference: AdministrationTimeReference
  /** Bioavailability F in (0, 1], present only when explicitly supplied. */
  readonly bioavailability?: number
}

export const ADMINISTRATION_ROUTES: readonly AdministrationRoute[] = [
  'iv-bolus',
  'iv-infusion',
  'extravascular',
  'other',
  'unknown',
]

export const ADMINISTRATION_REGIMENS: readonly AdministrationRegimen[] = [
  'single-dose',
  'repeated-dose',
  'repeated-dose-steady-state',
  'unknown',
]

export const ADMINISTRATION_TIME_REFERENCES: readonly AdministrationTimeReference[] = [
  'dose-time',
  'infusion-start',
  'first-observation',
  'other',
  'unknown',
]

export const ADMINISTRATION_DOSE_BASES: readonly AdministrationDoseBasis[] = [
  'per-administration',
  'total-regimen',
  'unknown',
]

/** One administration-field problem, identified by a dotted field path. */
export interface AdministrationIssue {
  readonly field: string
  readonly message: string
}

function quantityIssue(
  quantity: AdministrationQuantity,
  dimension: DimensionId,
  allowZero: boolean,
  field: string,
  label: string,
): AdministrationIssue[] {
  const issues: AdministrationIssue[] = []
  if (typeof quantity.value !== 'number' || !Number.isFinite(quantity.value)) {
    issues.push({ field: `${field}.value`, message: `${label} must be a finite number.` })
  } else if (allowZero ? quantity.value < 0 : quantity.value <= 0) {
    issues.push({
      field: `${field}.value`,
      message: `${label} must be ${allowZero ? 'zero or greater' : 'greater than zero'}.`,
    })
  }
  const unit = typeof quantity.unit === 'string' ? quantity.unit.trim() : ''
  if (unit === '') {
    issues.push({ field: `${field}.unit`, message: `A unit is required for ${label.toLowerCase()}.` })
  } else {
    const def = unitCatalog.get(unit)
    if (def === undefined) {
      issues.push({ field: `${field}.unit`, message: `Unit "${unit}" is not in the unit catalog.` })
    } else if (def.dimension !== dimension) {
      issues.push({
        field: `${field}.unit`,
        message: `Unit "${unit}" is a ${def.dimension} unit, not a ${dimension} unit.`,
      })
    }
  }
  return issues
}

/**
 * Validate the administration metadata's scientific rules (unit dimensions,
 * positivity, infusion duration XOR rate, bioavailability range). Structural
 * shape (enums, object types) is the schema's job; this owns only what the
 * schema cannot decide without the unit catalog.
 */
export function validateAdministration(
  administration: AdministrationMetadata,
): readonly AdministrationIssue[] {
  const issues: AdministrationIssue[] = []

  if (!ADMINISTRATION_ROUTES.includes(administration.route)) {
    issues.push({ field: 'route', message: `Unknown administration route "${String(administration.route)}".` })
  }
  if (!ADMINISTRATION_REGIMENS.includes(administration.regimen)) {
    issues.push({ field: 'regimen', message: `Unknown regimen "${String(administration.regimen)}".` })
  }
  if (!ADMINISTRATION_TIME_REFERENCES.includes(administration.timeReference)) {
    issues.push({
      field: 'timeReference',
      message: `Unknown time reference "${String(administration.timeReference)}".`,
    })
  }

  if (administration.dose !== undefined) {
    issues.push(...quantityIssue(administration.dose, 'mass', false, 'dose', 'Dose amount'))
  }

  if (administration.doseBasis !== undefined) {
    if (!ADMINISTRATION_DOSE_BASES.includes(administration.doseBasis)) {
      issues.push({
        field: 'doseBasis',
        message: `Unknown dose basis "${String(administration.doseBasis)}".`,
      })
    } else if (administration.dose === undefined) {
      // A basis for a dose that was never recorded describes nothing and would
      // invite a later reader to assume an amount exists.
      issues.push({
        field: 'doseBasis',
        message: 'A dose basis requires a recorded dose amount.',
      })
    }
  }

  if (administration.infusion !== undefined) {
    const hasDuration = administration.infusion.duration !== undefined
    const hasRate = administration.infusion.rate !== undefined
    if (hasDuration && hasRate) {
      issues.push({
        field: 'infusion',
        message: 'An infusion records either a duration or a rate, not both.',
      })
    }
    if (hasDuration) {
      issues.push(
        ...quantityIssue(administration.infusion.duration, 'time', false, 'infusion.duration', 'Infusion duration'),
      )
    }
    if (hasRate) {
      issues.push(
        ...quantityIssue(administration.infusion.rate, 'mass-flow-rate', false, 'infusion.rate', 'Infusion rate'),
      )
    }
  }

  if (administration.dosingInterval !== undefined) {
    issues.push(
      ...quantityIssue(administration.dosingInterval, 'time', false, 'dosingInterval', 'Dosing interval'),
    )
  }

  if (administration.bioavailability !== undefined) {
    const f = administration.bioavailability
    if (typeof f !== 'number' || !Number.isFinite(f)) {
      issues.push({ field: 'bioavailability', message: 'Bioavailability must be a finite number.' })
    } else if (f <= 0 || f > 1) {
      issues.push({
        field: 'bioavailability',
        message: 'Bioavailability must be greater than 0 and at most 1.',
      })
    } else if (
      (administration.route === 'iv-bolus' || administration.route === 'iv-infusion') &&
      f !== 1
    ) {
      // Absolute bioavailability for an intravenous route is 1 by definition.
      // Do not let contradictory metadata become an input to later dose-based
      // calculations; retain an explicitly supplied F=1 if the user records it.
      issues.push({
        field: 'bioavailability',
        message: 'Bioavailability for intravenous administration is 1; a different F conflicts with the recorded route.',
      })
    }
  }

  if (administration.infusion !== undefined && administration.route !== 'iv-infusion') {
    issues.push({
      field: 'infusion',
      message: 'Infusion duration/rate metadata requires the IV-infusion route.',
    })
  }

  return issues
}

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

/**
 * A below-quantification-limit record is left-censored: the true concentration
 * is known only to be below the recorded limit. It carries NO measured
 * concentration, and `limit` is a detection bound, never a substitute value.
 */
export type CensoringType = 'below-quantification-limit'

/** Fields shared by every measurement record regardless of censoring. */
interface ExperimentalMeasurementBase {
  /** Stable local identity (storage only; never a source row id). */
  readonly id: ExperimentalMeasurementId
  /** 1-based data row in the source file (header excluded). */
  readonly sourceRow: number
  /** Measured time in the dataset's declared time unit. */
  readonly time: number
  /** Optional replicate/sample identifier, preserved verbatim. */
  readonly sampleId?: string
  /** Optional measurement-level note, preserved verbatim. */
  readonly note?: string
}

/**
 * A quantified observation: an actually recorded, finite, non-negative
 * concentration. This is the only shape older readers and analyses understood;
 * it carries no `censored` field, so pre-50F records remain quantified.
 */
export interface QuantifiedMeasurement extends ExperimentalMeasurementBase {
  /** Measured concentration in the dataset's declared concentration unit. */
  readonly concentration: number
}

/**
 * A below-quantification-limit observation: a real record whose true value is
 * unknown, with an explicit numeric LLOQ in the dataset's concentration unit
 * and the original text unchanged. It must never be read as `concentration`.
 */
export interface CensoredMeasurement extends ExperimentalMeasurementBase {
  readonly censored: true
  readonly censoring: CensoringType
  /** The original, unchanged source text (e.g. "<0.1" or "BLQ"). */
  readonly rawText: string
  /** The numeric quantification limit, finite and greater than zero, in the dataset's concentration unit. */
  readonly limit: number
}

/** One measurement record in source order — quantified or below the limit. */
export type ExperimentalMeasurement = QuantifiedMeasurement | CensoredMeasurement

/** A measurement before storage assigns its local identity. */
export type ExperimentalMeasurementInput = QuantifiedMeasurementInput | CensoredMeasurementInput

/** Quantified observation as supplied by an import (no local id yet). */
export interface QuantifiedMeasurementInput {
  readonly sourceRow: number
  readonly time: number
  readonly concentration: number
  readonly sampleId?: string
  readonly note?: string
}

/** Below-limit observation as supplied by an import (no local id yet). */
export interface CensoredMeasurementInput {
  readonly sourceRow: number
  readonly time: number
  readonly censored: true
  readonly censoring: CensoringType
  readonly rawText: string
  readonly limit: number
  readonly sampleId?: string
  readonly note?: string
}

/**
 * True when the record is a below-quantification-limit observation. Pre-50F
 * records have no `censored` field and are therefore never treated as censored.
 */
export function isCensoredMeasurement(
  measurement: ExperimentalMeasurement,
): measurement is CensoredMeasurement {
  return (
    measurement !== null &&
    typeof measurement === 'object' &&
    (measurement as { censored?: unknown }).censored === true
  )
}

/** True when the record carries an actual measured concentration. */
export function isQuantifiedMeasurement(
  measurement: ExperimentalMeasurement,
): measurement is QuantifiedMeasurement {
  return !isCensoredMeasurement(measurement)
}

/** True when an import-supplied observation is below the quantification limit. */
export function isCensoredMeasurementInput(
  measurement: ExperimentalMeasurementInput,
): measurement is CensoredMeasurementInput {
  return (measurement as { censored?: unknown }).censored === true
}

/** True when an import-supplied observation carries an actual concentration. */
export function isQuantifiedMeasurementInput(
  measurement: ExperimentalMeasurementInput,
): measurement is QuantifiedMeasurementInput {
  return !isCensoredMeasurementInput(measurement)
}

export interface CensoredMeasurementsSummary {
  readonly count: number
  readonly sourceRows: readonly number[]
}

/** Count and locate every below-limit record, or null when none exists. */
export function censoredMeasurementsSummary(
  measurements: readonly ExperimentalMeasurement[],
): CensoredMeasurementsSummary | null {
  const sourceRows: number[] = []
  for (const measurement of measurements) {
    if (isCensoredMeasurement(measurement)) sourceRows.push(measurement.sourceRow)
  }
  return sourceRows.length === 0 ? null : { count: sourceRows.length, sourceRows }
}

/** Stable refusal code shared by every numeric analysis that needs a value. */
export const CENSORED_CONCENTRATION_UNSUPPORTED = 'CENSORED_CONCENTRATION_UNSUPPORTED'

/**
 * The message a numeric analysis reports when it must refuse censored records.
 * It names the count and source rows and never proposes a substitution.
 */
export function censoredRefusalMessage(measurements: readonly ExperimentalMeasurement[]): string | null {
  const summary = censoredMeasurementsSummary(measurements)
  if (summary === null) return null
  return `The dataset contains ${summary.count} below-quantification-limit record(s) (source rows ${summary.sourceRows.join(', ')}). Numeric concentration analyses do not yet support censored observations: no limit is substituted, dropped or treated as a measured concentration.`
}

/** One violation of the measurement contract, addressed by its field name. */
export interface MeasurementContractIssue {
  /** The offending field, so a schema can attach the message to that path. */
  readonly field: string
  readonly message: string
}

/** Censoring metadata: no quantified observation may carry any of these. */
const RESERVED_CENSORING_FIELDS = ['censored', 'censoring', 'rawText', 'limit'] as const

/** `<0.1` — the inline below-limit bound shape CSV import recognises. */
const INLINE_BELOW_LIMIT_BOUND = /^<\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*$/

/** What a censored record's original text says about its bound. */
export type InlineBelowLimitBound =
  | { readonly kind: 'number'; readonly bound: number }
  /** The text has the `<number` shape but names no finite number (e.g. `<1e400`). */
  | { readonly kind: 'invalid' }
  /** A symbolic marker (`BLQ`, `<LLOQ`, …) that carries no inline number. */
  | { readonly kind: 'none' }

/**
 * The bound a `<number` raw text names, read with the same numeric
 * interpretation as CSV import. Only a trimmed copy is matched, so `rawText`
 * itself is never rewritten.
 */
export function inlineBelowLimitBound(rawText: string): InlineBelowLimitBound {
  const match = INLINE_BELOW_LIMIT_BOUND.exec(rawText.trim())
  if (match === null) return { kind: 'none' }
  const bound = Number(match[1])
  if (!Number.isFinite(bound)) return { kind: 'invalid' }
  return { kind: 'number', bound: Object.is(bound, -0) ? 0 : bound }
}

/**
 * The measurement contract, enforced at every runtime boundary (CSV input,
 * stored records, `.npex` import and export). Structural schemas already
 * require the right fields; this rejects what a permissive object would let
 * through:
 *
 * - a quantified observation carries a concentration and **no** censoring
 *   metadata, so `censored: false` is a contradiction rather than a quantified
 *   record;
 * - a censored observation carries **no** concentration, and an inline
 *   `<number` bound in `rawText` must agree with the recorded `limit`.
 */
export function measurementContractIssues(record: unknown): MeasurementContractIssue[] {
  if (record === null || typeof record !== 'object') return []
  const fields = record as Record<string, unknown>
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(fields, key)
  const issues: MeasurementContractIssue[] = []
  if (fields['censored'] === true) {
    if (has('concentration')) {
      issues.push({
        field: 'concentration',
        message:
          'a below-quantification-limit record must not carry a concentration; the limit is not a measured value',
      })
    }
    const rawText = fields['rawText']
    const limit = fields['limit']
    if (typeof rawText === 'string' && typeof limit === 'number' && Number.isFinite(limit)) {
      const inline = inlineBelowLimitBound(rawText)
      if (inline.kind === 'invalid') {
        issues.push({
          field: 'rawText',
          message: `the original text "${rawText}" names a below-limit bound that is not a finite number`,
        })
      } else if (inline.kind === 'number' && inline.bound !== limit) {
        issues.push({
          field: 'limit',
          message: `the recorded limit ${limit} disagrees with the ${inline.bound} bound in the original text "${rawText}"`,
        })
      }
    }
    return issues
  }
  for (const field of RESERVED_CENSORING_FIELDS) {
    if (has(field)) {
      issues.push({
        field,
        message: `a quantified observation must not carry the reserved censoring field "${field}"`,
      })
    }
  }
  return issues
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
  /**
   * Optional administration context (phase 50A). Absent (records created
   * before this phase) means no administration metadata was recorded; the UI
   * shows it as unknown, never as an invented dose or route.
   */
  readonly administration?: AdministrationMetadata
}

/** Everything a caller supplies when creating a dataset. */
export interface ExperimentalDatasetInput {
  readonly name: string
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly measurements: readonly ExperimentalMeasurementInput[]
  readonly provenance: DatasetProvenance
  readonly notes?: string
  readonly administration?: AdministrationMetadata
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
export const MAX_CENSORED_RAW_TEXT_LENGTH = 200
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
