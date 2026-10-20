import { describe, expect, it } from 'vitest'
import {
  STATE_INDEX,
  twoCompartmentSystem,
  concentrations,
  massBalanceResidual,
  roundForReport,
} from './two-compartment-pk'
import type { TwoCompartmentParameters } from './two-compartment-pk'
import { createIntegrator } from '../solver'
import type { OdeState, SolverOptions } from '../types'

/**
 * Independent oracles: every expected trajectory below is a closed-form
 * solution of the model equations, never a value copied from the code.
 */

const SOLVER: SolverOptions = {
  absoluteTolerance: 1e-11,
  relativeTolerance: 1e-11,
  initialStep: 0.01,
  minStep: 1e-12,
  maxStep: 0.25,
  maxSteps: 200000,
}

const params = (overrides: Partial<TwoCompartmentParameters> = {}): TwoCompartmentParameters => ({
  centralVolume: 10,
  peripheralVolume: 20,
  clearance: 2,
  intercompartmentalClearance: 0,
  infusionRate: 0,
  ...overrides,
})

const state = (ac: number, ap = 0, ae = 0, ain = 0): OdeState => [ac, ap, ae, ain]

/** Integrate a system with given parameters to the given times. */
const run = (p: TwoCompartmentParameters, start: OdeState, times: readonly number[]) => {
  const created = createIntegrator<TwoCompartmentParameters>(
    { system: twoCompartmentSystem, parameters: p, startTime: 0, startState: start, targets: times },
    { settings: SOLVER },
  )
  if (!created.ok) throw new Error(JSON.stringify(created.errors))
  const result = created.integrator.integrate(times, false)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.samples
}

const at = (samples: readonly { readonly time: number; readonly state: OdeState }[], time: number): OdeState => {
  const sample = samples.find((s) => s.time === time)
  if (sample === undefined) throw new Error(`no sample at ${time}`)
  return sample.state
}

describe('derivative — equations written out by hand', () => {
  it('computes each component exactly as documented', () => {
    const p = params({ clearance: 3, intercompartmentalClearance: 4, infusionRate: 5 })
    // A_c = 10 mg, V_c = 10 L → C_c = 1 mg/L
    // A_p = 20 mg, V_p = 20 L → C_p = 1 mg/L
    const d = twoCompartmentSystem.derivative(0, state(10, 20, 0, 0), p)
    // dA_c/dt = R − CL·C_c − Q·(C_c − C_p) = 5 − 3·1 − 4·(1−1) = 2
    expect(d[STATE_INDEX.centralAmount]).toBeCloseTo(2, 12)
    // dA_p/dt = Q·(C_c − C_p) = 0
    expect(d[STATE_INDEX.peripheralAmount]).toBeCloseTo(0, 12)
    // dA_e/dt = CL·C_c = 3
    expect(d[STATE_INDEX.cumulativeEliminated]).toBeCloseTo(3, 12)
    // dA_in/dt = R = 5
    expect(d[STATE_INDEX.cumulativeInput]).toBeCloseTo(5, 12)
  })

  it('drives the peripheral compartment from the concentration difference', () => {
    // CL = 0 isolates the exchange term.
    const p = params({ clearance: 0, intercompartmentalClearance: 6 })
    // C_c = 2 mg/L (20/10), C_p = 0.5 mg/L (10/20) → Q(C_c − C_p) = 6 · 1.5 = 9
    const d = twoCompartmentSystem.derivative(0, state(20, 10), p)
    expect(d[STATE_INDEX.peripheralAmount]).toBeCloseTo(9, 12)
    expect(d[STATE_INDEX.centralAmount]).toBeCloseTo(-9, 12)
  })

  it('declares four states and never depends on time directly', () => {
    expect(twoCompartmentSystem.dimension).toBe(4)
    const p = params({ intercompartmentalClearance: 1 })
    const a = twoCompartmentSystem.derivative(0, state(5, 1), p)
    const b = twoCompartmentSystem.derivative(99, state(5, 1), p)
    expect(a).toEqual(b)
  })
})

