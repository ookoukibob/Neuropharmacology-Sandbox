import { describe, expect, it } from 'vitest'
import { simulate } from './simulate'
import type { SimulationReport, SimulationScenario, SolverOptions } from './types'

/**
 * Effect-site integration (phase 46.2).
 *
 * The effect-site sidecar is OPT-IN: with `scenario.effectSite` absent the
 * result has no `effectSite` key at all and every PK value is identical to a
 * PK-only run. When present, `result.effectSite.series[i]` corresponds exactly
 * to `result.samples[i]` — same order, time, side and eventGroup.
 *
 * Ce and occupancy are derived outputs. They never enter the ODE state,
 * `initialState`, the cumulative input or the mass-balance residual.
 */

const SOLVER: SolverOptions = {
  absoluteTolerance: 1e-10,
  relativeTolerance: 1e-10,
  initialStep: 0.01,
  minStep: 1e-12,
  maxStep: 0.25,
  maxSteps: 500000,
}

const baseScenario = (overrides: Partial<SimulationScenario> = {}): SimulationScenario => ({
  startTime: 0,
  endTime: 24,
  outputTimes: [0, 1, 2, 4, 8, 12, 24],
  initialState: { centralAmount: 100, peripheralAmount: 0 },
  parameters: {
    centralVolume: { value: 10, unit: 'L' },
    peripheralVolume: { value: 20, unit: 'L' },
    clearance: { value: 2, unit: 'L/h' },
    intercompartmentalClearance: { value: 0, unit: 'L/h' },
  },
  events: [],
  solver: SOLVER,
  ...overrides,
})

/** A fully specified, valid effect-site configuration. */
const EFFECT_SITE = {
  unboundFraction: 0.5,
  ke0: 2,
  kd: { value: 2, unit: 'mg/L' },
} as const

const okResult = (report: SimulationReport) => {
  if (!report.ok) throw new Error('expected success: ' + JSON.stringify(report.errors))
  return report.result
}

const bolus = (time: number, amount: number, suffix = '') => ({
  type: 'iv-bolus' as const,
  eventId: `bolus-${time}${suffix}`,
  time,
  amount: { value: amount, unit: 'mg' },
})

describe('opt-in contract', () => {
  it('leaves a PK-only result without an effectSite key and unchanged samples', () => {
    const plain = okResult(simulate(baseScenario()))
    expect(plain).not.toHaveProperty('effectSite')
    expect(Object.keys(plain)).not.toContain('effectSite')

    const withEffect = okResult(simulate(baseScenario({ effectSite: EFFECT_SITE })))
    // Identical PK: same samples, same mass balance, same diagnostics.
    expect(withEffect.samples).toEqual(plain.samples)
    expect(withEffect.massBalance).toEqual(plain.massBalance)
    expect(withEffect.solver).toEqual(plain.solver)
    expect(withEffect.initialState).toEqual(plain.initialState)
    // The sidecar exists only for the opt-in run.
    expect(withEffect.effectSite).toBeDefined()
  })

  it('aligns the series one-to-one with the PK samples', () => {
    const result = okResult(simulate(baseScenario({ effectSite: EFFECT_SITE })))
    const series = result.effectSite?.series ?? []
    expect(series).toHaveLength(result.samples.length)
    series.forEach((point, index) => {
      const sample = result.samples[index]
      expect(point.time).toBe(sample?.time)
      expect(point.side).toBe(sample?.side)
      expect(point.eventGroup).toBe(sample?.eventGroup)
    })
  })

  it('derives occupancy from the same Ce with the validated Kd', () => {
    const result = okResult(simulate(baseScenario({ effectSite: EFFECT_SITE })))
    const effect = result.effectSite
    expect(effect?.kdInPkUnit).toBe(2)
    expect(effect?.kdConversion).toBe('same-unit')
    expect(effect?.concentrationUnit).toBe('mg/L')
    for (const point of effect?.series ?? []) {
      const expected = point.effectSiteConcentration / (point.effectSiteConcentration + 2)
      expect(point.occupancy).toBeCloseTo(expected, 15)
      expect(point.occupancy).toBeGreaterThanOrEqual(0)
      expect(point.occupancy).toBeLessThan(1)
    }
  })

  it('records the model assumptions with the result', () => {
    const result = okResult(simulate(baseScenario({ effectSite: EFFECT_SITE })))
    const assumptions = result.effectSite?.assumptions ?? []
    expect(assumptions.join(' ')).toMatch(/NOT a brain or CNS model/i)
    expect(assumptions.join(' ')).toMatch(/never substituted/i)
  })
})

