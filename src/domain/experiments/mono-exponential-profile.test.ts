import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import {
  MAX_DIMENSIONLESS_RATE,
  fitMonoExponentialDecay,
  type MonoExponentialFitResult,
} from './mono-exponential-fit'
import {
  BROAD_BAND_FRACTION,
  MINIMUM_DISTINCT_TIMES,
  analyzeMonoExponentialProfile,
  profileRateGrid,
  type MonoExponentialProfileResult,
} from './mono-exponential-profile'

/**
 * Practical identifiability screening (phase 47C).
 *
 * Every fixture is SYNTHETIC: generated from a known equation, or a small
 * hand-written arithmetic series. No pharmacological measurement is used.
 * Assertions target the diagnostic's structure and direction (localized vs
 * broad vs boundary, present vs absent), never exact floating-point
 * formatting or grid internals.
 */

function rows(pairs: ReadonlyArray<readonly [number, number]>): ExperimentalMeasurement[] {
  return pairs.map(([time, concentration], index) => ({
    id: 'm' + String(index + 1),
    sourceRow: index + 1,
    time,
    concentration,
  }))
}

/** Noiseless data from the model's own equation, with a known rate. */
function synth(cRef: number, k: number, times: readonly number[]): ExperimentalMeasurement[] {
  return rows(times.map((time) => [time, cRef * Math.exp(-k * time)] as const))
}

function fitted(data: readonly ExperimentalMeasurement[]): Extract<
  MonoExponentialFitResult,
  { ok: true }
> {
  const result = fitMonoExponentialDecay(data)
  if (!result.ok) throw new Error('fit failed: ' + result.code + ' ' + result.message)
  return result
}

function profiled(data: readonly ExperimentalMeasurement[]): Extract<
  MonoExponentialProfileResult,
  { ok: true }
> {
  const result = analyzeMonoExponentialProfile(data, fitted(data))
  if (!result.ok) throw new Error('profile failed: ' + result.code + ' ' + result.message)
  return result
}

describe('a well-localized profile', () => {
  const data = synth(100, 0.25, [0, 1, 2, 4, 6, 8, 12])

  it('reports a localized minimum and a narrow near-minimum band', () => {
    const profile = profiled(data)
    expect(profile.localization).toBe('localized')
    expect(profile.nearMinimumBandResolution).toBe('measured')
    expect(profile.nearMinimumRateRange).not.toBeNull()
    const band = profile.nearMinimumRateRange
    if (band === null) return
    expect(band.min).toBeGreaterThan(0)
    expect(band.max).toBeGreaterThanOrEqual(band.min)
    // Narrow relative to the whole admissible interval.
    expect(profile.nearMinimumBandFraction).not.toBeNull()
    expect(profile.nearMinimumBandFraction as number).toBeLessThan(BROAD_BAND_FRACTION)
    expect(profile.sufficientDistinctTimes).toBe(true)
    expect(profile.distinctTimeCount).toBe(7)
    expect(profile.boundary.atLowerBound).toBe(false)
    expect(profile.boundary.atUpperBound).toBe(false)
    expect(profile.boundary.nearLowerBound).toBe(false)
    expect(profile.boundary.nearUpperBound).toBe(false)
  })

  it('contains the known rate inside the band and treats the estimate as the minimum', () => {
    const profile = profiled(data)
    const band = profile.nearMinimumRateRange
    if (band === null) throw new Error('expected a measured band')
    // The synthetic rate is 0.25; the band brackets it.
    expect(band.min).toBeLessThanOrEqual(0.25)
    expect(band.max).toBeGreaterThanOrEqual(0.25)
    expect(profile.objectiveDrop).toBeGreaterThan(0)
  })

  it('reports the fit estimate verbatim and never replaces it with a grid point', () => {
    const fit = fitted(data)
    const profile = analyzeMonoExponentialProfile(data, fit)
    if (!profile.ok) throw new Error('expected a profile')
    expect(profile.fittedRate).toBe(fit.k)
    expect(profile.fittedSse).toBe(fit.sse)

    const valid = profile.points.filter((point) => point.ok)
    expect(valid.length).toBeGreaterThan(100)

    // The estimate and the best evaluated candidate agree to numerical
    // resolution at the data's own scale (the optimizer stops on a relative
    // tolerance, so its value may sit a few ulps above the best grid value).
    // Neither is ever substituted for the other.
    let bestEvaluated = Number.POSITIVE_INFINITY
    for (const point of valid) {
      if (point.ok && point.sse < bestEvaluated) bestEvaluated = point.sse
    }
    expect(Math.abs(bestEvaluated - fit.sse)).toBeLessThanOrEqual(1e-9 * 100 ** 2)
  })
})

