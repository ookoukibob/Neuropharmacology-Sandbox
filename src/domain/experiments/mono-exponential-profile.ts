/**
 * Practical identifiability screening for the mono-exponential fit (phase 47C).
 *
 * The fit (`mono-exponential-fit.ts`) has exactly one parameter in its
 * nonlinear search: the dimensionless rate `q = k·T`, where `T` is the
 * observed time span. The amplitude `C_ref` is not searched — for every trial
 * rate it is re-solved in closed form by a non-negative variable projection.
 * "The objective" is therefore already a PROFILE objective in `k`: the
 * amplitude is concentrated out, not held fixed.
 *
 * This module evaluates that same objective over a documented grid of
 * admissible rates and describes its shape. It never re-fits, never replaces
 * the estimate, and never changes the fitting algorithm.
 *
 * WHAT THIS IS NOT
 * - It is not a structural-identifiability analysis. Structural
 *   identifiability is a property of the model structure alone; this screen
 *   depends on the particular observations.
 * - It is not a likelihood profile. A residual-sum-of-squares profile only
 *   becomes a likelihood profile under a declared error model, and none is
 *   declared here.
 * - It is not a confidence interval, standard error, model comparison or
 *   goodness-of-fit verdict. No coverage probability and no pass/fail
 *   threshold is produced.
 *
 * Pure: no React, DOM, Plotly, storage or I/O. Measurements are read only.
 */
import type { ExperimentalMeasurement } from './experimental-dataset'
import {
  MAX_DIMENSIONLESS_RATE,
  createMonoExponentialObjective,
  type FitFailureCode,
  type MonoExponentialFitResult,
} from './mono-exponential-fit'

type SuccessfulFit = Extract<MonoExponentialFitResult, { ok: true }>

/**
 * Screening floor for the number of DISTINCT measured times.
 *
 * Rationale: the model has two fitted quantities. With fewer than three
 * distinct times the residual pattern cannot separate a wrong shape from
 * noise, so the objective shape is not informative about the rate. This is a
 * documented screening floor, not a statistical requirement, and it matches
 * the "fewer than three distinct time points" note the initial 47C slice
 * already reports.
 */
export const MINIMUM_DISTINCT_TIMES = 3

/**
 * Heuristic width of the near-minimum band, as a relative increase over the
 * estimate's own residual sum of squares.
 *
 * A candidate rate is "nearly equivalent" when its objective is within this
 * fraction of the estimate's value. Rationale: it asks a question about the
 * fit itself — how much worse does the residual get if the rate is forced
 * away? A 50 % increase in a sum of squares is a ~22 % increase in residual
 * magnitude (√1.5 ≈ 1.22), so rates that worsen the unweighted residual by
 * roughly a fifth or more are treated as distinguishable.
 *
 * It is a HEURISTIC screening convention with no probabilistic meaning. It is
 * deliberately NOT scaled by the attainable improvement over the whole
 * admissible range: that scale is dominated by the strongest residual in the
 * dataset (an outlier at the reference time would make almost every rate look
 * equivalent), whereas this one is local to the minimum.
 */
export const NEAR_MINIMUM_RSS_FRACTION = 0.5

/**
 * Band width, as a fraction of the admissible rate interval, above which the
 * minimum is called broad.
 *
 * Rationale: a band covering more than a tenth of the evaluated range means
 * many numerically near-equivalent rates, i.e. the objective does not localize
 * the rate for practical purposes. Heuristic, like NEAR_MINIMUM_RSS_FRACTION.
 */
export const BROAD_BAND_FRACTION = 0.1

/**
 * Lower-boundary proximity in model-response terms.
 *
 * `q` is the decay exponent across the whole observed span, so the fitted
 * model predicts a fractional decline of `1 − e^(−q)`. At `q = 0.02` that
 * decline is ~2 % — the fit is then numerically indistinguishable from "no
 * decay across the observed window". Expressed this way the threshold states a
 * property of the fitted curve instead of an arbitrary distance in parameter
 * space.
 */
