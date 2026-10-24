/**
 * Interval AUC over one dosing interval (phase 50C): AUCτ.
 *
 * AUCτ is the observed area under the concentration–time curve between two
 * EXPLICITLY SELECTED, ACTUALLY OBSERVED sampling times whose distance equals
 * the recorded dosing interval τ. It is an observed-interval quantity: it is
 * never extrapolated, never interpolated, never zero-filled at a boundary, and
 * never derived from `aucInf`.
 *
 * Why the strictness:
 * - The interval start and end must each be an existing observation. A missing
 *   boundary would require inventing a concentration, so it is refused rather
 *   than estimated.
 * - The measured length must equal the recorded τ. The only tolerance is a
 *   floating-point/unit-conversion tolerance (~1e-9 relative), never a window
 *   wide enough to hide a real time difference.
 * - The terminal rate used for volume parameters comes from THIS interval's
 *   observations only (see `analyzeIntervalAuc`). A λ_z taken from another part
 *   of the dataset would not describe the interval being analysed.
 * - A computable area never implies steady state. Steady state is a recorded
 *   declaration (`regimen`), never inferred from the curve or from a selected
 *   window.
 *
 * Reuse, not reimplementation: the area is produced by the same
 * `trapezoidalArea` used for `AUC(0→last)`, and the interval's λ_z comes from
 * the same `analyzeNca` used by the main card, applied to the interval subset.
 * No second integration rule, unit table or regression is introduced.
 *
 * Pure domain module: no React, no storage, no I/O.
 */
import { unitCatalog } from '../pharmacology/unit-catalog'
import type {
  AdministrationMetadata,
  AdministrationQuantity,
  AdministrationRegimen,
  AdministrationRoute,
  ExperimentalMeasurement,
} from './experimental-dataset'
import {
  analyzeNca,
  trapezoidalArea,
  type NcaAnalysis,
  type NcaIntegrationMethod,
  type NcaInterval,
  type NcaMetric,
  type NcaTerminalPhase,
} from './nca'

/** The interval the analyst selected, in the dataset's own time unit. */
export interface IntervalAucSelection {
  readonly startTime: number
  readonly endTime: number
}

/** One interval-selection precondition and whether it holds. */
export interface IntervalAucPrecondition {
  readonly id: string
  readonly status: 'met' | 'not-met' | 'not-applicable'
  readonly message: string
}

export type IntervalAucUnavailableCode =
  /** No administration record exists. */
  | 'ADMINISTRATION_MISSING'
  /** The regimen is recorded as unknown, so no dosing interval can be assumed. */
  | 'REGIMEN_UNKNOWN'
  /** A single dose has no dosing interval to integrate over. */
  | 'REGIMEN_NOT_REPEATED'
  /** No τ is recorded. */
  | 'DOSING_INTERVAL_MISSING'
  /** The recorded τ is not a positive finite number. */
  | 'DOSING_INTERVAL_NOT_POSITIVE'
  /** The recorded τ is not a time quantity. */
  | 'DOSING_INTERVAL_UNIT_INCOMPATIBLE'
  /** The dataset's declared time unit is not a time unit. */
  | 'TIME_UNIT_INCOMPATIBLE'
  /** No interval has been selected yet. */
  | 'INTERVAL_NOT_SELECTED'
  /** The selected start/end are not finite numbers. */
  | 'INTERVAL_NOT_FINITE'
  /** The selected start is not strictly before the selected end. */
  | 'INTERVAL_ORDER'
  /** A boundary time has no observation (interpolating it is not allowed). */
  | 'INTERVAL_BOUNDARY_NOT_OBSERVED'
  /** The measured interval length differs from the recorded τ. */
  | 'INTERVAL_LENGTH_MISMATCH'
  /** Fewer than two usable observations inside the interval. */
  | 'INSUFFICIENT_OBSERVATIONS'
  /** Duplicate sampling times inside the interval. */
  | 'DUPLICATE_SAMPLING_TIMES'
  /** A measurement is not a valid finite non-negative pair. */
  | 'INVALID_MEASUREMENT'
  /** The integrated area is not a finite, positive number. */
  | 'NUMERICAL_FAILURE'

/** The validated interval, with the provenance needed to audit the area. */
export interface IntervalAucCoverage {
  readonly startTime: number
  readonly endTime: number
  readonly timeUnit: string
  /** 1-based source row of the observation at the selected start. */
  readonly startSourceRow: number
  /** 1-based source row of the observation at the selected end. */
  readonly endSourceRow: number
  /** End − start, in hours (the unit used for the τ comparison). */
  readonly observedDurationHours: number
  readonly declaredInterval: AdministrationQuantity
  /** τ, in hours. */
  readonly declaredIntervalHours: number
  readonly observationCount: number
  readonly observedTimes: readonly number[]
}

