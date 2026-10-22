/**
 * One-compartment mono-exponential decay fit (phase 47B).
 *
 *   C(t) = C_ref · exp(−k · (t − t_ref))
 *
 * with t_ref = min(t_i), C_ref the fitted concentration AT t_ref in the
 * dataset's declared concentration unit, and k ≥ 0 in the reciprocal of the
 * dataset's declared time unit. When t_ref = 0, C_ref is the fitted C₀.
 *
 * This is a constrained decay model: it cannot represent a rising curve, an
 * absorption phase, a baseline offset or multiple kinetic phases. A converged
 * fit is a numerical result, not evidence that the model suits the data.
 *
 * Pure: no React, DOM, Plotly or Dexie. The caller's measurements are read,
 * never mutated, sorted, averaged or deduplicated — every row contributes
 * independently to the objective, including exact replicates.
 */
import type { ExperimentalMeasurement } from './experimental-dataset'

/**
 * Upper search bound for the dimensionless rate q = k·T.
 *
 * A NAMED algorithm constant, not a scientific assumption: q = 50 means the
 * concentration falls by e^−50 ≈ 2e−22 across the observed time span, which is
 * far below any representable precision. If the optimum lands on this bound
 * the rate is unresolved beyond it and the result carries a warning.
 */
export const MAX_DIMENSIONLESS_RATE = 50

/** Coarse scan resolution over [0, MAX_DIMENSIONLESS_RATE]. */
const COARSE_STEPS = 200

/** Golden-section relative tolerance on q, and its iteration cap. */
const REFINE_RELATIVE_TOLERANCE = 1e-12
const REFINE_MAX_ITERATIONS = 200

/** A rate at or below this fraction of the span is reported as k = 0. */
const ZERO_RATE_EPSILON = 1e-12

export type FitWarningCode =
  /** The optimum lies at the k = 0 boundary: no identifiable positive rate. */
  | 'ZERO_RATE_BOUNDARY'
  /** The optimum reached the numerical upper bound; the rate is unresolved. */
  | 'RATE_AT_UPPER_BOUND'
  /** The data span no positive time, so a decay rate cannot be estimated. */
  | 'NO_TIME_SPAN'

export interface FitWarning {
  readonly code: FitWarningCode
  readonly message: string
}

export type FitFailureCode =
  | 'NO_MEASUREMENTS'
  | 'INVALID_MEASUREMENT'
  | 'NEGATIVE_VALUE'
  | 'NO_TIME_SPAN'
  | 'ALL_ZERO_CONCENTRATIONS'
  | 'DEGENERATE_OBJECTIVE'
  | 'NON_CONVERGED'
  | 'NON_FINITE'

export type MonoExponentialFitFailure = {
  readonly ok: false
  readonly code: FitFailureCode
  readonly message: string
}

export type MonoExponentialFitResult =
  | {
      readonly ok: true
      readonly tRef: number
      /** Fitted concentration at tRef, in the dataset concentration unit. */
      readonly cRef: number
      /** First-order decay rate, in reciprocal dataset time units (≥ 0). */
      readonly k: number
      /** ln(2)/k when k > 0; absent at the zero-rate boundary. */
      readonly halfLife?: number
      readonly sse: number
      readonly measurementCount: number
      /** True when k is 0 (no identifiable decay). */
      readonly zeroRate: boolean
      readonly warnings: readonly FitWarning[]
    }
  | {
      readonly ok: false
      readonly code: FitFailureCode
      readonly message: string
    }

const failure = (code: FitFailureCode, message: string): MonoExponentialFitFailure => ({
  ok: false,
  code,
  message,
})

/** One normalized observation: unit-free time and scaled concentration. */
interface NormalizedPoint {
  readonly u: number
  readonly c: number
}

/**
 * Sum of squared errors at a trial q, with the amplitude solved by variable
 * projection. Returns null when an intermediate is not finite.
 */
function sseAt(q: number, points: readonly NormalizedPoint[]): { sse: number; cRef: number } | null {
  let num = 0
  let den = 0
  for (const point of points) {
    const g = Math.exp(-q * point.u)
    num += point.c * g
    den += g * g
  }
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null
  // The constrained optimum: amplitude may not be negative.
  const cRef = Math.max(0, num / den)
  let sse = 0
  for (const point of points) {
    const g = Math.exp(-q * point.u)
    const residual = point.c - cRef * g
    sse += residual * residual
  }
  if (!Number.isFinite(sse)) return null
  return { sse, cRef }
}

