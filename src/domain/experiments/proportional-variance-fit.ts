/**
 * Maximum-likelihood fits for the two candidate mean models under an EXPLICIT
 * alternative error model: independent Gaussian errors whose variance is
 * proportional to the model-predicted concentration.
 *
 *   Y_i | t_i  ~  Normal( μ_i , φ · μ_i ),   μ_i = μ(t_i; θ) > 0,  φ > 0
 *
 * `φ` has the unit of a CONCENTRATION (not a concentration squared): the
 * variance φ·μ then carries concentration², as it must. The mean models are the
 * existing candidates, unchanged:
 *
 *   M0  μ(t) = A · exp(−k · (t − t_ref))              A ≥ 0, k ≥ 0
 *   M1  μ(t) = B + A · exp(−k · (t − t_ref))          A ≥ 0, B ≥ 0, k ≥ 0
 *
 * WHY THIS IS NOT A WEIGHTED LEAST-SQUARES FIT. When the weights depend on the
 * fitted mean, minimising Σ (y−μ)²/μ is NOT equivalent to maximising the
 * Gaussian likelihood: the likelihood also carries Σ ln μ from the log-variance
 * term. This module therefore optimises the actual profile log-likelihood
 *
 *   −2 lnL(θ) = n·ln(2π) + n·ln(φ̂) + Σ ln μ_i + n,
 *   φ̂ = (1/n) Σ (y_i − μ_i)² / μ_i,
 *
 * and never an unweighted or weighted residual sum of squares. Reusing the
 * existing least-squares estimates here would be wrong: A, B and k are
 * re-estimated under this likelihood.
 *
 * CLOSED FORMS (exact, not approximations).
 *
 * M0, at a fixed dimensionless rate q = k·span:
 *   ∂/∂A of the profile objective gives  A = Σ y_i / Σ g_i,  g_i = exp(−q·u_i).
 *
 * M1, at fixed q, reparameterised as μ_i = m·h_i with
 *   h_i = (1−λ) + λ·g_i,  m = A + B > 0,  λ = A/(A+B) ∈ [0, 1]:
 *   the profile is minimised at  m = Σ y_i / Σ h_i,
 *   leaving a one-dimensional profile in λ that is searched deterministically.
 *
 * ZERO OBSERVATIONS ARE VALID. A zero observed concentration has a finite
 * Gaussian density for any strictly positive mean: its contribution is
 * ln(φμ) + μ/φ, which diverges only as μ → 0. Whether that makes the JOINT
 * likelihood unbounded depends on the mean model and on the other rows, so the
 * two candidates are analysed separately.
 *
 *   M0 (μ_i = A·exp(−q·u_i)). Driving one observation's prediction to zero
 *   requires q → ∞, because A is pinned by the positive observations. That
 *   drives EVERY u > 0 prediction to zero. If any of those observations is
 *   positive, its residual term grows like y²/μ and the deviance diverges to
 *   +∞, which rules out this particular sequence (the rate tending to
 *   infinity) as a source of an unbounded likelihood. It does NOT rule out
 *   every degeneracy: exact-fit degeneracy, where the dispersion tends to
 *   zero, is a separate failure mode (below). If every observation after the
 *   first measured time is exactly zero, nothing constrains the tail: φ̂ tends
 *   to a finite value while Σ ln μ_i → −∞, so the likelihood increases without
 *   bound and no MLE exists.
 *
 *   M1 (μ_i = B + A·exp(−q·u_i)). With B > 0 every prediction is ≥ B > 0, so no
 *   single contribution can diverge. The unbounded configuration appears only
 *   along B → 0 with q → ∞, which reduces to the M0 case; the criterion is
 *   therefore identical for both candidates.
 *
 * That zero-related configuration is rejected (`UNBOUNDED_LIKELIHOOD`); a
 * zero by itself does not invalidate a dataset. For example, 100, 20, 0 at
 * times 0, 1, 2 has a finite interior maximum (verified in the tests) and is
 * fitted normally.
 *
 * THE LIKELIHOOD IS ALSO UNBOUNDED WHERE THE FIT IS EXACT. If a candidate can
 * reproduce every observation with μ_i > 0, then φ̂ → 0 and −2 lnL → −∞. That
 * is a degenerate boundary of this error model, not an estimate. Such a fit is
 * reported as a STRUCTURED FAILURE (`DEGENERATE_DISPERSION`), never with a
 * substituted variance floor or epsilon. The same rule applies when a
 * predicted concentration is not strictly positive or not finite
 * (`NON_POSITIVE_PREDICTION`): the normal density is not defined there, so no
 * amount of clamping is scientifically legitimate.
 *
 * Pure: no React, DOM, Plotly or storage. Measurements are read only, and
 * every row — including exact replicates and duplicate timestamps — remains an
 * independent observation in source order.
 */