export const LOWER_BOUNDARY_RESPONSE = 0.02

/**
 * Upper-boundary proximity as a fraction of the optimizer's numerical cap.
 *
 * At 98 % of `MAX_DIMENSIONLESS_RATE` the exponential has fallen to
 * e^(−49) ≈ 5e−22, so the objective is numerically identical to its value at
 * the cap: the rate is not resolved inside the admissible range either way.
 */
export const UPPER_BOUNDARY_FRACTION = 0.98

/** Dense part of the evaluation grid: `q` from 0 to this value. */
const DENSE_Q_LIMIT = 10

/** Points per unit of `q` in the dense part (step 1/12). */
const DENSE_STEPS_PER_Q = 12

/** Step of the sparse part, covering `q` from just above the dense limit to the cap. */
const TAIL_STEP = 1

/**
 * Documented evaluation grid over the dimensionless rate.
 *
 * It is deliberately non-uniform, and the NON-UNIFORMITY IS A DISPLAY
 * DECISION, not a scientific claim: the reported estimate never comes from
 * this grid (it is the fit's own `k`), the grid only describes the objective's
 * shape. Concentrating points where a decay of practical interest lives keeps
 * the near-minimum region legible instead of compressing it into the first
 * fraction of a 0–50 axis.
 *
 * The full admissible interval `[0, MAX_DIMENSIONLESS_RATE]` is still covered,
 * so a flat tail or an estimate at the cap remains visible.
 */
export function profileRateGrid(): readonly number[] {
  const grid: number[] = []
  for (let index = 0; index <= DENSE_Q_LIMIT * DENSE_STEPS_PER_Q; index += 1) {
    grid.push(index / DENSE_STEPS_PER_Q)
  }
  for (let q = DENSE_Q_LIMIT + TAIL_STEP; q <= MAX_DIMENSIONLESS_RATE; q += TAIL_STEP) {
    grid.push(q)
  }
  return grid
}

/** Why one candidate rate could not be evaluated. */
export type ProfilePointFailureReason = 'NON_FINITE_RATE' | 'NON_FINITE_OBJECTIVE'

/** A candidate rate whose objective value was computed. */
export interface ProfileValidPoint {
  readonly ok: true
  /** Dimensionless rate `q = k · span`. */
  readonly q: number
  /** Candidate elimination rate in the reciprocal dataset time unit. */
  readonly k: number
  /** Residual sum of squares at `k`, amplitude re-solved, in (concentration unit)². */
  readonly sse: number
}

/** A candidate rate whose objective value could NOT be computed. */
export interface ProfileInvalidPoint {
  readonly ok: false
  readonly q: number
  /** Absent when the rate itself is not representable for this time span. */
  readonly k: number | null
  readonly reason: ProfilePointFailureReason
}

export type MonoExponentialProfilePoint = ProfileValidPoint | ProfileInvalidPoint

/**
 * How the shape of the objective around the estimate is described.
 *
 * `localized` and `broad` are statements about THIS objective on THIS dataset.
 * Neither implies structural identifiability or a confidence region.
 */
export type ProfileLocalization =
  /** The estimate sits exactly at `k = 0`: no positive rate is supported. */
  | 'boundary-zero-rate'
  /** The estimate reached the optimizer's numerical cap: the rate is unresolved. */
  | 'boundary-upper-rate'
  /** A narrow near-minimum band: the objective discriminates rates at the screened resolution. */
  | 'localized'
  /** A wide near-minimum band: many rates are nearly equivalent under this objective. */
  | 'broad'
  /** The screen cannot classify the shape (sparse times, degenerate or truncated band). */
  | 'indeterminate'

