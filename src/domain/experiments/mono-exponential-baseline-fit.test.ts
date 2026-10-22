import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import { fitMonoExponentialWithBaseline } from './mono-exponential-baseline-fit'
import { fitMonoExponentialDecay, type MonoExponentialFitResult } from './mono-exponential-fit'

/**
 * M1 — mono-exponential decay with an additive baseline (phase 47C).
 *
 * All fixtures are SYNTHETIC, generated from the model equation with full
 * floating-point precision (never pre-rounded literals, which would move the
 * generating parameters away from the values being recovered).
 */

let counter = 0
const row = (time: number, concentration: number): ExperimentalMeasurement => {
  counter += 1
  return { id: `m${counter}`, sourceRow: counter, time, concentration }
}

const rows = (pairs: ReadonlyArray<readonly [number, number]>): ExperimentalMeasurement[] => {
  counter = 0
  return pairs.map(([time, concentration]) => row(time, concentration))
}

/** C(t) = B + A·exp(−k·(t − tRef)) evaluated at full precision. */
const synth = (
  amplitude: number,
  baseline: number,
  k: number,
  times: readonly number[],
  tRef = 0,
): ExperimentalMeasurement[] =>
  rows(times.map((time) => [time, baseline + amplitude * Math.exp(-k * (time - tRef))] as const))

const baselineFit = (data: readonly ExperimentalMeasurement[]) => {
  const result = fitMonoExponentialWithBaseline(data)
  if (!result.ok) throw new Error('baseline fit failed: ' + result.code + ' ' + result.message)
  return result
}

const monoFit = (data: readonly ExperimentalMeasurement[]): Extract<
  MonoExponentialFitResult,
  { ok: true }
> => {
  const result = fitMonoExponentialDecay(data)
  if (!result.ok) throw new Error('mono fit failed: ' + result.code + ' ' + result.message)
  return result
}

