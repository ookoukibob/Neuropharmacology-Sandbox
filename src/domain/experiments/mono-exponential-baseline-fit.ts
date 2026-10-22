/**
 * One-compartment mono-exponential decay with an ADDITIVE BASELINE
 * (phase 47C model comparison, candidate model M1).
 *
 *   C(t) = B + A · exp(−k · (t − t_ref)),   A ≥ 0, B ≥ 0, k ≥ 0
 *
 * `t_ref`, the observed span and the concentration scaling are NOT
 * re-derived here: they come from the shared preparation the production
 * M0 fit uses, so both candidates see exactly the same rows, the same
 * reference time convention and the same original concentration scale.
 *
 * WHAT THE BASELINE IS: a free additive offset in the observed data. It can
 * represent a plateau the decay does not reach, a persistent background
 * reading or a model-form mismatch. It is NOT evidence for a particular
 * physiological mechanism — a baseline term is a shape, not a cause.
 *
 * Numerics. For a fixed dimensionless rate `q = k·span` the amplitude and
 * baseline subproblem is a two-variable non-negative least squares problem.
 * With `g_i = exp(−q·u_i)` it has three faces: both coefficients free,
 * `A = 0`, and `B = 0`. Because every observed concentration is
 * non-negative, the two single-coefficient faces are always feasible, and the
 * constrained optimum of a convex quadratic on two free variables must lie on
 * one of the three. Enumerating the faces and keeping the lowest sum of
 * squares is therefore exact — no iterative solver and no tolerance-dependent
 * stopping rule is involved. The reported objective is re-evaluated from the
 * residuals themselves, never from the normal equations, so a near-perfect
 * fit cannot be reported as a small negative sum of squares.
 *
 * The rate itself is found with the same deterministic strategy as M0: a
 * coarse scan over the documented `[0, MAX_DIMENSIONLESS_RATE]` range, a
 * golden-section refinement inside the bracket around the best scanned point,
 * and an explicit comparison against both endpoints. A coarse-grid value is
 * never published as the estimate.
 *
 * Pure: no React, DOM, Plotly or storage. Measurements are read only.
 */
import { goldenSectionMinimize } from './bounded-minimize'
import type { ExperimentalMeasurement } from './experimental-dataset'
import {
  MAX_DIMENSIONLESS_RATE,
  prepareMonoExponentialProblem,
  type FitFailureCode,
  type NormalizedObservation,
} from './mono-exponential-fit'

/** Coarse scan resolution over [0, MAX_DIMENSIONLESS_RATE], as in M0. */
const COARSE_STEPS = 200

/** A dimensionless rate at or below this is reported as k = 0. */
const ZERO_RATE_EPSILON = 1e-12

/**
 * A decay contribution below this fraction of the largest observed
 * concentration is treated as numerically absent: `A·(1 − e^(−q))` is the
 * total change the decay term produces across the observed window, and at
 * 1e−9 of the concentration scale it is far below any measurement resolution.
 * This is a numerical-resolution statement, not a scientific judgement about
 * whether a small decay "matters".
 */
export const DECAY_RESOLUTION_FRACTION = 1e-9

/**
 * A fitted baseline below this fraction of the largest observed concentration
 * is reported as sitting on the `B = 0` boundary (the model then reduces to
 * M0 in shape). Numerical-resolution statement, like the decay fraction.
 */
export const BASELINE_RESOLUTION_FRACTION = 1e-12

/**
 * Relative floor for the 2×2 normal-equation determinant.
 *
 * `det = n·Σg² − (Σg)²` vanishes as `q → 0` (the decay becomes a constant and
 * the two coefficients are no longer separately identifiable). Below this
 * relative floor the unconstrained candidate is skipped and the constrained
 * faces decide, which is exactly the right answer in that limit.
 */
const DETERMINANT_RELATIVE_FLOOR = 1e-14

export type BaselineFitWarningCode =
  /** The optimum sits at q = 0: the fitted model is a constant baseline. */
  | 'ZERO_RATE_BOUNDARY'
  /** The optimum reached the numerical upper bound on the dimensionless rate. */
  | 'RATE_AT_UPPER_BOUND'
  /** The decay term contributes nothing resolvable, so k is uninformative. */
  | 'ZERO_AMPLITUDE'
  /** The baseline sits on its lower bound: the model reduces to M0's shape. */
  | 'BASELINE_AT_ZERO'

export interface BaselineFitWarning {
  readonly code: BaselineFitWarningCode
  readonly message: string
}

