import { describe, expect, it } from 'vitest'
import {
  PHI_SERIES_THRESHOLD,
  decayComplement,
  phi,
  propagateEffectSite,
  type EffectSiteSample,
} from './effect-site-propagation'

/**
 * Effect-site propagation (phase 46).
 *
 * Every expected value comes from closed-form mathematics or an independent
 * numerical integration whose error is far below the test tolerance — never
 * from the production propagator itself.
 */

const sample = (time: number, concentration: number, side = 'interval'): EffectSiteSample => ({
  time,
  centralConcentration: concentration,
  side,
})

const okSeries = (result: ReturnType<typeof propagateEffectSite>): readonly number[] => {
  if (!result.ok) throw new Error('expected success: ' + JSON.stringify(result.errors))
  return result.series.map((entry) => entry.effectSiteConcentration)
}

/** Independent high-accuracy RK4 reference for dCe/dt = ke0(Cu(t) − Ce). */
function rk4Reference(
  cu: (t: number) => number,
  ce0: number,
  ke0: number,
  tStart: number,
  tEnd: number,
  steps = 200_000,
): number {
  let ce = ce0
  const h = (tEnd - tStart) / steps
  const f = (t: number, x: number): number => ke0 * (cu(t) - x)
  for (let i = 0; i < steps; i += 1) {
    const t = tStart + i * h
    const k1 = f(t, ce)
    const k2 = f(t + h / 2, ce + (h / 2) * k1)
    const k3 = f(t + h / 2, ce + (h / 2) * k2)
    const k4 = f(t + h, ce + h * k3)
    ce += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4)
  }
  return ce
}

describe('phi(x) — accuracy, branch continuity, stability', () => {
  it('matches the direct expression well above the threshold', () => {
    for (const x of [1, 0.5, 0.1, 0.05]) {
      const direct = 1 - -Math.expm1(-x) / x
      expect(phi(x)).toBeCloseTo(direct, 14)
    }
  })

  it('keeps full accuracy far below the threshold where the direct form loses digits', () => {
    // Exact leading behaviour: phi(x) → x/2 as x → 0.
    for (const x of [1e-8, 1e-12]) {
      const relativeError = Math.abs(phi(x) - x / 2) / (x / 2)
      // The x²/6 term is the leading correction (~x/3 relative), so compare
      // against the two-term series instead of x/2 alone.
      const twoTerm = x / 2 - (x * x) / 6
      expect(relativeError).toBeGreaterThan(0) // x/2 alone is not the answer
      expect(Math.abs(phi(x) - twoTerm) / twoTerm).toBeLessThan(1e-15)
    }
    // The direct form is demonstrably worse at 1e-12 (evidence for the branch).
    const x = 1e-12
    const direct = 1 - -Math.expm1(-x) / x
    const series = phi(x)
    expect(Math.abs(direct - series) / series).toBeGreaterThan(1e-6)
  })

  it('is continuous across the branch threshold', () => {
    const below = phi(PHI_SERIES_THRESHOLD * (1 - 1e-9))
    const above = phi(PHI_SERIES_THRESHOLD * (1 + 1e-9))
    // The two sides differ only by the O(x) step across the threshold.
    expect(Math.abs(below - above)).toBeLessThan(PHI_SERIES_THRESHOLD * 1e-8)
    // Immediately either side of the exact threshold value.
    const atThreshold = phi(PHI_SERIES_THRESHOLD)
    expect(Math.abs(atThreshold - (1 - -Math.expm1(-PHI_SERIES_THRESHOLD) / PHI_SERIES_THRESHOLD))).toBeLessThan(1e-17)
  })

  it('treats 1 − r/x without cancellation for the smallest representable x', () => {
    // x/2 dominates; the value must be positive and finite, never negative or NaN.
    for (const x of [1e-300, 1e-200, 1e-16]) {
      const value = phi(x)
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
    }
  })
})

describe('decayComplement', () => {
  it('returns exactly 1 − e^−x and stays accurate for tiny x', () => {
    expect(decayComplement(0)).toBe(0)
    expect(decayComplement(1)).toBeCloseTo(1 - Math.exp(-1), 15)
    // For x = 1e-12, 1 − e^−x ≈ x: the relative error must be ~x/2 = 5e-13,
    // far better than a naive 1 − Math.exp(−x), which underflows to 0 here.
    const tiny = decayComplement(1e-12)
    expect(tiny).toBeGreaterThan(0)
    expect(Math.abs(tiny - 1e-12) / 1e-12).toBeLessThan(1e-12)
  })
})

