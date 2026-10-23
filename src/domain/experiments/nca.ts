/**
 * Noncompartmental analysis (NCA) of a concentration–time dataset.
 *
 * This module implements the standard, textbook NCA definitions — linear and
 * linear-up/log-down trapezoidal integration, observed Cmax/Tmax, and
 * log-linear regression of the terminal phase — INDEPENDENTLY, from the
 * authoritative published definitions (Gabrielsson & Weiner, Rowland & Tozer,
 * and regulatory NCA guidance). No source code is copied from any NCA package;
 * see THIRD_PARTY_NOTICES.md for the reuse decision and attribution.
 *
 * Scientific-integrity rules:
 * - The caller's measurements are read, never mutated, sorted in place or
 *   averaged. Analysis order is a sort of a COPY; every result carries the
 *   1-based `sourceRow` values it was derived from.
 * - Nothing is silently discarded. Observations that cannot contribute to a
 *   given metric (non-positive concentrations in log integration or terminal
 *   regression) are reported as excluded, with the reason, not deleted.
 * - No concentration at time zero is invented: if the first observation is
 *   after time zero, the computed area is named for the interval it actually
 *   covers and is never labelled `AUC0-last`.
 * - Invalid metrics are returned as `unavailable` with a structured reason,
 *   never as zero, NaN, an arbitrary estimate or a fabricated half-life.
 * - Derived results are ephemeral and are never persisted here.
 *
 * Pure domain module: no React, no Plotly, no storage.
 */
import type { ExperimentalMeasurement } from './experimental-dataset'

/** Trapezoidal methods for area under the curve. */
export type NcaIntegrationMethod = 'linear' | 'linear-up-log-down'

/** Analysis settings the user can inspect and change. */
export interface NcaAnalysisOptions {
  readonly integrationMethod: NcaIntegrationMethod
  /**
   * Number of trailing positive observations used for the terminal log-linear
   * regression. Default 3 (a widely used convention); minimum 2.
   */
  readonly terminalPointCount: number
}

export const DEFAULT_TERMINAL_POINT_COUNT = 3
export const MIN_TERMINAL_POINT_COUNT = 2

/** How a value was obtained. */
export type NcaMetricKind = 'observed' | 'calculated' | 'extrapolated'

export type NcaUnavailableCode =
  /** Fewer observations than the metric needs. */
  | 'INSUFFICIENT_OBSERVATIONS'
  /** More than one observation shares a sampling time; AUC needs a policy. */
  | 'DUPLICATE_SAMPLING_TIMES'
  /** No strictly positive concentration is available where one is required. */
  | 'NO_POSITIVE_CONCENTRATION'
  /** The terminal slope is not negative, so no decay is described. */
  | 'NON_POSITIVE_TERMINAL_SLOPE'
  /** Too few positive observations for the terminal regression. */
  | 'INSUFFICIENT_TERMINAL_POINTS'
  /** The last observation is not positive, so extrapolation is not defined. */
  | 'TERMINAL_TAIL_NOT_POSITIVE'
  /** A measurement is not a valid finite non-negative pair. */
  | 'INVALID_MEASUREMENT'

export interface NcaMetricAvailable {
  readonly status: 'available'
  readonly value: number
  readonly unit: string
  readonly kind: NcaMetricKind
  /** Human-readable parameter name, e.g. "AUC(0→last)". */
  readonly name?: string
  /** Named integration or regression method, when applicable. */
  readonly method?: string
  /** 1-based source rows this value was derived from. */
  readonly contributingSourceRows: readonly number[]
  /** Extra notes (e.g. tied maximum, interval naming). */
  readonly notes?: readonly string[]
}

export interface NcaMetricUnavailable {
  readonly status: 'unavailable'
  readonly code: NcaUnavailableCode
  readonly message: string
}

export type NcaMetric = NcaMetricAvailable | NcaMetricUnavailable

/** Diagnostics of the terminal log-linear regression. */
export interface NcaTerminalRegression {
  /** slope of ln(C) against time (should be negative). */
  readonly slope: number
  readonly intercept: number
  /** Elimination rate constant λ_z = −slope, in reciprocal time units. */
  readonly lambdaZ: number
  /** ln(2)/λ_z. */
  readonly halfLife: number
  /** Coefficient of determination of the log-linear fit, in [0, 1]. */
  readonly rSquared: number
  readonly observationCount: number
  /** Fitted concentrations at the selected times (for inspection). */
  readonly fittedConcentrations: readonly number[]
}