export type MonoExponentialBaselineFitResult =
  | {
      readonly ok: true
      readonly tRef: number
      /** Decay amplitude `A` at `t_ref`, in the dataset concentration unit (≥ 0). */
      readonly amplitude: number
      /** Additive baseline `B`, in the dataset concentration unit (≥ 0). */
      readonly baseline: number
      /** First-order decay rate in reciprocal dataset time units (≥ 0). */
      readonly k: number
      /** ln(2)/k when k > 0; absent at the zero-rate boundary. */
      readonly halfLife?: number
      readonly sse: number
      readonly measurementCount: number
      /** A, B and k are all estimated mean-model parameters. */
      readonly meanParameterCount: 3
      readonly dimensionlessRate: number
      readonly zeroRate: boolean
      /**
       * False when the decay term carries no resolvable contribution, so the
       * rate is not informed by these data even though the fit converged.
       */
      readonly rateInformative: boolean
      readonly warnings: readonly BaselineFitWarning[]
    }
  | {
      readonly ok: false
      readonly code: FitFailureCode
      readonly message: string
    }

const failure = (
  code: FitFailureCode,
  message: string,
): Extract<MonoExponentialBaselineFitResult, { ok: false }> => ({ ok: false, code, message })

/** Coefficients of the constrained two-variable solve, in normalized units. */
interface Coefficients {
  readonly amplitude: number
  readonly baseline: number
  readonly sse: number
}

/**
 * Exact non-negative least squares for `(A, B)` at one rate.
 *
 * Returns `null` when an intermediate is not finite. Never returns a negative
 * coefficient and never returns a negative sum of squares.
 */
function solveAmplitudeBaseline(
  observations: readonly NormalizedObservation[],
  q: number,
): Coefficients | null {
  const n = observations.length
  let sumG = 0
  let sumGG = 0
  let sumY = 0
  let sumYG = 0
  let sumYY = 0
  for (const observation of observations) {
    const g = Math.exp(-q * observation.u)
    const y = observation.c
    sumG += g
    sumGG += g * g
    sumY += y
    sumYG += y * g
    sumYY += y * y
  }
  if (
    !Number.isFinite(sumG) ||
    !Number.isFinite(sumGG) ||
    !Number.isFinite(sumY) ||
    !Number.isFinite(sumYG) ||
    !Number.isFinite(sumYY)
  ) {
    return null
  }
  if (!(sumGG > 0) || !(n > 0)) return null

  const determinant = n * sumGG - sumG * sumG
  const determinantFloor = DETERMINANT_RELATIVE_FLOOR * n * sumGG

  // Candidate order matters only for exact ties: the constant-baseline face is
  // tried first so a degenerate q → 0 optimum reports A = 0 rather than an
  // arbitrary amplitude paired with B = 0.
  const candidates: { amplitude: number; baseline: number; score: number }[] = []

  const consider = (amplitude: number, baseline: number, approximateSse: number): void => {
    if (!Number.isFinite(amplitude) || !Number.isFinite(baseline)) return
    if (amplitude < 0 || baseline < 0) return
    if (!Number.isFinite(approximateSse)) return
    // Clamp only for candidate ranking; the published SSE is recomputed below.
    candidates.push({
      amplitude,
      baseline,
      score: approximateSse > 0 ? approximateSse : 0,
    })
  }

  // Face A = 0: constant at the mean concentration (always feasible, since
  // every observation is non-negative).
  consider(0, sumY / n, sumYY - (sumY * sumY) / n)
  // Face B = 0: pure decay from a zero asymptote.
  consider(sumYG / sumGG, 0, sumYY - (sumYG * sumYG) / sumGG)
  // Interior: both coefficients free, only when the system is well posed and
  // the unconstrained solution is feasible.
  if (determinant > determinantFloor) {
    const amplitude = (n * sumYG - sumG * sumY) / determinant
    const baseline = (sumGG * sumY - sumG * sumYG) / determinant
    consider(amplitude, baseline, sumYY - (amplitude * sumYG + baseline * sumY))
  }

  let chosen = candidates[0]
  if (chosen === undefined) return null
  for (const candidate of candidates) {
    if (candidate.score < chosen.score) chosen = candidate
  }

  // Report the objective from the residuals, so a near-perfect fit cannot come
  // back as a small negative number and cannot hide cancellation error.
  let sse = 0
  for (const observation of observations) {
    const g = Math.exp(-q * observation.u)
    const residual = observation.c - chosen.baseline - chosen.amplitude * g
    sse += residual * residual
  }
  if (!Number.isFinite(sse) || sse < 0) return null

  return {
    amplitude: chosen.amplitude,
    baseline: chosen.baseline,
    sse,
  }
}

/**
 * Fit `B + A·exp(−k·(t − t_ref))` to measured observations.
 *
 * Unweighted least squares on the ORIGINAL concentration scale, every row an
 * independent observation — the same objective, rows and scaling as M0.
 */
