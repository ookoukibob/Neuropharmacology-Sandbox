import { describe, expect, it } from 'vitest'
import {
  effectSiteDerivative,
  initialEffectSiteConcentration,
  receptorOccupancy,
  resolveEffectSite,
} from './effect-site'

/**
 * Effect-site and occupancy (phase 46). Every expected value below comes from
 * closed-form mathematics or hand arithmetic, never from the implementation.
 */

const okResolved = (input: Parameters<typeof resolveEffectSite>[0]) => {
  const result = resolveEffectSite(input)
  if (!result.ok) throw new Error('expected resolution: ' + JSON.stringify(result.errors))
  return result.resolved
}

describe('resolveEffectSite — validation', () => {
  const base = { unboundFraction: 0.1, ke0: 0.5, kd: { value: 2, unit: 'mg/L' } }

  it('accepts a fully specified Kd in the PK concentration unit', () => {
    const resolved = okResolved(base)
    expect(resolved).toEqual({
      unboundFraction: 0.1,
      ke0: 0.5,
      kdInPkUnit: 2,
      kdConversion: 'same-unit',
    })
  })

  it('requires every parameter (no pharmacological defaults)', () => {
    expect(resolveEffectSite(undefined).ok).toBe(false)
    for (const field of ['unboundFraction', 'ke0', 'kd'] as const) {
      const broken = { ...base } as Record<string, unknown>
      delete broken[field]
      const result = resolveEffectSite(broken as never)
      expect(result.ok).toBe(false)
      // An absent field is reported as missing (the message names it); a
      // present-but-invalid value would be NOT_A_NUMBER instead.
      if (!result.ok) {
        expect(['MISSING_PARAMETER', 'NOT_A_NUMBER']).toContain(result.errors[0]?.code)
        expect(result.errors[0]?.field).toContain(field)
      }
    }
  })

  it('rejects a non-finite or out-of-range unbound fraction', () => {
    for (const fu of [Number.NaN, 0, -0.1, 1.5]) {
      const result = resolveEffectSite({ ...base, unboundFraction: fu })
      expect(result.ok).toBe(false)
    }
    // fu = 1 is a valid (fully unbound) declaration.
    expect(okResolved({ ...base, unboundFraction: 1 }).unboundFraction).toBe(1)
  })

  it('rejects ke0 that is zero, negative or non-finite', () => {
    for (const ke0 of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = resolveEffectSite({ ...base, ke0 })
      expect(result.ok).toBe(false)
    }
  })

  it('rejects a zero, negative or non-finite Kd', () => {
    for (const value of [0, -2, Number.NaN]) {
      const result = resolveEffectSite({ ...base, kd: { value, unit: 'mg/L' } })
      expect(result.ok).toBe(false)
    }
  })

  it('rejects a Kd unit that is not a concentration', () => {
    const result = resolveEffectSite({ ...base, kd: { value: 2, unit: 'h' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.code).toBe('INCOMPATIBLE_UNITS')
    const unknown = resolveEffectSite({ ...base, kd: { value: 2, unit: 'bananas' } })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.errors[0]?.code).toBe('UNKNOWN_UNIT')
  })

  it('converts a mass-concentration Kd exactly, without a molecular weight', () => {
    // 2000 µg/mL = 2 g/L = 2000 mg/L
    const resolved = okResolved({ ...base, kd: { value: 2000, unit: 'µg/mL' } })
    expect(resolved.kdConversion).toBe('unit-conversion')
    expect(resolved.kdInPkUnit).toBeCloseTo(2000, 9)
    expect(resolved.molecularWeightUsed).toBeUndefined()
  })

  it('requires an explicit molecular weight (with provenance) for a molar Kd', () => {
    const molar = { ...base, kd: { value: 100, unit: 'nM' } }
    const missing = resolveEffectSite(molar)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.errors[0]?.code).toBe('MISSING_PARAMETER')

    const noProvenance = resolveEffectSite({ ...molar, molecularWeight: { value: 300, unit: 'g/mol' } })
    expect(noProvenance.ok).toBe(false)

    const badUnit = resolveEffectSite({
      ...molar,
      molecularWeight: { value: 300, unit: 'mg/L' },
      molecularWeightProvenance: 'synthetic test value',
    })
    expect(badUnit.ok).toBe(false)

    const valid = resolveEffectSite({
      ...molar,
      molecularWeight: { value: 300, unit: 'g/mol' },
      molecularWeightProvenance: 'synthetic test value',
    })
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      // 100 nM = 1e-7 mol/L × 300 g/mol = 3e-5 g/L = 0.03 mg/L
      expect(valid.resolved.kdConversion).toBe('molecular-weight')
      expect(valid.resolved.kdInPkUnit).toBeCloseTo(0.03, 12)
      expect(valid.resolved.molecularWeightUsed).toBe(300)
    }
  })
})

