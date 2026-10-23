import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import {
  buildProportionalVarianceCriterion,
  compareProportionalVarianceModels,
  computeProportionalVarianceAicc,
  proportionalVarianceComparisonNotes,
} from './proportional-variance-comparison'
import {
  GAUSSIAN_PROPORTIONAL_VARIANCE,
  type ProportionalVarianceFitSuccess,
} from './proportional-variance-fit'

const rows = (
  pairs: readonly (readonly [number, number])[],
): readonly ExperimentalMeasurement[] =>
  pairs.map(([time, concentration], index) => ({
    id: `m${String(index + 1)}`,
    sourceRow: index + 1,
    time,
    concentration,
  }))

const decaying = rows([
  [0, 100],
  [0.5, 83],
  [1, 70],
  [2, 51],
  [3, 39],
])

function fittedStub(
  overrides: Partial<ProportionalVarianceFitSuccess> = {},
): ProportionalVarianceFitSuccess {
  return {
    ok: true,
    modelId: 'M0',
    label: 'M0',
    formula: 'C(t) = A · exp(−k · (t − t_ref))',
    tRef: 0,
    amplitude: 100,
    baseline: null,
    k: 0.4,
    dimensionlessRate: 1.2,
    dispersion: 2,
    logLikelihood: -5,
    deviance: 10,
    weightedResidualSum: 16,
    measurementCount: 10,
    meanParameterCount: 2,
    totalParameterCount: 3,
    zeroRate: false,
    rateInformative: true,
    hasBoundaryEstimate: false,
    warnings: [],
    ...overrides,
  }
}

describe('proportional-variance comparison — fitting both candidates', () => {
  it('reports both models on the same rows with model-based parameter counts', () => {
    const comparison = compareProportionalVarianceModels(decaying)
    expect(comparison.ok).toBe(true)
    if (!comparison.ok) return

    expect(comparison.observationCount).toBe(5)
    expect(comparison.distinctTimeCount).toBe(5)
    const [m0, m1] = comparison.models
    expect(m0.ok).toBe(true)
    expect(m1.ok).toBe(true)
    if (!m0.ok || !m1.ok) return

    expect(m0.meanParameterCount).toBe(2)
    expect(m0.totalParameterCount).toBe(3)
    expect(m1.meanParameterCount).toBe(3)
    expect(m1.totalParameterCount).toBe(4)
    expect(m0.measurementCount).toBe(5)
    expect(m1.measurementCount).toBe(5)
    expect(m0.modelId).toBe('M0')
    expect(m1.modelId).toBe('M1')
    expect(m1.baseline).not.toBeNull()
    expect(Number.isFinite(m0.dispersion)).toBe(true)
    expect(Number.isFinite(m1.dispersion)).toBe(true)
  })

  it('keeps a failed candidate visible instead of inventing an estimate', () => {
    // Constant data: both candidates reproduce it exactly, so the likelihood
    // has no finite maximum under this variance function.
    const constant = rows([
      [0, 40],
      [1, 40],
      [2, 40],
      [3, 40],
      [4, 40],
      [5, 40],
    ])
    const comparison = compareProportionalVarianceModels(constant)
    expect(comparison.ok).toBe(true)
    if (!comparison.ok) return
    for (const model of comparison.models) {
      expect(model.ok).toBe(false)
      if (!model.ok) expect(model.code).toBe('DEGENERATE_DISPERSION')
    }
  })

  it('rejects structurally invalid datasets with the shared reason', () => {
    const empty = compareProportionalVarianceModels([])
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe('MEASUREMENT_MISMATCH')

    const singleTime = compareProportionalVarianceModels(
      rows([
        [2, 10],
        [2, 12],
      ]),
    )
    expect(singleTime.ok).toBe(false)
    if (!singleTime.ok) expect(singleTime.message).toMatch(/single distinct time/i)

    const negative = compareProportionalVarianceModels(
      rows([
        [-1, 10],
        [0, 5],
      ]),
    )
    expect(negative.ok).toBe(false)
    if (!negative.ok) expect(negative.code).toBe('INVALID_MEASUREMENT')
  })

  it('does not mutate the measurements', () => {
    const before = decaying.map((row) => ({ ...row }))
    compareProportionalVarianceModels(decaying)
    expect(decaying).toEqual(before)
  })
})

