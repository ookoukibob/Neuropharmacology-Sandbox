import { describe, expect, it } from 'vitest'
import type { Provenance } from '../../domain/provenance/provenance'
import { errorCodes, errorsOf, resultOf, warningCodes } from '../../tests/report'
import { calculateHillResponse, type HillResponseInput } from './model'

/** Synthetic test values chosen for exact or independently checkable math. */
const p = (value: number, unit: string, provenance?: Provenance) =>
  provenance === undefined ? { value, unit } : { value, unit, provenance }

const base = (): HillResponseInput => ({
  e0: p(0, '%'),
  emax: p(100, '%'),
  ec50: p(10, 'nM'),
  hillCoefficient: p(2, '1'),
  concentration: p(20, 'nM'),
})

const hill = (overrides: Partial<HillResponseInput>) => calculateHillResponse({ ...base(), ...overrides })

describe('calculateHillResponse — normal cases', () => {
  it('computes the canonical sigmoid point exactly (n = 2, [D] = 2·EC50)', () => {
    // f = 20²/(10²+20²) = 400/500 = 0.8 → E = 0 + 100·0.8 = 80
    const result = resultOf(hill({}))
    expect(result.outputs.find((o) => o.symbol === 'E')?.value).toBe(80)
    expect(result.outputs.find((o) => o.symbol === 'f')?.value).toBe(0.8)
    expect(result.outputs[0]?.unit).toBe('%')
  })

  it('is exactly half-maximal at [D] = EC50, for any n', () => {
    for (const n of [0.5, 1, 2, 10]) {
      const result = resultOf(
        hill({ ec50: p(4.7, 'nM'), hillCoefficient: p(n, '1'), concentration: p(4.7, 'nM') }),
      )
      expect(result.outputs.find((o) => o.symbol === 'f')?.value).toBe(0.5)
      expect(result.outputs[0]?.value).toBe(50) // E0 = 0, Emax = 100
    }
  })

  it('returns the baseline E0 at [D] = 0 (n > 0), never an invented value', () => {
    const report = hill({ e0: p(7.5, '%'), concentration: p(0, 'nM') })
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBe(7.5)
    expect(result.outputs.find((o) => o.symbol === 'f')?.value).toBe(0)
    const step = result.trace.find((s) => s.label === 'Fractional response')
    expect(step?.substituted).toContain('[D] = 0')
  })

  it('approaches Emax at saturating concentrations', () => {
    const result = resultOf(hill({ concentration: p(1e300, 'nM'), hillCoefficient: p(1, '1') }))
    expect(result.outputs[0]?.value).toBe(100)
    expect(result.outputs.find((o) => o.symbol === 'f')?.value).toBe(1)
  })

  it('handles fractional Hill coefficients (n = 0.5 via an independent identity)', () => {
    // E0=0, Emax=100, EC50=9 nM, [D]=16 nM, n=0.5:
    // f = √16/(√9+√16) = 4/7 → E = 400/7
    const result = resultOf(
      hill({
        ec50: p(9, 'nM'),
        hillCoefficient: p(0.5, '1'),
        concentration: p(16, 'nM'),
      }),
    )
    expect(result.outputs.find((o) => o.symbol === 'f')?.value).toBeCloseTo(4 / 7, 9)
    expect(result.outputs[0]?.value).toBeCloseTo(400 / 7, 8)
  })

  it('handles steep coefficients (n = 4 via an independent identity)', () => {
    // f = 20⁴/(10⁴+20⁴) = 16/17
    const result = resultOf(hill({ hillCoefficient: p(4, '1') }))
    expect(result.outputs.find((o) => o.symbol === 'f')?.value).toBeCloseTo(16 / 17, 9)
    expect(result.outputs[0]?.value).toBeCloseTo(1600 / 17, 8)
  })

  it('supports negative Emax (declining response) with signed arithmetic', () => {
    const result = resultOf(
      hill({
        e0: p(100, '%'),
        emax: p(-100, '%'),
        ec50: p(5, 'nM'),
        hillCoefficient: p(1, '1'),
        concentration: p(5, 'nM'),
      }),
    )
    expect(result.outputs[0]?.value).toBe(50) // 100 + (−100)·0.5
  })

  it('converts EC50 into the [D] unit explicitly (1000 nM vs 1 µM)', () => {
    const result = resultOf(
      hill({
        ec50: p(1000, 'nM'),
        hillCoefficient: p(1, '1'),
        concentration: p(1, 'µM'),
      }),
    )
    expect(result.outputs[0]?.value).toBe(50) // EC50 = 1 µM → f = 0.5
    const conversion = result.trace.find((s) => s.label === 'Unit conversion')
    expect(conversion).toBeDefined()
    expect(conversion?.result.unit).toBe('µM')
    expect(conversion?.result.value).toBe(1) // 1000 nM = 1 µM exactly
    expect(result.inputs[2]).toMatchObject({ value: 1000, unit: 'nM' })
  })

  it('accepts caller-chosen effect units and preserves them', () => {
    const result = resultOf(
      hill({
        e0: p(-20, 'mV'),
        emax: p(80, 'mV'),
        hillCoefficient: p(1, '1'),
        concentration: p(10, 'nM'),
      }),
    )
    expect(result.outputs[0]?.unit).toBe('mV')
    expect(result.outputs[0]?.value).toBe(20) // −20 + 80·0.5
  })
})