export function fitMonoExponentialWithBaseline(
  measurements: readonly ExperimentalMeasurement[],
): MonoExponentialBaselineFitResult {
  const prepared = prepareMonoExponentialProblem(measurements)
  if (!prepared.ok) return failure(prepared.code, prepared.message)
  const { tRef, span, maxAbsConcentration, observations } = prepared.problem

  const objective = (q: number): number => {
    const solved = solveAmplitudeBaseline(observations, q)
    return solved === null ? Number.POSITIVE_INFINITY : solved.sse
  }

  // 1. Deterministic coarse scan over the whole documented range.
  let bestIndex = 0
  let bestValue = Number.POSITIVE_INFINITY
  const step = MAX_DIMENSIONLESS_RATE / COARSE_STEPS
  for (let index = 0; index <= COARSE_STEPS; index += 1) {
    const value = objective((MAX_DIMENSIONLESS_RATE * index) / COARSE_STEPS)
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
  const lo = Math.max(0, (bestIndex - 1) * step)
  const hi = Math.min(MAX_DIMENSIONLESS_RATE, (bestIndex + 1) * step)
  const refined = goldenSectionMinimize(objective, lo, hi)
  if (!Number.isFinite(refined.x) || !Number.isFinite(refined.value)) {
    return failure('NON_CONVERGED', 'The rate optimizer did not converge to a finite value.')
  }

  // 3. Endpoints are part of the admissible set and are compared explicitly.
  let qBest = refined.x
  let bestSse = refined.value
  const atZero = objective(0)
  const atUpper = objective(MAX_DIMENSIONLESS_RATE)
  if (atZero <= bestSse) {
    qBest = 0
    bestSse = atZero
  }
  if (atUpper < bestSse) {
    qBest = MAX_DIMENSIONLESS_RATE
    bestSse = atUpper
  }

  // 4. The published estimate is always a refined or explicitly evaluated
  //    point, never a coarse-grid value.
  const zeroRate = qBest <= ZERO_RATE_EPSILON
  const qFinal = zeroRate ? 0 : qBest

  const solved = solveAmplitudeBaseline(observations, qFinal)
  if (solved === null) {
    return failure('NON_FINITE', 'The fit produced a non-finite intermediate value.')
  }

  const scale = maxAbsConcentration
  const amplitude = solved.amplitude * scale
  const baseline = solved.baseline * scale
  const sse = solved.sse * scale * scale
  if (!Number.isFinite(amplitude) || !Number.isFinite(baseline) || !Number.isFinite(sse)) {
    return failure('NON_FINITE', 'The fitted parameters are not finite.')
  }

  const k = qFinal / span
  if (!Number.isFinite(k)) {
    return failure(
      'NON_FINITE',
      'The fitted decay rate is not representable as a finite number for this time span.',
    )
  }

  // Total change the decay term produces across the observed window.
  const decayContribution = amplitude * (1 - Math.exp(-qFinal))
  if (!Number.isFinite(decayContribution)) {
    return failure('NON_FINITE', 'The fitted decay contribution is not finite.')
  }
  const decayResolvable = decayContribution > DECAY_RESOLUTION_FRACTION * maxAbsConcentration
  const rateInformative = qFinal > 0 && decayResolvable

  const warnings: BaselineFitWarning[] = []
  if (zeroRate) {
    warnings.push({
      code: 'ZERO_RATE_BOUNDARY',
      message:
        'The best fit lies at the zero-rate boundary: the fitted model is a constant baseline and no positive decay rate is supported.',
    })
  }
  if (qFinal >= MAX_DIMENSIONLESS_RATE) {
    warnings.push({
      code: 'RATE_AT_UPPER_BOUND',
      message:
        'The optimum reached the numerical upper bound for the dimensionless rate, so the rate is unresolved beyond that limit and is not a reliable estimate.',
    })
  }
  if (!zeroRate && !decayResolvable) {
    warnings.push({
      code: 'ZERO_AMPLITUDE',
      message:
        'The decay amplitude is effectively zero: the decay term changes the fitted curve by less than 1e−9 of the largest observed concentration, so the rate is not informed by these data even though the fit converged.',
    })
  }
  if (baseline <= BASELINE_RESOLUTION_FRACTION * maxAbsConcentration) {
    warnings.push({
      code: 'BASELINE_AT_ZERO',
      message:
        'The fitted baseline sits on its lower bound (B = 0), so this fit has the same shape as the mono-exponential model without a baseline.',
    })
  }

  const halfLife = zeroRate ? undefined : Math.LN2 / k
  if (halfLife !== undefined && !Number.isFinite(halfLife)) {
    return failure('NON_FINITE', 'The derived half-life is not finite.')
  }

  return {
    ok: true,
    tRef,
    amplitude,
    baseline,
    k,
    ...(halfLife === undefined ? {} : { halfLife }),
    sse,
    measurementCount: measurements.length,
    meanParameterCount: 3,
    dimensionlessRate: qFinal,
    zeroRate,
    rateInformative,
    warnings,
  }
}