/** Where the estimate sits relative to the admissible rate bounds. */
export interface ProfileBoundaryProximity {
  /** The estimate as the dimensionless decay exponent across the observed span. */
  readonly dimensionlessRate: number
  /** Exactly at the `k = 0` bound (no positive rate). */
  readonly atLowerBound: boolean
  /** Exactly at the optimizer's numerical upper cap. */
  readonly atUpperBound: boolean
  /** Interior, but the model predicts under ~2 % decline across the observed span. */
  readonly nearLowerBound: boolean
  /** At or within the numerically unresolvable band below the upper cap. */
  readonly nearUpperBound: boolean
}

/** A closed interval of rates in the reciprocal dataset time unit. */
export interface ProfileRateInterval {
  readonly min: number
  readonly max: number
}

/** Whether the near-minimum band could be measured on the evaluation grid. */
export type ProfileBandResolution =
  /** At least one evaluated rate lies inside the band; its width is reported. */
  | 'measured'
  /** The band is narrower than the grid step, so its width is not resolved. */
  | 'narrower-than-grid'
  /** No band is defined (boundary estimate, no improvement, or no valid points). */
  | 'not-applicable'

export interface MonoExponentialProfileDiagnostics {
  readonly ok: true
  /**
   * Admissible interval actually evaluated. `max` is null when
   * `MAX_DIMENSIONLESS_RATE / span` is not representable for this time span,
   * in which case only the `k = 0` candidate can be evaluated.
   */
  readonly admissibleRateRange: { readonly min: number; readonly max: number | null }
  /** One entry per candidate rate, ascending in `q` and therefore in `k`. */
  readonly points: readonly MonoExponentialProfilePoint[]
  readonly validPointCount: number
  readonly invalidPointCount: number
  /** The fit's estimate, reported verbatim — never a grid point. */
  readonly fittedRate: number
  /** The fit's residual sum of squares, reported verbatim. */
  readonly fittedSse: number
  /** Residual sum of squares at `k = 0` (best constant-concentration fit). */
  readonly zeroRateSse: number
  /** `zeroRateSse − fittedSse`: the improvement attributable to a positive rate. */
  readonly objectiveDrop: number
  readonly boundary: ProfileBoundaryProximity
  readonly localization: ProfileLocalization
  /**
   * Evaluated rates whose objective is within the near-minimum band. Null when
   * the band is not defined or is narrower than the grid step.
   */
  readonly nearMinimumRateRange: ProfileRateInterval | null
  /**
   * Band width as a fraction of the admissible interval, in [0, 1]. Null when
   * the band or the admissible interval is not resolved.
   */
  readonly nearMinimumBandFraction: number | null
  readonly nearMinimumBandResolution: ProfileBandResolution
  readonly measurementCount: number
  readonly distinctTimeCount: number
  /** Whether enough distinct times exist for the shape description to be meaningful. */
  readonly sufficientDistinctTimes: boolean
  /** Standing limitations of this screen; always present. */
  readonly limitations: readonly string[]
  /** Dataset-specific findings worth surfacing. */
  readonly warnings: readonly string[]
}

export type ProfileFailureCode =
  | 'NO_MEASUREMENTS'
  | 'MEASUREMENT_MISMATCH'
  | 'INVALID_MEASUREMENT'
  | 'NEGATIVE_VALUE'
  | 'NO_TIME_SPAN'
  | 'ALL_ZERO_CONCENTRATIONS'
  | 'NON_FINITE_PARAMETER'
  /** Defensive: no candidate rate could be evaluated at all. */
  | 'NO_VALID_EVALUATION'

export interface MonoExponentialProfileFailure {
  readonly ok: false
  readonly code: ProfileFailureCode
  readonly message: string
}

export type MonoExponentialProfileResult =
  | MonoExponentialProfileDiagnostics
  | MonoExponentialProfileFailure

const profileFailure = (
  code: ProfileFailureCode,
  message: string,
): MonoExponentialProfileFailure => ({ ok: false, code, message })