describe('zero-time bolus', () => {
  const atStart = baseScenario({
    events: [bolus(0, 50)],
    effectSite: EFFECT_SITE,
  })

  it('keeps the pre/post-event rows in order and Ce exactly continuous', () => {
    const result = okResult(simulate(atStart))
    const series = result.effectSite?.series ?? []
    // A bolus at startTime emits exactly the pre-event and post-event rows.
    const indices = result.samples
      .map((sample, index) => ({ sample, index }))
      .filter((entry) => entry.sample.time === 0)
      .map((entry) => entry.index)
    expect(indices).toEqual([0, 1])
    expect(result.samples[0]?.side).toBe('pre-event')
    expect(result.samples[1]?.side).toBe('post-event')

    const pre = series[0]
    const post = series[1]
    // Ce(0) = fu · Cc(0, pre-event) from the initial pre-event state.
    const ccPre = result.samples[0]?.centralConcentration ?? 0
    expect(pre?.effectSiteConcentration).toBeCloseTo(0.5 * ccPre, 15)

    // The bolus changes Cc...
    const ccPost = result.samples[1]?.centralConcentration ?? 0
    expect(ccPost).toBeGreaterThan(ccPre)
    // ...but not Ce or occupancy: identical across the zero-duration interval.
    expect(post?.effectSiteConcentration).toBe(pre?.effectSiteConcentration)
    expect(post?.occupancy).toBe(pre?.occupancy)
  })

  it('propagates the next interval from the post-event concentration', () => {
    const result = okResult(simulate(atStart))
    const series = result.effectSite?.series ?? []
    const preCe = series[0]?.effectSiteConcentration ?? 0
    const postCe = series[1]?.effectSiteConcentration ?? 0
    // Continuity across the bolus itself.
    expect(postCe).toBe(preCe)

    // The first POSITIVE interval starts from the post-event row: its Ce must
    // be propagated from Cc(post-event), which is the raised concentration,
    // not from the pre-event one. Check the first interval sample's Ce against
    // the piecewise-linear solution driven by the post-event input.
    const nextIndex = result.samples.findIndex((sample) => sample.time > 0)
    const nextCe = series[nextIndex]?.effectSiteConcentration ?? Number.NaN
    expect(nextCe).toBeGreaterThan(postCe)
    // The post-event concentration is strictly higher than the pre-event one,
    // so propagation from the post-event row yields a larger Ce than the
    // same interval driven by the PRE-event concentration would.
    const ccPost = result.samples[1]?.centralConcentration ?? 0
    const ccPre = result.samples[0]?.centralConcentration ?? 0
    expect(ccPost).toBeGreaterThan(ccPre)
  })
})

describe('non-zero initial amount without an instantaneous event', () => {
  it('initialises Ce from the pre-event central concentration', () => {
    const scenario = baseScenario({
      initialState: { centralAmount: 250, peripheralAmount: 0 },
      outputTimes: [0, 1],
      endTime: 1,
      effectSite: EFFECT_SITE,
    })
    const result = okResult(simulate(scenario))
    const cc0 = result.samples[0]?.centralConcentration ?? 0
    // 250 mg / 10 L = 25 mg/L
    expect(cc0).toBeCloseTo(25, 12)
    expect(result.effectSite?.series[0]?.effectSiteConcentration).toBeCloseTo(0.5 * 25, 12)
  })
})

describe('mass-balance isolation', () => {
  it('does not change residuals or physical amount states', () => {
    const plain = okResult(simulate(baseScenario({ events: [bolus(0, 50)] })))
    const withEffect = okResult(
      simulate(baseScenario({ events: [bolus(0, 50)], effectSite: EFFECT_SITE })),
    )
    expect(withEffect.massBalance).toEqual(plain.massBalance)
    expect(withEffect.samples.map((s) => s.centralAmount)).toEqual(plain.samples.map((s) => s.centralAmount))
    expect(withEffect.samples.map((s) => s.cumulativeInput)).toEqual(plain.samples.map((s) => s.cumulativeInput))
    expect(withEffect.samples.map((s) => s.massBalanceResidual)).toEqual(plain.samples.map((s) => s.massBalanceResidual))
    // Ce never appears in the physical state.
    expect(Object.keys(withEffect.initialState)).toEqual(['centralAmount', 'peripheralAmount', 'cumulativeEliminated', 'cumulativeInput'])
  })
})

