/**
 * Two-candidate model comparison with a CONDITIONAL AICc (phase 47C).
 *
 * Candidate set — fixed and deliberately small:
 *   M0  C(t) = A · exp(−k · (t − t_ref))          A ≥ 0, k ≥ 0
 *   M1  C(t) = B + A · exp(−k · (t − t_ref))      A ≥ 0, B ≥ 0, k ≥ 0
 *
 * M0 is the existing production fit, reused verbatim. M1 is fitted to exactly
 * the same rows, reference time, span, original concentration scale, weights
 * and objective. Adding a third candidate is out of scope.
 *
 * AICc is available only when the analyst DECLARES the one supported error
 * model:
 *
 *   independent additive Gaussian errors with a common variance on the
 *   original concentration scale
 *
 * Declaring it is an assumption, not evidence: the data do not establish
 * homoscedastic additive Gaussian errors, and nothing here tests them.
 *
 * AICc is reported as RELATIVE support inside this two-model candidate set
 * under that assumption. It is not proof of a mechanism, not a goodness-of-fit
 * verdict, and not a confidence statement. No weights, tests, intervals,
 * standard errors or winner labels are produced, and no threshold is applied.
 *
 * Pure: no React, DOM, Plotly or storage.
 */
import {
  censoredRefusalMessage,
  type ExperimentalMeasurement,
  type QuantifiedMeasurement,
} from './experimental-dataset'
import {
  fitMonoExponentialWithBaseline,
  type BaselineFitWarning,
  type MonoExponentialBaselineFitResult,
} from './mono-exponential-baseline-fit'
import type { MonoExponentialFitResult } from './mono-exponential-fit'

type SuccessfulFit = Extract<MonoExponentialFitResult, { ok: true }>

/** The candidate models of this increment. */
export type CandidateModelId = 'M0' | 'M1'

/** The only error model supported here. There is deliberately no second one. */
export const GAUSSIAN_ADDITIVE_ERROR_MODEL = 'independent-additive-gaussian-common-variance'

export type ErrorModelId = typeof GAUSSIAN_ADDITIVE_ERROR_MODEL

/** Exactly what the analyst is asked to declare. */
export const ERROR_MODEL_STATEMENT =
  'Independent additive Gaussian errors with a common variance on the original concentration scale.'

/** Stated next to the declaration, so the UI cannot present it as a finding. */
export const ERROR_MODEL_CAVEAT =
  'Declaring this is an assumption, not evidence: the data do not establish that the residuals are independent, Gaussian or equally uncertain.'

/**
 * One variance parameter per model, on top of its mean-model parameters.
 *
 * This is the count that enters the information criterion — NOT the number of
 * variables a nonlinear optimizer iterates over. An amplitude obtained by
 * variable projection is still an estimated model parameter.
 */
export const VARIANCE_PARAMETER_COUNT = 1

/** One estimated mean-model parameter, with the unit KIND it carries. */
export interface ComparisonParameter {
  readonly key: 'A' | 'B' | 'k'
  readonly label: string
  readonly value: number
  /** Resolved to the dataset's declared unit by the presentation layer. */
  readonly unit: 'concentration' | 'inverse-time'
}

export interface FittedCandidateModel {
  readonly ok: true
  readonly modelId: CandidateModelId
  readonly label: string
  readonly formula: string
  readonly meanParameterCount: 2 | 3
  /**
   * Mean-model parameters plus `VARIANCE_PARAMETER_COUNT`. Typed as a number so
   * the sum cannot silently disagree with its inputs; the unit tests pin the
   * actual values (3 for M0, 4 for M1).
   */
  readonly totalParameterCount: number
  readonly measurementCount: number
  readonly sse: number
  /** sqrt(SSE / n) in the original concentration unit. */
  readonly rmse: number
  readonly parameters: readonly ComparisonParameter[]
  readonly warnings: readonly string[]
  /** True when any estimate sits on a constraint boundary or is unresolved. */
  readonly hasBoundaryEstimate: boolean
}

export interface FailedCandidateModel {
  readonly ok: false
  readonly modelId: CandidateModelId
  readonly label: string
  readonly formula: string
  readonly meanParameterCount: 2 | 3
  readonly totalParameterCount: number
  readonly message: string
}

export type CandidateModel = FittedCandidateModel | FailedCandidateModel