import { goldenSectionMinimize } from './bounded-minimize'
import type { ExperimentalMeasurement, QuantifiedMeasurement } from './experimental-dataset'
import {
  MAX_DIMENSIONLESS_RATE,
  prepareMonoExponentialProblem,
  type FitFailureCode,
  type NormalizedObservation,
} from './mono-exponential-fit'

/**
 * Identifier of the alternative error model. Deliberately distinct from the
 * homoscedastic identifier: criteria computed under the two are never mixed.
 */
export const GAUSSIAN_PROPORTIONAL_VARIANCE =
  'independent-gaussian-variance-proportional-to-mean'

export type ProportionalVarianceErrorModelId = typeof GAUSSIAN_PROPORTIONAL_VARIANCE

/** Exactly what the analyst is asked to declare. */
export const PROPORTIONAL_VARIANCE_STATEMENT =
  'Independent Gaussian errors whose variance is proportional to the model-predicted concentration on the original scale: Var(Yᵢ | tᵢ) = φ · μᵢ, with one positive dispersion φ in concentration units.'

/** Stated next to the declaration, so the UI cannot present it as a finding. */
export const PROPORTIONAL_VARIANCE_CAVEAT =
  'Declaring this is an assumption, not evidence: the data do not establish that the variance follows the fitted concentration, that errors are independent, or that they are Gaussian.'

/**
 * Coarse resolution of the dimensionless rate scan over [0, 50]. A numerical
 * screening grid, not a scientific threshold; the published estimate always
 * comes from the golden-section refinement or an explicit endpoint.
 */
const RATE_COARSE_STEPS = 100

/** Coarse resolution of the mixing fraction λ ∈ [0, 1] in the global scan. */
const LAMBDA_COARSE_STEPS = 8

/** A dimensionless rate at or below this is reported as k = 0. */
const ZERO_RATE_EPSILON = 1e-12

/**
 * Coordinate-refinement stopping rule and cap. The loop stops when a full round
 * improves the profile objective by less than this relative amount; the cap
 * bounds the worst case. Both are numerical convergence controls.
 */
const COORDINATE_TOLERANCE = 1e-12
const MAX_COORDINATE_ROUNDS = 12

/**
 * A fitted coefficient below this fraction of the concentration scale is
 * numerically zero (floating-point resolution statement, as in the baseline
 * fit). It is used to LABEL a boundary, never to replace a value.
 */
const COEFFICIENT_RESOLUTION = 1e-12

/**
 * A decay contribution below this fraction of the concentration scale is
 * numerically absent, so the rate carries no information even if the optimizer
 * converges. Numerical-resolution statement, not a scientific judgement.
 */
const DECAY_RESOLUTION = 1e-9

/**
 * Dispersion at or below this fraction of the concentration scale is treated as
 * numerically zero, i.e. the candidate reproduces the data to floating-point
 * resolution and the likelihood has no finite maximum. This is a REJECTION
 * threshold, never a variance floor: nothing is substituted, the fit fails.
 */
const DISPERSION_RESOLUTION = 32 * Number.EPSILON

export type ProportionalVarianceWarningCode =
  /** The optimum sits at q = 0: no identifiable positive rate. */
  | 'ZERO_RATE_BOUNDARY'
  /** The optimum reached the numerical upper bound on the dimensionless rate. */
  | 'RATE_AT_UPPER_BOUND'
  /** The decay term carries no resolvable contribution; the rate is uninformed. */
  | 'ZERO_AMPLITUDE'
  /** M1's baseline sits on its lower bound, so the mean model reduces to M0's shape. */
  | 'BASELINE_AT_ZERO'
  /** M1's amplitude sits on its lower bound, so the mean model is a constant. */
  | 'AMPLITUDE_AT_ZERO'

export interface ProportionalVarianceWarning {
  readonly code: ProportionalVarianceWarningCode
  readonly message: string
}