describe('proportional-variance AICc — arithmetic and gates', () => {
  it('computes AIC and the small-sample correction from the maximised likelihood', () => {
    // n = 10, K = 3, lnL = −5  →  AIC = 10 + 6 = 16, correction = 24/6 = 4.
    const result = computeProportionalVarianceAicc({
      declared: true,
      errorModel: GAUSSIAN_PROPORTIONAL_VARIANCE,
      fit: fittedStub({ logLikelihood: -5, deviance: 10, measurementCount: 10, totalParameterCount: 3 }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deviance).toBe(10)
    expect(result.aic).toBe(16)
    expect(result.correction).toBe(4)
    expect(result.aicc).toBe(20)
    expect(result.dispersion).toBe(2)
    expect(result.errorModel).toBe(GAUSSIAN_PROPORTIONAL_VARIANCE)
  })

  it('refuses to compute anything before the assumption is declared', () => {
    const result = computeProportionalVarianceAicc({
      declared: false,
      errorModel: null,
      fit: fittedStub(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ASSUMPTION_NOT_DECLARED')
    expect(result.message).toMatch(/its own explicit declaration/i)
  })

  it('reports a failed candidate as unavailable with its own reason', () => {
    const result = computeProportionalVarianceAicc({
      declared: true,
      errorModel: GAUSSIAN_PROPORTIONAL_VARIANCE,
      fit: {
        ok: false,
        code: 'DEGENERATE_DISPERSION',
        message: 'The candidate reproduces every observation.',
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('FIT_UNAVAILABLE')
    expect(result.message).toMatch(/reproduces every observation/i)
  })

  it('refuses a zero dispersion rather than substituting a floor', () => {
    const result = computeProportionalVarianceAicc({
      declared: true,
      errorModel: GAUSSIAN_PROPORTIONAL_VARIANCE,
      fit: fittedStub({ dispersion: 0 }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ZERO_DISPERSION')
  })

  it('refuses a non-finite likelihood', () => {
    const result = computeProportionalVarianceAicc({
      declared: true,
      errorModel: GAUSSIAN_PROPORTIONAL_VARIANCE,
      fit: fittedStub({ logLikelihood: Number.NaN }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('NON_FINITE_LIKELIHOOD')
  })

  it('gates the small-sample correction per model', () => {
    // n = 5: M0 (K = 3) keeps one residual degree of freedom, M1 (K = 4) none.
    const comparison = compareProportionalVarianceModels(decaying)
    if (!comparison.ok) throw new Error('expected a comparison')
    const criterion = buildProportionalVarianceCriterion(comparison, true)

    expect(criterion.m0.ok).toBe(true)
    expect(criterion.m1.ok).toBe(false)
    if (!criterion.m1.ok) expect(criterion.m1.code).toBe('INSUFFICIENT_OBSERVATIONS')
    expect(criterion.difference).toBeNull()
  })

  it('reports unavailable for both candidates when the sample is too small', () => {
    // n = 4 with K = 3 leaves n − K − 1 = 0.
    const four = rows([
      [0, 90],
      [1, 62],
      [2, 45],
      [4, 20],
    ])
    const comparison = compareProportionalVarianceModels(four)
    if (!comparison.ok) throw new Error('expected a comparison')
    const criterion = buildProportionalVarianceCriterion(comparison, true)
    expect(criterion.m0.ok).toBe(false)
    if (!criterion.m0.ok) expect(criterion.m0.code).toBe('INSUFFICIENT_OBSERVATIONS')
  })

  it('reports the difference as arithmetic only', () => {
    // Give both models the same counts so both criteria exist.
    const comparison = compareProportionalVarianceModels(
      rows([
        [0, 100],
        [0.5, 84],
        [1, 71],
        [2, 50],
        [3, 38],
        [5, 20],
        [7, 11],
        [9, 6],
      ]),
    )
    if (!comparison.ok) throw new Error('expected a comparison')
    const criterion = buildProportionalVarianceCriterion(comparison, true)
    if (!criterion.m0.ok || !criterion.m1.ok) throw new Error('expected both criteria')

    expect(criterion.difference).toBeCloseTo(criterion.m1.aicc - criterion.m0.aicc, 9)
    expect(criterion.assumptionStatement).toMatch(/Var\(Yᵢ \| tᵢ\) = φ · μᵢ/)
    expect(criterion.caveat).toMatch(/assumption, not evidence/i)

    // Withdrawing the declaration removes both values and the difference.
    const withdrawn = buildProportionalVarianceCriterion(comparison, false)
    expect(withdrawn.m0.ok).toBe(false)
    expect(withdrawn.m1.ok).toBe(false)
    expect(withdrawn.difference).toBeNull()
  })

  it('states the limits of this comparison', () => {
    const notes = proportionalVarianceComparisonNotes().join(' ')
    expect(notes).toMatch(/not comparable/i)
    expect(notes).toMatch(/never ranked against each other/i)
    expect(notes).toMatch(/strictly positive/i)
    expect(notes).toMatch(/no finite maximum/i)
    expect(notes).toMatch(/no hypothesis test/i)
    expect(notes).toMatch(/does not test whether the variance really is proportional/i)
  })
})