export type IntervalAucMetric =
  | {
      readonly status: 'available'
      readonly name: 'AUCτ'
      readonly value: number
      /** `concentrationUnit·timeUnit`, the interval's own units. */
      readonly unit: string
      readonly integrationMethod: NcaIntegrationMethod
      readonly method: string
      readonly contributingSourceRows: readonly number[]
      /** Per-segment breakdown (times, source rows, area, linear/log). */
      readonly segments: readonly NcaInterval[]
      readonly observationCount: number
      readonly notes: readonly string[]
    }
  | { readonly status: 'unavailable'; readonly code: IntervalAucUnavailableCode; readonly message: string }

export interface IntervalAucInput {
  readonly measurements: readonly ExperimentalMeasurement[]
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly administration: AdministrationMetadata | undefined
  /** The integration method currently selected on the NCA card. */
  readonly integrationMethod: NcaIntegrationMethod
  /** The terminal point count currently selected on the NCA card. */
  readonly terminalPointCount: number
  /** The analyst's selection, or null when nothing is selected yet. */
  readonly selection: IntervalAucSelection | null
  /**
   * The analyst's explicit statement that the selected interval begins at the
   * recorded administration time of the dose it describes. It is echoed into
   * the report as an analysis input; it is never written to the dataset, never
   * persisted, and never inferred from τ or from the curve.
   */
  readonly administrationAligned: boolean
}

export interface IntervalAucReport {
  readonly status: 'available' | 'unavailable'
  readonly route: AdministrationRoute | 'not-recorded'
  readonly regimen: AdministrationRegimen | 'not-recorded'
  readonly administrationRecorded: boolean
  readonly selection: IntervalAucSelection | null
  readonly administrationAligned: boolean
  readonly interval: IntervalAucCoverage | null
  readonly aucTau: IntervalAucMetric
  /**
   * NCA of the interval subset only. Its λ_z / terminal phase are the ONLY ones
   * valid for volume parameters in this interval; the whole-dataset λ_z is
   * never substituted.
   */
  readonly intervalNca: NcaAnalysis | null
  readonly lambdaZ: NcaMetric | null
  readonly halfLife: NcaMetric | null
  readonly terminalPhase: NcaTerminalPhase | null
  readonly integrationMethod: NcaIntegrationMethod
  readonly terminalPointCount: number
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly preconditions: readonly IntervalAucPrecondition[]
  readonly warnings: readonly string[]
  readonly summary: string
  readonly code?: IntervalAucUnavailableCode
  readonly message?: string
}

/**
 * Relative tolerance for the τ comparison. It exists only to absorb
 * binary64/unit-factor noise: at τ = 8 h it is ~3·10⁻⁸ s, far below any real
 * sampling difference. It is never used to accept a different interval.
 */
export const INTERVAL_LENGTH_RELATIVE_TOLERANCE = 1e-9

/** Exact shortest round-trip rendering for recorded values. */
const exact = (value: number): string => String(value)

function baseFactor(unit: string, dimension: 'time'): number | null {
  const def = unitCatalog.get(unit)
  if (def === undefined || def.dimension !== dimension) return null
  return def.toBase
}

function observedTimesOf(measurements: readonly ExperimentalMeasurement[]): readonly number[] {
  return [...new Set(measurements.map((measurement) => measurement.time))].sort((a, b) => a - b)
}

