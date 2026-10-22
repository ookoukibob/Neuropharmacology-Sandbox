import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import {
  GAUSSIAN_ADDITIVE_ERROR_MODEL,
  VARIANCE_PARAMETER_COUNT,
  buildComparisonAicc,
  compareMonoExponentialModels,
  computeGaussianAicc,
  type MonoExponentialModelComparison,
} from './mono-exponential-model-comparison'
import { fitMonoExponentialDecay } from './mono-exponential-fit'

/**
 * Model comparison and conditional AICc (phase 47C).
 *
 * Synthetic fixtures only. AICc reference values are computed with the
 * likelihood route (`AIC = −2·lnL + 2K`) rather than by repeating the
 * implementation's formula, and one case is pinned to a hand-calculated
 * number so a transcription error in either route is caught.
 */

let counter = 0
const rows = (pairs: ReadonlyArray<readonly [number, number]>): ExperimentalMeasurement[] => {
  counter = 0
  return pairs.map(([time, concentration]) => {
    counter += 1
    return { id: `m${counter}`, sourceRow: counter, time, concentration }
  })
}

const synth = (
  amplitude: number,
  baseline: number,
  k: number,
  times: readonly number[],
): ExperimentalMeasurement[] =>
  rows(times.map((time) => [time, baseline + amplitude * Math.exp(-k * time)] as const))

const fittedM0 = (data: readonly ExperimentalMeasurement[]) => {
  const result = fitMonoExponentialDecay(data)
  if (!result.ok) throw new Error('M0 failed: ' + result.code + ' ' + result.message)
  return result
}

const compared = (data: readonly ExperimentalMeasurement[]): MonoExponentialModelComparison => {
  const result = compareMonoExponentialModels(data, fittedM0(data))
  if (!result.ok) throw new Error('comparison failed: ' + result.code + ' ' + result.message)
  return result
}