describe('M1 recovers known parameters', () => {
  /**
   * Tolerances are relative to the generating value and justified by the
   * method: a bracketed golden-section refinement on noiseless data leaves the
   * objective flat to well below any measurement resolution, so the recovered
   * parameter is limited by the refinement tolerance rather than by the data.
   */
  const relativeError = (actual: number, expected: number): number =>
    expected === 0 ? Math.abs(actual) : Math.abs(actual - expected) / Math.abs(expected)

  it('recovers A, B and k from a noiseless decaying-plus-baseline series', () => {
    const data = synth(90, 10, 0.4, [0, 0.5, 1, 2, 3, 5])
    const fit = baselineFit(data)

    expect(relativeError(fit.amplitude, 90)).toBeLessThan(1e-5)
    expect(relativeError(fit.baseline, 10)).toBeLessThan(1e-5)
    expect(relativeError(fit.k, 0.4)).toBeLessThan(1e-6)
    expect(fit.sse).toBeLessThan(1e-8)
    expect(fit.measurementCount).toBe(6)
    expect(fit.meanParameterCount).toBe(3)
    expect(fit.zeroRate).toBe(false)
    expect(fit.rateInformative).toBe(true)
    expect(fit.warnings).toEqual([])
    expect(relativeError(fit.halfLife ?? 0, Math.LN2 / 0.4)).toBeLessThan(1e-6)
  })

  it('uses the earliest observation as t_ref when it is not zero', () => {
    // No measurement at zero: A must be the amplitude AT t_ref, and B the
    // baseline the decay approaches.
    const data = synth(40, 6, 0.5, [2, 3, 5, 7], 2)
    const fit = baselineFit(data)
    expect(fit.tRef).toBe(2)
    expect(relativeError(fit.amplitude, 40)).toBeLessThan(1e-5)
    expect(relativeError(fit.baseline, 6)).toBeLessThan(1e-5)
    expect(relativeError(fit.k, 0.5)).toBeLessThan(1e-6)
  })

  it('recovers a purely exponential decay with a zero baseline', () => {
    const data = synth(100, 0, 0.5, [0, 1, 2, 3, 4])
    const fit = baselineFit(data)
    expect(relativeError(fit.amplitude, 100)).toBeLessThan(1e-5)
    expect(fit.baseline).toBeLessThan(1e-6)
    expect(relativeError(fit.k, 0.5)).toBeLessThan(1e-6)
    expect(fit.warnings.map((warning) => warning.code)).toContain('BASELINE_AT_ZERO')
  })

  it('never lets the baseline model fit worse than the nested decay model', () => {
    const cases = [
      synth(90, 10, 0.4, [0, 0.5, 1, 2, 3, 5]),
      synth(100, 0, 0.5, [0, 1, 2, 3, 4]),
      synth(20, 5, 1.2, [0, 0.25, 0.75, 1.5]),
      rows([
        [0, 100],
        [1, 80],
        [2, 75],
        [3, 45],
      ]),
    ]
    for (const data of cases) {
      const m0 = monoFit(data)
      const m1 = baselineFit(data)
      const scale = Math.max(...data.map((measurement) => measurement.concentration)) ** 2
      // B = 0 is inside M1's feasible set, so its objective cannot be higher —
      // checked to numerical resolution at the data's own scale, because on
      // noiseless data both sums of squares are floating-point noise.
      expect(m1.sse).toBeLessThanOrEqual(m0.sse + 1e-9 * scale)
      expect(m1.amplitude).toBeGreaterThanOrEqual(0)
      expect(m1.baseline).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('M1 boundary and degenerate cases', () => {
  it('reports a constant series as a baseline-only fit at the zero-rate boundary', () => {
    const data = rows([
      [0, 100],
      [1, 100],
      [2, 100],
    ])
    const fit = baselineFit(data)
    expect(fit.zeroRate).toBe(true)
    expect(fit.k).toBe(0)
    expect(fit.amplitude).toBe(0)
    expect(fit.baseline).toBeCloseTo(100, 10)
    expect(fit.rateInformative).toBe(false)
    expect(fit.halfLife).toBeUndefined()
    expect(fit.warnings.map((warning) => warning.code)).toContain('ZERO_RATE_BOUNDARY')
  })

  it('does not invent decay for increasing concentrations', () => {
    const data = rows([
      [0, 5],
      [1, 9],
      [2, 20],
    ])
    const fit = baselineFit(data)
    expect(fit.zeroRate).toBe(true)
    expect(fit.amplitude).toBe(0)
    expect(fit.baseline).toBeCloseTo((5 + 9 + 20) / 3, 10)
  })

  it('reports the numerical upper bound when the decay runs off the range', () => {
    const data = rows([
      [0, 100],
      [2, 0],
      [4, 0],
      [6, 0],
      [8, 0],
    ])
    const fit = baselineFit(data)
    expect(fit.warnings.map((warning) => warning.code)).toContain('RATE_AT_UPPER_BOUND')
    expect(fit.k).toBeGreaterThan(0)
  })

  it('fails structurally rather than returning placeholder parameters', () => {
    const cases: ReadonlyArray<readonly [string, readonly ExperimentalMeasurement[], string]> = [
      ['empty', [], 'NO_MEASUREMENTS'],
      ['single time', rows([[2, 10], [2, 12]]), 'NO_TIME_SPAN'],
      ['all zero', rows([[0, 0], [1, 0]]), 'ALL_ZERO_CONCENTRATIONS'],
    ]
    for (const [label, data, code] of cases) {
      const result = fitMonoExponentialWithBaseline(data)
      expect(result.ok, label).toBe(false)
      if (!result.ok) expect(result.code, label).toBe(code)
    }
    const negative = fitMonoExponentialWithBaseline(rows([[0, -1], [1, 5]]))
    expect(negative.ok).toBe(false)
    if (!negative.ok) expect(negative.code).toBe('NEGATIVE_VALUE')
    const malformed = fitMonoExponentialWithBaseline([
      null,
    ] as unknown as readonly ExperimentalMeasurement[])
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.code).toBe('INVALID_MEASUREMENT')
  })
})

describe('M1 data integrity', () => {
  it('keeps duplicate timestamps and replicates as separate observations', () => {
    // Four distinct times with three parameters cannot be fitted exactly, so
    // every row carries weight. Duplicating the t = 0 observation must
    // therefore move the estimate — proof that the row is a separate
    // contribution rather than a collapsed duplicate.
    const base = rows([
      [0, 100],
      [1, 62],
      [2, 40],
      [4, 20],
    ])
    const replicated = rows([
      [0, 100],
      [0, 100],
      [1, 62],
      [2, 40],
      [4, 20],
    ])
    const baseFit = baselineFit(base)
    const replicatedFit = baselineFit(replicated)

    expect(replicatedFit.measurementCount).toBe(5)
    expect(baseFit.measurementCount).toBe(4)
    const amplitudeChange =
      Math.abs(replicatedFit.amplitude - baseFit.amplitude) / baseFit.amplitude
    const baselineChange = Math.abs(replicatedFit.baseline - baseFit.baseline)
    expect(amplitudeChange + baselineChange).toBeGreaterThan(1e-6)
  })

  it('never mutates the caller’s measurements and is deterministic', () => {
    const data = synth(50, 8, 0.9, [0, 0.5, 1, 2, 4])
    const snapshot = data.map((measurement) => ({ ...measurement }))
    data.forEach((measurement) => Object.freeze(measurement))
    Object.freeze(data)

    const first = fitMonoExponentialWithBaseline(data)
    const second = fitMonoExponentialWithBaseline(data)
    expect(first).toEqual(second)
    expect(data).toEqual(snapshot)
  })
})