/** The standing limitations, stated once so the UI cannot drift from the domain. */
function standingLimitations(): readonly string[] {
  return [
    'This is a screening of one least-squares objective on one dataset. It is not a structural or formal practical-identifiability proof, and passing it does not establish that the rate is scientifically identifiable.',
    'The near-minimum band is a heuristic: rates whose objective is within ' +
      String(Math.round(NEAR_MINIMUM_RSS_FRACTION * 100)) +
      '% of the estimate’s residual sum of squares are treated as nearly equivalent. It is not a confidence interval and has no coverage probability.',
    'A residual sum of squares is not a likelihood. No error distribution or variance model is assumed or tested here, so no likelihood-ratio or profile-likelihood interpretation applies.',
    'The unweighted objective treats every observation as equally uncertain on the original concentration scale. That assumption is not verified by this screen.',
    'Only this model’s own rate parameterization is evaluated; nothing here compares alternative models or justifies choosing one.',
    'The grid allocates more candidate rates to the region where a decay of practical interest lies. That is a display choice; the reported estimate always comes from the fit, never from the grid.',
  ]
}

/** Plain failure text for a shared validation code, kept dataset-neutral. */
function failureFromFitCode(code: FitFailureCode, message: string): MonoExponentialProfileFailure {
  switch (code) {
    case 'NO_MEASUREMENTS':
    case 'INVALID_MEASUREMENT':
    case 'NEGATIVE_VALUE':
    case 'NO_TIME_SPAN':
    case 'ALL_ZERO_CONCENTRATIONS':
      return profileFailure(code, message)
    default:
      return profileFailure('NO_VALID_EVALUATION', message)
  }
}

/**
 * Evaluate the fit objective over the documented rate grid and describe its
 * shape. Requires a SUCCESSFUL fit: this is a diagnostic of an existing
 * estimate, never an alternative fitting path.
 */