export function analyzeIntervalAuc(input: IntervalAucInput): IntervalAucReport {
  const { measurements, timeUnit, concentrationUnit, administration, selection } = input
  const preconditions: IntervalAucPrecondition[] = []
  const warnings: string[] = []

  const base = {
    route: administration?.route ?? ('not-recorded' as const),
    regimen: administration?.regimen ?? ('not-recorded' as const),
    administrationRecorded: administration !== undefined,
    selection,
    administrationAligned: input.administrationAligned,
    intervalNca: null,
    lambdaZ: null,
    halfLife: null,
    terminalPhase: null,
    integrationMethod: input.integrationMethod,
    terminalPointCount: input.terminalPointCount,
    timeUnit,
    concentrationUnit,
    warnings,
  }

  const refuse = (
    code: IntervalAucUnavailableCode,
    message: string,
  ): IntervalAucReport => ({
    ...base,
    status: 'unavailable',
    interval: null,
    aucTau: { status: 'unavailable', code, message },
    preconditions,
    summary: message,
    code,
    message,
  })

  // --- 1. A recorded regimen with a dosing interval ------------------------
  if (administration === undefined) {
    const message =
      'No administration metadata is recorded, so no dosing interval τ is known and no interval can be labelled AUCτ.'
    preconditions.push({ id: 'administration', status: 'not-met', message })
    return refuse('ADMINISTRATION_MISSING', message)
  }
  preconditions.push({
    id: 'administration',
    status: 'met',
    message: 'An administration record is present.',
  })

  if (administration.regimen === 'unknown') {
    const message =
      'The dosing regimen is recorded as unknown. An interval AUCτ requires a recorded repeated-dose regimen; repetition is never inferred from the sampling times.'
    preconditions.push({ id: 'regimen', status: 'not-met', message })
    return refuse('REGIMEN_UNKNOWN', message)
  }
  if (administration.regimen === 'single-dose') {
    const message =
      'The regimen is a single dose, so there is no dosing interval τ to integrate over. A single-dose curve must not be re-labelled as an interval AUCτ.'
    preconditions.push({ id: 'regimen', status: 'not-met', message })
    return refuse('REGIMEN_NOT_REPEATED', message)
  }
  preconditions.push({
    id: 'regimen',
    status: 'met',
    message:
      administration.regimen === 'repeated-dose-steady-state'
        ? 'Regimen is repeated dosing at steady state (as declared, not inferred).'
        : 'Regimen is repeated dosing (not at steady state).',
  })

  const tau = administration.dosingInterval
  if (tau === undefined) {
    const message =
      'No dosing interval τ is recorded, so the required length of the interval is unknown.'
    preconditions.push({ id: 'dosing-interval', status: 'not-met', message })
    return refuse('DOSING_INTERVAL_MISSING', message)
  }
  if (!Number.isFinite(tau.value) || tau.value <= 0) {
    const message = 'The recorded dosing interval τ must be a positive finite number.'
    preconditions.push({ id: 'dosing-interval', status: 'not-met', message })
    return refuse('DOSING_INTERVAL_NOT_POSITIVE', message)
  }
  const tauToH = baseFactor(tau.unit, 'time')
  if (tauToH === null) {
    const message = `The dosing interval unit "${tau.unit}" is not a time unit.`
    preconditions.push({ id: 'dosing-interval', status: 'not-met', message })
    return refuse('DOSING_INTERVAL_UNIT_INCOMPATIBLE', message)
  }
  const timeToH = baseFactor(timeUnit, 'time')
  if (timeToH === null) {
    const message = `The dataset time unit "${timeUnit}" is not a time unit, so the interval length cannot be compared with τ.`
    preconditions.push({ id: 'time-unit', status: 'not-met', message })
    return refuse('TIME_UNIT_INCOMPATIBLE', message)
  }
  const declaredIntervalHours = tau.value * tauToH
  preconditions.push({
    id: 'dosing-interval',
    status: 'met',
    message: `Dosing interval τ = ${exact(tau.value)} ${tau.unit} (${exact(declaredIntervalHours)} h).`,
  })

  // --- 2. The analyst's explicit selection --------------------------------
  if (selection === null) {
    const message =
      'No interval has been selected. AUCτ is defined by an explicitly selected interval with observed start and end times; a default is never applied.'
    preconditions.push({ id: 'interval-selection', status: 'not-met', message })
    return refuse('INTERVAL_NOT_SELECTED', message)
  }
  if (!Number.isFinite(selection.startTime) || !Number.isFinite(selection.endTime)) {
    const message = 'The selected interval start and end must be finite numbers.'
    preconditions.push({ id: 'interval-selection', status: 'not-met', message })
    return refuse('INTERVAL_NOT_FINITE', message)
  }
  if (!(selection.startTime < selection.endTime)) {
    const message = `The selected interval start (${exact(selection.startTime)} ${timeUnit}) must be earlier than its end (${exact(selection.endTime)} ${timeUnit}).`
    preconditions.push({ id: 'interval-selection', status: 'not-met', message })
    return refuse('INTERVAL_ORDER', message)
  }
  preconditions.push({
    id: 'interval-selection',
    status: 'met',
    message: `Selected interval ${exact(selection.startTime)} → ${exact(selection.endTime)} ${timeUnit}.`,
  })

  // --- 3. Observations, boundaries and interval length --------------------
  const invalid = measurements.filter(
    (measurement) =>
      typeof measurement.time !== 'number' ||
      typeof measurement.concentration !== 'number' ||
      !Number.isFinite(measurement.time) ||
      !Number.isFinite(measurement.concentration) ||
      measurement.time < 0 ||
      measurement.concentration < 0,
  )
  if (invalid.length > 0) {
    const message = `Some measurements are invalid and cannot be integrated: row(s) ${invalid
      .map((measurement) => measurement.sourceRow)
      .join(', ')}.`
    preconditions.push({ id: 'measurements', status: 'not-met', message })
    return refuse('INVALID_MEASUREMENT', message)
  }

  const sorted = [...measurements].sort((a, b) => a.time - b.time)
  const startObservation = sorted.find((measurement) => measurement.time === selection.startTime)
  const endObservation = sorted.find((measurement) => measurement.time === selection.endTime)
  if (startObservation === undefined || endObservation === undefined) {
    const missing = [
      startObservation === undefined ? `start ${exact(selection.startTime)} ${timeUnit}` : null,
      endObservation === undefined ? `end ${exact(selection.endTime)} ${timeUnit}` : null,
    ]
      .filter((entry): entry is string => entry !== null)
      .join(' and ')
    const message = `No observation exists at the selected ${missing}. Interpolating, extrapolating or zero-filling a boundary is not permitted, so the interval cannot be integrated.`
    preconditions.push({ id: 'interval-boundaries', status: 'not-met', message })
    return refuse('INTERVAL_BOUNDARY_NOT_OBSERVED', message)
  }
  preconditions.push({
    id: 'interval-boundaries',
    status: 'met',
    message: `Observed boundaries: source rows ${startObservation.sourceRow} (${exact(selection.startTime)} ${timeUnit}) and ${endObservation.sourceRow} (${exact(selection.endTime)} ${timeUnit}).`,
  })

  const observedDurationHours = (selection.endTime - selection.startTime) * timeToH
  const tolerance = Math.max(1e-12, INTERVAL_LENGTH_RELATIVE_TOLERANCE * declaredIntervalHours)
  if (Math.abs(observedDurationHours - declaredIntervalHours) > tolerance) {
    const message = `The selected interval is ${exact(observedDurationHours)} h long, but the recorded dosing interval τ is ${exact(declaredIntervalHours)} h. An interval that is not one τ wide is not an AUCτ.`
    preconditions.push({ id: 'interval-length', status: 'not-met', message })
    return refuse('INTERVAL_LENGTH_MISMATCH', message)
  }
  preconditions.push({
    id: 'interval-length',
    status: 'met',
    message: `The selected interval is one τ wide (${exact(observedDurationHours)} h ≈ τ = ${exact(declaredIntervalHours)} h).`,
  })

  const inside = sorted.filter(
    (measurement) =>
      measurement.time >= selection.startTime && measurement.time <= selection.endTime,
  )
  const insideTimes = inside.map((measurement) => measurement.time)
  const duplicate = insideTimes.find((time, index) => index > 0 && time === insideTimes[index - 1])
  if (duplicate !== undefined) {
    const message = `Sampling time ${exact(duplicate)} ${timeUnit} occurs more than once inside the selected interval. The existing NCA rule applies: observations are never averaged, so the interval area is unavailable until the duplicate is resolved.`
    preconditions.push({ id: 'interval-observations', status: 'not-met', message })
    return refuse('DUPLICATE_SAMPLING_TIMES', message)
  }
  if (inside.length < 2) {
    const message =
      'The selected interval contains fewer than two observations, so no trapezoid can be formed.'
    preconditions.push({ id: 'interval-observations', status: 'not-met', message })
    return refuse('INSUFFICIENT_OBSERVATIONS', message)
  }
  preconditions.push({
    id: 'interval-observations',
    status: 'met',
    message: `${inside.length} observation(s) lie inside the interval, including both boundaries.`,
  })

  // --- 4. The area, through the existing trapezoidal implementation -------
  const points = inside.map((measurement) => ({
    time: measurement.time,
    concentration: measurement.concentration,
    sourceRow: measurement.sourceRow,
  }))
  const area = trapezoidalArea(points, input.integrationMethod)
  if (area === null || !Number.isFinite(area.value) || area.value <= 0) {
    const message =
      'The trapezoidal area over the selected interval is not a positive finite number, so no AUCτ is reported.'
    preconditions.push({ id: 'interval-area', status: 'not-met', message })
    return refuse('NUMERICAL_FAILURE', message)
  }

  const notes: string[] = [
    'AUCτ is the observed area between two sampled boundary times; no value is interpolated, extrapolated or zero-filled.',
  ]
  if (input.integrationMethod === 'linear-up-log-down' && area.fellBackToLinear) {
    notes.push(
      'At least one decreasing segment used the linear trapezoid because its logarithmic form was undefined (zero or equal concentrations).',
    )
  }
  if (inside.length === 2) {
    notes.push('The interval contains only its two boundary observations, so the area is a single trapezoid.')
  }

  const aucTau: IntervalAucMetric = {
    status: 'available',
    name: 'AUCτ',
    value: area.value,
    unit: `${concentrationUnit}·${timeUnit}`,
    integrationMethod: input.integrationMethod,
    method:
      input.integrationMethod === 'linear'
        ? 'linear trapezoidal (observed intervals only)'
        : 'linear-up/log-down trapezoidal (observed intervals only)',
    contributingSourceRows: points.map((point) => point.sourceRow),
    segments: area.intervals,
    observationCount: inside.length,
    notes,
  }
  preconditions.push({
    id: 'interval-area',
    status: 'met',
    message: `AUCτ = ${exact(area.value)} ${aucTau.unit} over ${area.intervals.length} trapezoid segment(s).`,
  })

  // --- 5. λ_z from THIS interval only -------------------------------------
  const intervalNca = analyzeNca(inside, timeUnit, concentrationUnit, {
    integrationMethod: input.integrationMethod,
    terminalPointCount: input.terminalPointCount,
  })
  if (!intervalNca.ok) {
    warnings.push(
      `The selected interval could not be analysed for a terminal phase (${intervalNca.code}): ${intervalNca.message} Volume parameters will be unavailable for this interval.`,
    )
    preconditions.push({
      id: 'interval-lambda-z',
      status: 'not-met',
      message:
        'The terminal phase of the selected interval is unavailable, so no interval-specific λ_z exists (clearance does not require it).',
    })
    return {
      ...base,
      status: 'available',
      interval: {
        startTime: selection.startTime,
        endTime: selection.endTime,
        timeUnit,
        startSourceRow: startObservation.sourceRow,
        endSourceRow: endObservation.sourceRow,
        observedDurationHours,
        declaredInterval: tau,
        declaredIntervalHours,
        observationCount: inside.length,
        observedTimes: insideTimes,
      },
      aucTau,
      preconditions,
      summary: `AUCτ over the selected interval ${exact(selection.startTime)} → ${exact(selection.endTime)} ${timeUnit}.`,
    }
  }

  if (intervalNca.lambdaZ.status === 'available') {
    preconditions.push({
      id: 'interval-lambda-z',
      status: 'met',
      message: `λ_z from the selected interval only: ${exact(intervalNca.lambdaZ.value)} ${intervalNca.lambdaZ.unit} over source rows ${intervalNca.terminalPhase.selectedSourceRows.join(', ')}.`,
    })
  } else {
    preconditions.push({
      id: 'interval-lambda-z',
      status: 'not-met',
      message: `The selected interval has no usable terminal λ_z (${intervalNca.lambdaZ.code}), so volume parameters are unavailable for this interval; clearance does not require it.`,
    })
  }
  warnings.push(...intervalNca.warnings)

  return {
    ...base,
    status: 'available',
    interval: {
      startTime: selection.startTime,
      endTime: selection.endTime,
      timeUnit,
      startSourceRow: startObservation.sourceRow,
      endSourceRow: endObservation.sourceRow,
      observedDurationHours,
      declaredInterval: tau,
      declaredIntervalHours,
      observationCount: inside.length,
      observedTimes: insideTimes,
    },
    aucTau,
    intervalNca,
    lambdaZ: intervalNca.lambdaZ,
    halfLife: intervalNca.halfLife,
    terminalPhase: intervalNca.terminalPhase,
    preconditions,
    summary: `AUCτ over the selected interval ${exact(selection.startTime)} → ${exact(selection.endTime)} ${timeUnit} (τ = ${exact(tau.value)} ${tau.unit}).`,
  }
}

/**
 * Observed sampling times in ascending order, for building an interval
 * selector. Returned values are the dataset's own stored times — nothing is
 * rounded, resampled or generated.
 */
export function observedTimeChoices(
  measurements: readonly ExperimentalMeasurement[],
): readonly number[] {
  return observedTimesOf(measurements)
}