describe('a broad, poorly localized profile', () => {
  it('reports a broad band when many rates fit nearly equally well', () => {
    // A fast initial drop followed by noise: the objective is flat for a wide
    // range of rates, so forcing the rate away barely worsens the residual.
    const data = rows([
      [0, 100],
      [1, 20],
      [2, 25],
      [3, 22],
      [4, 24],
    ])
    const profile = profiled(data)
    expect(profile.localization).toBe('broad')
    expect(profile.nearMinimumBandFraction).not.toBeNull()
    expect(profile.nearMinimumBandFraction as number).toBeGreaterThan(BROAD_BAND_FRACTION)
    const band = profile.nearMinimumRateRange
    if (band === null) throw new Error('expected a measured band')
    expect(band.max / band.min).toBeGreaterThan(1)
  })
})

describe('boundary optima', () => {
  it('classifies a k = 0 estimate as a zero-rate boundary with no band', () => {
    const data = rows([
      [0, 5],
      [1, 9],
      [2, 20],
    ])
    const profile = profiled(data)
    expect(profile.localization).toBe('boundary-zero-rate')
    expect(profile.boundary.atLowerBound).toBe(true)
    expect(profile.boundary.dimensionlessRate).toBe(0)
    expect(profile.nearMinimumRateRange).toBeNull()
    expect(profile.nearMinimumBandFraction).toBeNull()
    expect(profile.nearMinimumBandResolution).toBe('not-applicable')
    expect(profile.objectiveDrop).toBe(0)
    expect(profile.warnings.join(' ')).toMatch(/zero-rate boundary/i)
  })

  it('classifies a cap-reaching estimate as an unresolved upper-bound rate', () => {
    // Decay far faster than the sampled window: the optimum runs to the
    // optimizer's numerical cap.
    const data = rows([
      [0, 100],
      [2, 0],
      [4, 0],
      [6, 0],
      [8, 0],
    ])
    const profile = profiled(data)
    expect(profile.localization).toBe('boundary-upper-rate')
    expect(profile.boundary.atUpperBound).toBe(true)
    expect(profile.warnings.join(' ')).toMatch(/upper bound/i)
  })

  it('flags an interior estimate that barely decays as near the lower bound', () => {
    // ~0.7 % predicted decline across the span: indistinguishable from no decay.
    const data = rows([
      [0, 100],
      [1, 99.5],
      [2, 99.6],
      [3, 99.2],
    ])
    const profile = profiled(data)
    expect(profile.boundary.atLowerBound).toBe(false)
    expect(profile.boundary.dimensionlessRate).toBeGreaterThan(0)
    expect(profile.boundary.nearLowerBound).toBe(true)
    // A band squeezed against the bound cannot be measured as a shape.
    expect(profile.localization).toBe('indeterminate')
    expect(profile.warnings.join(' ')).toMatch(/close to the zero-rate boundary/i)
  })
})

describe('insufficient distinct time points', () => {
  it('reports the sparse-time state without inventing a shape', () => {
    // Four rows, but only two distinct times: replicates add information about
    // scatter, not about the rate.
    const data = rows([
      [0, 100],
      [0, 98],
      [1, 50],
      [1, 49],
    ])
    const profile = profiled(data)
    expect(profile.sufficientDistinctTimes).toBe(false)
    expect(profile.distinctTimeCount).toBe(2)
    expect(profile.measurementCount).toBe(4)
    expect(profile.localization).toBe('indeterminate')
    expect(profile.warnings.join(' ')).toMatch(/2 distinct time points/i)
    // The candidate data is still returned for visualization, and the rows are
    // not collapsed: the count comes from the measurements, not the fit.
    expect(profile.validPointCount).toBeGreaterThan(1)
  })

  it('uses the documented minimum as the boundary of sufficiency', () => {
    const atFloor = profiled(synth(100, 0.5, [0, 1, 2]))
    expect(MINIMUM_DISTINCT_TIMES).toBe(3)
    expect(atFloor.distinctTimeCount).toBe(3)
    expect(atFloor.sufficientDistinctTimes).toBe(true)
  })
})