/** Golden-section minimisation on a bracketed interval (deterministic). */
function goldenSection(
  f: (q: number) => number,
  lo: number,
  hi: number,
): { q: number; value: number } {
  const invPhi = (Math.sqrt(5) - 1) / 2
  let a = lo
  let b = hi
  let c = b - invPhi * (b - a)
  let d = a + invPhi * (b - a)
  let fc = f(c)
  let fd = f(d)
  for (let i = 0; i < REFINE_MAX_ITERATIONS; i += 1) {
    if (Math.abs(b - a) <= REFINE_RELATIVE_TOLERANCE * (Math.abs(a) + Math.abs(b) + 1e-300)) break
    if (fc <= fd) {
      b = d
      d = c
      fd = fc
      c = b - invPhi * (b - a)
      fc = f(c)
    } else {
      a = c
      c = d
      fc = fd
      d = a + invPhi * (b - a)
      fd = f(d)
    }
  }
  const q = (a + b) / 2
  return { q, value: f(q) }
}

/**
 * The normalized problem the fit is defined on: the reference time and span,
 * the concentration scale, and one unit-free observation per measurement.
 */
interface NormalizedObjective {
  readonly tRef: number
  readonly span: number
  readonly maxAbsConcentration: number
  readonly points: readonly NormalizedPoint[]
}

/**
 * Validate the rows and derive the normalized problem. This is the single
 * definition of "the objective" — the fit and the Phase 47C profile screening
 * both go through it, so a diagnostic can never be computed against a
 * different objective than the one that produced the estimate.
 *
 * Errors keep their original order, codes and messages.
 */
function prepareObjective(
  measurements: readonly ExperimentalMeasurement[],
):
  | { readonly ok: true; readonly prepared: NormalizedObjective }
  | { readonly ok: false; readonly failure: MonoExponentialFitFailure } {
  if (measurements.length === 0) {
    return {
      ok: false,
      failure: failure('NO_MEASUREMENTS', 'The dataset has no measurements to fit.'),
    }
  }

  let tRef = Number.POSITIVE_INFINITY
  let tMax = Number.NEGATIVE_INFINITY
  let maxAbsConcentration = 0
  for (const measurement of measurements) {
    // Runtime shape guard: a stored row is normally well formed, but this
    // boundary must never throw on a malformed element (null, undefined, a
    // primitive, or an object missing a field). TypeScript types are erased.
    if (measurement === null || typeof measurement !== 'object') {
      return {
        ok: false,
        failure: failure('INVALID_MEASUREMENT', 'A measurement is not an object.'),
      }
    }
    const { time, concentration } = measurement as { time?: unknown; concentration?: unknown }
    if (typeof time !== 'number' || typeof concentration !== 'number') {
      return {
        ok: false,
        failure: failure(
          'INVALID_MEASUREMENT',
          'A measurement is missing a numeric time or concentration.',
        ),
      }
    }
    if (!Number.isFinite(time) || !Number.isFinite(concentration)) {
      return {
        ok: false,
        failure: failure(
          'INVALID_MEASUREMENT',
          'A measurement contains a non-finite time or concentration.',
        ),
      }
    }
    if (time < 0 || concentration < 0) {
      return {
        ok: false,
        failure: failure('NEGATIVE_VALUE', 'Times and concentrations must be non-negative.'),
      }
    }
    if (time < tRef) tRef = time
    if (time > tMax) tMax = time
    if (concentration > maxAbsConcentration) maxAbsConcentration = concentration
  }

  const span = tMax - tRef
  if (!(span > 0)) {
    return {
      ok: false,
      failure: failure(
        'NO_TIME_SPAN',
        'The dataset has a single distinct time, so a decay rate is not identifiable.',
      ),
    }
  }
  if (maxAbsConcentration === 0) {
    return {
      ok: false,
      failure: failure(
        'ALL_ZERO_CONCENTRATIONS',
        'Every measured concentration is zero, so a decay rate is not identifiable.',
      ),
    }
  }

  // Scale by the largest concentration so extreme magnitudes cannot overflow
  // the normal equations; the amplitude is rescaled afterwards.
  const points: NormalizedPoint[] = measurements.map((measurement) => ({
    u: (measurement.time - tRef) / span,
    c: measurement.concentration / maxAbsConcentration,
  }))

  return { ok: true, prepared: { tRef, span, maxAbsConcentration, points } }
}