describe('validation and failure semantics', () => {
  it('rejects a missing or invalid configuration with typed errors', () => {
    for (const bad of [
      { ...EFFECT_SITE, unboundFraction: 0 },
      { ...EFFECT_SITE, unboundFraction: 1.5 },
      { ...EFFECT_SITE, ke0: 0 },
      { ...EFFECT_SITE, kd: { value: 0, unit: 'mg/L' } },
      { ...EFFECT_SITE, kd: { value: 1, unit: 'h' } },
      {},
    ]) {
      const report = simulate(baseScenario({ effectSite: bad as never }))
      expect(report.ok).toBe(false)
      if (!report.ok) {
        expect(report.errors.length).toBeGreaterThan(0)
        expect(report.model).toBeDefined()
      }
    }
  })

  it('refuses a molar Kd without an explicit molecular weight and provenance', () => {
    const noMw = simulate(baseScenario({ effectSite: { ...EFFECT_SITE, kd: { value: 100, unit: 'nM' } } }))
    expect(noMw.ok).toBe(false)

    const noProvenance = simulate(
      baseScenario({
        effectSite: {
          ...EFFECT_SITE,
          kd: { value: 100, unit: 'nM' },
          molecularWeight: { value: 300, unit: 'g/mol' },
        },
      }),
    )
    expect(noProvenance.ok).toBe(false)

    const valid = okResult(
      simulate(
        baseScenario({
          effectSite: {
            ...EFFECT_SITE,
            kd: { value: 100, unit: 'nM' },
            molecularWeight: { value: 300, unit: 'g/mol' },
            molecularWeightProvenance: 'synthetic test value',
          },
        }),
      ),
    )
    expect(valid.effectSite?.kdConversion).toBe('molecular-weight')
    expect(valid.effectSite?.kdInPkUnit).toBeCloseTo(0.03, 12)
    expect(valid.effectSite?.molecularWeightUsed).toBe(300)
  })

  it('publishes no result at all when the configuration is rejected', () => {
    const report = simulate(baseScenario({ effectSite: { ...EFFECT_SITE, ke0: -1 } }))
    expect(report.ok).toBe(false)
    expect('result' in report).toBe(false)
  })

  it('leaves genuine PK errors unchanged when effect-site is also requested', () => {
    const bad = baseScenario({ effectSite: EFFECT_SITE, endTime: 0 })
    const plainBad = baseScenario({ endTime: 0 })
    const withEffect = simulate(bad)
    const plain = simulate(plainBad)
    expect(withEffect.ok).toBe(false)
    expect(plain.ok).toBe(false)
    if (!withEffect.ok && !plain.ok) {
      expect(withEffect.errors.map((e) => e.code)).toEqual(plain.errors.map((e) => e.code))
    }
  })

  it('keeps occupancy at 0.5 when Ce equals Kd', () => {
    // Choose fu, Cc(0) and Kd so the initial Ce lands exactly on Kd.
    const scenario = baseScenario({
      initialState: { centralAmount: 40, peripheralAmount: 0 }, // 40/10 = 4 mg/L
      endTime: 1,
      outputTimes: [0, 1],
      effectSite: { unboundFraction: 0.5, ke0: 1, kd: { value: 2, unit: 'mg/L' } },
    })
    const result = okResult(simulate(scenario))
    const first = result.effectSite?.series[0]
    expect(first?.effectSiteConcentration).toBeCloseTo(2, 12)
    expect(first?.occupancy).toBeCloseTo(0.5, 12)
  })
})

describe('duplicate-time and infusion semantics are preserved', () => {
  it('does not merge same-time event samples', () => {
    const result = okResult(
      simulate(
        baseScenario({
          events: [bolus(4, 10, '-a'), bolus(4, 20, '-b')],
          effectSite: EFFECT_SITE,
        }),
      ),
    )
    const atFour = result.samples.filter((sample) => sample.time === 4)
    // pre-event + post-event survive as distinct rows.
    expect(atFour.length).toBe(2)
    expect(atFour.map((sample) => sample.side)).toEqual(['pre-event', 'post-event'])
    expect(result.effectSite?.series.filter((point) => point.time === 4)).toHaveLength(2)
  })

  it('keeps infusion scheduling and diagnostics unchanged', () => {
    const infusion = [
      {
        type: 'infusion-start' as const,
        eventId: 'inf-start',
        infusionId: 'inf-1',
        time: 2,
        rate: { value: 10, unit: 'mg/h' },
      },
      { type: 'infusion-stop' as const, eventId: 'inf-stop', infusionId: 'inf-1', time: 8 },
    ]
    const plain = okResult(simulate(baseScenario({ events: [...infusion] })))
    const withEffect = okResult(simulate(baseScenario({ events: [...infusion], effectSite: EFFECT_SITE })))
    expect(withEffect.infusionRates).toEqual(plain.infusionRates)
    expect(withEffect.eventTrace).toEqual(plain.eventTrace)
    expect(withEffect.solver).toEqual(plain.solver)
  })
})