export interface NcaTerminalPhase {
  readonly status: 'available' | 'unavailable'
  /** 1-based source rows selected for the regression (trailing positive observations). */
  readonly selectedSourceRows: readonly number[]
  readonly selectedTimes: readonly number[]
  /** Number of positive observations eligible for terminal selection. */
  readonly eligiblePositiveCount: number
  /** Present when a regression could be fitted, even if λ_z is unusable. */
  readonly regression: NcaTerminalRegression | null
  readonly code?: NcaUnavailableCode
  readonly message?: string
}

export interface NcaAnalysis {
  readonly ok: true
  readonly cmax: NcaMetric
  readonly tmax: NcaMetric
  /** Area under the observed curve; named AUC(0→last) only when it starts at 0. */
  readonly aucLast: NcaMetric
  /**
   * Extrapolated AUC to infinity (when the terminal phase supports it): named
   * AUC(0→∞) when the dataset starts at time zero, or AUC(first→∞) when the
   * first observation is after time zero (the interval before it is excluded).
   */
  readonly aucInf: NcaMetric
  /** (AUC∞ − AUClast) / AUC∞, as a fraction (0–1). */
  readonly extrapolatedFraction: NcaMetric
  readonly lambdaZ: NcaMetric
  readonly halfLife: NcaMetric
  readonly terminalPhase: NcaTerminalPhase
  readonly warnings: readonly string[]
}

export type NcaReport =
  | NcaAnalysis
  | { readonly ok: false; readonly code: NcaUnavailableCode; readonly message: string }

/** One sorted observation, tied back to its source row. */
interface SortedObservation {
  readonly time: number
  readonly concentration: number
  readonly sourceRow: number
}

const unavailable = (code: NcaUnavailableCode, message: string): NcaMetricUnavailable => ({
  status: 'unavailable',
  code,
  message,
})

const available = (input: {
  value: number
  unit: string
  kind: NcaMetricKind
  name?: string
  contributingSourceRows: readonly number[]
  method?: string
  notes?: readonly string[]
}): NcaMetricAvailable => ({
  status: 'available',
  value: input.value,
  unit: input.unit,
  kind: input.kind,
  ...(input.name === undefined ? {} : { name: input.name }),
  ...(input.method === undefined ? {} : { method: input.method }),
  contributingSourceRows: input.contributingSourceRows,
  ...(input.notes === undefined ? {} : { notes: input.notes }),
})

// ---------------------------------------------------------------------------
// Trapezoidal integration
// ---------------------------------------------------------------------------

/** Linear trapezoid over one interval. */
export function linearTrapezoid(t1: number, c1: number, t2: number, c2: number): number {
  return ((c1 + c2) / 2) * (t2 - t1)
}

/**
 * Logarithmic trapezoid over one interval.
 *
 *   AUC = (C1 − C2) · (t2 − t1) / ln(C1/C2)
 *
 * Returns `null` when it is not defined: either concentration must be ≤ 0, or
 * the concentrations are equal (the limit of the formula). A null is a signal
 * for the caller to fall back to the linear trapezoid — never a value.
 */
export function logTrapezoid(t1: number, c1: number, t2: number, c2: number): number | null {
  if (!(c1 > 0) || !(c2 > 0)) return null
  if (c1 === c2) return null
  return ((c1 - c2) / Math.log(c1 / c2)) * (t2 - t1)
}

/**
 * Linear-up / log-down trapezoid over one interval.
 *
 * Increasing interval (C2 > C1): linear trapezoid. Decreasing interval
 * (C2 < C1): logarithmic trapezoid. Equal concentrations: linear (the log
 * formula is undefined at C1 = C2). A logarithmic trapezoid with a zero or
 * negative endpoint falls back to the linear trapezoid, and the fallback is
 * reported by the caller as a note — the measurement is never dropped.
 */