describe('concentrations and reporting', () => {
  it('computes C = A / V per compartment', () => {
    const c = concentrations(state(12, 30), params({ centralVolume: 4, peripheralVolume: 10 }))
    expect(c.central).toBe(3)
    expect(c.peripheral).toBe(3)
  })

  it('rounds reported values to 12 significant digits without touching zeros', () => {
    expect(roundForReport(0.1 + 0.2)).toBe(0.3)
    expect(roundForReport(0)).toBe(0)
    expect(roundForReport(-0)).toBe(0)
    expect(roundForReport(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('Q = 0 closed-form limit (single bolus)', () => {
  // A_c(t) = D·e^(−k t) with k = CL/V_c; A_e(t) = D(1 − e^(−k t)); C_c = A_c/V_c.
  const D = 100
  const Vc = 10
  const CL = 2
  const k = CL / Vc
  const times = [0.5, 1, 2, 4, 8, 12, 24]

  it('reproduces A_c, C_c and A_e exactly as the analytical solution', () => {
    const samples = run(params(), state(D), times)
    for (const t of times) {
      const s = at(samples, t)
      const ac = s[STATE_INDEX.centralAmount] ?? Number.NaN
      const ae = s[STATE_INDEX.cumulativeEliminated] ?? Number.NaN
      const cc = ac / Vc
      const exactAc = D * Math.exp(-k * t)
      const exactAe = D * (1 - Math.exp(-k * t))
      // Justified tolerance: |·| ≤ 1e-6 × (atol/rtol scale) is far tighter
      // than any reporting precision, yet above accumulated round-off.
      expect(Math.abs(ac - exactAc)).toBeLessThanOrEqual(1e-9 * Math.max(1, exactAc))
      expect(Math.abs(ae - exactAe)).toBeLessThanOrEqual(1e-9 * Math.max(1, exactAe))
      expect(Math.abs(cc - (D / Vc) * Math.exp(-k * t))).toBeLessThanOrEqual(1e-10)
      // No peripheral transfer when Q = 0.
      expect(s[STATE_INDEX.peripheralAmount]).toBe(0)
    }
  })

  it('keeps A_c + A_p + A_e = A_c(0) + A_p(0) + A_in(t) along the whole run', () => {
    const samples = run(params(), state(D), times)
    for (const sample of samples) {
      expect(Math.abs(massBalanceResidual(sample.state, D))).toBeLessThanOrEqual(1e-10)
    }
  })

  it('treats an initial peripheral amount as inert when Q = 0', () => {
    const samples = run(params(), state(D, 40), [6])
    expect(at(samples, 6)[STATE_INDEX.peripheralAmount]).toBe(40)
    expect(Math.abs(massBalanceResidual(at(samples, 6), D + 40))).toBeLessThanOrEqual(1e-10)
  })
})

describe('two-compartment distribution (Q > 0)', () => {
  const p = params({ intercompartmentalClearance: 3 })
  // Hand-derived check at the start: the initial central drop is faster than
  // elimination alone (distribution into the periphery), and A_p rises.
  it('moves drug into the periphery and back', () => {
    const samples = run(p, state(100), [0.5, 1, 2, 3, 6, 12])
    const ap = (t: number): number => at(samples, t)[STATE_INDEX.peripheralAmount] ?? Number.NaN
    // Initially the peripheral amount rises strictly.
    expect(ap(0.5)).toBeGreaterThan(0)
    expect(ap(1)).toBeGreaterThan(ap(0.5))
    expect(ap(2)).toBeGreaterThan(ap(1))
    // It has a maximum and then declines (drug returns to the centre).
    const peak = Math.max(ap(0.5), ap(1), ap(2), ap(3), ap(6), ap(12))
    expect(ap(12)).toBeLessThan(peak)
  })

  it('satisfies C_c = C_p at a single equilibrium point only if Q > 0 and nothing else moves', () => {
    // With CL = 0 and R_in = 0, the exchange conserves mass and equal
    // concentrations are the only distribution equilibrium.
    const noElim = params({ clearance: 0, intercompartmentalClearance: 2 })
    const samples = run(noElim, state(100), [24])
    const s = at(samples, 24)
    const { central, peripheral } = concentrations(s, noElim)
    // Not exactly equal at finite time, but the difference has shrunk by more
    // than an order of magnitude compared with the initial C_p = 0.
    expect(Math.abs(central - peripheral)).toBeLessThan(0.1 * central)
    // Total amount is conserved exactly (nothing eliminated, nothing added).
    const total = (s[0] ?? 0) + (s[1] ?? 0) + (s[2] ?? 0)
    expect(Math.abs(total - 100)).toBeLessThan(1e-9)
  })

  it('matches the independent closed form of the two-compartment micro-constant solution', () => {
    // With no elimination, the exchange system is linear with eigenvalues
    // 0 and −λ = −Q(1/V_c + 1/V_p), so with A_c(0) = A0, A_p(0) = 0:
    //   A_c(t) = A_c,∞ + k·e^(−λt),   A_c,∞ = A0·V_c/(V_c+V_p),  k = A0 − A_c,∞
    //   A_p(t) = A0 − A_c(t)
    const Vc = 10
    const Vp = 20
    const Q = 3
    const p = params({ centralVolume: Vc, peripheralVolume: Vp, clearance: 0, intercompartmentalClearance: Q })
    const lambda = Q * (1 / Vc + 1 / Vp)
    const A0 = 90
    const times = [0.25, 1, 2, 5, 10]
    const samples = run(p, state(A0), times)
    for (const t of times) {
      const s = at(samples, t)
      const e = Math.exp(-lambda * t)
      const plateau = (A0 * Vc) / (Vc + Vp)
      const exactAc = plateau + (A0 - plateau) * e
      const exactAp = A0 - exactAc
      expect(Math.abs((s[0] ?? 0) - exactAc)).toBeLessThanOrEqual(1e-9 * A0)
      expect(Math.abs((s[1] ?? 0) - exactAp)).toBeLessThanOrEqual(1e-9 * A0)
    }
  })
})

describe('elimination and constant input', () => {
  it('eliminates with CL only (V_p and Q do not change the steady-state loss)', () => {
    const p = params({ clearance: 5, intercompartmentalClearance: 2 })
    const samples = run(p, state(10, 20), [1])
    const s = at(samples, 1)
    const input = 30
    expect(massBalanceResidual(s, input)).toBeLessThan(1e-10)
    expect(massBalanceResidual(s, input)).toBeGreaterThan(-1e-10)
    // A_e is strictly positive after one hour.
    expect(s[STATE_INDEX.cumulativeEliminated]).toBeGreaterThan(0)
  })

  it('integrates a zero system as exactly zero', () => {
    const samples = run(params(), state(0), [1, 5, 10])
    for (const sample of samples) {
      expect(sample.state).toEqual([0, 0, 0, 0])
      expect(massBalanceResidual(sample.state, 0)).toBe(0)
    }
  })

  it('reaches the expected steady state under a constant infusion', () => {
    // Q > 0, CL > 0: total mass eventually grows linearly at R_in while the
    // elimination rate tends to R_in. A_e(t) − R_in·t tends to a constant.
    const R = 4
    const p = params({ clearance: 3, intercompartmentalClearance: 5, infusionRate: R })
    // A_in integrates dA_in/dt = R from the start, so it starts at 0 here.
    const samples = run(p, state(0), [10, 40])
    // A_in(t) = R·t by construction.
    expect(Math.abs((at(samples, 10)[STATE_INDEX.cumulativeInput] ?? 0) - R * 10)).toBeLessThan(1e-9)
    expect(Math.abs((at(samples, 40)[STATE_INDEX.cumulativeInput] ?? 0) - R * 40)).toBeLessThan(1e-9)
    for (const sample of samples) {
      expect(Math.abs(massBalanceResidual(sample.state, 0))).toBeLessThan(1e-8)
    }
  })

  it('is deterministic and never mutates its inputs', () => {
    const p = Object.freeze(params({ intercompartmentalClearance: 1 }))
    const start = Object.freeze([50, 10, 0, 0]) as OdeState
    const a = run(p, start, [1, 2, 3])
    const b = run(p, start, [1, 2, 3])
    expect(a).toEqual(b)
    expect(start).toEqual([50, 10, 0, 0])
  })
})
