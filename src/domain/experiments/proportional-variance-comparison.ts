/**
 * Two-candidate comparison under the PROPORTIONAL-VARIANCE error model.
 *
 * This is a separate likelihood path from the homoscedastic comparison:
 *
 *   independent Gaussian errors, Var(Y_i | t_i) = φ · μ_i,  φ > 0
 *
 * Both mean models are RE-FITTED under this likelihood; the existing
 * least-squares estimates are never reused as if they were maximum-likelihood
 * estimates here. Criteria from the two error models are never mixed, ranked
 * together or substituted for one another.
 *
 * With n observations, total estimated likelihood parameters K (mean-model
 * parameters plus the dispersion φ) and maximised log-likelihood lnL̂:
 *
 *   AIC  = −2·lnL̂ + 2K
 *   AICc = AIC + 2K(K+1)/(n − K − 1)
 *
 * K is read from the statistical model, not from the optimizer: M1's amplitude
 * is obtained from a closed-form profile at each trial rate, but it is still an
 * estimated mean-model parameter.
 *
 * AICc is unavailable — with a structured reason, never a substituted number —
 * when the assumption is undeclared, a candidate has no finite likelihood, the
 * dispersion is numerically zero, or n − K − 1 ≤ 0.
 *
 * Pure: no React, DOM, Plotly or storage.
 */
import type { ExperimentalMeasurement } from './experimental-dataset'
import { prepareMonoExponentialProblem } from './mono-exponential-fit'
import {
  GAUSSIAN_PROPORTIONAL_VARIANCE,
  PROPORTIONAL_VARIANCE_CAVEAT,
  PROPORTIONAL_VARIANCE_STATEMENT,
  fitProportionalVarianceDecay,
  fitProportionalVarianceWithBaseline,
  type ProportionalVarianceErrorModelId,
  type ProportionalVarianceFitResult,
} from './proportional-variance-fit'

export type ProportionalVarianceComparisonFailureCode =
  | 'MEASUREMENT_MISMATCH'
  | 'INVALID_MEASUREMENT'
  | 'NON_FINITE_PARAMETER'

export interface ProportionalVarianceComparison {
  readonly ok: true
  readonly observationCount: number
  readonly distinctTimeCount: number
  /** M0 first, M1 second, both fitted under Var = φ·μ. */
  readonly models: readonly [ProportionalVarianceFitResult, ProportionalVarianceFitResult]
  readonly notes: readonly string[]
}

export interface ProportionalVarianceComparisonFailure {
  readonly ok: false
  readonly code: ProportionalVarianceComparisonFailureCode
  readonly message: string
}

export type ProportionalVarianceComparisonResult =
  | ProportionalVarianceComparison
  | ProportionalVarianceComparisonFailure

export type ProportionalVarianceAiccUnavailableCode =
  /** The analyst has not declared this error model. */
  | 'ASSUMPTION_NOT_DECLARED'
  /** This candidate has no successful fit under this likelihood. */
  | 'FIT_UNAVAILABLE'
  /** The maximised log-likelihood or deviance is not finite. */
  | 'NON_FINITE_LIKELIHOOD'
  /** φ̂ is not strictly positive, so the Gaussian variance is degenerate. */
  | 'ZERO_DISPERSION'
  /** n − K − 1 ≤ 0, so the small-sample correction is not defined. */
  | 'INSUFFICIENT_OBSERVATIONS'

export interface ProportionalVarianceAiccAvailable {
  readonly ok: true
  readonly errorModel: ProportionalVarianceErrorModelId
  readonly observationCount: number
  readonly totalParameterCount: number
  readonly logLikelihood: number
  readonly deviance: number
  /** φ̂ in concentration units. */
  readonly dispersion: number
  readonly aic: number
  /** 2K(K+1)/(n − K − 1). */
  readonly correction: number
  readonly aicc: number
}

export interface ProportionalVarianceAiccUnavailable {
  readonly ok: false
  readonly code: ProportionalVarianceAiccUnavailableCode
  readonly message: string
}

export type ProportionalVarianceAicc =
  | ProportionalVarianceAiccAvailable
  | ProportionalVarianceAiccUnavailable

export interface ProportionalVarianceCriterion {
  readonly errorModel: ProportionalVarianceErrorModelId | null
  readonly assumptionStatement: string
  readonly caveat: string
  readonly m0: ProportionalVarianceAicc
  readonly m1: ProportionalVarianceAicc
  /** m1.aicc − m0.aicc, arithmetic only; null unless both values exist. */
  readonly difference: number | null
}

const unavailable = (
  code: ProportionalVarianceAiccUnavailableCode,
  message: string,
): ProportionalVarianceAiccUnavailable => ({ ok: false, code, message })

/** The limitations reported with every proportional-variance comparison. */
export function proportionalVarianceComparisonNotes(): readonly string[] {
  return [
    'Both candidates are re-fitted under this likelihood to the same rows, reference time, observed span, original concentration scale and source order. Replicates and duplicate timestamps remain separate observations.',
    'This is a different likelihood from the common-variance comparison shown above. AICc values from the two error models are not comparable, are never ranked against each other, and are never substituted for one another.',
    'AICc is relative support WITHIN these two mean models under the declared variance function. It is not proof of the mechanism and says nothing about a model outside this pair.',
    'Declaring the variance function is an assumption, not evidence: this comparison does not test whether the variance really is proportional to the fitted concentration, nor whether errors are independent or Gaussian.',
    'The likelihood requires every predicted concentration to be strictly positive and finite. Candidates that cannot satisfy that are reported as failures; no epsilon, variance floor or clamping is applied to make an invalid likelihood computable.',
    'An observed concentration of zero is valid: its density is finite for any positive prediction. A dataset whose every observation after the earliest measured time is zero is rejected, because nothing constrains the tail and the likelihood increases without bound as the rate grows.',
    'When a candidate reproduces the data to floating-point resolution, the dispersion is numerically zero and the likelihood has no finite maximum. The criterion is withheld in that case.',
    'Boundary estimates and nonlinear fitting weaken the regularity assumptions behind information criteria. Boundary warnings are shown, and the comparison is less reliable when they appear.',
    'No hypothesis test, confidence interval, standard error, model weight, probability or winner classification is produced, and no AICc threshold is applied.',
  ]
}