describe('descriptive comparison', () => {
  const data = synth(90, 10, 0.4, [0, 0.5, 1, 2, 3, 5])

  it('reports both models with their own parameters, counts and units kinds', () => {
    const comparison = compared(data)
    expect(comparison.observationCount).toBe(6)
    expect(comparison.distinctTimeCount).toBe(6)
    expect(comparison.models).toHaveLength(2)

    const [m0, m1] = comparison.models
    expect(m0.modelId).toBe('M0')
    expect(m0.ok).toBe(true)
    expect(m1.modelId).toBe('M1')
    expect(m1.ok).toBe(true)
    if (!m0.ok || !m1.ok) return

    // Mean-model parameters: M0 = A, k. M1 = A, B, k.
    expect(m0.meanParameterCount).toBe(2)
    expect(m1.meanParameterCount).toBe(3)
    // Total likelihood parameters include the variance.
    expect(m0.totalParameterCount).toBe(2 + VARIANCE_PARAMETER_COUNT)
    expect(m1.totalParameterCount).toBe(3 + VARIANCE_PARAMETER_COUNT)
    expect(VARIANCE_PARAMETER_COUNT).toBe(1)

    expect(m0.measurementCount).toBe(6)
    expect(m1.measurementCount).toBe(6)
    expect(m0.parameters.map((parameter) => parameter.key)).toEqual(['A', 'k'])
    expect(m1.parameters.map((parameter) => parameter.key)).toEqual(['A', 'B', 'k'])
    expect(m0.parameters.every((parameter) => Number.isFinite(parameter.value))).toBe(true)
    expect(m1.parameters.every((parameter) => Number.isFinite(parameter.value))).toBe(true)
    // Amplitude and baseline are concentrations; the rate is reciprocal time.
    expect(m1.parameters.map((parameter) => parameter.unit)).toEqual([
      'concentration',
      'concentration',
      'inverse-time',
    ])
    expect(m0.formula).toMatch(/exp\(−k · \(t − t_ref\)\)/)
    expect(m1.formula).toMatch(/^C\(t\) = B \+ A · exp/)
  })

  it('reflects the nested relationship: M1 fits this baseline shape better', () => {
    const comparison = compared(data)
    const [m0, m1] = comparison.models
    if (!m0.ok || !m1.ok) throw new Error('expected two successful fits')
    expect(m1.sse).toBeLessThan(m0.sse)
    expect(m1.rmse).toBeLessThan(m0.rmse)
    expect(m0.rmse).toBeCloseTo(Math.sqrt(m0.sse / m0.measurementCount), 12)
    expect(m1.rmse).toBeCloseTo(Math.sqrt(m1.sse / m1.measurementCount), 12)
  })

  it('states that a lower SSE is not evidence of superiority', () => {
    const comparison = compared(data)
    const notes = comparison.notes.join(' ')
    expect(notes).toMatch(/more parameters can reduce the residual sum of squares/i)
    expect(notes).toMatch(/not by itself evidence of scientific superiority/i)
    expect(notes).toMatch(/shape, not a physiological mechanism/i)
    expect(notes).toMatch(/No hypothesis test/i)
  })

  it('rejects a fit that belongs to different measurements', () => {
    const fit = fittedM0(
      rows([
        [0, 10],
        [1, 5],
        [2, 2.5],
      ]),
    )
    const result = compareMonoExponentialModels(
      rows([
        [0, 10],
        [1, 5],
      ]),
      fit,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('MEASUREMENT_MISMATCH')
  })

  it('rejects a non-finite fit parameter', () => {
    const data = rows([
      [0, 10],
      [1, 5],
      [2, 2.5],
    ])
    const result = compareMonoExponentialModels(data, {
      ok: true,
      tRef: 0,
      cRef: Number.NaN,
      k: 0.5,
      sse: 0,
      measurementCount: 3,
      zeroRate: false,
      warnings: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('NON_FINITE_PARAMETER')
  })

  it('does not mutate the measurements and is deterministic', () => {
    const frozen = synth(60, 4, 0.7, [0, 1, 2, 3, 5])
    const snapshot = frozen.map((measurement) => ({ ...measurement }))
    frozen.forEach((measurement) => Object.freeze(measurement))
    Object.freeze(frozen)
    const first = compareMonoExponentialModels(frozen, fittedM0(frozen))
    const second = compareMonoExponentialModels(frozen, fittedM0(frozen))
    expect(first).toEqual(second)
    expect(frozen).toEqual(snapshot)
  })
})

describe('AICc gating', () => {
  const data = synth(90, 10, 0.4, [0, 0.5, 1, 2, 3, 5])

  it('is unavailable for both models when no error model is declared', () => {
    const comparison = compared(data)
    const aicc = buildComparisonAicc(comparison, null)
    expect(aicc.errorModel).toBeNull()
    expect(aicc.m0.ok).toBe(false)
    expect(aicc.m1.ok).toBe(false)
    if (aicc.m0.ok || aicc.m1.ok) throw new Error('expected unavailable')
    expect(aicc.m0.code).toBe('ASSUMPTION_NOT_DECLARED')
    expect(aicc.m1.code).toBe('ASSUMPTION_NOT_DECLARED')
    expect(aicc.difference).toBeNull()
    expect(aicc.assumptionStatement).toMatch(/independent additive gaussian errors/i)
    expect(aicc.caveat).toMatch(/assumption, not evidence/i)
  })

  it('reports both criteria when the assumption is declared', () => {
    const comparison = compared(data)
    const aicc = buildComparisonAicc(comparison, GAUSSIAN_ADDITIVE_ERROR_MODEL)
    expect(aicc.m0.ok).toBe(true)
    expect(aicc.m1.ok).toBe(true)
    if (!aicc.m0.ok || !aicc.m1.ok) throw new Error('expected available values')

    expect(aicc.m0.observationCount).toBe(6)
    expect(aicc.m0.totalParameterCount).toBe(3)
    expect(aicc.m1.totalParameterCount).toBe(4)
    expect(Number.isFinite(aicc.m0.aicc)).toBe(true)
    expect(Number.isFinite(aicc.m1.aicc)).toBe(true)
    expect(aicc.difference).toBeCloseTo(aicc.m1.aicc - aicc.m0.aicc, 12)
    // The comparison does not apply a threshold or a winner label.
    expect(aicc).not.toHaveProperty('winner')
  })

  it('refuses AICc when n − K − 1 is not positive, even if the other model qualifies', () => {
    // Five rows: M0 (K = 3) has 5 − 3 − 1 = 1, M1 (K = 4) has 5 − 4 − 1 = 0.
    const five = synth(80, 5, 0.5, [0, 0.5, 1, 2, 3])
    const comparison = compared(five)
    const aicc = buildComparisonAicc(comparison, GAUSSIAN_ADDITIVE_ERROR_MODEL)
    expect(aicc.m0.ok).toBe(true)
    expect(aicc.m1.ok).toBe(false)
    if (aicc.m1.ok) return
    expect(aicc.m1.code).toBe('INSUFFICIENT_OBSERVATIONS')
    expect(aicc.difference).toBeNull()
  })

  it('marks a boundary estimate as reported but less reliable', () => {
    // Constant series: both models collapse to a constant.
    const flat = rows([
      [0, 100],
      [1, 100],
      [2, 100],
      [4, 100],
      [6, 100],
    ])
    const comparison = compared(flat)
    const [m0, m1] = comparison.models
    if (!m0.ok || !m1.ok) throw new Error('expected fits')
    // The boundary is reported rather than silently hidden...
    expect(m0.hasBoundaryEstimate).toBe(true)
    expect(m1.hasBoundaryEstimate).toBe(true)
    expect(comparison.notes.join(' ')).toMatch(/boundary/i)
    // ...and this particular series fits a constant exactly, so the residual
    // variance is degenerate and AICc is refused instead of being computed
    // from a substituted epsilon.
    const aicc = buildComparisonAicc(comparison, GAUSSIAN_ADDITIVE_ERROR_MODEL)
    expect(aicc.m0.ok).toBe(false)
    if (aicc.m0.ok) return
    expect(aicc.m0.code).toBe('ZERO_RESIDUAL_VARIANCE')
  })
})

describe('the Gaussian AICc formula', () => {
  it('matches a hand-calculated reference for n = 8, SSE = 2.5, K = 3', () => {
    const result = computeGaussianAicc({
      errorModel: GAUSSIAN_ADDITIVE_ERROR_MODEL,
      observationCount: 8,
      sse: 2.5,
      totalParameterCount: 3,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // AIC  = 8·ln(2π) + 8 + 8·ln(2.5/8) + 2·3      ≈ 19.3978
    // AICc = AIC + 2·3·4/(8−3−1) = AIC + 6           ≈ 25.3978
    expect(result.aic).toBeCloseTo(19.3978, 3)
    expect(result.correction).toBeCloseTo(6, 10)
    expect(result.aicc).toBeCloseTo(25.3978, 3)
    expect(result.totalParameterCount).toBe(3)
    expect(result.observationCount).toBe(8)
  })

  it('agrees with the likelihood route AIC = −2·lnL + 2K', () => {
    const n = 12
    const sse = 4.25
    const k = 4
    const result = computeGaussianAicc({
      errorModel: GAUSSIAN_ADDITIVE_ERROR_MODEL,
      observationCount: n,
      sse,
      totalParameterCount: k,
    })
    if (!result.ok) throw new Error('expected a value')
    const logLikelihood = -(n / 2) * (Math.log(2 * Math.PI) + Math.log(sse / n) + 1)
    expect(result.logLikelihood).toBeCloseTo(logLikelihood, 10)
    expect(result.aic).toBeCloseTo(-2 * logLikelihood + 2 * k, 9)
    expect(result.aicc).toBeCloseTo(result.aic + (2 * k * (k + 1)) / (n - k - 1), 9)
  })

  it('refuses a zero residual variance instead of substituting an epsilon', () => {
    const result = computeGaussianAicc({
      errorModel: GAUSSIAN_ADDITIVE_ERROR_MODEL,
      observationCount: 10,
      sse: 0,
      totalParameterCount: 3,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ZERO_RESIDUAL_VARIANCE')
    expect(result.message).toMatch(/degenerate/i)
  })

  it('refuses a non-finite residual sum of squares', () => {
    const result = computeGaussianAicc({
      errorModel: GAUSSIAN_ADDITIVE_ERROR_MODEL,
      observationCount: 10,
      sse: Number.POSITIVE_INFINITY,
      totalParameterCount: 3,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('NON_FINITE_SSE')
  })

  it('refuses an undeclared assumption even when the numbers are valid', () => {
    const result = computeGaussianAicc({
      errorModel: null,
      observationCount: 50,
      sse: 1,
      totalParameterCount: 3,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ASSUMPTION_NOT_DECLARED')
  })

  it('reports a failed candidate as unavailable rather than fitting it anyway', () => {
    const comparison: MonoExponentialModelComparison = {
      ok: true,
      observationCount: 6,
      distinctTimeCount: 6,
      models: [
        {
          ok: true,
          modelId: 'M0',
          label: 'M0',
          formula: 'C(t) = A · exp(−k · (t − t_ref))',
          meanParameterCount: 2,
          totalParameterCount: 3,
          measurementCount: 6,
          sse: 2,
          rmse: Math.sqrt(2 / 6),
          parameters: [],
          warnings: [],
          hasBoundaryEstimate: false,
        },
        {
          ok: false,
          modelId: 'M1',
          label: 'M1',
          formula: 'C(t) = B + A · exp(−k · (t − t_ref))',
          meanParameterCount: 3,
          totalParameterCount: 4,
          message: 'The rate optimizer did not converge to a finite value.',
        },
      ],
      notes: [],
    }
    const aicc = buildComparisonAicc(comparison, GAUSSIAN_ADDITIVE_ERROR_MODEL)
    expect(aicc.m0.ok).toBe(true)
    expect(aicc.m1.ok).toBe(false)
    if (aicc.m1.ok) return
    expect(aicc.m1.code).toBe('FIT_UNAVAILABLE')
    expect(aicc.m1.message).toMatch(/did not converge/i)
    expect(aicc.difference).toBeNull()
  })
})