export type ProportionalVarianceFailureCode =
  | FitFailureCode
  /** φ̂ ≤ 0 or numerically zero: the likelihood has no finite maximum. */
  | 'DEGENERATE_DISPERSION'
  /**
   * Every observation after the earliest measured time is exactly zero. No
   * positive observation constrains the tail, so the likelihood grows without
   * bound as the rate increases and no finite maximum-likelihood estimate
   * exists. A zero observation on its own does NOT trigger this.
   */
  | 'UNBOUNDED_LIKELIHOOD'
  /** A predicted concentration was not strictly positive and finite. */
  | 'NON_POSITIVE_PREDICTION'

export interface ProportionalVarianceFitSuccess {
  readonly ok: true
  readonly modelId: 'M0' | 'M1'
  readonly label: string
  readonly formula: string
  readonly tRef: number
  /** Amplitude A at t_ref, in the dataset concentration unit (≥ 0). */
  readonly amplitude: number
  /** Additive baseline B for M1; null for M0. */
  readonly baseline: number | null
  /** First-order decay rate in reciprocal dataset time units (≥ 0). */
  readonly k: number
  /** ln(2)/k when k > 0; absent at the zero-rate boundary. */
  readonly halfLife?: number
  readonly dimensionlessRate: number
  /** φ in concentration units: Var(Y) = φ · μ. */
  readonly dispersion: number
  /** Maximized log-likelihood under this error model. */
  readonly logLikelihood: number
  /** −2 lnL, in the dataset's original concentration unit. */
  readonly deviance: number
  /**
   * Σ (y_i − μ_i)² / μ_i = n · φ̂, in the dataset concentration unit. This is
   * NOT the dimensionless Pearson sum: dividing by the variance φ·μ instead of
   * μ is what makes that sum equal to n.
   */
  readonly weightedResidualSum: number
  readonly measurementCount: number
  readonly meanParameterCount: 2 | 3
  /** Mean-model parameters plus the one dispersion parameter. */
  readonly totalParameterCount: number
  readonly zeroRate: boolean
  /** False when the decay term is numerically absent. */
  readonly rateInformative: boolean
  readonly hasBoundaryEstimate: boolean
  readonly warnings: readonly ProportionalVarianceWarning[]
}

export interface ProportionalVarianceFitFailure {
  readonly ok: false
  readonly code: ProportionalVarianceFailureCode
  readonly message: string
}

export type ProportionalVarianceFitResult =
  | ProportionalVarianceFitSuccess
  | ProportionalVarianceFitFailure

const failure = (
  code: ProportionalVarianceFailureCode,
  message: string,
): ProportionalVarianceFitFailure => ({ ok: false, code, message })

/** One evaluated point of the profile, in the normalized concentration scale. */
interface ProfileCandidate {
  readonly q: number
  /** Mixing fraction; 1 for M0 (baseline absent). */
  readonly lambda: number
  /** n·ln(φ̂) + Σ ln μ, the part of −2 lnL that depends on the mean parameters. */
  readonly objective: number
  readonly amplitude: number
  readonly baseline: number
  readonly dispersion: number
  readonly logLikelihood: number
}

interface ProfileContext {
  readonly observations: readonly NormalizedObservation[]
  readonly observationCount: number
  /** Σ c over all observations (normalized concentrations). */
  readonly totalConcentration: number
}

/**
 * M0 profile at a fixed dimensionless rate.
 *
 * `A = Σ c / Σ g` is the exact maximiser of the profile likelihood for this
 * error model. Returns null for any non-finite intermediate or a
 * non-positive prediction; the caller reports that as a gap, never as a value.
 */
function evaluateM0(context: ProfileContext, q: number): ProfileCandidate | null {
  const { observations, observationCount: n, totalConcentration } = context
  let sumG = 0
  for (const observation of observations) {
    const g = Math.exp(-q * observation.u)
    if (!(g > 0) || !Number.isFinite(g)) return null
    sumG += g
  }
  if (!(sumG > 0) || !Number.isFinite(sumG)) return null

  const amplitude = totalConcentration / sumG
  if (!(amplitude > 0) || !Number.isFinite(amplitude)) return null
  const logAmplitude = Math.log(amplitude)

  let weightedResidualSum = 0
  let logPredictionSum = 0
  for (const observation of observations) {
    const g = Math.exp(-q * observation.u)
    const predicted = amplitude * g
    if (!(predicted > 0) || !Number.isFinite(predicted)) return null
    const residual = observation.c - predicted
    weightedResidualSum += (residual * residual) / predicted
    // ln(μ) computed additively: μ itself may be far from 1 while its log is not.
    logPredictionSum += logAmplitude + Math.log(g)
  }
  if (!(weightedResidualSum > 0) || !Number.isFinite(weightedResidualSum)) return null
  if (!Number.isFinite(logPredictionSum)) return null

  const dispersion = weightedResidualSum / n
  if (!(dispersion > 0) || !Number.isFinite(dispersion)) return null
  const objective = n * Math.log(dispersion) + logPredictionSum
  if (!Number.isFinite(objective)) return null

  return {
    q,
    lambda: 1,
    objective,
    amplitude,
    baseline: 0,
    dispersion,
    logLikelihood: -(n * Math.log(2 * Math.PI) + objective + n) / 2,
  }
}