describe('calculateHillResponse — invalid inputs', () => {
  it('never defaults the Hill coefficient — missing n fails', () => {
    const { hillCoefficient: _omitted, ...withoutN } = base()
    const report = calculateHillResponse(withoutN as HillResponseInput)
    expect(errorCodes(report)).toEqual(['MISSING_PARAMETER'])
    expect(errorsOf(report)[0]?.parameter).toBe('n')
  })

  it('rejects n = 0 and n < 0 (no positive or negative degeneracy)', () => {
    const zero = hill({ hillCoefficient: p(0, '1') })
    expect(errorCodes(zero)).toEqual(['ZERO_NOT_ALLOWED'])
    expect(errorsOf(zero)[0]?.parameter).toBe('n')

    const negative = hill({ hillCoefficient: p(-1, '1') })
    expect(errorCodes(negative)).toEqual(['NEGATIVE_VALUE'])
    expect(errorsOf(negative)[0]?.parameter).toBe('n')
  })

  it('rejects zero or negative EC50', () => {
    expect(errorCodes(hill({ ec50: p(0, 'nM') }))).toEqual(['ZERO_NOT_ALLOWED'])
    expect(errorCodes(hill({ ec50: p(-10, 'nM') }))).toEqual(['NEGATIVE_VALUE'])
  })

  it('rejects negative concentrations but accepts zero', () => {
    expect(errorCodes(hill({ concentration: p(-1, 'nM') }))).toEqual(['NEGATIVE_VALUE'])
    expect(hill({ concentration: p(0, 'nM') }).ok).toBe(true)
  })

  it('rejects NaN / ±Infinity in effect parameters (signs are allowed)', () => {
    expect(errorCodes(hill({ e0: p(Number.NaN, '%') }))).toEqual(['NOT_A_NUMBER'])
    expect(errorCodes(hill({ emax: p(Number.POSITIVE_INFINITY, '%') }))).toEqual(['NOT_A_NUMBER'])
    // Negative E0/Emax are legitimate signed quantities:
    expect(hill({ e0: p(-50, '%') }).ok).toBe(true)
    expect(hill({ emax: p(-100, '%') }).ok).toBe(true)
  })

  it('requires E0 and Emax to share one effect unit', () => {
    const report = hill({ e0: p(0, '%'), emax: p(100, 'a.u.') })
    expect(errorCodes(report)).toEqual(['INCOMPATIBLE_UNITS'])
    expect(errorsOf(report)[0]?.parameter).toBe('Emax')
  })

  it('requires explicit effect units (blank unit fails)', () => {
    const report = hill({ e0: p(0, '') })
    expect(errorCodes(report)).toEqual(['MISSING_PARAMETER'])
    expect(errorsOf(report)[0]?.parameter).toBe('E0.unit')
  })

  it('requires the dimensionless unit "1" for n', () => {
    expect(errorCodes(hill({ hillCoefficient: p(2, '') }))).toEqual(['MISSING_PARAMETER'])
    expect(errorCodes(hill({ hillCoefficient: p(2, '%') }))).toEqual(['INCOMPATIBLE_UNITS'])
    expect(errorCodes(hill({ hillCoefficient: p(2, 'h') }))).toEqual(['INCOMPATIBLE_UNITS'])
    expect(errorCodes(hill({ hillCoefficient: p(2, 'nM') }))).toEqual(['INCOMPATIBLE_UNITS'])
    expect(errorCodes(hill({ hillCoefficient: p(2, 'xyz') }))).toEqual(['UNKNOWN_UNIT'])
    expect(hill({ hillCoefficient: p(2, '1') }).ok).toBe(true)
  })

  it('refuses molar [D] with mass EC50 (would need a molecular weight)', () => {
    const report = hill({ ec50: p(10, 'mg/L') })
    expect(errorCodes(report)).toEqual(['INCOMPATIBLE_UNITS'])
    expect(errorsOf(report)[0]?.parameter).toBe('EC50')
  })

  it('reports missing parameters without cascading unit errors', () => {
    const report = calculateHillResponse({} as HillResponseInput)
    expect(errorsOf(report).map((e) => e.parameter)).toEqual(['E0', 'Emax', 'n', 'EC50', '[D]'])
    expect(errorCodes(report).every((code) => code === 'MISSING_PARAMETER')).toBe(true)
  })

  it('has no field for IC50 — IC50 can never be passed as EC50', () => {
    // @ts-expect-error -- `ic50` is deliberately absent from the Hill input
    const report = calculateHillResponse({ ...base(), ic50: p(3, 'nM') })
    const result = resultOf(report)
    expect(result.inputs.map((i) => i.symbol)).toEqual(['E0', 'Emax', 'EC50', 'n', '[D]'])
    expect(result.inputs[2]).toMatchObject({ value: 10, unit: 'nM' }) // EC50, not the foreign ic50
  })
})