export function linearUpLogDownTrapezoid(
  t1: number,
  c1: number,
  t2: number,
  c2: number,
): { readonly area: number; readonly method: 'linear' | 'log'; readonly fellBackToLinear: boolean } {
  if (c2 > c1) {
    return { area: linearTrapezoid(t1, c1, t2, c2), method: 'linear', fellBackToLinear: false }
  }
  const logarithmic = logTrapezoid(t1, c1, t2, c2)
  if (logarithmic !== null) {
    return { area: logarithmic, method: 'log', fellBackToLinear: false }
  }
  return { area: linearTrapezoid(t1, c1, t2, c2), method: 'linear', fellBackToLinear: true }
}

/** A single trapezoidal interval and how it was integrated. */
export interface NcaInterval {
  readonly fromTime: number
  readonly toTime: number
  readonly fromConcentration: number
  readonly toConcentration: number
  readonly fromSourceRow: number
  readonly toSourceRow: number
  readonly area: number
  readonly method: 'linear' | 'log'
}

/**
 * Trapezoidal area over consecutive sorted points.
 *
 * `points` must be sorted by ascending time with no duplicate times. Returns
 * the total area, the contributing source rows, and the per-interval breakdown
 * (including any linear fallbacks for a log-down method).
 */
export function trapezoidalArea(
  points: readonly SortedObservation[],
  method: NcaIntegrationMethod,
): { readonly value: number; readonly intervals: readonly NcaInterval[]; readonly fellBackToLinear: boolean } | null {
  if (points.length < 2) return null
  const intervals: NcaInterval[] = []
  let value = 0
  let fellBackToLinear = false
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1] as SortedObservation
    const current = points[index] as SortedObservation
    let area: number
    let intervalMethod: 'linear' | 'log'
    if (method === 'linear') {
      area = linearTrapezoid(previous.time, previous.concentration, current.time, current.concentration)
      intervalMethod = 'linear'
    } else {
      const step = linearUpLogDownTrapezoid(
        previous.time,
        previous.concentration,
        current.time,
        current.concentration,
      )
      area = step.area
      intervalMethod = step.method
      if (step.fellBackToLinear) fellBackToLinear = true
    }
    if (!Number.isFinite(area)) return null
    value += area
    intervals.push({
      fromTime: previous.time,
      toTime: current.time,
      fromConcentration: previous.concentration,
      toConcentration: current.concentration,
      fromSourceRow: previous.sourceRow,
      toSourceRow: current.sourceRow,
      area,
      method: intervalMethod,
    })
  }
  return { value, intervals, fellBackToLinear }
}

// ---------------------------------------------------------------------------
// Log-linear regression
// ---------------------------------------------------------------------------

/**
 * Least-squares regression of ln(concentration) against time.
 *
 * Returns null when fewer than two points are supplied or the times are not
 * distinct enough to determine a slope. `slope` is the regression slope
 * (−λ_z for a decaying phase); `rSquared` is the coefficient of determination
 * of the log-transformed fit, in [0, 1].
 */