/**
 * The fit objective as a reusable evaluator (phase 47C).
 *
 * `evaluateDimensionless(q)` is exactly the quantity the optimizer minimises:
 * the residual sum of squares at a fixed dimensionless rate `q = k·span`, with
 * the amplitude re-solved in closed form by the same non-negative variable
 * projection the fit uses. Both `sse` and `cRef` are returned in the
 * dataset's original units, so they are directly comparable with the fitted
 * `sse`/`cRef`: `fit.sse` is the same quantity as
 * `evaluateDimensionless(fit.k · span).sse`, up to floating-point resolution.
 *
 * A `null` return means the evaluation could not be completed (a non-finite
 * or negative trial rate, or a non-finite intermediate). Callers must report
 * that gap explicitly and must never substitute an interpolated or plausible
 * value for it.
 */
export interface MonoExponentialObjectiveEvaluator {
  readonly tRef: number
  readonly span: number
  readonly maxAbsConcentration: number
  evaluateDimensionless(q: number): { readonly sse: number; readonly cRef: number } | null
}

export type MonoExponentialObjectiveOutcome =
  | { readonly ok: true; readonly objective: MonoExponentialObjectiveEvaluator }
  | { readonly ok: false; readonly code: FitFailureCode; readonly message: string }

export function createMonoExponentialObjective(
  measurements: readonly ExperimentalMeasurement[],
): MonoExponentialObjectiveOutcome {
  const prepared = prepareObjective(measurements)
  if (!prepared.ok) {
    return { ok: false, code: prepared.failure.code, message: prepared.failure.message }
  }
  const { tRef, span, maxAbsConcentration, points } = prepared.prepared
  const scale = maxAbsConcentration * maxAbsConcentration
  return {
    ok: true,
    objective: {
      tRef,
      span,
      maxAbsConcentration,
      evaluateDimensionless(q: number) {
        if (!Number.isFinite(q) || q < 0) return null
        const evaluated = sseAt(q, points)
        if (evaluated === null) return null
        const sse = evaluated.sse * scale
        const cRef = evaluated.cRef * maxAbsConcentration
        if (!Number.isFinite(sse) || !Number.isFinite(cRef)) return null
        return { sse, cRef }
      },
    },
  }
}

/**
 * Fit the constrained mono-exponential decay model to measured observations.
 *
 * Every measurement is an independent contribution to an unweighted
 * least-squares objective on the ORIGINAL concentration scale (no log
 * transform), so zero concentrations are valid observations.
 */