export function analyzeMonoExponentialProfile(
  measurements: readonly ExperimentalMeasurement[],
  fit: SuccessfulFit,
): MonoExponentialProfileResult {
  if (measurements.length === 0) {
    return profileFailure('NO_MEASUREMENTS', 'The dataset has no measurements to profile.')
  }
  if (measurements.length !== fit.measurementCount) {
    return profileFailure(
      'MEASUREMENT_MISMATCH',
      'The measurements do not match the observations used by this fit, so the profile was not computed.',
    )
  }
  if (
    !Number.isFinite(fit.tRef) ||
    !Number.isFinite(fit.cRef) ||
    !Number.isFinite(fit.k) ||
    !Number.isFinite(fit.sse)
  ) {
    return profileFailure(
      'NON_FINITE_PARAMETER',
      'The fit contains a non-finite value; the objective profile is unavailable.',
    )
  }

  const created = createMonoExponentialObjective(measurements)
  if (!created.ok) return failureFromFitCode(created.code, created.message)
  const { objective } = created
  const { span } = objective

  // Verified again here so no arithmetic below can divide by zero, even if the
  // shared preparation ever changes its guards.
  if (!(span > 0) || !Number.isFinite(span)) {
    return profileFailure(
      'NO_TIME_SPAN',
      'The dataset has no positive finite time span, so a rate profile is unavailable.',
    )
  }

  const upperRate = MAX_DIMENSIONLESS_RATE / span
  const admissibleRateRange = {
    min: 0,
    max: Number.isFinite(upperRate) ? upperRate : null,
  }

  const points: MonoExponentialProfilePoint[] = []
  const validPoints: ProfileValidPoint[] = []
  for (const q of profileRateGrid()) {
    const k = q / span
    if (!Number.isFinite(k)) {
      points.push({ ok: false, q, k: null, reason: 'NON_FINITE_RATE' })
      continue
    }
    const evaluated = objective.evaluateDimensionless(q)
    if (evaluated === null) {
      points.push({ ok: false, q, k, reason: 'NON_FINITE_OBJECTIVE' })
      continue
    }
    const point: ProfileValidPoint = { ok: true, q, k, sse: evaluated.sse }
    points.push(point)
    validPoints.push(point)
  }
  const invalidPointCount = points.length - validPoints.length

  // Defensive: with a positive finite span the k = 0 candidate always
  // evaluates, so this branch is unreachable through the current bounds. It
  // exists so that "no comparable evaluation" can never be reported as a
  // successful profile.
  if (validPoints.length === 0) {
    return profileFailure(
      'NO_VALID_EVALUATION',
      'No candidate decay rate could be evaluated for this dataset, so no profile is available.',
    )
  }

  const distinctTimes = new Set<number>()
  for (const measurement of measurements) distinctTimes.add(measurement.time)
  const distinctTimeCount = distinctTimes.size
  const sufficientDistinctTimes = distinctTimeCount >= MINIMUM_DISTINCT_TIMES

  const zeroRateEvaluation = objective.evaluateDimensionless(0)
  // Defensive only: q = 0 is evaluable whenever k = 0 is, so `fit.sse` stands in
  // only to keep the arithmetic finite. A missing evaluation is never reported
  // as an improvement, it collapses the drop to zero.
  const zeroRateSse = zeroRateEvaluation === null ? fit.sse : zeroRateEvaluation.sse
  // The fit's own objective value can never exceed the k = 0 value (the
  // optimizer compares the two explicitly), so the drop is non-negative.
  const objectiveDrop = Math.max(0, zeroRateSse - fit.sse)

  const dimensionlessRate = fit.k * span
  const atLowerBound = fit.zeroRate
  const atUpperBound = fit.warnings.some((warning) => warning.code === 'RATE_AT_UPPER_BOUND')
  const boundary: ProfileBoundaryProximity = {
    dimensionlessRate,
    atLowerBound,
    atUpperBound,
    nearLowerBound: !atLowerBound && dimensionlessRate < LOWER_BOUNDARY_RESPONSE,
    nearUpperBound: dimensionlessRate >= UPPER_BOUNDARY_FRACTION * MAX_DIMENSIONLESS_RATE,
  }

  // Near-minimum band: evaluated rates whose objective is within a documented
  // relative increase over the estimate's own value. A band truncated by a
  // bound, or one narrower than the grid step, is not a clean shape measure,
  // so it is labelled rather than silently treated as zero width.
  let nearMinimumRateRange: ProfileRateInterval | null = null
  let nearMinimumBandFraction: number | null = null
  let nearMinimumBandResolution: ProfileBandResolution = 'not-applicable'
  if (!atLowerBound && objectiveDrop > 0) {
    const threshold = fit.sse * (1 + NEAR_MINIMUM_RSS_FRACTION)
    let min: number | null = null
    let max: number | null = null
    for (const point of validPoints) {
      if (point.sse > threshold) continue
      if (min === null || point.k < min) min = point.k
      if (max === null || point.k > max) max = point.k
    }
    if (min === null || max === null) {
      nearMinimumBandResolution = 'narrower-than-grid'
    } else {
      nearMinimumRateRange = { min, max }
      nearMinimumBandResolution = 'measured'
      if (admissibleRateRange.max !== null) {
        const admissibleWidth = admissibleRateRange.max - admissibleRateRange.min
        nearMinimumBandFraction = admissibleWidth > 0 ? (max - min) / admissibleWidth : null
      }
    }
  }

  const localization = classifyLocalization({
    atLowerBound,
    atUpperBound,
    nearLowerBound: boundary.nearLowerBound,
    nearUpperBound: boundary.nearUpperBound,
    sufficientDistinctTimes,
    objectiveDrop,
    nearMinimumBandResolution,
    nearMinimumBandFraction,
  })

  const warnings: string[] = []
  if (atLowerBound) {
    warnings.push(
      'The best fit lies at the zero-rate boundary, so there is no interior minimum to locate: the data support no positive decay rate at this objective.',
    )
  } else if (boundary.nearLowerBound) {
    warnings.push(
      'The estimated rate is very close to the zero-rate boundary: the fitted model predicts almost no decline across the observed time span, so the rate is poorly separated from "no decay".',
    )
  }
  if (atUpperBound) {
    warnings.push(
      'The estimate reached the optimizer’s numerical upper bound, so the true rate lies at or beyond the evaluated range and the profile cannot localize it.',
    )
  } else if (boundary.nearUpperBound) {
    warnings.push(
      'The estimate is inside the numerically unresolvable band below the optimizer’s upper bound, so its exact value is not determined by this objective.',
    )
  }
  if (!sufficientDistinctTimes) {
    warnings.push(
      'Only ' +
        String(distinctTimeCount) +
        ' distinct time point' +
        (distinctTimeCount === 1 ? '' : 's') +
        ' are available. The shape screen needs at least ' +
        String(MINIMUM_DISTINCT_TIMES) +
        ' to describe how the objective localizes the rate, so no shape classification is reported.',
    )
  }
  if (objectiveDrop <= 0 && !atLowerBound) {
    warnings.push(
      'Allowing a positive rate did not reduce the objective, so there is no improvement to measure the near-minimum band against.',
    )
  }
  if (nearMinimumBandResolution === 'narrower-than-grid') {
    warnings.push(
      'Every evaluated rate outside the estimate raised the objective by more than the screening tolerance, so the near-minimum band is narrower than the evaluation grid and its width is not reported.',
    )
  }
  if (invalidPointCount > 0) {
    warnings.push(
      String(invalidPointCount) +
        ' of ' +
        String(points.length) +
        ' candidate rates could not be evaluated for this time span. Those candidates are reported as unavailable and were not interpolated, replaced or dropped silently.',
    )
  }
  if (admissibleRateRange.max === null) {
    warnings.push(
      'The upper end of the admissible rate range is not representable for this time span, so only the zero-rate candidate could be evaluated.',
    )
  }

  return {
    ok: true,
    admissibleRateRange,
    points,
    validPointCount: validPoints.length,
    invalidPointCount,
    fittedRate: fit.k,
    fittedSse: fit.sse,
    zeroRateSse,
    objectiveDrop,
    boundary,
    localization,
    nearMinimumRateRange,
    nearMinimumBandFraction,
    nearMinimumBandResolution,
    measurementCount: measurements.length,
    distinctTimeCount,
    sufficientDistinctTimes,
    limitations: standingLimitations(),
    warnings,
  }
}