/**
 * M1 profile at a fixed dimensionless rate and mixing fraction.
 *
 * With `m = A + B` and `λ = A/(A+B)`, the profile is minimised at
 * `m = Σ c / Σ h`, so only λ is searched. Every point is re-evaluated from its
 * residuals (no normal-equation cancellation) and must have μ > 0.
 */
function evaluateM1(
  context: ProfileContext,
  q: number,
  decay: readonly number[],
  lambda: number,
): ProfileCandidate | null {
  if (!(lambda >= 0) || !(lambda <= 1) || !Number.isFinite(lambda)) return null
  const { observations, observationCount: n, totalConcentration } = context

  let sumH = 0
  for (const g of decay) {
    if (!(g > 0) || !Number.isFinite(g)) return null
    sumH += 1 - lambda + lambda * g
  }
  if (!(sumH > 0) || !Number.isFinite(sumH)) return null

  const total = totalConcentration / sumH
  if (!(total > 0) || !Number.isFinite(total)) return null
  const logTotal = Math.log(total)

  let weightedResidualSum = 0
  let logPredictionSum = 0
  for (let index = 0; index < n; index += 1) {
    const g = decay[index] as number
    const h = 1 - lambda + lambda * g
    if (!(h > 0) || !Number.isFinite(h)) return null
    const predicted = total * h
    if (!(predicted > 0) || !Number.isFinite(predicted)) return null
    const residual = (observations[index] as NormalizedObservation).c - predicted
    weightedResidualSum += (residual * residual) / predicted
    logPredictionSum += logTotal + Math.log(h)
  }
  if (!(weightedResidualSum > 0) || !Number.isFinite(weightedResidualSum)) return null
  if (!Number.isFinite(logPredictionSum)) return null

  const dispersion = weightedResidualSum / n
  if (!(dispersion > 0) || !Number.isFinite(dispersion)) return null
  const objective = n * Math.log(dispersion) + logPredictionSum
  if (!Number.isFinite(objective)) return null

  return {
    q,
    lambda,
    objective,
    amplitude: total * lambda,
    baseline: total * (1 - lambda),
    dispersion,
    logLikelihood: -(n * Math.log(2 * Math.PI) + objective + n) / 2,
  }
}

/**
 * exp(−q·u) for every observation, computed once per trial rate.
 *
 * The mixing-fraction search reuses this array instead of recomputing an
 * exponential per observation per λ, which is the dominant cost at large n.
 * Returns null if any factor is not strictly positive and finite.
 */
function decayFactors(context: ProfileContext, q: number): number[] | null {
  const decay: number[] = []
  for (const observation of context.observations) {
    const g = Math.exp(-q * observation.u)
    if (!(g > 0) || !Number.isFinite(g)) return null
    decay.push(g)
  }
  return decay
}

function better(
  candidate: ProfileCandidate | null,
  incumbent: ProfileCandidate | null,
): ProfileCandidate | null {
  if (candidate === null) return incumbent
  if (incumbent === null) return candidate
  return candidate.objective < incumbent.objective ? candidate : incumbent
}

/**
 * Minimise the M1 profile over λ ∈ [0, 1] at a fixed rate.
 *
 * Deterministic coarse scan, golden-section refinement inside the bracket of
 * the best scanned point, then an explicit comparison against both endpoints —
 * the constrained optimum can legitimately sit at λ = 0 (constant mean) or
 * λ = 1 (baseline at zero). A coarse-grid value is never returned unless it is
 * also the best point evaluated.
 */
function bestLambda(context: ProfileContext, q: number): ProfileCandidate | null {
  const decay = decayFactors(context, q)
  if (decay === null) return null
  return bestLambdaWithDecay(context, q, decay)
}