describe('effect-site equilibration — analytical oracles', () => {
  const resolved = { unboundFraction: 0.5, ke0: 2 }

  it('drives Ce towards fu·Cc for a constant input, with the exact solution', () => {
    // dCe/dt = ke0(Cu − Ce) with constant Cu: Ce(t) = Cu + (Ce0 − Cu)e^(−ke0 t)
    const cu = 4
    const ce0 = 0
    const ke0 = resolved.ke0
    const exact = (t: number): number => cu + (ce0 - cu) * Math.exp(-ke0 * t)

    // Compare the derivative-based ODE with its closed form by integrating
    // with a hand-written RK4 (independent of the project's solver).
    const rk4 = (ce: number, dt: number): number => {
      const f = (x: number): number => effectSiteDerivative(cu / resolved.unboundFraction, x, resolved)
      const k1 = f(ce)
      const k2 = f(ce + (dt / 2) * k1)
      const k3 = f(ce + (dt / 2) * k2)
      const k4 = f(ce + dt * k3)
      return ce + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4)
    }
    let ce = ce0
    const dt = 1e-4
    for (let i = 0; i < 5000; i += 1) ce = rk4(ce, dt)
    expect(ce).toBeCloseTo(exact(0.5), 8)
  })

  it('leaves Ce at its initial value as ke0 → 0 (no equilibration)', () => {
    const tiny = { unboundFraction: 0.5, ke0: 1e-12 }
    const change = effectSiteDerivative(10, 0, tiny)
    expect(change).toBeCloseTo(5e-12, 20)
    expect(change).toBeLessThan(1e-10)
  })

  it('tracks the unbound concentration immediately as ke0 becomes large', () => {
    const fast = { unboundFraction: 0.2, ke0: 1e6 }
    // Cu = 0.2 · 10 = 2. With ke0·dt = 1 the exact solution Ce(dt) =
    // Cu(1 − e^(−ke0·dt)) = 2(1 − e^−1) ≈ 1.2642 — i.e. one rate-constant
    // worth of time already covers most of the equilibration.
    const dt = 1e-6
    const exact = 2 * (1 - Math.exp(-1))
    // Integrate the ODE (RK4, independent of the project's solver) for one
    // rate-constant worth of time: ke0·dt = 1.
    // Sub-step so each RK4 step sees λh ≪ 1 (a single step at λh = 1 carries
    // ~1% truncation error, which would be a test error, not a model one).
    const integrate = (resolved: { unboundFraction: number; ke0: number }): number => {
      let ce = 0
      const steps = 200
      const h = dt / steps
      const f = (x: number): number => effectSiteDerivative(10, x, resolved)
      for (let i = 0; i < steps; i += 1) {
        const k1 = f(ce)
        const k2 = f(ce + (h / 2) * k1)
        const k3 = f(ce + (h / 2) * k2)
        const k4 = f(ce + h * k3)
        ce += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4)
      }
      return ce
    }
    expect(integrate(fast)).toBeCloseTo(exact, 6)
    // The same time with a much smaller ke0 moves far less.
    expect(integrate({ unboundFraction: 0.2, ke0: 1 })).toBeLessThan(exact / 10)
  })

  it('starts the effect site at equilibrium with the initial unbound concentration', () => {
    expect(initialEffectSiteConcentration(10, 0.25)).toBe(2.5)
    expect(initialEffectSiteConcentration(0, 0.25)).toBe(0)
  })
})

describe('receptorOccupancy — bounds and known values', () => {
  it('is exactly Kd-matched at Ce = Kd (occupancy 0.5)', () => {
    expect(receptorOccupancy(2, 2)).toBeCloseTo(0.5, 15)
    expect(receptorOccupancy(100, 100)).toBeCloseTo(0.5, 15)
  })

  it('follows the hand-computed ratio for other concentrations', () => {
    // Ce = 3, Kd = 1 → 3/4
    expect(receptorOccupancy(3, 1)).toBeCloseTo(0.75, 15)
    // Ce = 1, Kd = 3 → 1/4
    expect(receptorOccupancy(1, 3)).toBeCloseTo(0.25, 15)
    // Ce = 9, Kd = 1 → 0.9
    expect(receptorOccupancy(9, 1)).toBeCloseTo(0.9, 15)
  })

  it('is zero at zero concentration and stays within [0, 1)', () => {
    expect(receptorOccupancy(0, 2)).toBe(0)
    for (const ce of [1e-9, 0.5, 1, 1e3, 1e9]) {
      const occupancy = receptorOccupancy(ce, 2)
      expect(occupancy).toBeGreaterThanOrEqual(0)
      expect(occupancy).toBeLessThan(1)
    }
  })

  it('is monotonic in concentration and in Kd', () => {
    expect(receptorOccupancy(2, 2)).toBeGreaterThan(receptorOccupancy(1, 2))
    expect(receptorOccupancy(2, 2)).toBeGreaterThan(receptorOccupancy(2, 4))
  })

  it('never treats a negative concentration as occupancy', () => {
    expect(receptorOccupancy(-1, 2)).toBe(0)
  })
})
