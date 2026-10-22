import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import {
  MAX_DIMENSIONLESS_RATE,
  fitCurvePoints,
  fitMonoExponentialDecay,
  type MonoExponentialFitResult,
} from './mono-exponential-fit'

/**
 * One-compartment mono-exponential decay fit (phase 47B).
 *
 * All fixtures are SYNTHETIC — generated from a known equation or hand-picked
 * arithmetic values. No real drug concentrations or unverified
 * pharmacological data appear here.
 */

let counter = 0
const row = (time: number, concentration: number): ExperimentalMeasurement => {
  counter += 1
  return { id: `m${counter}`, sourceRow: counter, time, concentration }
}

const rows = (pairs: ReadonlyArray<readonly [number, number]>): ExperimentalMeasurement[] => {
  counter = 0
  return pairs.map(([t, c]) => row(t, c))
}

/** Generate noiseless synthetic data from a known equation. */
const synth = (
  cRef: number,
  k: number,
  times: readonly number[],
  tRef = 0,
): ExperimentalMeasurement[] =>
  rows(times.map((t) => [t, cRef * Math.exp(-k * (t - tRef))] as const))

const okFit = (result: MonoExponentialFitResult) => {
  if (!result.ok) throw new Error('expected a fit: ' + result.code + ' ' + result.message)
  return result
}

describe('recovers known parameters from noiseless data', () => {
  it('recovers C_ref and k from a synthetic decay', () => {
    const data = synth(100, 0.25, [0, 1, 2, 4, 6, 8, 12])
    const fit = okFit(fitMonoExponentialDecay(data))
    expect(fit.tRef).toBe(0)
    expect(fit.cRef).toBeCloseTo(100, 6)
    expect(fit.k).toBeCloseTo(0.25, 6)
    expect(fit.zeroRate).toBe(false)
    expect(fit.warnings).toEqual([])
  })

  it('recovers the same rate when the earliest observation is after zero', () => {
    // No measurement at t = 0: C_ref must be the value AT t_ref, not an
    // extrapolated "initial concentration".
    const data = synth(50, 0.4, [2, 3, 5, 7, 9], 2)
    const fit = okFit(fitMonoExponentialDecay(data))
    expect(fit.tRef).toBe(2)
    expect(fit.cRef).toBeCloseTo(50, 6)
    expect(fit.k).toBeCloseTo(0.4, 6)
  })

  it('derives the half-life as ln(2)/k', () => {
    const data = synth(80, 0.35, [0, 1, 2, 3, 4, 6])
    const fit = okFit(fitMonoExponentialDecay(data))
    expect(fit.halfLife).toBeDefined()
    expect(fit.halfLife as number).toBeCloseTo(Math.LN2 / 0.35, 9)
  })
})

describe('data handling that must not change the evidence', () => {
  it('fits data containing zero concentrations without log transformation', () => {
    const data = rows([
      [0, 100],
      [1, 50],
      [2, 25],
      [3, 0],
      [4, 6.25],
    ])
    const fit = okFit(fitMonoExponentialDecay(data))
    expect(fit.measurementCount).toBe(5)
    expect(Number.isFinite(fit.sse)).toBe(true)
    expect(fit.k).toBeGreaterThan(0)
  })

  it('keeps duplicate timestamps and exact replicates as separate contributions', () => {
    const base = synth(100, 0.3, [0, 1, 2, 3])
    // Two exact replicates at t = 1, and a duplicate timestamp at t = 2.
    const withReplicates = rows([
      ...base.map((m) => [m.time, m.concentration] as const),
      [1, base[1]?.concentration as number],
      [2, base[2]?.concentration as number],
    ])
    const plain = okFit(fitMonoExponentialDecay(base))
    const replicated = okFit(fitMonoExponentialDecay(withReplicates))
    // Identical values on the curve do not move the fit...
    expect(replicated.k).toBeCloseTo(plain.k, 6)
    expect(replicated.cRef).toBeCloseTo(plain.cRef, 6)
    // ...but every row still counts.
    expect(replicated.measurementCount).toBe(6)
  })

  it('is invariant to input permutation and never mutates the caller array', () => {
    const data = synth(60, 0.2, [0, 1, 3, 5, 8])
    const copy = data.map((m) => ({ ...m }))
    const forward = okFit(fitMonoExponentialDecay(data))
    const reversed = okFit(fitMonoExponentialDecay([...data].reverse()))
    expect(reversed.k).toBeCloseTo(forward.k, 9)
    expect(reversed.cRef).toBeCloseTo(forward.cRef, 9)
    // The caller's array and rows are untouched, in their original order.
    expect(data).toEqual(copy)
    expect(data.map((m) => m.time)).toEqual([0, 1, 3, 5, 8])
  })
})