export function logLinearRegression(
  points: readonly SortedObservation[],
): NcaTerminalRegression | null {
  const n = points.length
  if (n < 2) return null
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumXY = 0
  let sumYY = 0
  for (const point of points) {
    if (!(point.concentration > 0) || !Number.isFinite(point.concentration)) return null
    const y = Math.log(point.concentration)
    sumX += point.time
    sumY += y
    sumXX += point.time * point.time
    sumXY += point.time * y
    sumYY += y * y
  }
  const denominator = n * sumXX - sumX * sumX
  if (!(denominator > 0) || !Number.isFinite(denominator)) return null
  const slope = (n * sumXY - sumX * sumY) / denominator
  const intercept = (sumY - slope * sumX) / n
  const meanY = sumY / n
  const ssTotal = sumYY - n * meanY * meanY
  const residuals = points.map((point) => {
    const fitted = intercept + slope * point.time
    return Math.log(point.concentration) - fitted
  })
  const ssResidual = residuals.reduce((total, residual) => total + residual * residual, 0)
  const rSquared = ssTotal > 0 ? Math.min(1, Math.max(0, 1 - ssResidual / ssTotal)) : 1

  const lambdaZ = -slope
  if (!Number.isFinite(slope) || !Number.isFinite(intercept) || !Number.isFinite(rSquared)) {
    return null
  }
  const halfLife = lambdaZ > 0 ? Math.LN2 / lambdaZ : Number.NaN
  const fittedConcentrations = points.map((point) => Math.exp(intercept + slope * point.time))

  return {
    slope,
    intercept,
    lambdaZ,
    halfLife: Number.isFinite(halfLife) ? halfLife : Number.NaN,
    rSquared,
    observationCount: n,
    fittedConcentrations,
  }
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

function invalidMeasurements(
  measurements: readonly ExperimentalMeasurement[],
): readonly { sourceRow: number; reason: string }[] | null {
  const invalid: { sourceRow: number; reason: string }[] = []
  for (const measurement of measurements) {
    if (
      measurement === null ||
      typeof measurement !== 'object' ||
      typeof measurement.time !== 'number' ||
      typeof measurement.concentration !== 'number' ||
      !Number.isFinite(measurement.time) ||
      !Number.isFinite(measurement.concentration) ||
      measurement.time < 0 ||
      measurement.concentration < 0
    ) {
      invalid.push({ sourceRow: measurement?.sourceRow ?? 0, reason: 'non-finite or negative time/concentration' })
    }
  }
  return invalid.length === 0 ? null : invalid
}

function duplicateTimes(sorted: readonly SortedObservation[]): readonly number[] {
  const times: number[] = []
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1] as SortedObservation).time === (sorted[index] as SortedObservation).time) {
      if (times[times.length - 1] !== (sorted[index] as SortedObservation).time) {
        times.push((sorted[index] as SortedObservation).time)
      }
    }
  }
  return times
}

/**
 * Run noncompartmental analysis over a concentration–time dataset.
 *
 * `measurements` are read only; the analysis sorts a copy and never mutates or
 * averages the input. `timeUnit` and `concentrationUnit` label the outputs; no
 * unit conversion is performed because every observation already shares the
 * dataset's declared units.
 */