function bestLambdaWithDecay(
  context: ProfileContext,
  q: number,
  decay: readonly number[],
): ProfileCandidate | null {
  let best: ProfileCandidate | null = null
  let bestIndex = 0
  for (let index = 0; index <= LAMBDA_COARSE_STEPS; index += 1) {
    const lambda = index / LAMBDA_COARSE_STEPS
    const candidate = evaluateM1(context, q, decay, lambda)
    if (candidate !== null && (best === null || candidate.objective < best.objective)) {
      best = candidate
      bestIndex = index
    }
  }
  if (best === null) return null

  const step = 1 / LAMBDA_COARSE_STEPS
  const lo = Math.max(0, (bestIndex - 1) * step)
  const hi = Math.min(1, (bestIndex + 1) * step)
  const refined = goldenSectionMinimize(
    (lambda) => {
      const candidate = evaluateM1(context, q, decay, lambda)
      return candidate === null ? Number.POSITIVE_INFINITY : candidate.objective
    },
    lo,
    hi,
  )
  if (Number.isFinite(refined.x) && Number.isFinite(refined.value)) {
    best = better(evaluateM1(context, q, decay, refined.x), best)
  }

  // Explicit endpoints: the constrained optimum may sit on either boundary,
  // where the mean model degenerates to a constant or to the M0 shape.
  best = better(evaluateM1(context, q, decay, 0), best)
  best = better(evaluateM1(context, q, decay, 1), best)
  return best
}

/**
 * M1 search: a global two-dimensional coarse scan over (q, λ), followed by
 * coordinate golden-section refinement and a final conditional λ solve at the
 * published rate.
 *
 * WHY COORDINATE REFINEMENT. Evaluating the conditional λ optimum inside every
 * trial rate would multiply the cost by the λ search for no benefit at these
 * sample sizes; the coordinate scheme keeps the work bounded while every
 * published value is still a refined point. The global coarse scan brackets the
 * basin, two refinement rounds absorb the coupling between q and λ, and the
 * final λ solve guarantees that the reported mixing fraction is conditionally
 * optimal at the reported rate. A coarse-grid value is never published: the
 * returned candidate is the best EVALUATED point and carries its own q.
 */
function refineMixing(
  context: ProfileContext,
  q: number,
  seed: number,
  halfWidth: number,
): ProfileCandidate | null {
  const decay = decayFactors(context, q)
  if (decay === null) return null
  const seedCandidate = evaluateM1(context, q, decay, Math.min(1, Math.max(0, seed)))
  const lo = Math.max(0, seed - halfWidth)
  const hi = Math.min(1, seed + halfWidth)
  const refined = goldenSectionMinimize(
    (lambda) => {
      const candidate = evaluateM1(context, q, decay, lambda)
      return candidate === null ? Number.POSITIVE_INFINITY : candidate.objective
    },
    lo,
    hi,
  )
  let best = seedCandidate
  if (Number.isFinite(refined.x) && Number.isFinite(refined.value)) {
    best = better(evaluateM1(context, q, decay, refined.x), best)
  }
  return best
}

function refineRate(
  context: ProfileContext,
  seed: number,
  lambda: number,
  halfWidth: number,
): ProfileCandidate | null {
  const at = (q: number): ProfileCandidate | null => {
    const decay = decayFactors(context, q)
    if (decay === null) return null
    return evaluateM1(context, q, decay, lambda)
  }
  const seedCandidate = at(seed)
  const lo = Math.max(0, seed - halfWidth)
  const hi = Math.min(MAX_DIMENSIONLESS_RATE, seed + halfWidth)
  const refined = goldenSectionMinimize(
    (q) => {
      const candidate = at(q)
      return candidate === null ? Number.POSITIVE_INFINITY : candidate.objective
    },
    lo,
    hi,
  )
  let best = seedCandidate
  if (Number.isFinite(refined.x) && Number.isFinite(refined.value)) {
    best = better(at(refined.x), best)
  }
  return best
}