/**
 * Fit both candidates under Var = φ·μ and return their descriptive results.
 *
 * Never substitutes a plausible fit for a failed one: a failed candidate stays
 * in the tuple with its structured failure code and message.
 */
export function compareProportionalVarianceModels(
  measurements: readonly ExperimentalMeasurement[],
): ProportionalVarianceComparisonResult {
  const prepared = prepareMonoExponentialProblem(measurements)
  if (!prepared.ok) {
    const code: ProportionalVarianceComparisonFailureCode =
      prepared.code === 'INVALID_MEASUREMENT' || prepared.code === 'NEGATIVE_VALUE'
        ? 'INVALID_MEASUREMENT'
        : 'MEASUREMENT_MISMATCH'
    return { ok: false, code, message: prepared.message }
  }

  const distinctTimes = new Set<number>()
  for (const measurement of measurements) {
    if (
      measurement === null ||
      typeof measurement !== 'object' ||
      typeof measurement.time !== 'number' ||
      !Number.isFinite(measurement.time)
    ) {
      return {
        ok: false,
        code: 'INVALID_MEASUREMENT',
        message: 'A measurement is invalid; the comparison is unavailable.',
      }
    }
    distinctTimes.add(measurement.time)
  }

  const m0 = fitProportionalVarianceDecay(measurements)
  const m1 = fitProportionalVarianceWithBaseline(measurements)

  return {
    ok: true,
    observationCount: measurements.length,
    distinctTimeCount: distinctTimes.size,
    models: [m0, m1],
    notes: proportionalVarianceComparisonNotes(),
  }
}

/**
 * AICc for one candidate under the declared proportional-variance model.
 *
 * `AIC = −2·lnL̂ + 2K` uses the maximised likelihood returned by the fit — not
 * a weighted residual sum of squares, which is not the objective of this
 * likelihood.
 */
export function computeProportionalVarianceAicc(input: {
  readonly declared: boolean
  readonly errorModel: ProportionalVarianceErrorModelId | null
  readonly fit: ProportionalVarianceFitResult
}): ProportionalVarianceAicc {
  const { declared, errorModel, fit } = input
  if (!declared || errorModel !== GAUSSIAN_PROPORTIONAL_VARIANCE) {
    return unavailable(
      'ASSUMPTION_NOT_DECLARED',
      'AICc under this variance function requires its own explicit declaration; none has been declared for this comparison.',
    )
  }
  if (!fit.ok) {
    return unavailable('FIT_UNAVAILABLE', fit.message)
  }
  if (
    !Number.isFinite(fit.logLikelihood) ||
    !Number.isFinite(fit.deviance) ||
    !Number.isFinite(fit.dispersion)
  ) {
    return unavailable(
      'NON_FINITE_LIKELIHOOD',
      'The maximised likelihood or its dispersion is not finite.',
    )
  }
  if (!(fit.dispersion > 0)) {
    return unavailable(
      'ZERO_DISPERSION',
      'The dispersion estimate is zero, so the Gaussian variance is degenerate and the criterion is not defined.',
    )
  }
  const n = fit.measurementCount
  const k = fit.totalParameterCount
  if (!Number.isInteger(n) || !Number.isInteger(k) || n <= 0 || k <= 0) {
    return unavailable(
      'INSUFFICIENT_OBSERVATIONS',
      'The observation or parameter count is not a positive whole number.',
    )
  }
  if (n - k - 1 <= 0) {
    return unavailable(
      'INSUFFICIENT_OBSERVATIONS',
      'There are not enough observations for the small-sample correction: n − K − 1 must be positive.',
    )
  }

  const aic = fit.deviance + 2 * k
  const correction = (2 * k * (k + 1)) / (n - k - 1)
  const aicc = aic + correction
  if (!Number.isFinite(aic) || !Number.isFinite(correction) || !Number.isFinite(aicc)) {
    return unavailable('NON_FINITE_LIKELIHOOD', 'The information criterion is not finite for this fit.')
  }

  return {
    ok: true,
    errorModel: GAUSSIAN_PROPORTIONAL_VARIANCE,
    observationCount: n,
    totalParameterCount: k,
    logLikelihood: fit.logLikelihood,
    deviance: fit.deviance,
    dispersion: fit.dispersion,
    aic,
    correction,
    aicc,
  }
}

/**
 * Criterion block for an existing comparison.
 *
 * Kept separate from the fitting function so declaring or withdrawing the
 * assumption never re-fits either candidate.
 */
export function buildProportionalVarianceCriterion(
  comparison: ProportionalVarianceComparison,
  declared: boolean,
): ProportionalVarianceCriterion {
  const errorModel = declared ? GAUSSIAN_PROPORTIONAL_VARIANCE : null
  const m0 = computeProportionalVarianceAicc({ declared, errorModel, fit: comparison.models[0] })
  const m1 = computeProportionalVarianceAicc({ declared, errorModel, fit: comparison.models[1] })
  return {
    errorModel,
    assumptionStatement: PROPORTIONAL_VARIANCE_STATEMENT,
    caveat: PROPORTIONAL_VARIANCE_CAVEAT,
    m0,
    m1,
    difference: m0.ok && m1.ok ? m1.aicc - m0.aicc : null,
  }
}