describe('failed candidate evaluations', () => {
  it('reports candidates it could not evaluate instead of substituting values', () => {
    // A subnormal (but positive) span: k = q / span overflows to Infinity for
    // every q > 0, so only the k = 0 candidate is representable. The constant
    // concentrations put the estimate exactly at the zero-rate boundary.
    const data = rows([
      [0, 100],
      [Number.MIN_VALUE, 100],
    ])
    const profile = profiled(data)
    expect(profile.invalidPointCount).toBeGreaterThan(0)
    expect(profile.validPointCount).toBeGreaterThanOrEqual(1)
    expect(profile.admissibleRateRange.max).toBeNull()
    expect(profile.invalidPointCount + profile.validPointCount).toBe(profile.points.length)
    for (const point of profile.points) {
      if (point.ok) continue
      expect(point.reason).toBe('NON_FINITE_RATE')
      expect(point.k).toBeNull()
    }
    expect(profile.warnings.join(' ')).toMatch(/could not be evaluated/i)
    expect(profile.warnings.join(' ')).toMatch(/not .*interpolated/i)
  })

  it('keeps failed candidates out of the near-minimum band', () => {
    const profile = profiled(
      rows([
        [0, 100],
        [Number.MIN_VALUE, 100],
      ]),
    )
    const band = profile.nearMinimumRateRange
    if (band === null) return
    expect(Number.isFinite(band.min)).toBe(true)
    expect(Number.isFinite(band.max)).toBe(true)
  })
})