describe('calculateHillResponse — numerical edge cases', () => {
  it('large n converges to the step limit (n = 100, [D] > EC50 → E = Emax)', () => {
    const result = resultOf(hill({ hillCoefficient: p(100, '1') })) // [D] = 2·EC50
    expect(result.outputs[0]?.value).toBe(100)
  })

  it('large n keeps the sub-EC50 tail as a tiny but correct value', () => {
    // n = 100, [D] = 5, EC50 = 10 → f = 1/(1+2¹⁰⁰)
    const result = resultOf(
      hill({ ec50: p(10, 'nM'), hillCoefficient: p(100, '1'), concentration: p(5, 'nM') }),
    )
    const expected = 100 / (1 + Math.pow(2, 100))
    expect((result.outputs[0]?.value as number) / expected).toBeCloseTo(1, 8)
    expect(result.outputs[0]?.value).toBeGreaterThan(0)
  })

  it('very large n with r > 1 overflows r^n and falls back to the limiting value', () => {
    // n = 1e6, [D] = 5, EC50 = 10 → r = 2, 2^1e6 ≈ 10^301030 (out of range)
    const report = hill({
      ec50: p(10, 'nM'),
      hillCoefficient: p(1e6, '1'),
      concentration: p(5, 'nM'),
    })
    const result = resultOf(report)
    expect(warningCodes(report)).toContain('NUMERICAL_OVERFLOW')
    // Limit of f as r^n → ∞ is 0 → E = E0; the reported 0 is the true limit
    // rounded into the double range, warned rather than silent:
    expect(warningCodes(report)).toContain('NUMERICAL_UNDERFLOW')
    expect(result.outputs[0]?.value).toBe(0)
  })

  it('underflowing fractional responses report 0 with a warning', () => {
    // [D] = 1e-300, EC50 = 1, n = 2 → f = 1/(1+1e600) ≈ 1e-600 → E underflows.
    const report = hill({
      e0: p(0, '%'),
      emax: p(100, '%'),
      ec50: p(1, 'nM'),
      hillCoefficient: p(2, '1'),
      concentration: p(1e-300, 'nM'),
    })
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBe(0)
    expect(warningCodes(report)).toContain('NUMERICAL_UNDERFLOW')
  })

  it('a moderate large-n midpoint stays computable (n = 1000)', () => {
    // [D] = 9, EC50 = 10, n = 1000 → E = 100/(1+(10/9)^1000)
    const result = resultOf(
      hill({
        ec50: p(10, 'nM'),
        hillCoefficient: p(1000, '1'),
        concentration: p(9, 'nM'),
      }),
    )
    const expected = 100 / (1 + Math.pow(10 / 9, 1000))
    expect((result.outputs[0]?.value as number) / expected).toBeCloseTo(1, 6)
  })
})