function searchRateAndMixing(context: ProfileContext): ProfileCandidate | null {
  const qStep = MAX_DIMENSIONLESS_RATE / RATE_COARSE_STEPS
  const lambdaStep = 1 / LAMBDA_COARSE_STEPS

  // 1. Global coarse scan. It brackets the basin for the refinements below.
  let best: ProfileCandidate | null = null
  for (let rateIndex = 0; rateIndex <= RATE_COARSE_STEPS; rateIndex += 1) {
    const q = rateIndex * qStep
    const decay = decayFactors(context, q)
    if (decay === null) continue
    for (let lambdaIndex = 0; lambdaIndex <= LAMBDA_COARSE_STEPS; lambdaIndex += 1) {
      const candidate = evaluateM1(context, q, decay, lambdaIndex * lambdaStep)
      best = better(candidate, best)
    }
  }
  if (best === null) return null

  // 2. Coordinate refinement. The q/λ optimum can sit on a curved ridge, where
  //    a fixed number of rounds may stop short of the joint optimum, so the
  //    loop runs until the objective stops improving (or a documented cap).
  let current: ProfileCandidate = best
  let q = current.q
  let lambda = current.lambda
  let previousObjective = current.objective
  for (let round = 0; round < MAX_COORDINATE_ROUNDS; round += 1) {
    const mixed = refineMixing(context, q, lambda, lambdaStep)
    if (mixed !== null) {
      const improved = better(mixed, current)
      if (improved !== null) current = improved
      lambda = mixed.lambda
    }
    const rated = refineRate(context, q, lambda, qStep)
    if (rated !== null) {
      const improved = better(rated, current)
      if (improved !== null) current = improved
      q = rated.q
    }
    const improvement = previousObjective - current.objective
    previousObjective = current.objective
    if (improvement <= COORDINATE_TOLERANCE * (1 + Math.abs(current.objective))) break
  }

  // 3. Conditional λ solve at the published rate, then the endpoints of q.
  current = better(bestLambda(context, q), current) ?? current
  current = better(bestLambda(context, 0), current) ?? current
  current = better(bestLambda(context, MAX_DIMENSIONLESS_RATE), current) ?? current
  return current
}

/**
 * Shared deterministic search across q ∈ [0, MAX_DIMENSIONLESS_RATE].
 *
 * A coarse scan establishes the bracket, golden-section refines inside it, and
 * both endpoints are compared explicitly. `at` must return null for a failed
 * evaluation; those gaps are never filled in.
 */
function searchRate(
  at: (q: number) => ProfileCandidate | null,
): ProfileCandidate | null {
  let best: ProfileCandidate | null = null
  let bestIndex = 0
  for (let index = 0; index <= RATE_COARSE_STEPS; index += 1) {
    const q = (MAX_DIMENSIONLESS_RATE * index) / RATE_COARSE_STEPS
    const candidate = at(q)
    if (candidate !== null && (best === null || candidate.objective < best.objective)) {
      best = candidate
      bestIndex = index
    }
  }
  if (best === null) return null

  const step = MAX_DIMENSIONLESS_RATE / RATE_COARSE_STEPS
  const lo = Math.max(0, (bestIndex - 1) * step)
  const hi = Math.min(MAX_DIMENSIONLESS_RATE, (bestIndex + 1) * step)
  const refined = goldenSectionMinimize(
    (q) => {
      const candidate = at(q)
      return candidate === null ? Number.POSITIVE_INFINITY : candidate.objective
    },
    lo,
    hi,
  )
  if (Number.isFinite(refined.x) && Number.isFinite(refined.value)) {
    best = better(at(refined.x), best)
  }

  // Endpoints are part of the admissible set and must be represented even if
  // the golden-section bracket never includes them.
  best = better(at(0), best)
  best = better(at(MAX_DIMENSIONLESS_RATE), best)
  return best
}

const M0_LABEL = 'M0 · mono-exponential decay'
const M0_FORMULA = 'C(t) = A · exp(−k · (t − t_ref))'
const M1_LABEL = 'M1 · mono-exponential decay with additive baseline'
const M1_FORMULA = 'C(t) = B + A · exp(−k · (t − t_ref))'

/**
 * Model identity for presentation, available even when a candidate failed and
 * therefore has no result object to read a label from.
 */
export const PROPORTIONAL_VARIANCE_MODEL_LABELS = { M0: M0_LABEL, M1: M1_LABEL } as const
export const PROPORTIONAL_VARIANCE_MODEL_FORMULAS = { M0: M0_FORMULA, M1: M1_FORMULA } as const

/**
 * Turn a normalized profile optimum into the published result.
 *
 * Normalization divided every concentration by the largest observed value, so
 * amplitudes, the baseline and φ are multiplied back by that scale, and the
 * log-likelihood gains the Jacobian term −n·ln(scale) that the density of a
 * rescaled response requires. The reported numbers are therefore on the
 * dataset's original concentration scale, and φ is in concentration units.
 */