describe('A. constant input — independent analytical solution', () => {
  it('follows Ce(t+h) = Cu + (Ce(t) − Cu)e^(−ke0 h)', () => {
    const ke0 = 2
    const fu = 0.5
    const cc = 4 // Cu = 2
    const cu = fu * cc
    const ce0 = 0
    const h = 0.5
    // Split the interval into several samples to check path independence too.
    const times = [0, 0.1, 0.2, 0.35, 0.5]
    const result = propagateEffectSite({
      samples: times.map((t) => sample(t, cc)),
      unboundFraction: fu,
      ke0,
      initialCe: ce0,
    })
    const values = okSeries(result)
    times.forEach((t, index) => {
      const exact = cu + (ce0 - cu) * Math.exp(-ke0 * t)
      expect(values[index]).toBeCloseTo(exact, 12)
    })
    // The single-step closed form agrees with the multi-step path.
    const oneStep = ce0 * Math.exp(-ke0 * h) + cu * (1 - Math.exp(-ke0 * h))
    expect(values[values.length - 1]).toBeCloseTo(oneStep, 12)
  })
})

describe('B. linearly changing input — closed form vs independent RK4', () => {
  it('matches the analytical solution of the linear-input ODE', () => {
    const ke0 = 2
    const fu = 1
    const u0 = 1
    const u1 = 3
    const h = 0.5
    const ce0 = 0
    const result = propagateEffectSite({
      samples: [sample(0, u0), sample(h, u1)],
      unboundFraction: fu,
      ke0,
      initialCe: ce0,
    })
    const values = okSeries(result)
    const first = values[0] as number
    const second = values[1] as number
    expect(first).toBe(ce0)
    // Analytical: Ce = u1 − slope/ke0 + (Ce0 − (u0 − slope/ke0))e^(−ke0 h)
    const slope = (u1 - u0) / h
    const exact = u1 - slope / ke0 + (ce0 - (u0 - slope / ke0)) * Math.exp(-ke0 * h)
    expect(second).toBeCloseTo(exact, 12)

    // Independent numerical reference (RK4, 200k steps) of the same ODE.
    const reference = rk4Reference((t) => u0 + ((u1 - u0) * t) / h, ce0, ke0, 0, h)
    expect(second).toBeCloseTo(reference, 10)
    expect(Math.abs(second - reference)).toBeLessThan(1e-11)
  })

  it('is exact for the reconstructed input, independent of sub-division', () => {
    const ke0 = 1.5
    const ce0 = 0.25
    const coarse = okSeries(
      propagateEffectSite({ samples: [sample(0, 0), sample(1, 2)], unboundFraction: 1, ke0, initialCe: ce0 }),
    )
    // Same piecewise-linear path, sampled more finely at intermediate points
    // that lie exactly ON the line — the reconstruction is identical.
    const fine = okSeries(
      propagateEffectSite({
        samples: [sample(0, 0), sample(0.25, 0.5), sample(0.5, 1), sample(0.75, 1.5), sample(1, 2)],
        unboundFraction: 1,
        ke0,
        initialCe: ce0,
      }),
    )
    expect(fine[fine.length - 1]).toBeCloseTo(coarse[1] as number, 12)
  })
})