export interface MonoExponentialModelComparison {
  readonly ok: true
  readonly observationCount: number
  readonly distinctTimeCount: number
  /** M0 first, M1 second. */
  readonly models: readonly [CandidateModel, CandidateModel]
  /**
   * The M1 fit this comparison was built from. Exposed so residual diagnostics
   * describe the same fit instead of re-running the model.
   */
  readonly baselineFit: MonoExponentialBaselineFitResult
  /** Standing limitations of the comparison itself. */
  readonly notes: readonly string[]
}

export type ComparisonFailureCode =
  | 'MEASUREMENT_MISMATCH'
  | 'INVALID_MEASUREMENT'
  | 'NON_FINITE_PARAMETER'
  | 'CENSORED_CONCENTRATION_UNSUPPORTED'

export interface ModelComparisonFailure {
  readonly ok: false
  readonly code: ComparisonFailureCode
  readonly message: string
}

export type MonoExponentialModelComparisonResult =
  | MonoExponentialModelComparison
  | ModelComparisonFailure

export type AiccUnavailableCode =
  /** The analyst has not declared the supported error model. */
  | 'ASSUMPTION_NOT_DECLARED'
  /** This candidate has no successful fit. */
  | 'FIT_UNAVAILABLE'
  /** The residual sum of squares is not finite. */
  | 'NON_FINITE_SSE'
  /** SSE is zero: the Gaussian variance estimate is degenerate. */
  | 'ZERO_RESIDUAL_VARIANCE'
  /** n − K − 1 ≤ 0, so the small-sample correction is not defined. */
  | 'INSUFFICIENT_OBSERVATIONS'

export interface AiccAvailable {
  readonly ok: true
  readonly errorModel: ErrorModelId
  readonly observationCount: number
  readonly totalParameterCount: number
  readonly sse: number
  /** Maximized Gaussian log-likelihood implied by SSE / n. */
  readonly logLikelihood: number
  readonly aic: number
  /** 2K(K+1)/(n − K − 1). */
  readonly correction: number
  readonly aicc: number
}

export interface AiccUnavailable {
  readonly ok: false
  readonly code: AiccUnavailableCode
  readonly message: string
}

export type ConditionalAicc = AiccAvailable | AiccUnavailable

export interface ComparisonAicc {
  readonly errorModel: ErrorModelId | null
  readonly assumptionStatement: string
  readonly caveat: string
  readonly m0: ConditionalAicc
  readonly m1: ConditionalAicc
  /**
   * m1.aicc − m0.aicc, arithmetic only. Null unless both models report a value.
   * Negative means M1 has the lower (relatively better supported) criterion.
   */
  readonly difference: number | null
}

const unavailable = (code: AiccUnavailableCode, message: string): AiccUnavailable => ({
  ok: false,
  code,
  message,
})

/**
 * Conditional AICc for a Gaussian least-squares fit.
 *
 *   AIC  = n·ln(2π) + n + n·ln(SSE/n) + 2K
 *   AICc = AIC + 2K(K+1)/(n − K − 1)
 *
 * `K` is the total number of estimated likelihood parameters, including the
 * residual variance. A zero SSE is reported as unavailable rather than being
 * replaced by an epsilon, and ordinary AIC is never substituted for AICc.
 */
export function computeGaussianAicc(input: {
  readonly errorModel: ErrorModelId | null
  readonly observationCount: number
  readonly sse: number
  readonly totalParameterCount: number
}): ConditionalAicc {
  const { errorModel, observationCount: n, sse, totalParameterCount: k } = input
  if (errorModel !== GAUSSIAN_ADDITIVE_ERROR_MODEL) {
    return unavailable(
      'ASSUMPTION_NOT_DECLARED',
      'AICc requires an explicitly declared error model; none has been declared for this comparison.',
    )
  }
  if (!Number.isFinite(sse)) {
    return unavailable('NON_FINITE_SSE', 'The residual sum of squares is not finite.')
  }
  if (!(sse > 0)) {
    return unavailable(
      'ZERO_RESIDUAL_VARIANCE',
      'The residual sum of squares is zero, so the Gaussian variance estimate is degenerate and the criterion is not defined.',
    )
  }
  if (!Number.isFinite(n) || !Number.isFinite(k) || !Number.isInteger(n) || !Number.isInteger(k)) {
    return unavailable('NON_FINITE_SSE', 'The observation or parameter count is not a finite whole number.')
  }
  if (n - k - 1 <= 0) {
    return unavailable(
      'INSUFFICIENT_OBSERVATIONS',
      'There are not enough observations for the small-sample correction: n − K − 1 must be positive.',
    )
  }

  const logTwoPi = Math.log(2 * Math.PI)
  const logMeanSquare = Math.log(sse / n)
  const logLikelihood = -(n / 2) * (logTwoPi + logMeanSquare + 1)
  const aic = n * logTwoPi + n + n * logMeanSquare + 2 * k
  const correction = (2 * k * (k + 1)) / (n - k - 1)
  const aicc = aic + correction
  if (
    !Number.isFinite(logLikelihood) ||
    !Number.isFinite(aic) ||
    !Number.isFinite(correction) ||
    !Number.isFinite(aicc)
  ) {
    return unavailable('NON_FINITE_SSE', 'The information criterion is not finite for this fit.')
  }

  return {
    ok: true,
    errorModel,
    observationCount: n,
    totalParameterCount: k,
    sse,
    logLikelihood,
    aic,
    correction,
    aicc,
  }
}