function classifyLocalization(input: {
  readonly atLowerBound: boolean
  readonly atUpperBound: boolean
  readonly nearLowerBound: boolean
  readonly nearUpperBound: boolean
  readonly sufficientDistinctTimes: boolean
  readonly objectiveDrop: number
  readonly nearMinimumBandResolution: ProfileBandResolution
  readonly nearMinimumBandFraction: number | null
}): ProfileLocalization {
  if (input.atLowerBound) return 'boundary-zero-rate'
  if (input.atUpperBound) return 'boundary-upper-rate'
  // A band squeezed against either bound is truncated, so its width is not a
  // measure of the objective's shape.
  if (input.nearLowerBound || input.nearUpperBound) return 'indeterminate'
  if (!input.sufficientDistinctTimes) return 'indeterminate'
  if (!(input.objectiveDrop > 0)) return 'indeterminate'
  if (input.nearMinimumBandResolution === 'not-applicable') return 'indeterminate'
  // A band no wider than the grid step means the objective rises steeply on
  // both sides of the estimate: sharply localized at this resolution.
  if (input.nearMinimumBandResolution === 'narrower-than-grid') return 'localized'
  const fraction = input.nearMinimumBandFraction
  if (fraction === null || !Number.isFinite(fraction)) return 'indeterminate'
  return fraction > BROAD_BAND_FRACTION ? 'broad' : 'localized'
}