function publish(
  modelId: 'M0' | 'M1',
  candidate: ProfileCandidate,
  tRef: number,
  scale: number,
  span: number,
  measurementCount: number,
): ProportionalVarianceFitResult {
  const n = measurementCount
  const amplitude = candidate.amplitude * scale
  const baseline = candidate.baseline * scale
  const dispersion = candidate.dispersion * scale
  const logLikelihood = candidate.logLikelihood - n * Math.log(scale)
  const deviance = -2 * logLikelihood
  const weightedResidualSum = candidate.dispersion * n * scale

  if (
    !Number.isFinite(amplitude) ||
    !Number.isFinite(baseline) ||
    !Number.isFinite(dispersion) ||
    !Number.isFinite(logLikelihood) ||
    !Number.isFinite(deviance)
  ) {
    return failure('NON_FINITE', 'The fitted parameters are not representable as finite numbers.')
  }
  if (amplitude < 0 || baseline < 0) {
    return failure('NON_FINITE', 'A fitted coefficient is negative, which the constrained model forbids.')
  }
  if (!(dispersion > DISPERSION_RESOLUTION * scale)) {
    return failure(
      'DEGENERATE_DISPERSION',
      'The candidate reproduces every observation to floating-point resolution, so the dispersion is numerically zero and this likelihood has no finite maximum.',
    )
  }

  const k = candidate.q / span
  if (!Number.isFinite(k)) {
    return failure(
      'NON_FINITE',
      'The fitted decay rate is not representable as a finite number for this time span.',
    )
  }

  const zeroRate = candidate.q <= ZERO_RATE_EPSILON
  const atUpperBound = candidate.q >= MAX_DIMENSIONLESS_RATE
  const amplitudeIsZero = amplitude <= COEFFICIENT_RESOLUTION * scale
  const baselineIsZero = modelId === 'M1' && baseline <= COEFFICIENT_RESOLUTION * scale
  const decayContribution = amplitude * (1 - Math.exp(-candidate.q))
  const rateInformative =
    !zeroRate && !atUpperBound && decayContribution > DECAY_RESOLUTION * scale

  const warnings: ProportionalVarianceWarning[] = []
  if (zeroRate) {
    warnings.push({
      code: 'ZERO_RATE_BOUNDARY',
      message:
        'The best likelihood lies at the zero-rate boundary: the constrained mean model finds no positive decay rate, and no finite half-life is available.',
    })
  }
  if (atUpperBound) {
    warnings.push({
      code: 'RATE_AT_UPPER_BOUND',
      message:
        'The optimum reached the numerical upper bound for the dimensionless rate, so the rate is unresolved beyond that limit.',
    })
  }
  if (!zeroRate && !rateInformative) {
    warnings.push({
      code: 'ZERO_AMPLITUDE',
      message:
        'The decay term contributes nothing resolvable across the observed window, so the rate is not informed by these data even though the likelihood has a maximum.',
    })
  }
  if (modelId === 'M1') {
    if (baselineIsZero) {
      warnings.push({
        code: 'BASELINE_AT_ZERO',
        message:
          'The fitted baseline lies on its lower bound, so the mean model has the same shape as the decay model without a baseline.',
      })
    }
    if (amplitudeIsZero) {
      warnings.push({
        code: 'AMPLITUDE_AT_ZERO',
        message:
          'The fitted amplitude lies on its lower bound, so the mean model is a constant at the fitted baseline.',
      })
    }
  }

  const halfLife = zeroRate ? undefined : Math.LN2 / k
  if (halfLife !== undefined && !Number.isFinite(halfLife)) {
    return failure('NON_FINITE', 'The derived half-life is not finite.')
  }

  return {
    ok: true,
    modelId,
    label: modelId === 'M0' ? M0_LABEL : M1_LABEL,
    formula: modelId === 'M0' ? M0_FORMULA : M1_FORMULA,
    tRef,
    amplitude,
    baseline: modelId === 'M0' ? null : baseline,
    k,
    ...(halfLife === undefined ? {} : { halfLife }),
    dimensionlessRate: candidate.q,
    dispersion,
    logLikelihood,
    deviance,
    weightedResidualSum,
    measurementCount,
    meanParameterCount: modelId === 'M0' ? 2 : 3,
    totalParameterCount: (modelId === 'M0' ? 2 : 3) + 1,
    zeroRate,
    rateInformative,
    hasBoundaryEstimate: zeroRate || atUpperBound || !rateInformative || amplitudeIsZero || baselineIsZero,
    warnings,
  }
}