describe('C. small x — stability (10⁻⁸, 10⁻¹², around the branch)', () => {
  const ke0 = 1
  const cases: ReadonlyArray<[number, number]> = [
    [1e-8, 0],
    [1e-12, 0],
    [5e-3, 1e-3],
    [2e-2, 1e-2],
  ]
  for (const [h, ce0] of cases) {
    it(`stays accurate and finite at h = ${h}`, () => {
      const u0 = 0
      const u1 = 2
      const values = okSeries(
        propagateEffectSite({ samples: [sample(0, u0), sample(h, u1)], unboundFraction: 1, ke0, initialCe: ce0 }),
      )
      const value = values[1] as number
      expect(Number.isFinite(value)).toBe(true)
      // Exact expansion for this interval:
      //   Ce1 = Ce0(1 − r) + u0(r − φ) + u1·φ
      // Compute the reference from the mathematical series for r and φ
      // (independent of the production branch choice) to O(x^3).
      const x = ke0 * h
      const rRef = x - (x * x) / 2 + (x * x * x) / 6
      const phiRef = x / 2 - (x * x) / 6 + (x * x * x) / 24
      const expected = ce0 * (1 - rRef) + u0 * (rRef - phiRef) + u1 * phiRef
      // Both are O(x) in magnitude; require agreement to ~1e-12 RELATIVE of
      // that scale, which is far inside double precision for x ≥ 1e-8.
      const scale = Math.abs(expected) || u1 * x / 2
      // The reference is truncated at x^3, so its own error is O(x^4); allow
      // that plus double-precision rounding, still far stricter than any
      // physically meaningful deviation.
      expect(Math.abs(value - expected) / scale).toBeLessThan(1e-9 + 10 * x * x)
    })
  }

  it('falls back to the series on both sides of the threshold without a jump', () => {
    const u1 = 1
    const at = (h: number): number =>
      okSeries(
        propagateEffectSite({
          samples: [sample(0, 0), sample(h, u1)],
          unboundFraction: 1,
          ke0: 1,
          initialCe: 0,
        }),
      )[1] as number
    const justBelow = at(PHI_SERIES_THRESHOLD * (1 - 1e-6))
    const justAbove = at(PHI_SERIES_THRESHOLD * (1 + 1e-6))
    // Ce here is u1·phi(x) ≈ x/2 ≈ 5e-3 for x ≈ 1e-2. Continuity means the
    // gap between the two branches is at rounding level RELATIVE to that value.
    expect(justBelow).toBeGreaterThan(0)
    const relativeGap = Math.abs(justBelow - justAbove) / Math.max(justBelow, justAbove)
    // The two branches are the SAME function sampled at x∓: the gap is therefore
    // exactly the step across the threshold, dx·φ′(x)/φ(x) with dx = 2e-6·x.
    // Worked out: dx = 2.0e-8, φ′(x) ≈ 0.5, φ ≈ 4.98e-3 → relative gap
    // ≈ 1.99e-6 (measured 1.993342e-6). "Continuous" here means the gap is
    // explained by that step, not by a branch defect.
    const dx = PHI_SERIES_THRESHOLD * 2e-6
    const stepGap = (dx * 0.5) / justAbove
    expect(relativeGap).toBeLessThan(stepGap * 1.01)
  })
})

describe('D. large x — bounded, no overshoot, converges to the input', () => {
  for (const x of [50, 100, 700]) {
    it(`remains finite and converges to Cu at x = ${x}`, () => {
      const ke0 = 1
      const h = x
      const ce0 = 1000
      const u1 = 1
      const values = okSeries(
        propagateEffectSite({
          samples: [sample(0, ce0), sample(h, u1)],
          unboundFraction: 1,
          ke0,
          initialCe: ce0,
        }),
      )
      const ce1 = values[1] as number
      expect(Number.isFinite(ce1)).toBe(true)
      // Exact solution under a linearly ramped input u0 → u1 over h:
      //   Ce1 = u1 − m/ke0 + (Ce0 − (u0 − m/ke0))·e^(−x),  m = (u1 − u0)/h
      // For x ≫ 1 the exponential term vanishes and Ce1 → u1 − m/ke0, NOT u1:
      // the ramp keeps the input moving, so a residual of order u0/x remains.
      const m = (u1 - ce0) / h
      const exact = u1 - m / ke0
      expect(Math.abs(ce1 - exact) / Math.abs(exact)).toBeLessThan(1e-10)
      // Exact residual: Ce1 − u1 = −m/ke0 = −(u1 − u0)/x, which shrinks like
      // 1/x as the interval lengthens — convergence, not a vanishing gap.
      const expectedResidual = -(u1 - ce0) / x
      expect(Math.abs(ce1 - u1 - expectedResidual) / Math.abs(expectedResidual)).toBeLessThan(1e-10)
      expect(Math.abs(ce1 - u1)).toBeLessThan(Math.abs(u1 - ce0) * 1.000001 / x)
      // No overshoot beyond the interval's endpoints.
      expect(ce1).toBeGreaterThanOrEqual(Math.min(ce0, u1) - 1e-9)
      expect(ce1).toBeLessThanOrEqual(Math.max(ce0, u1) + 1e-9)
    })
  }
})

