import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import { fitMonoExponentialDecay } from './mono-exponential-fit'
import {
  GAUSSIAN_PROPORTIONAL_VARIANCE,
  fitProportionalVarianceDecay,
  fitProportionalVarianceWithBaseline,
  type ProportionalVarianceFitResult,
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

/** A decaying series with an additive baseline, rounded to 6 decimals. */
const baselineSeries = rows([
  [0, 112.55368],
  [0.25, 89.793525],
  [0.5, 89.905126],
  [1, 81.970636],
  [2, 44.836352],
  [3, 35.83813],
  [5, 14.294831],
  [7, 14.588951],
])

/**
 * A plateau-with-spike series whose maximum-likelihood rate differs from the
 * rate that minimises the weighted residual sum of squares. Reference values
 * were computed independently from the closed forms used here:
 * ML q ≈ 2.5695 (A ≈ 69.4418, φ ≈ 10.2319, lnL ≈ −25.44941),
 * weighted-SSE q ≈ 2.2885, where the likelihood is −25.52910.
 */
const weightedContrastSeries = rows([
  [0, 72.495684],
  [0.5, 94.471783],
  [2, 14.346366],
  [3, 14.346366],
  [6, 14.346366],
  [10, 14.346366],
])

function successful(result: ProportionalVarianceFitResult) {
  if (!result.ok) throw new Error(`expected a successful fit, got ${result.code}: ${result.message}`)
  return result
}

/** Deterministic uniform generator, so the synthetic sample is reproducible. */
function uniform(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function normal(seed: number): () => number {
  const next = uniform(seed)
  return () => {
    const u = Math.max(next(), 1e-12)
    const v = next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

describe('proportional-variance fit — likelihood arithmetic', () => {
  it('reports the profile maximum, not a weighted least-squares estimate', () => {
    const fit = successful(fitProportionalVarianceDecay(baselineSeries))

    // Independent expected values from the closed forms (see module docs).
    // The independent grid located the optimum at q ≈ 2.3825; the refinement
    // resolves it slightly below that grid point.
    expect(Math.abs(fit.dimensionlessRate - 2.3825)).toBeLessThan(0.003)
    expect(fit.amplitude).toBeCloseTo(104.8283158, 4)
    expect(fit.dispersion).toBeCloseTo(0.85551359, 6)
    expect(fit.logLikelihood).toBeCloseTo(-26.1464613, 5)
    expect(fit.deviance).toBeCloseTo(52.2929225, 4)

    // The amplitude is Σ y / Σ g at the reported rate …
    const span = 7
    const g = baselineSeries.map((row) => Math.exp(-(fit.dimensionlessRate * row.time) / span))
    const sumY = baselineSeries.reduce((total, row) => total + row.concentration, 0)
    const sumG = g.reduce((total, value) => total + value, 0)
    expect(fit.amplitude).toBeCloseTo(sumY / sumG, 6)

    // The existing least-squares estimate is a different estimator entirely.
    const leastSquares = fitMonoExponentialDecay(baselineSeries)
    if (!leastSquares.ok) throw new Error('expected the least-squares fit')
    expect(Math.abs(fit.amplitude - leastSquares.cRef) / leastSquares.cRef).toBeGreaterThan(0.02)
  })

  it('reports a log-likelihood that matches the direct Gaussian density', () => {
    const fit = successful(fitProportionalVarianceWithBaseline(baselineSeries))
    const span = 7
    const g = baselineSeries.map((row) => Math.exp(-(fit.dimensionlessRate * row.time) / span))
    const mu = g.map((value) => (fit.baseline as number) + fit.amplitude * value)
    const direct = baselineSeries.reduce((total, row, index) => {
      const predicted = mu[index] as number
      return (
        total -
        0.5 *
          (Math.log(2 * Math.PI * fit.dispersion * predicted) +
            (row.concentration - predicted) ** 2 / (fit.dispersion * predicted))
      )
    }, 0)
    expect(fit.logLikelihood).toBeCloseTo(direct, 6)
    expect(fit.deviance).toBeCloseTo(-2 * direct, 6)

    // Σ (y − μ)²/μ = n·φ, in the concentration unit.
    const weightedSum = baselineSeries.reduce((total, row, index) => {
      const predicted = mu[index] as number
      return total + (row.concentration - predicted) ** 2 / predicted
    }, 0)
    expect(fit.weightedResidualSum).toBeCloseTo(weightedSum, 5)
    expect(fit.weightedResidualSum).toBeCloseTo(fit.measurementCount * fit.dispersion, 6)
  })

  it('optimises the likelihood where the weighted sum of squares would choose another rate', () => {
    const fit = successful(fitProportionalVarianceDecay(weightedContrastSeries))

    expect(fit.dimensionlessRate).toBeCloseTo(2.5695, 2)
    expect(fit.logLikelihood).toBeCloseTo(-25.4494134, 4)
    expect(fit.amplitude).toBeCloseTo(69.4418, 2)

    const times = weightedContrastSeries.map((row) => row.time)
    const span = (times[times.length - 1] as number) - (times[0] as number)
    const logLikelihoodAt = (q: number): number => {
      const g = times.map((time) => Math.exp(-q * (time - (times[0] as number)) / span))
      const sumY = weightedContrastSeries.reduce((total, row) => total + row.concentration, 0)
      const amplitude = sumY / g.reduce((total, value) => total + value, 0)
      const mu = g.map((value) => amplitude * value)
      const dispersion =
        weightedContrastSeries.reduce(
          (total, row, index) => total + ((row.concentration - (mu[index] as number)) ** 2) / (mu[index] as number),
          0,
        ) / mu.length
      return -0.5 * (mu.length * Math.log(2 * Math.PI) + mu.length * Math.log(dispersion) + mu.reduce((total, value) => total + Math.log(value), 0) + mu.length)
    }

    // The weighted-SSE optimum sits at q ≈ 2.2885 and is worse under the
    // likelihood: the fit did not minimise that objective.
    expect(logLikelihoodAt(2.2885)).toBeCloseTo(-25.5290994, 4)
    expect(fit.logLikelihood).toBeGreaterThan(logLikelihoodAt(2.2885) + 0.05)

    // And the weighted sum of squares is larger at the published fit.
    const weightedSseAt = (q: number): number => {
      const g = times.map((time) => Math.exp(-q * (time - (times[0] as number)) / span))
      const sumY = weightedContrastSeries.reduce((total, row) => total + row.concentration, 0)
      const amplitude = sumY / g.reduce((total, value) => total + value, 0)
      return weightedContrastSeries.reduce(
        (total, row, index) =>
          total + ((row.concentration - amplitude * (g[index] as number)) ** 2) / (amplitude * (g[index] as number)),
        0,
      )
    }
    expect(weightedSseAt(fit.dimensionlessRate)).toBeGreaterThan(weightedSseAt(2.2885))

    // At the published rate the weighted-SSE amplitude is materially different
    // from the likelihood estimate, so the two objectives select different fits.
    const gAtFit = times.map(
      (time) => Math.exp(-(fit.dimensionlessRate * (time - (times[0] as number))) / span),
    )
    const sumY = weightedContrastSeries.reduce((total, row) => total + row.concentration, 0)
    const sumG = gAtFit.reduce((total, value) => total + value, 0)
    const sumYSquaredOverG = weightedContrastSeries.reduce(
      (total, row, index) => total + (row.concentration * row.concentration) / (gAtFit[index] as number),
      0,
    )
    const weightedAmplitude = Math.sqrt(sumYSquaredOverG / sumG)
    expect(weightedAmplitude).toBeCloseTo(78.3689, 2)
    expect(Math.abs(fit.amplitude - weightedAmplitude) / weightedAmplitude).toBeGreaterThan(0.1)
    expect(fit.amplitude).toBeCloseTo(sumY / sumG, 6)
  })

  it('recovers known parameters from a deterministic synthetic sample', () => {
    const z = normal(20261022)
    const measurements: ExperimentalMeasurement[] = []
    const amplitude = 90
    const baseline = 10
    const rate = 0.4
    const dispersion = 1.2
    for (let index = 0; index < 80; index += 1) {
      const time = (index / 79) * 10
      const mu = baseline + amplitude * Math.exp(-rate * time)
      const observed = mu + z() * Math.sqrt(dispersion * mu)
      measurements.push({
        id: `s${String(index + 1)}`,
        sourceRow: index + 1,
        time,
        concentration: Math.max(1e-6, observed),
      })
    }

    const fit = successful(fitProportionalVarianceWithBaseline(measurements))
    expect(Math.abs(fit.amplitude - amplitude) / amplitude).toBeLessThan(0.08)
    expect(Math.abs((fit.baseline as number) - baseline) / baseline).toBeLessThan(0.4)
    expect(Math.abs(fit.k - rate) / rate).toBeLessThan(0.12)
    expect(Math.abs(fit.dispersion - dispersion) / dispersion).toBeLessThan(0.3)
    expect(fit.measurementCount).toBe(80)
    expect(fit.meanParameterCount).toBe(3)
    expect(fit.totalParameterCount).toBe(4)
  })

  it('nests the decay model inside the baseline model', () => {
    for (const data of [baselineSeries, weightedContrastSeries]) {
      const m0 = successful(fitProportionalVarianceDecay(data))
      const m1 = successful(fitProportionalVarianceWithBaseline(data))
      // B = 0 is inside M1's feasible set, so its maximised likelihood cannot
      // be lower.
      expect(m1.deviance).toBeLessThanOrEqual(m0.deviance + 1e-6)
      expect(m0.meanParameterCount).toBe(2)
      expect(m0.totalParameterCount).toBe(3)
      expect(m1.totalParameterCount).toBe(4)
    }
  })

  it('scales with the declared concentration unit', () => {
    const scaled = baselineSeries.map((row) => ({ ...row, concentration: row.concentration * 1000 }))
    const base = successful(fitProportionalVarianceDecay(baselineSeries))
    const thousand = successful(fitProportionalVarianceDecay(scaled))

    // Rescaling can move the refined rate by a few ulps of the search, never
    // by a scientifically meaningful amount.
    expect(Math.abs(thousand.k - base.k) / base.k).toBeLessThan(1e-7)
    expect(thousand.amplitude / base.amplitude).toBeCloseTo(1000, 5)
    expect(thousand.dispersion / base.dispersion).toBeCloseTo(1000, 5)
    // Rescaling the response changes the density by −n·ln(scale).
    expect(thousand.logLikelihood - base.logLikelihood).toBeCloseTo(
      -baselineSeries.length * Math.log(1000),
      5,
    )
  })
})

describe('proportional-variance fit — data integrity and boundaries', () => {
  it('keeps duplicate timestamps and replicates as separate observations', () => {
    const base = rows([
      [0, 100],
      [1, 62],
      [2, 40],
      [4, 18],
      [6, 8],
    ])
    const replicated = rows([
      [0, 100],
      [0, 100],
      [1, 62],
      [2, 40],
      [4, 18],
      [6, 8],
    ])
    const baseFit = successful(fitProportionalVarianceDecay(base))
    const replicatedFit = successful(fitProportionalVarianceDecay(replicated))

    expect(replicatedFit.measurementCount).toBe(6)
    expect(baseFit.measurementCount).toBe(5)
    const change = Math.abs(replicatedFit.amplitude - baseFit.amplitude) / baseFit.amplitude
    expect(change).toBeGreaterThan(1e-6)
  })

  it('never mutates or reorders the measurements, and is deterministic', () => {
    const before = baselineSeries.map((row) => ({ ...row }))
    const first = successful(fitProportionalVarianceWithBaseline(baselineSeries))
    const second = successful(fitProportionalVarianceWithBaseline(baselineSeries))
    expect(first).toEqual(second)
    expect(baselineSeries).toEqual(before)
    expect(baselineSeries.map((row) => row.sourceRow)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('accepts a zero observation when a positive row constrains the tail', () => {
    // 100, 20, 0 at times 0, 1, 2. As q -> infinity every u > 0 prediction is
    // driven to zero, but the positive row at t = 1 makes the deviance diverge
    // to +infinity there, so the joint likelihood is bounded and has a finite
    // interior maximum. Independent reference: q = 3.674, A = 101.294086,
    // phi = 1.170784, lnL = -8.664868.
    const data = rows([
      [0, 100],
      [1, 20],
      [2, 0],
    ])
    const fit = successful(fitProportionalVarianceDecay(data))
    expect(Math.abs(fit.dimensionlessRate - 3.674)).toBeLessThan(0.01)
    expect(fit.amplitude).toBeCloseTo(101.294, 2)
    expect(fit.dispersion).toBeCloseTo(1.1708, 3)
    expect(fit.logLikelihood).toBeCloseTo(-8.66487, 4)
    expect(fit.dimensionlessRate).toBeLessThan(50)
    expect(fit.rateInformative).toBe(true)

    // The baseline model nests it and stays finite too.
    const withBaseline = successful(fitProportionalVarianceWithBaseline(data))
    expect(Number.isFinite(withBaseline.logLikelihood)).toBe(true)
    expect(withBaseline.deviance).toBeLessThanOrEqual(fit.deviance + 1e-6)
  })

  it('keeps a zero at the reference time when later rows are positive', () => {
    // The reference row is zero and later rows are positive: the later rows pin
    // the amplitude, so no prediction is driven to zero. The constrained rate
    // collapses to q = 0, which is a reported boundary, not a failure.
    const fit = successful(
      fitProportionalVarianceDecay(
        rows([
          [0, 0],
          [1, 50],
          [2, 20],
        ]),
      ),
    )
    expect(fit.zeroRate).toBe(true)
    expect(fit.warnings.map((warning) => warning.code)).toContain('ZERO_RATE_BOUNDARY')
  })

  it('rejects the configuration whose joint likelihood is unbounded', () => {
    // Every observation after t = 0 is zero, so nothing constrains the tail:
    // phi-hat stays finite while sum ln mu -> -infinity, and the likelihood
    // grows without bound as the rate increases.
    for (const data of [
      rows([
        [0, 100],
        [1, 0],
        [2, 0],
      ]),
      rows([
        [0, 100],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    ]) {
      for (const result of [
        fitProportionalVarianceDecay(data),
        fitProportionalVarianceWithBaseline(data),
      ]) {
        expect(result.ok).toBe(false)
        if (result.ok) continue
        expect(result.code).toBe('UNBOUNDED_LIKELIHOOD')
        expect(result.message).toMatch(/after the earliest measured time/i)
        expect(result.message).toMatch(/increases without bound/i)
      }
    }

    const allZero = fitProportionalVarianceWithBaseline(
      rows([
        [0, 0],
        [1, 0],
      ]),
    )
    expect(allZero.ok).toBe(false)
    if (allZero.ok) return
    expect(allZero.code).toBe('ALL_ZERO_CONCENTRATIONS')
  })

  it('refuses a dataset it reproduces exactly, instead of inventing a variance', () => {
    const constant = rows([
      [0, 50],
      [1, 50],
      [2, 50],
      [3, 50],
      [4, 50],
      [5, 50],
    ])
    for (const result of [
      fitProportionalVarianceDecay(constant),
      fitProportionalVarianceWithBaseline(constant),
    ]) {
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('DEGENERATE_DISPERSION')
      expect(result.message).toMatch(/no finite maximum/i)
    }
  })

  it('propagates the shared structural validation', () => {
    const cases: readonly [readonly ExperimentalMeasurement[], string][] = [
      [[], 'NO_MEASUREMENTS'],
      [rows([[2, 10], [2, 12]]), 'NO_TIME_SPAN'],
      [rows([[-1, 10], [0, 5]]), 'NEGATIVE_VALUE'],
      [rows([[0, Number.POSITIVE_INFINITY], [1, 5]]), 'INVALID_MEASUREMENT'],
    ]
    for (const [data, code] of cases) {
      const result = fitProportionalVarianceDecay(data)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe(code)
    }

    const malformed = fitProportionalVarianceDecay([
      null as unknown as ExperimentalMeasurement,
    ])
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.code).toBe('INVALID_MEASUREMENT')
  })

  it('labels a zero-rate boundary without failing', () => {
    const rising = rows([
      [0, 5],
      [1, 9],
      [2, 20],
      [3, 30],
    ])
    const fit = successful(fitProportionalVarianceDecay(rising))
    expect(fit.zeroRate).toBe(true)
    expect(fit.k).toBe(0)
    expect(fit.halfLife).toBeUndefined()
    expect(fit.warnings.map((warning) => warning.code)).toContain('ZERO_RATE_BOUNDARY')
    expect(fit.hasBoundaryEstimate).toBe(true)
  })

  it('reports a baseline on its lower bound', () => {
    // A pure decay with a small deterministic perturbation: the constrained
    // baseline estimate sits on its lower bound.
    const pureDecay = rows([
      [0, 100],
      [0.5, 78.4],
      [1, 60.1],
      [2, 36.4],
      [3, 22.6],
      [5, 8.1],
    ])
    const fit = successful(fitProportionalVarianceWithBaseline(pureDecay))
    expect(fit.baseline).toBe(0)
    expect(fit.warnings.map((warning) => warning.code)).toContain('BASELINE_AT_ZERO')
    expect(fit.hasBoundaryEstimate).toBe(true)
  })

  it('stays finite for subnormal and near-zero measurements', () => {
    const tiny = rows([
      [0, 5e-320],
      [1, 2e-320],
      [2, 1e-320],
      [3, 4e-321],
    ])
    const result = fitProportionalVarianceDecay(tiny)
    if (result.ok) {
      expect(Number.isFinite(result.amplitude)).toBe(true)
      expect(Number.isFinite(result.dispersion)).toBe(true)
      expect(Number.isFinite(result.logLikelihood)).toBe(true)
      expect(Number.isFinite(result.deviance)).toBe(true)
    } else {
      expect(['DEGENERATE_DISPERSION', 'DEGENERATE_OBJECTIVE', 'NON_FINITE']).toContain(result.code)
    }
  })

  it('exposes the declared error model identifier and statement', () => {
    expect(GAUSSIAN_PROPORTIONAL_VARIANCE).toBe(
      'independent-gaussian-variance-proportional-to-mean',
    )
  })
})