export function analyzeNca(
  measurements: readonly ExperimentalMeasurement[],
  timeUnit: string,
  concentrationUnit: string,
  options: NcaAnalysisOptions,
): NcaReport {
  const warnings: string[] = []
  const aucUnit = `${concentrationUnit}·${timeUnit}`
  const rateUnit = `${timeUnit}⁻¹`

  if (options.terminalPointCount < MIN_TERMINAL_POINT_COUNT || !Number.isInteger(options.terminalPointCount)) {
    return {
      ok: false,
      code: 'INSUFFICIENT_TERMINAL_POINTS',
      message: `The terminal phase needs at least ${MIN_TERMINAL_POINT_COUNT} points.`,
    }
  }

  const invalid = invalidMeasurements(measurements)
  if (invalid !== null) {
    return {
      ok: false,
      code: 'INVALID_MEASUREMENT',
      message: `Some measurements are invalid and cannot be analysed: ${invalid
        .map((entry) => `row ${entry.sourceRow} (${entry.reason})`)
        .join(', ')}.`,
    }
  }
  if (measurements.length === 0) {
    return { ok: false, code: 'INSUFFICIENT_OBSERVATIONS', message: 'There are no measurements to analyse.' }
  }

  // Sort a copy by time (stable order for equal times is irrelevant: equal
  // times are reported as duplicates below).
  const sorted: SortedObservation[] = measurements
    .map((measurement) => ({
      time: measurement.time,
      concentration: measurement.concentration,
      sourceRow: measurement.sourceRow,
    }))
    .sort((a, b) => a.time - b.time)

  // Whether the curve starts at time zero determines the interval every area
  // metric actually covers: [0, …] versus [first time, …]. There is always at
  // least one observation here (empty input returned above).
  const startsAtZero = (sorted[0] as SortedObservation).time === 0

  // --- Cmax / Tmax (computed over every observation) -----------------------
  let cmax = Number.NEGATIVE_INFINITY
  for (const point of sorted) {
    if (point.concentration > cmax) cmax = point.concentration
  }
  const maxSourceRows = sorted
    .filter((point) => point.concentration === cmax)
    .map((point) => point.sourceRow)
  const maxTimes = [...new Set(sorted.filter((point) => point.concentration === cmax).map((point) => point.time))]
  const tmaxValue = maxTimes.length > 0 ? Math.min(...maxTimes) : Number.NaN
  // Tmax provenance is the observation(s) at the earliest time attaining the
  // maximum; Cmax provenance is every row attaining the maximum.
  const tmaxSourceRows = sorted
    .filter((point) => point.concentration === cmax && point.time === tmaxValue)
    .map((point) => point.sourceRow)
  const cmaxMetric = available({
    value: cmax,
    unit: concentrationUnit,
    kind: 'observed',
    contributingSourceRows: maxSourceRows,
  })
  const tmaxNotes: string[] = []
  if (maxTimes.length > 1) {
    tmaxNotes.push('The maximum concentration occurs at more than one sampling time; the earliest time is reported.')
    warnings.push('Cmax is tied across multiple sampling times; Tmax reports the earliest time attaining the maximum.')
  }
  const tmaxMetric = Number.isFinite(tmaxValue)
    ? available({
        value: tmaxValue,
        unit: timeUnit,
        kind: 'observed',
        contributingSourceRows: tmaxSourceRows,
        ...(tmaxNotes.length === 0 ? {} : { notes: tmaxNotes }),
      })
    : unavailable('INSUFFICIENT_OBSERVATIONS', 'Tmax could not be determined.')

  // --- Duplicates ----------------------------------------------------------
  const duplicates = duplicateTimes(sorted)
  const hasDuplicates = duplicates.length > 0
  if (hasDuplicates) {
    warnings.push(
      `Duplicate sampling times were found (${duplicates.map((time) => `${time} ${timeUnit}`).join(', ')}). AUC and terminal-phase metrics are unavailable until each sampling time has a single observation; observations are never averaged.`,
    )
  }

  // --- AUC (trapezoidal) ----------------------------------------------------
  let aucLast: NcaMetric
  let aucLastValue: number | null = null
  if (hasDuplicates || sorted.length < 2) {
    aucLast = unavailable(
      hasDuplicates ? 'DUPLICATE_SAMPLING_TIMES' : 'INSUFFICIENT_OBSERVATIONS',
      hasDuplicates
        ? 'Duplicate sampling times must be resolved before AUC can be integrated.'
        : 'At least two distinct sampling times are required for AUC.',
    )
  } else {
    const area = trapezoidalArea(sorted, options.integrationMethod)
    if (area === null) {
      aucLast = unavailable('INSUFFICIENT_OBSERVATIONS', 'AUC could not be integrated.')
    } else {
      aucLastValue = area.value
      const aucNotes: string[] = []
      if (!startsAtZero) {
        aucNotes.push(
          'The first observation is after time zero, so this is the area over the observed interval, not AUC0-last; no concentration at time zero was invented.',
        )
        warnings.push(
          'The dataset does not start at time zero; the reported area covers the observed interval only and is not labelled AUC0-last.',
        )
      }
      if (options.integrationMethod === 'linear-up-log-down' && area.fellBackToLinear) {
        aucNotes.push('At least one decreasing interval used the linear trapezoid because its logarithmic form was undefined (zero or equal concentrations).')
      }
      aucLast = available({
        value: area.value,
        unit: aucUnit,
        kind: 'calculated',
        name: startsAtZero ? 'AUC(0→last)' : 'AUC(first→last)',
        method: options.integrationMethod === 'linear' ? 'linear trapezoidal' : 'linear-up/log-down trapezoidal',
        contributingSourceRows: sorted.map((point) => point.sourceRow),
        ...(aucNotes.length === 0 ? {} : { notes: aucNotes }),
      })
    }
  }

  // --- Terminal phase -------------------------------------------------------
  const positiveSorted = sorted.filter((point) => point.concentration > 0)
  const eligiblePositiveCount = positiveSorted.length
  let terminalPhase: NcaTerminalPhase
  let lambdaZMetric: NcaMetric
  let halfLifeMetric: NcaMetric
  let regression: NcaTerminalRegression | null = null

  if (hasDuplicates) {
    terminalPhase = {
      status: 'unavailable',
      selectedSourceRows: [],
      selectedTimes: [],
      eligiblePositiveCount,
      regression: null,
      code: 'DUPLICATE_SAMPLING_TIMES',
      message: 'Duplicate sampling times must be resolved before the terminal phase can be selected.',
    }
    lambdaZMetric = unavailable('DUPLICATE_SAMPLING_TIMES', terminalPhase.message as string)
    halfLifeMetric = unavailable('DUPLICATE_SAMPLING_TIMES', terminalPhase.message as string)
  } else if (eligiblePositiveCount < options.terminalPointCount) {
    terminalPhase = {
      status: 'unavailable',
      selectedSourceRows: [],
      selectedTimes: [],
      eligiblePositiveCount,
      regression: null,
      code: 'INSUFFICIENT_TERMINAL_POINTS',
      message: `Only ${eligiblePositiveCount} positive observations are available; at least ${options.terminalPointCount} are required for the terminal regression.`,
    }
    lambdaZMetric = unavailable('INSUFFICIENT_TERMINAL_POINTS', terminalPhase.message as string)
    halfLifeMetric = unavailable('INSUFFICIENT_TERMINAL_POINTS', terminalPhase.message as string)
  } else {
    const selected = positiveSorted.slice(positiveSorted.length - options.terminalPointCount)
    regression = logLinearRegression(selected)
    const selectedSourceRows = selected.map((point) => point.sourceRow)
    const selectedTimes = selected.map((point) => point.time)
    const trailingNonPositive = sorted.filter((point) => point.concentration <= 0 && point.time > (selected[0] as SortedObservation).time)
    if (trailingNonPositive.length > 0) {
      warnings.push(
        `${trailingNonPositive.length} observation(s) with non-positive concentration follow the terminal phase and are excluded from the log-linear regression.`,
      )
    }
    if (regression === null) {
      terminalPhase = {
        status: 'unavailable',
        selectedSourceRows,
        selectedTimes,
        eligiblePositiveCount,
        regression: null,
        code: 'INSUFFICIENT_TERMINAL_POINTS',
        message: 'The terminal regression could not be fitted.',
      }
      lambdaZMetric = unavailable('INSUFFICIENT_TERMINAL_POINTS', 'The terminal regression could not be fitted.')
      halfLifeMetric = unavailable('INSUFFICIENT_TERMINAL_POINTS', 'The terminal regression could not be fitted.')
    } else {
      if (regression.lambdaZ <= 0) {
        terminalPhase = {
          status: 'unavailable',
          selectedSourceRows,
          selectedTimes,
          eligiblePositiveCount,
          regression,
          code: 'NON_POSITIVE_TERMINAL_SLOPE',
          message: 'The selected terminal points do not decline (the log-linear slope is not negative), so no elimination rate can be estimated.',
        }
        lambdaZMetric = unavailable('NON_POSITIVE_TERMINAL_SLOPE', terminalPhase.message as string)
        halfLifeMetric = unavailable('NON_POSITIVE_TERMINAL_SLOPE', terminalPhase.message as string)
      } else {
        terminalPhase = { status: 'available', selectedSourceRows, selectedTimes, eligiblePositiveCount, regression }
        lambdaZMetric = available({
          value: regression.lambdaZ,
          unit: rateUnit,
          kind: 'calculated',
          method: 'log-linear regression of the terminal phase',
          contributingSourceRows: selectedSourceRows,
        })
        halfLifeMetric = available({
          value: regression.halfLife,
          unit: timeUnit,
          kind: 'calculated',
          method: 'ln(2)/λ_z',
          contributingSourceRows: selectedSourceRows,
        })
        if (regression.rSquared < 0.8) {
          warnings.push(
            'The terminal regression explains less than 80% of the log-concentration variance (R² < 0.8); this is a quality screen, not a proof that the terminal phase is invalid.',
          )
        }
      }
    }
  }

  // --- Extrapolated AUC ------------------------------------------------------
  let aucInf: NcaMetric
  let extrapolatedFraction: NcaMetric
  const terminalOk = terminalPhase.status === 'available' && regression !== null && regression.lambdaZ > 0
  if (!terminalOk || aucLastValue === null) {
    aucInf = unavailable(
      terminalPhase.code ?? 'INSUFFICIENT_TERMINAL_POINTS',
      'AUC extrapolated to infinity requires a usable terminal phase and an integrated observed curve.',
    )
    extrapolatedFraction = unavailable(
      terminalPhase.code ?? 'INSUFFICIENT_TERMINAL_POINTS',
      'The extrapolated fraction requires an extrapolated AUC.',
    )
  } else {
    // terminalOk implies regression !== null and aucLastValue !== null, but
    // TypeScript cannot follow the boolean, so narrow explicitly.
    if (regression === null || aucLastValue === null) {
      aucInf = unavailable('INSUFFICIENT_TERMINAL_POINTS', 'The extrapolated AUC could not be computed.')
      extrapolatedFraction = unavailable('INSUFFICIENT_TERMINAL_POINTS', 'The extrapolated fraction could not be computed.')
    } else {
      // Extrapolation is anchored at the last observation only when it is the
      // terminal phase's end (i.e. positive). Otherwise the area between the
      // terminal end and a trailing zero cannot be apportioned cleanly.
      const lastPoint = sorted[sorted.length - 1] as SortedObservation
      if (lastPoint.concentration <= 0) {
        aucInf = unavailable(
          'TERMINAL_TAIL_NOT_POSITIVE',
          'The last observation is not positive, so the observed area cannot be consistently extrapolated from the terminal phase; resolve the trailing observations first.',
        )
        extrapolatedFraction = unavailable('TERMINAL_TAIL_NOT_POSITIVE', 'The extrapolated fraction requires an extrapolated AUC.')
      } else {
        const extrapolatedArea = lastPoint.concentration / regression.lambdaZ
        const aucInfValue = aucLastValue + extrapolatedArea
        const fraction = extrapolatedArea / aucInfValue
        if (startsAtZero) {
          aucInf = available({
            value: aucInfValue,
            unit: aucUnit,
            kind: 'extrapolated',
            name: 'AUC(0→∞)',
            method: 'AUC(last) + C_last/λ_z',
            contributingSourceRows: sorted.map((point) => point.sourceRow),
          })
          extrapolatedFraction = available({
            value: fraction,
            unit: 'fraction',
            kind: 'calculated',
            method: '(AUC(0→∞) − AUC(0→last)) / AUC(0→∞)',
            contributingSourceRows: sorted.map((point) => point.sourceRow),
          })
          if (fraction > 0.2) {
            warnings.push(
              'More than 20% of the extrapolated AUC is outside the observed interval; this is a quality criterion from regulatory NCA guidance, not proof that the estimate is invalid.',
            )
          }
        } else {
          // The observed area already excludes the interval before the first
          // observation, so the derived result is over [first time, ∞), not
          // [0, ∞). Name it, describe its formula, and never present the
          // conventional complete-curve criterion as interchangeable.
          aucInf = available({
            value: aucInfValue,
            unit: aucUnit,
            kind: 'extrapolated',
            name: 'AUC(first→∞)',
            method: 'AUC(first→last) + C_last/λ_z',
            contributingSourceRows: sorted.map((point) => point.sourceRow),
            notes: [
              'The interval before the first observation is not included, so this is a partial-interval estimate, not AUC(0→∞); no concentration at time zero was invented.',
            ],
          })
          extrapolatedFraction = available({
            value: fraction,
            unit: 'fraction',
            kind: 'calculated',
            method: '(AUC(first→∞) − AUC(first→last)) / AUC(first→∞)',
            contributingSourceRows: sorted.map((point) => point.sourceRow),
            notes: [
              'Fraction of the partial-interval AUC(first→∞) attributable to the extrapolated tail beyond the last observation.',
            ],
          })
          warnings.push(
            'The dataset does not start at time zero, so the extrapolated result is AUC(first→∞): the interval before the first observation is excluded, and it is not directly interchangeable with a complete AUC(0→∞).',
          )
          if (fraction > 0.2) {
            warnings.push(
              'More than 20% of the partial-interval area is attributable to the extrapolated tail. The conventional ≤20% extrapolation criterion applies to a complete AUC(0→∞) and is not directly interchangeable with the partial AUC(first→∞) reported here.',
            )
          }
        }
      }
    }
  }

  return {
    ok: true,
    cmax: cmaxMetric,
    tmax: tmaxMetric,
    aucLast,
    aucInf,
    extrapolatedFraction,
    lambdaZ: lambdaZMetric,
    halfLife: halfLifeMetric,
    terminalPhase,
    warnings,
  }
}