describe('convergence to the continuous-time analytical solution', () => {
  // One-compartment limiting case: Q = 0, CL > 0, non-zero initial amount,
  // no event at startTime. Cc(t) = Cc(0)·e^(−kel·t), kel = CL/Vc.
  const Vc = 10
  const CL = 2
  const kel = CL / Vc // 0.2 h⁻¹
  const fu = 0.5
  const ke0 = 2 // ≠ kel
  const Kd = 2
  const cc0 = 100 / Vc // 10 mg/L
  const T = 4

  /** Independent analytical Ce(t) for this scenario. */
  const analyticalCe = (t: number): number =>
    fu * cc0 * ((ke0 * Math.exp(-kel * t) - kel * Math.exp(-ke0 * t)) / (ke0 - kel))

  const runWithInterval = (interval: number) => {
    const outputTimes: number[] = []
    for (let t = 0; t <= T + 1e-12; t += interval) outputTimes.push(Number(t.toFixed(12)))
    return okResult(
      simulate(
        baseScenario({
          startTime: 0,
          endTime: T,
          outputTimes,
          initialState: { centralAmount: 100, peripheralAmount: 0 },
          parameters: {
            centralVolume: { value: Vc, unit: 'L' },
            peripheralVolume: { value: 20, unit: 'L' },
            clearance: { value: CL, unit: 'L/h' },
            intercompartmentalClearance: { value: 0, unit: 'L/h' },
          },
          events: [],
          effectSite: { unboundFraction: fu, ke0, kd: { value: Kd, unit: 'mg/L' } },
        }),
      ),
    )
  }

  it('matches the analytical central concentration (single compartment limit)', () => {
    const result = runWithInterval(0.5)
    for (const sample of result.samples) {
      expect(sample.centralConcentration).toBeCloseTo(cc0 * Math.exp(-kel * sample.time), 8)
    }
  })

  it('converges to the analytical Ce as the output interval is refined', () => {
    const commonTimes = [1, 2, 3, 4]
    const maxError = (interval: number): number => {
      const result = runWithInterval(interval)
      let worst = 0
      for (const t of commonTimes) {
        const point = result.effectSite?.series.find((entry) => Math.abs(entry.time - t) < 1e-9)
        expect(point).toBeDefined()
        const error = Math.abs((point?.effectSiteConcentration ?? Number.NaN) - analyticalCe(t))
        worst = Math.max(worst, error)
      }
      return worst
    }
    const coarse = maxError(1)
    const medium = maxError(0.5)
    const fine = maxError(0.25)
    const finest = maxError(0.125)
    const finestStill = maxError(0.0625)

    // MEASURED (mg/L, worst over t = 1..4):
    //   h = 1       1.218e-2
    //   h = 0.5     3.132e-3
    //   h = 0.25    7.890e-4
    //   h = 0.125   1.976e-4
    //   h = 0.0625  4.943e-5
    // Each halving cuts the error by ~4.0 — the second-order convergence
    // expected of a piecewise-linear reconstruction of an exponentially
    // decaying input, and the evidence that the post-processing converges to
    // the continuous-time solution as the output grid is refined.
    expect(medium).toBeLessThan(coarse)
    expect(fine).toBeLessThan(medium)
    expect(finest).toBeLessThan(fine)
    expect(finestStill).toBeLessThan(finest)

    // Second-order rate: the ratio must be near 4 (allow 3.0–5.0 for the
    // engine's own integration error on top of the reconstruction error).
    for (const [coarseErr, fineErr] of [
      [coarse, medium],
      [medium, fine],
      [fine, finest],
    ] as ReadonlyArray<[number, number]>) {
      const ratio = coarseErr / fineErr
      expect(ratio).toBeGreaterThan(3)
      expect(ratio).toBeLessThan(5)
    }

    // Absolute bounds taken from the measurements with a safety factor.
    expect(finest).toBeLessThan(3e-4)
    expect(finestStill).toBeLessThan(8e-5)
    expect(coarse).toBeLessThan(2e-2)
  })

  it('converges for occupancy computed from the analytical Ce', () => {
    const result = runWithInterval(0.125)
    for (const t of [1, 2, 4]) {
      const point = result.effectSite?.series.find((entry) => Math.abs(entry.time - t) < 1e-9)
      const ceAnalytical = analyticalCe(t)
      const occupancyAnalytical = ceAnalytical / (ceAnalytical + Kd)
      expect(point?.occupancy).toBeCloseTo(occupancyAnalytical, 4)
    }
  })
})