const M0_LABEL = 'M0 · mono-exponential decay'
const M0_FORMULA = 'C(t) = A · exp(−k · (t − t_ref))'
const M1_LABEL = 'M1 · mono-exponential decay with additive baseline'
const M1_FORMULA = 'C(t) = B + A · exp(−k · (t − t_ref))'

function rmseOf(sse: number, n: number): number {
  return n > 0 ? Math.sqrt(sse / n) : Number.POSITIVE_INFINITY
}

function baselineWarningText(warning: BaselineFitWarning): string {
  return warning.message
}

/** The limitations reported with every comparison, declared or not. */
export function comparisonNotes(): readonly string[] {
  return [
    'Both models use the same rows, reference time, observed span, original concentration scale, unweighted objective and treatment of duplicate timestamps. Replicates remain separate observations.',
    'AICc is relative support WITHIN this two-model candidate set under the declared error model. It is not proof of the true mechanism, and it does not test whether that error model is correct.',
    'AICc is conditional on the declared assumption. Declaring independent additive Gaussian errors with a common variance does not establish that the residuals are independent, Gaussian or equally uncertain.',
    'Models with more parameters can reduce the residual sum of squares by construction: a smaller SSE for M1 is not by itself evidence of scientific superiority, and the baseline term is a shape, not a physiological mechanism.',
    'Constrained boundary estimates and nonlinear fitting weaken the regularity assumptions behind information criteria. Boundary warnings are shown, and the comparison is less reliable when they appear.',
    'No hypothesis test, confidence interval, standard error, model weight, probability or winner classification is produced, and no AICc threshold is applied.',
  ]
}

/**
 * Descriptive comparison of M0 (already fitted) with M1 (fitted here).
 *
 * Never re-fits M0 and never changes its estimate. A failed M1 is reported as
 * a failed candidate row, not as a plausible-looking set of numbers.
 */