describe('boundary and non-identifiable cases', () => {
  it('reports the zero-rate boundary for constant concentrations', () => {
    const data = rows([
      [0, 10],
      [1, 10],
      [2, 10],
      [3, 10],
    ])
    const fit = okFit(fitMonoExponentialDecay(data))
    expect(fit.zeroRate).toBe(true)
    expect(fit.k).toBe(0)
    expect(fit.halfLife).toBeUndefined()
    expect(fit.warnings.map((w) => w.code)).toContain('ZERO_RATE_BOUNDARY')
  })

  it('returns the k = 0 boundary for increasing concentrations without inventing decay', () => {
    const data = rows([
      [0, 5],
      [1, 8],
      [2, 12],
      [3, 20],
    ])
    const fit = okFit(fitMonoExponentialDecay(data))
    expect(fit.zeroRate).toBe(true)
    expect(fit.k).toBe(0)
    expect(fit.halfLife).toBeUndefined()
    expect(fit.warnings.map((w) => w.code)).toContain('ZERO_RATE_BOUNDARY')
    expect(fit.warnings[0]?.message).toMatch(/no positive decay rate|no finite half-life/i)
  })

  it('rejects a single distinct time', () => {
    const result = fitMonoExponentialDecay(rows([
      [2, 10],
      [2, 11],
      [2, 12],
    ]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NO_TIME_SPAN')
  })

  it('identifies an all-zero dataset as non-identifiable', () => {
    const result = fitMonoExponentialDecay(rows([
      [0, 0],
      [1, 0],
      [2, 0],
    ]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ALL_ZERO_CONCENTRATIONS')
  })

  it('rejects empty input, non-finite values and negative values', () => {
    expect(fitMonoExponentialDecay([]).ok).toBe(false)
    const nonFinite = fitMonoExponentialDecay(rows([
      [0, 10],
      [Number.NaN, 5],
    ]))
    expect(nonFinite.ok).toBe(false)
    if (!nonFinite.ok) expect(nonFinite.code).toBe('INVALID_MEASUREMENT')
    const negative = fitMonoExponentialDecay(rows([
      [-1, 10],
      [1, 5],
    ]))
    expect(negative.ok).toBe(false)
    if (!negative.ok) expect(negative.code).toBe('NEGATIVE_VALUE')
  })
})

describe('numerical robustness', () => {
  it('handles very small and very large valid concentration magnitudes', () => {
    for (const scale of [1e-9, 1e-3, 1, 1e6, 1e9]) {
      const data = synth(scale, 0.3, [0, 1, 2, 4])
      const fit = okFit(fitMonoExponentialDecay(data))
      expect(fit.cRef).toBeGreaterThan(0)
      // Relative comparison: an absolute toBeCloseTo tolerance is meaningless
      // at 1e9 where one ulp is ~1e-7.
      expect(Math.abs(fit.cRef - scale) / scale).toBeLessThan(1e-9)
      expect(fit.k).toBeCloseTo(0.3, 5)
      expect(Number.isFinite(fit.sse)).toBe(true)
    }
  })

  it('handles small and large time scales', () => {
    for (const span of [1e-6, 1e-3, 1, 1e3, 1e6]) {
      const k = 0.5 / span
      const data = synth(10, k, [0, span * 0.25, span * 0.5, span])
      const fit = okFit(fitMonoExponentialDecay(data))
      expect(fit.k).toBeCloseTo(k, 4)
    }
  })

  it('warns when the optimum reaches the upper numerical bound', () => {
    // A decay so fast it collapses inside the first sampling interval.
    const data = rows([
      [0, 1],
      [1, 1e-30],
      [2, 1e-40],
    ])
    const fit = okFit(fitMonoExponentialDecay(data))
    const codes = fit.warnings.map((w) => w.code)
    expect(codes).toContain('RATE_AT_UPPER_BOUND')
    expect(fit.k).toBeCloseTo(MAX_DIMENSIONLESS_RATE / 2, 6)
  })

  it('reports finite, bounded parameters and curve points for every success', () => {
    const cases = [
      synth(100, 0.2, [0, 1, 2, 4]),
      synth(5, 0.9, [0, 0.5, 1, 2]),
      rows([[0, 10], [1, 10], [2, 10]]),
    ]
    for (const data of cases) {
      const fit = okFit(fitMonoExponentialDecay(data))
      expect(Number.isFinite(fit.cRef)).toBe(true)
      expect(Number.isFinite(fit.k)).toBe(true)
      expect(fit.k).toBeGreaterThanOrEqual(0)
      expect(fit.k).toBeLessThanOrEqual(MAX_DIMENSIONLESS_RATE)
      if (fit.halfLife !== undefined) expect(Number.isFinite(fit.halfLife)).toBe(true)
      const minTime = Math.min(...data.map((m) => m.time))
      const maxTime = Math.max(...data.map((m) => m.time))
      const curve = fitCurvePoints(fit, minTime, maxTime)
      expect(curve.length).toBeGreaterThan(1)
      for (const point of curve) {
        expect(Number.isFinite(point.time)).toBe(true)
        expect(Number.isFinite(point.concentration)).toBe(true)
        expect(point.time).toBeGreaterThanOrEqual(minTime)
        expect(point.time).toBeLessThanOrEqual(maxTime)
      }
    }
  })
})

describe('fitCurvePoints', () => {
  it('samples only inside the observed range, sorted ascending, never extrapolating', () => {
    const data = synth(100, 0.5, [1, 2, 3, 4])
    const fit = okFit(fitMonoExponentialDecay(data))
    const curve = fitCurvePoints(fit, 1, 4)
    expect(curve[0]?.time).toBe(1)
    expect(curve[curve.length - 1]?.time).toBe(4)
    for (let i = 1; i < curve.length; i += 1) {
      expect((curve[i]?.time as number)).toBeGreaterThan(curve[i - 1]?.time as number)
    }
    // Every point lies on the fitted equation.
    for (const point of curve) {
      expect(point.concentration).toBeCloseTo(100 * Math.exp(-0.5 * point.time), 6)
    }
  })

  it('is deterministic for the same fit', () => {
    const data = synth(40, 0.3, [0, 2, 4, 6])
    const fit = okFit(fitMonoExponentialDecay(data))
    expect(fitCurvePoints(fit, 0, 6)).toEqual(fitCurvePoints(fit, 0, 6))
  })

  it('returns no points for an invalid range', () => {
    const fit = okFit(fitMonoExponentialDecay(synth(10, 0.2, [0, 1, 2])))
    expect(fitCurvePoints(fit, 5, 1)).toEqual([])
    expect(fitCurvePoints(fit, Number.NaN, 1)).toEqual([])
  })
})