describe('degenerate datasets', () => {
  const fitOf = (data: readonly ExperimentalMeasurement[]) => fitted(data)

  it('refuses to profile an empty dataset', () => {
    const data = rows([
      [0, 10],
      [1, 5],
    ])
    const result = analyzeMonoExponentialProfile([], fitOf(data))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('NO_MEASUREMENTS')
  })

  it('refuses rows that do not match the fitted dataset', () => {
    const data = rows([
      [0, 10],
      [1, 5],
      [2, 2.5],
    ])
    const result = analyzeMonoExponentialProfile(data.slice(0, 2), fitOf(data))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('MEASUREMENT_MISMATCH')
    expect(result.message).toMatch(/do not match/i)
  })

  it('refuses a single distinct time', () => {
    const data = rows([
      [2, 10],
      [2, 12],
    ])
    // The fit rejects this dataset outright. The profile shares the same
    // validation, so a structurally impossible fit is reported as unavailable
    // rather than profiled into a meaningless shape.
    expect(fitMonoExponentialDecay(data).ok).toBe(false)
    const result = analyzeMonoExponentialProfile(data, {
      ok: true,
      tRef: 2,
      cRef: 11,
      k: 0,
      sse: 2,
      measurementCount: 2,
      zeroRate: true,
      warnings: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('NO_TIME_SPAN')
  })

  it('reports all-zero concentrations as non-identifiable', () => {
    const data = rows([
      [0, 0],
      [1, 0],
      [2, 0],
    ])
    const result = analyzeMonoExponentialProfile(data, {
      ok: true,
      tRef: 0,
      cRef: 0,
      k: 0,
      sse: 0,
      measurementCount: 3,
      zeroRate: true,
      warnings: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ALL_ZERO_CONCENTRATIONS')
  })

  it('rejects a fit carrying a non-finite parameter', () => {
    const data = rows([
      [0, 10],
      [1, 5],
      [2, 2.5],
    ])
    const result = analyzeMonoExponentialProfile(data, {
      ok: true,
      tRef: 0,
      cRef: 10,
      k: Number.NaN,
      sse: 0,
      measurementCount: 3,
      zeroRate: false,
      warnings: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('NON_FINITE_PARAMETER')
  })

  it('rejects a malformed measurement row without throwing', () => {
    const data = rows([
      [0, 10],
      [1, 5],
    ])
    const malformed = [data[0], null] as unknown as readonly ExperimentalMeasurement[]
    const result = analyzeMonoExponentialProfile(malformed, {
      ok: true,
      tRef: 0,
      cRef: 10,
      k: 0.5,
      sse: 0,
      measurementCount: 2,
      zeroRate: false,
      warnings: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('INVALID_MEASUREMENT')
  })
})

describe('the objective itself', () => {
  it('evaluates the same residual sum of squares the fit minimises', () => {
    // Independent arithmetic: at k = 0 the best amplitude is the mean
    // concentration, so the objective is the total sum of squares about it.
    const data = rows([
      [0, 10],
      [1, 0],
      [2, 10],
    ])
    const profile = profiled(data)
    const mean = (10 + 0 + 10) / 3
    const expected =
      (10 - mean) ** 2 + (0 - mean) ** 2 + (10 - mean) ** 2
    expect(profile.zeroRateSse).toBeCloseTo(expected, 6)
    expect(profile.objectiveDrop).toBeCloseTo(expected - profile.fittedSse, 6)
    expect(profile.objectiveDrop).toBeGreaterThanOrEqual(0)
  })

  it('evaluates a documented, ascending grid over the full admissible range', () => {
    const grid = profileRateGrid()
    expect(grid[0]).toBe(0)
    expect(grid[grid.length - 1]).toBe(MAX_DIMENSIONLESS_RATE)
    for (let index = 1; index < grid.length; index += 1) {
      expect(grid[index] as number).toBeGreaterThan(grid[index - 1] as number)
    }
    const profile = profiled(synth(100, 0.4, [0, 1, 2, 4]))
    expect(profile.points).toHaveLength(grid.length)
    // Candidate rates ascend, and the admissible range matches the bounds.
    const rates = profile.points.map((point) => point.q)
    expect(rates).toEqual([...grid])
    expect(profile.admissibleRateRange.min).toBe(0)
    expect(profile.admissibleRateRange.max).not.toBeNull()
    expect(profile.admissibleRateRange.max as number).toBeCloseTo(MAX_DIMENSIONLESS_RATE / 4, 9)
  })
})

describe('data integrity', () => {
  it('never mutates the caller’s measurements', () => {
    const data = synth(80, 0.3, [0, 1, 3, 6])
    const snapshot = data.map((measurement) => ({ ...measurement }))
    data.forEach((measurement) => Object.freeze(measurement))
    Object.freeze(data)
    const profile = analyzeMonoExponentialProfile(data, fitted(data))
    expect(profile.ok).toBe(true)
    expect(data).toEqual(snapshot)
  })

  it('keeps duplicate timestamps as independent observations', () => {
    const withReplicates = rows([
      [0, 100],
      [0, 100],
      [1, 60],
      [1, 60],
      [2, 36],
    ])
    const profile = profiled(withReplicates)
    // The duplicated rows change the objective: doubling two rows is not the
    // same as averaging them away.
    expect(profile.measurementCount).toBe(5)
    expect(profile.distinctTimeCount).toBe(3)
    const single = profiled(rows([
      [0, 100],
      [1, 60],
      [2, 36],
    ]))
    expect(profile.zeroRateSse).not.toBeCloseTo(single.zeroRateSse, 9)
  })

  it('is deterministic for the same fit', () => {
    const data = synth(120, 0.35, [0, 1, 2, 5])
    const fit = fitted(data)
    expect(analyzeMonoExponentialProfile(data, fit)).toEqual(
      analyzeMonoExponentialProfile(data, fit),
    )
  })

  it('always states its limitations', () => {
    const profile = profiled(synth(100, 0.25, [0, 1, 2, 4]))
    const text = profile.limitations.join(' ')
    expect(text).toMatch(/not a structural or formal practical-identifiability proof/i)
    expect(text).toMatch(/not a confidence interval/i)
    expect(text).toMatch(/not a likelihood/i)
    expect(text).toMatch(/alternative models/i)
    expect(profile.limitations.length).toBeGreaterThanOrEqual(4)
  })
})