export function fitMonoExponentialDecay(
  measurements: readonly ExperimentalMeasurement[],
): MonoExponentialFitResult {
  const preparation = prepareObjective(measurements)
  if (!preparation.ok) return preparation.failure
  const { tRef, span, maxAbsConcentration, points } = preparation.prepared

  const objective = (q: number): number => {
    const evaluated = sseAt(q, points)
    return evaluated === null ? Number.POSITIVE_INFINITY : evaluated.sse
  }

  // 1. Deterministic coarse scan over the whole documented range.
  let bestIndex = 0
  let bestValue = Number.POSITIVE_INFINITY
  for (let index = 0; index <= COARSE_STEPS; index += 1) {
    const q = (MAX_DIMENSIONLESS_RATE * index) / COARSE_STEPS
    const value = objective(q)
    if (value < bestValue) {
      bestValue = value
      bestIndex = index
    }
  }
  if (!Number.isFinite(bestValue)) {
    return failure(
      'DEGENERATE_OBJECTIVE',
      'The least-squares objective could not be evaluated at any trial rate.',
    )
  }

  // 2. Refine inside the bracketing interval of the best coarse point.
  const step = MAX_DIMENSIONLESS_RATE / COARSE_STEPS
  const lo = Math.max(0, (bestIndex - 1) * step)
  const hi = Math.min(MAX_DIMENSIONLESS_RATE, (bestIndex + 1) * step)
  const refined = goldenSection(objective, lo, hi)
  if (!Number.isFinite(refined.q) || !Number.isFinite(refined.value)) {
    return failure('NON_CONVERGED', 'The rate optimizer did not converge to a finite value.')
  }

  // 3. Compare against the endpoints explicitly: the constrained optimum can
  //    legitimately sit at q = 0 (no decay) or at the numerical upper bound.
  const atZero = objective(0)
  const atUpper = objective(MAX_DIMENSIONLESS_RATE)
  let qBest = refined.q
  let bestSse = refined.value
  if (atZero <= bestSse) {
    qBest = 0
    bestSse = atZero
  }
  if (atUpper < bestSse) {
    qBest = MAX_DIMENSIONLESS_RATE
    bestSse = atUpper
  }

  // 4. Boundary classification happens in the DIMENSIONLESS parameter q.
  //    Comparing the dimensional k against epsilon/span is wrong twice over:
  //    both sides scale with 1/span (so the test is span-invariant and can
  //    mislabel a positive rate as zero), and for a subnormal span both can
  //    overflow to Infinity, making "Infinity <= Infinity" true.
  //
  //    When the tolerance classifies qBest as zero we SET it to zero before
  //    recomputing the amplitude and SSE, so k, zeroRate, halfLife and the
  //    warnings all describe the same solution.
  const atZeroBoundary = qBest <= ZERO_RATE_EPSILON
  const qFinal = atZeroBoundary ? 0 : qBest

  const solved = sseAt(qFinal, points)
  if (solved === null || !Number.isFinite(solved.cRef) || !Number.isFinite(solved.sse)) {
    return failure('NON_FINITE', 'The fit produced a non-finite intermediate value.')
  }

  const cRef = solved.cRef * maxAbsConcentration
  const sse = solved.sse * maxAbsConcentration * maxAbsConcentration
  if (!Number.isFinite(cRef) || !Number.isFinite(sse)) {
    return failure('NON_FINITE', 'The fitted parameters are not finite.')
  }
  if (!(cRef > 0)) {
    return failure(
      'DEGENERATE_OBJECTIVE',
      'The fitted amplitude is zero or negative, so no decay curve can be estimated.',
    )
  }

  // k = q/T. A subnormal-but-positive span can make this overflow: that rate is
  // not representable as a finite number, so it is a structured failure — never
  // a successful fit reporting Infinity, and never clamped to an arbitrary value.
  const k = qFinal / span
  if (!Number.isFinite(k)) {
    return failure(
      'NON_FINITE',
      'The fitted decay rate is not representable as a finite number for this time span.',
    )
  }
  const zeroRate = qFinal === 0
  const warnings: FitWarning[] = []

  if (zeroRate) {
    warnings.push({
      code: 'ZERO_RATE_BOUNDARY',
      message:
        'The best fit lies at the zero-rate boundary: the constrained model finds no positive decay rate, and no finite half-life is available. The data do not support an identifiable decay rate.',
    })
  }
  // The upper-bound warning describes the same q the result reports, and the
  // two boundary states are mutually exclusive by construction (qFinal is 0
  // only when the optimum is at the lower boundary).
  if (qFinal >= MAX_DIMENSIONLESS_RATE) {
    warnings.push({
      code: 'RATE_AT_UPPER_BOUND',
      message:
        'The optimum reached the numerical upper bound for the dimensionless rate, so the rate is unresolved beyond that limit; the reported rate and half-life are not reliable estimates.',
    })
  }

  const halfLife = zeroRate ? undefined : Math.LN2 / k
  if (halfLife !== undefined && !Number.isFinite(halfLife)) {
    return failure('NON_FINITE', 'The derived half-life is not finite.')
  }

  // Final guard: every reported numeric field must be finite before a result
  // is published as successful.
  if (!Number.isFinite(tRef) || !Number.isFinite(cRef) || !Number.isFinite(k) || !Number.isFinite(sse)) {
    return failure('NON_FINITE', 'The fitted parameters are not finite.')
  }

  return {
    ok: true,
    tRef,
    cRef,
    k,
    ...(halfLife === undefined ? {} : { halfLife }),
    sse,
    measurementCount: measurements.length,
    zeroRate,
    warnings,
  }
}

/** One point of the fitted model curve. */
export interface FitCurvePoint {
  readonly time: number
  readonly concentration: number
}

/**
 * Sample the fitted curve INSIDE the observed time range only.
 *
 * The result is a visualization of the fitted equation — never a replacement
 * for, or interpolation of, the measured rows. No extrapolation occurs, and
 * the dataset is not touched.
 */
export function fitCurvePoints(
  fit: Extract<MonoExponentialFitResult, { ok: true }>,
  minTime: number,
  maxTime: number,
  count = 101,
): readonly FitCurvePoint[] {
  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime) || maxTime < minTime) return []
  const points = Math.max(2, Math.floor(count))
  const span = maxTime - minTime
  const result: FitCurvePoint[] = []
  for (let index = 0; index < points; index += 1) {
    const time = span === 0 ? minTime : minTime + (span * index) / (points - 1)
    const concentration = fit.cRef * Math.exp(-fit.k * (time - fit.tRef))
    if (!Number.isFinite(time) || !Number.isFinite(concentration)) return []
    result.push({ time, concentration })
  }
  return result
}