export function compareMonoExponentialModels(
  measurements: readonly ExperimentalMeasurement[],
  monoExponentialFit: SuccessfulFit,
): MonoExponentialModelComparisonResult {
  if (measurements.length === 0) {
    return {
      ok: false,
      code: 'MEASUREMENT_MISMATCH',
      message: 'The dataset has no measurements to compare.',
    }
  }
  const censoredRefusal = censoredRefusalMessage(measurements)
  if (censoredRefusal !== null) {
    return { ok: false, code: 'CENSORED_CONCENTRATION_UNSUPPORTED', message: censoredRefusal }
  }
  if (measurements.length !== monoExponentialFit.measurementCount) {
    return {
      ok: false,
      code: 'MEASUREMENT_MISMATCH',
      message:
        'The measurements do not match the observations used by the mono-exponential fit, so no comparison was produced.',
    }
  }
  if (
    !Number.isFinite(monoExponentialFit.cRef) ||
    !Number.isFinite(monoExponentialFit.k) ||
    !Number.isFinite(monoExponentialFit.sse)
  ) {
    return {
      ok: false,
      code: 'NON_FINITE_PARAMETER',
      message: 'The mono-exponential fit contains a non-finite value; the comparison is unavailable.',
    }
  }

  const n = measurements.length
  const distinctTimes = new Set<number>()
  for (const measurement of measurements) {
    if (measurement === null || typeof measurement !== 'object') {
      return {
        ok: false,
        code: 'INVALID_MEASUREMENT',
        message: 'A measurement is invalid; the comparison is unavailable.',
      }
    }
    const concentration = (measurement as QuantifiedMeasurement).concentration
    if (
      typeof measurement.time !== 'number' ||
      typeof concentration !== 'number' ||
      !Number.isFinite(measurement.time) ||
      !Number.isFinite(concentration)
    ) {
      return {
        ok: false,
        code: 'INVALID_MEASUREMENT',
        message: 'A measurement is invalid; the comparison is unavailable.',
      }
    }
    distinctTimes.add(measurement.time)
  }

  const m0: FittedCandidateModel = {
    ok: true,
    modelId: 'M0',
    label: M0_LABEL,
    formula: M0_FORMULA,
    meanParameterCount: 2,
    totalParameterCount: 2 + VARIANCE_PARAMETER_COUNT,
    measurementCount: monoExponentialFit.measurementCount,
    sse: monoExponentialFit.sse,
    rmse: rmseOf(monoExponentialFit.sse, monoExponentialFit.measurementCount),
    parameters: [
      { key: 'A', label: 'A · concentration at the reference time', value: monoExponentialFit.cRef, unit: 'concentration' },
      { key: 'k', label: 'k · decay rate', value: monoExponentialFit.k, unit: 'inverse-time' },
    ],
    warnings: monoExponentialFit.warnings.map((warning) => warning.message),
    hasBoundaryEstimate:
      monoExponentialFit.zeroRate ||
      monoExponentialFit.warnings.some((warning) => warning.code === 'RATE_AT_UPPER_BOUND'),
  }

  const baselineFit = fitMonoExponentialWithBaseline(measurements)
  let m1: CandidateModel
  if (baselineFit.ok) {
    m1 = {
      ok: true,
      modelId: 'M1',
      label: M1_LABEL,
      formula: M1_FORMULA,
      meanParameterCount: 3,
      totalParameterCount: 3 + VARIANCE_PARAMETER_COUNT,
      measurementCount: baselineFit.measurementCount,
      sse: baselineFit.sse,
      rmse: rmseOf(baselineFit.sse, baselineFit.measurementCount),
      parameters: [
        { key: 'A', label: 'A · decay amplitude', value: baselineFit.amplitude, unit: 'concentration' },
        { key: 'B', label: 'B · baseline', value: baselineFit.baseline, unit: 'concentration' },
        { key: 'k', label: 'k · decay rate', value: baselineFit.k, unit: 'inverse-time' },
      ],
      warnings: baselineFit.warnings.map(baselineWarningText),
      hasBoundaryEstimate:
        baselineFit.zeroRate ||
        !baselineFit.rateInformative ||
        baselineFit.warnings.some((warning) => warning.code === 'RATE_AT_UPPER_BOUND'),
    }
  } else {
    m1 = {
      ok: false,
      modelId: 'M1',
      label: M1_LABEL,
      formula: M1_FORMULA,
      meanParameterCount: 3,
      totalParameterCount: 3 + VARIANCE_PARAMETER_COUNT,
      message: baselineFit.message,
    }
  }

  return {
    ok: true,
    observationCount: n,
    distinctTimeCount: distinctTimes.size,
    models: [m0, m1],
    baselineFit,
    notes: comparisonNotes(),
  }
}

/**
 * Compute the AICc block for an existing comparison.
 *
 * Kept separate from `compareMonoExponentialModels` so declaring or
 * withdrawing the assumption never re-fits either model.
 */
export function buildComparisonAicc(
  comparison: MonoExponentialModelComparison,
  errorModel: ErrorModelId | null,
): ComparisonAicc {
  const evaluate = (model: CandidateModel): ConditionalAicc => {
    if (!model.ok) {
      return unavailable('FIT_UNAVAILABLE', model.message)
    }
    return computeGaussianAicc({
      errorModel,
      observationCount: model.measurementCount,
      sse: model.sse,
      totalParameterCount: model.totalParameterCount,
    })
  }
  const m0 = evaluate(comparison.models[0])
  const m1 = evaluate(comparison.models[1])
  return {
    errorModel,
    assumptionStatement: ERROR_MODEL_STATEMENT,
    caveat: ERROR_MODEL_CAVEAT,
    m0,
    m1,
    difference: m0.ok && m1.ok ? m1.aicc - m0.aicc : null,
  }
}