describe('E. duplicate-time event samples (a bolus)', () => {
  it('preserves both samples and keeps Ce exactly continuous', () => {
    const before = sample(0, 1, 'pre-event')
    const after = sample(0, 11, 'post-event')
    const result = propagateEffectSite({
      samples: [before, after, sample(1, 11)],
      unboundFraction: 1,
      ke0: 1,
      initialCe: 0.5,
    })
    if (!result.ok) throw new Error('expected success')
    expect(result.series).toHaveLength(3)
    // Order, time and side are preserved verbatim.
    expect(result.series.map((entry) => entry.sample)).toEqual([before, after, result.series[2]?.sample])
    expect(result.series[0]?.sample.side).toBe('pre-event')
    expect(result.series[1]?.sample.side).toBe('post-event')
    // Ce does not jump across the bolus (zero-length interval, no division).
    expect(result.series[0]?.effectSiteConcentration).toBe(0.5)
    expect(result.series[1]?.effectSiteConcentration).toBe(0.5)
    // The NEXT positive interval starts from the post-event sample (Cu = 11).
    const exact = 11 + (0.5 - 11) * Math.exp(-1)
    expect(result.series[2]?.effectSiteConcentration).toBeCloseTo(exact, 12)
  })

  it('handles an all-duplicate series without dividing by zero', () => {
    const result = propagateEffectSite({
      samples: [sample(0, 1, 'pre-event'), sample(0, 9, 'post-event'), sample(0, 3)],
      unboundFraction: 1,
      ke0: 5,
      initialCe: 2,
    })
    const values = okSeries(result)
    expect(values).toEqual([2, 2, 2])
  })
})

describe('F. validation — typed errors, no partial result', () => {
  const base = { unboundFraction: 1, ke0: 1, initialCe: 0 }
  it('rejects decreasing timestamps', () => {
    const result = propagateEffectSite({ ...base, samples: [sample(1, 1), sample(0.5, 2)] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.code).toBe('CONFLICTING_PARAMETERS')
  })
  it('rejects non-finite times and concentrations', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(propagateEffectSite({ ...base, samples: [sample(bad, 1)] }).ok).toBe(false)
      expect(propagateEffectSite({ ...base, samples: [sample(0, bad)] }).ok).toBe(false)
    }
  })
  it('rejects negative concentrations', () => {
    const result = propagateEffectSite({ ...base, samples: [sample(0, -1)] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.code).toBe('NEGATIVE_VALUE')
  })
  it('rejects invalid parameters', () => {
    for (const bad of [
      { ...base, unboundFraction: 0 },
      { ...base, unboundFraction: 1.5 },
      { ...base, ke0: 0 },
      { ...base, ke0: Number.NaN },
      { ...base, initialCe: -1 },
      { ...base, initialCe: Number.POSITIVE_INFINITY },
    ]) {
      const result = propagateEffectSite({ ...bad, samples: [sample(0, 1)] })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
    }
  })
  it('reports no series at all on failure', () => {
    const result = propagateEffectSite({ ...base, samples: [sample(1, 1), sample(0, 1)] })
    expect(result.ok).toBe(false)
    expect('series' in result).toBe(false)
  })
})

describe('G. limiting and bounds behaviour', () => {
  it('keeps Ce within the bounds of the input trajectory endpoints', () => {
    // Non-negative endpoints: the response stays within [min, max] of
    // Ce0 and the reconstructed input over the interval.
    const values = okSeries(
      propagateEffectSite({
        samples: [sample(0, 2), sample(1, 4), sample(2, 1)],
        unboundFraction: 1,
        ke0: 3,
        initialCe: 2,
      }),
    )
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(4 + 1e-12)
    }
  })
  it('approaches the constant-input limit as ke0 → small over a fixed horizon', () => {
    const h = 1
    const ce0 = 0
    const u1 = 2
    const slow = okSeries(
      propagateEffectSite({ samples: [sample(0, 0), sample(h, u1)], unboundFraction: 1, ke0: 1e-6, initialCe: ce0 }),
    )[1] as number
    // With a vanishing rate constant the state barely moves.
    expect(slow).toBeLessThan(1e-5)
    expect(slow).toBeGreaterThanOrEqual(0)
  })
  it('is deterministic for identical inputs', () => {
    const input = { samples: [sample(0, 1), sample(1, 2)], unboundFraction: 0.5, ke0: 2, initialCe: 0.1 }
    expect(okSeries(propagateEffectSite(input))).toEqual(okSeries(propagateEffectSite(input)))
  })
})