describe('calculateHillResponse — report structure and trace', () => {
  const report = hill({})

  it('carries model identity, formula, assumptions and boundary warnings', () => {
    const result = resultOf(report)
    expect(result.model).toBe('dose-response.hill')
    expect(result.modelLabel).toContain('Hill')
    expect(result.formula).toBe('E = E0 + (Emax · [D]^n) / (EC50^n + [D]^n)')
    expect(result.assumptions.some((a) => a.includes('no defaults'))).toBe(true)
    expect(result.assumptions.some((a) => a.includes('IC50'))).toBe(true)
    const codes = warningCodes(report)
    expect(codes).toContain('MODEL_LIMITATION')
    expect(codes).toContain('MODEL_RESULT_NOT_CLINICAL')
  })

  it('echoes all five inputs with provenance only when supplied', () => {
    const literature = { type: 'literature' as const, source: 'Synthetic fixture (test data)' }
    const result = resultOf(hill({ ec50: p(10, 'nM', literature) }))
    expect(result.inputs.map((i) => i.symbol)).toEqual(['E0', 'Emax', 'EC50', 'n', '[D]'])
    expect(result.inputs[2]?.provenance).toEqual(literature)
    expect('provenance' in (result.inputs[3] ?? {})).toBe(false)
  })

  it('traces the stable-form evaluation and ends at the reported E', () => {
    const result = resultOf(report)
    const ratio = result.trace.find((s) => s.label === 'Concentration ratio')
    expect(ratio?.expression).toBe('r = EC50 / [D]')
    const fractional = result.trace.find((s) => s.label === 'Fractional response')
    expect(fractional?.expression).toContain('f = 1 / (1 + r^n)')
    const response = result.trace[result.trace.length - 1]
    expect(response?.label).toBe('Response')
    expect(response?.result.value).toBe(result.outputs[0]?.value)
    result.trace.forEach((step, i) => expect(step.index).toBe(i + 1))
  })
})

describe('calculateHillResponse — purity', () => {
  it('is deterministic and does not mutate its input', () => {
    const input: HillResponseInput = Object.freeze({
      e0: Object.freeze({ value: 0, unit: '%' }),
      emax: Object.freeze({ value: 100, unit: '%' }),
      ec50: Object.freeze({ value: 10, unit: 'nM' }),
      hillCoefficient: Object.freeze({ value: 2, unit: '1' }),
      concentration: Object.freeze({ value: 20, unit: 'nM' }),
    })
    expect(calculateHillResponse(input)).toEqual(calculateHillResponse(input))
    expect(input.concentration).toEqual({ value: 20, unit: 'nM' })
  })
})

describe('calculateHillResponse — invariants', () => {
  const concentrations = [1e-3, 1e-2, 0.1, 1, 10, 100, 1e3, 1e5]

  it('f stays within [0, 1] and is monotonic in [D]', () => {
    let previous = -1
    for (const d of concentrations) {
      const f = resultOf(hill({ concentration: p(d, 'nM') })).outputs.find(
        (o) => o.symbol === 'f',
      )?.value as number
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(1)
      expect(f).toBeGreaterThanOrEqual(previous)
      previous = f
    }
  })

  it('E stays within [E0, E0+Emax] for positive Emax and is monotonic', () => {
    let previous = Number.NEGATIVE_INFINITY
    for (const d of concentrations) {
      const e = resultOf(hill({ concentration: p(d, 'nM') })).outputs[0]?.value as number
      expect(e).toBeGreaterThanOrEqual(0) // E0
      expect(e).toBeLessThanOrEqual(100) // E0 + Emax
      expect(e).toBeGreaterThanOrEqual(previous)
      previous = e
    }
  })

  it('E stays within [E0+Emax, E0] for negative Emax and is monotonic decreasing', () => {
    let previous = Number.POSITIVE_INFINITY
    for (const d of concentrations) {
      const e = resultOf(
        hill({ emax: p(-100, '%'), concentration: p(d, 'nM') }),
      ).outputs[0]?.value as number
      expect(e).toBeLessThanOrEqual(0) // E0 = 0
      expect(e).toBeGreaterThanOrEqual(-100) // E0 + Emax
      expect(e).toBeLessThanOrEqual(previous)
      previous = e
    }
  })

  it('the Emax = 0 degenerate case returns exactly E0 for every [D]', () => {
    for (const d of concentrations) {
      expect(resultOf(hill({ emax: p(0, '%'), concentration: p(d, 'nM') })).outputs[0]?.value).toBe(0)
    }
  })
})