function prepareContext(
  measurements: readonly ExperimentalMeasurement[],
):
  | { readonly ok: true; readonly context: ProfileContext; readonly tRef: number; readonly span: number; readonly scale: number }
  | { readonly ok: false; readonly failure: ProportionalVarianceFitFailure } {
  const prepared = prepareMonoExponentialProblem(measurements)
  if (!prepared.ok) {
    return { ok: false, failure: failure(prepared.code, prepared.message) }
  }
  const { problem } = prepared
  // A zero observation is valid: its density is finite for any μ > 0. What makes
  // the JOINT likelihood unbounded is the absence of any positive observation
  // after the reference time. For M0, driving a late prediction to zero needs
  // q → ∞, which also drives every other u > 0 prediction to zero; a positive
  // row there would make the deviance diverge to +∞. Only when every late row is
  // zero does φ̂ stay finite while Σ ln μ_i → −∞. For M1 the same sequence
  // requires B → 0, so the criterion is identical. See the module docs.
  let allLaterObservationsAreZero = true
  let hasLaterObservation = false
  for (const measurement of measurements) {
    if (measurement.time > problem.tRef) {
      hasLaterObservation = true
      if ((measurement as QuantifiedMeasurement).concentration !== 0) {
        allLaterObservationsAreZero = false
        break
      }
    }
  }
  if (hasLaterObservation && allLaterObservationsAreZero) {
    return {
      ok: false,
      failure: failure(
        'UNBOUNDED_LIKELIHOOD',
        'Every observation after the earliest measured time is exactly zero, so no positive observation constrains the tail. As the decay rate grows, the predicted concentrations approach zero and the likelihood increases without bound: no finite maximum-likelihood estimate exists. This configuration is rejected rather than reported as a fit at the numerical rate cap.',
      ),
    }
  }
  let totalConcentration = 0
  for (const observation of problem.observations) {
    if (!Number.isFinite(observation.c) || observation.c < 0) {
      return {
        ok: false,
        failure: failure('INVALID_MEASUREMENT', 'A normalized concentration is invalid.'),
      }
    }
    totalConcentration += observation.c
  }
  if (!(totalConcentration > 0) || !Number.isFinite(totalConcentration)) {
    return {
      ok: false,
      failure: failure(
        'DEGENERATE_DISPERSION',
        'Every normalized concentration is zero, so no positive prediction is possible.',
      ),
    }
  }
  return {
    ok: true,
    context: {
      observations: problem.observations,
      observationCount: problem.observations.length,
      totalConcentration,
    },
    tRef: problem.tRef,
    span: problem.span,
    scale: problem.maxAbsConcentration,
  }
}

/**
 * Fit M0 by maximum likelihood under Var(Y) = φ·μ.
 *
 * The estimate is NOT the existing least-squares estimate: A is re-estimated
 * as Σ y / Σ g at each trial rate. The existing fit is untouched and remains
 * available on its own path.
 */
export function fitProportionalVarianceDecay(
  measurements: readonly ExperimentalMeasurement[],
): ProportionalVarianceFitResult {
  const prepared = prepareContext(measurements)
  if (!prepared.ok) return prepared.failure
  const { context, tRef, span, scale } = prepared

  const candidate = searchRate((q) => evaluateM0(context, q))
  if (candidate === null) {
    return failure(
      'DEGENERATE_OBJECTIVE',
      'The likelihood could not be evaluated at any admissible rate.',
    )
  }
  return publish('M0', candidate, tRef, scale, span, context.observationCount)
}

/**
 * Fit M1 by maximum likelihood under Var(Y) = φ·μ.
 *
 * The inner amplitude/baseline problem is solved exactly for each (q, λ); the
 * published estimate is the best refined point, never a coarse-grid value.
 */
export function fitProportionalVarianceWithBaseline(
  measurements: readonly ExperimentalMeasurement[],
): ProportionalVarianceFitResult {
  const prepared = prepareContext(measurements)
  if (!prepared.ok) return prepared.failure
  const { context, tRef, span, scale } = prepared

  const candidate = searchRateAndMixing(context)
  if (candidate === null) {
    return failure(
      'DEGENERATE_OBJECTIVE',
      'The likelihood could not be evaluated at any admissible rate and mixing fraction.',
    )
  }
  return publish('M1', candidate, tRef, scale, span, context.observationCount)
}
