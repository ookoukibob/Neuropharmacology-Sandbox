import { describe, expect, it } from 'vitest'
import type { CalculationReport, EngineParameter } from '../types'
import { errorsOf, errorCodes, resultOf, warningCodes } from '../../tests/report'
import { calculateFirstOrderPK, type FirstOrderPKInput } from './model'

/** Test-data factory. Values are synthetic numbers chosen for exact math. */
const p = (value: number, unit: string, provenance?: EngineParameter['provenance']): EngineParameter =>
  provenance === undefined ? { value, unit } : { value, unit, provenance }

describe('calculateFirstOrderPK — normal cases', () => {
  it('matches the closed form for a reference case', () => {
    // C0 = 100 nM, t½ = 8 h, t = 12 h → C = 100 · 2^(-12/8) = 100 · 2^(-1.5)
    // 2^1.5 = 2√2, so C = 100/(2√2) = 25√2 ≈ 35.35533905932738 nM.
    const report = calculateFirstOrderPK({
      c0: p(100, 'nM'),
      time: p(12, 'h'),
      halfLife: p(8, 'h'),
    })
    const result = resultOf(report)
    const c = result.outputs.find((o) => o.symbol === 'C(t)')
    expect(c?.value).toBeCloseTo(25 * Math.SQRT2, 9)
    expect(c?.unit).toBe('nM')

    // k = ln2/8 h, t½ echoed:
    const k = result.outputs.find((o) => o.symbol === 'k')
    expect(k?.value).toBeCloseTo(Math.LN2 / 8, 10)
    expect(k?.unit).toBe('1/h')
    expect(result.outputs.find((o) => o.symbol === 't½')?.value).toBe(8)
  })

  it('derives k from t½ such that k · t½ = ln 2', () => {
    const result = resultOf(
      calculateFirstOrderPK({ c0: p(10, 'nM'), time: p(1, 'h'), halfLife: p(6, 'h') }),
    )
    const k = result.outputs.find((o) => o.symbol === 'k')?.value ?? 0
    expect(k * 6).toBeCloseTo(Math.LN2, 9)
  })

  it('satisfies C(0) = C0', () => {
    const result = resultOf(
      calculateFirstOrderPK({ c0: p(42, 'nM'), time: p(0, 'h'), halfLife: p(6, 'h') }),
    )
    expect(result.outputs[0]?.value).toBe(42)
  })

  it('halves the concentration after each half-life', () => {
    const c0 = p(60, 'nM')
    for (const [t, expected] of [
      [4, 30],
      [8, 15],
      [12, 7.5],
    ]) {
      const result = resultOf(
        calculateFirstOrderPK({ c0, time: p(t as number, 'h'), halfLife: p(4, 'h') }),
      )
      expect(result.outputs[0]?.value).toBe(expected)
    }
  })

  it('treats C0 = 0 as valid: C(t) = 0 for every t', () => {
    const report = calculateFirstOrderPK({ c0: p(0, 'nM'), time: p(12, 'h'), halfLife: p(4, 'h') })
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBe(0)
    expect(warningCodes(report)).not.toContain('NUMERICAL_UNDERFLOW') // exact zero ≠ underflow
  })

  it('accepts k instead of t½ and derives t½ (and C = C0/e at t = 1/k)', () => {
    const report = calculateFirstOrderPK({ c0: p(100, 'nM'), time: p(10, 'h'), k: p(0.1, '1/h') })
    const result = resultOf(report)
    // C(10 h) = 100 · e^(−0.1·10) = 100/e
    expect(result.outputs[0]?.value).toBeCloseTo(100 / Math.E, 9)
    // t½ = ln(2)/0.1
    expect(result.outputs.find((o) => o.symbol === 't½')?.value).toBeCloseTo(Math.LN2 / 0.1, 9)
    expect(result.outputs.find((o) => o.symbol === 't½')?.unit).toBe('h')
    expect(result.outputs.find((o) => o.symbol === 'k')?.value).toBe(0.1)
    expect(result.inputs.map((i) => i.symbol)).toEqual(['C0', 't', 'k'])
  })

  it('converts t into the half-life unit explicitly (0.5 h = 30 min = 5 half-lives)', () => {
    // t½ = 6 min, t = 0.5 h → 30 min → 5 half-lives → 96 · 2^-5 = 3 nM.
    const report = calculateFirstOrderPK({
      c0: p(96, 'nM'),
      time: p(0.5, 'h'),
      halfLife: p(6, 'min'),
    })
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBe(3)
    const conversion = result.trace.find((step) => step.label === 'Unit conversion')
    expect(conversion).toBeDefined()
    expect(conversion?.result.unit).toBe('min')
    expect(conversion?.result.value).toBeCloseTo(30, 10)
    // Inputs echo what the caller supplied — never the converted value.
    expect(result.inputs[1]).toMatchObject({ value: 0.5, unit: 'h' })
  })
})

describe('calculateFirstOrderPK — boundary and extreme values', () => {
  it('reports 0 with a warning when the half-life is extremely short (underflow)', () => {
    // t½ = 1 µs-ish regime: t/t½ = 2e6 → e^(−1.4e6) is far below double range.
    const report = calculateFirstOrderPK({
      c0: p(100, 'nM'),
      time: p(2_000_000, 's'),
      halfLife: p(1e-6, 's'),
    })
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBe(0)
    expect(warningCodes(report)).toContain('NUMERICAL_UNDERFLOW')
  })

  it('handles an extremely long half-life (tiny but non-zero decay)', () => {
    // t½ = 1e12 h, t = 1000 h → C = 1000 · 2^(−1e-9) ≈ 999.999999307 nM
    const report = calculateFirstOrderPK({
      c0: p(1000, 'nM'),
      time: p(1000, 'h'),
      halfLife: p(1e12, 'h'),
    })
    expect(resultOf(report).outputs[0]?.value).toBeCloseTo(1000 * Math.pow(2, -1e-9), 6)
  })

  it('handles very large and very small starting concentrations without overflow/NaN', () => {
    const large = resultOf(
      calculateFirstOrderPK({ c0: p(1e300, 'M'), time: p(10, 'h'), halfLife: p(10, 'h') }),
    )
    expect(large.outputs[0]?.value).toBe(5e299)

    const small = resultOf(
      calculateFirstOrderPK({ c0: p(1e-300, 'M'), time: p(10, 'h'), halfLife: p(10, 'h') }),
    )
    expect(small.outputs[0]?.value).toBe(5e-301)
  })

  it('classifies a collapsed exp() and an overflowing k as loss — never silent', () => {
    // t½ = MIN_VALUE h → k ≈ 1.4e323 leaves the double range, and exp(−k·t)
    // leaves Decimal's own range (exact 0) although e^(−k·t) > 0 always.
    const report = calculateFirstOrderPK({
      c0: p(100, 'nM'),
      time: p(12, 'h'),
      halfLife: p(Number.MIN_VALUE, 'h'),
    })
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBe(0)
    expect(result.outputs[1]?.value).toBe(Number.POSITIVE_INFINITY)
    const warnings = report.ok ? report.result.warnings : []
    expect(warnings.some((w) => w.code === 'NUMERICAL_OVERFLOW')).toBe(true)
    expect(
      warnings.some((w) => w.code === 'NUMERICAL_UNDERFLOW' && w.message.includes('surviving fraction')),
    ).toBe(true)
    // The trace step agrees with the reported loss instead of showing a quiet 0.
    const survival = result.trace.find((s) => s.label === 'Surviving fraction')
    expect(survival?.result.value).toBe(0)
  })
})

describe('calculateFirstOrderPK — invalid inputs', () => {
  const bad = (overrides: Record<string, EngineParameter | undefined>) => {
    const input = {
      c0: p(100, 'nM'),
      time: p(1, 'h'),
      halfLife: p(6, 'h'),
      ...overrides,
    } as unknown as FirstOrderPKInput
    return calculateFirstOrderPK(input)
  }

  it('rejects negative values', () => {
    expect(errorCodes(bad({ c0: p(-1, 'nM') }))).toContain('NEGATIVE_VALUE')
    expect(errorCodes(bad({ time: p(-1, 'h') }))).toContain('NEGATIVE_VALUE')
    expect(errorCodes(bad({ halfLife: p(-6, 'h') }))).toContain('NEGATIVE_VALUE')
    const kErrors = calculateFirstOrderPK({
      c0: p(1, 'nM'),
      time: p(1, 'h'),
      k: p(-0.1, '1/h'),
    })
    expect(errorCodes(kErrors)).toContain('NEGATIVE_VALUE')
  })

  it('rejects zero half-life (k = ln2/0 undefined) and zero k (infinite t½)', () => {
    const zeroHalfLife = bad({ halfLife: p(0, 'h') })
    expect(errorCodes(zeroHalfLife)).toContain('ZERO_NOT_ALLOWED')
    expect(errorsOf(zeroHalfLife)[0]?.parameter).toBe('t½')

    const zeroK = calculateFirstOrderPK({ c0: p(1, 'nM'), time: p(1, 'h'), k: p(0, '1/h') })
    expect(errorCodes(zeroK)).toContain('ZERO_NOT_ALLOWED')
    expect(errorsOf(zeroK)[0]?.parameter).toBe('k')
  })

  it('requires either t½ or k — no default is invented', () => {
    const report = calculateFirstOrderPK({ c0: p(1, 'nM'), time: p(1, 'h') } as FirstOrderPKInput)
    expect(errorCodes(report)).toEqual(['MISSING_PARAMETER'])
    expect(errorsOf(report)[0]?.parameter).toBe('halfLife')
  })

  it('rejects t½ and k together as conflicting', () => {
    const report = bad({ halfLife: p(6, 'h'), k: p(0.1, '1/h') })
    expect(errorCodes(report)).toEqual(['CONFLICTING_PARAMETERS'])
  })

  it('rejects missing parameters without cascading unit errors', () => {
    const report = calculateFirstOrderPK({} as FirstOrderPKInput)
    expect(errorCodes(report)).toEqual(['MISSING_PARAMETER', 'MISSING_PARAMETER', 'MISSING_PARAMETER'])
    expect(errorsOf(report).map((e) => e.parameter)).toEqual(['C0', 't', 'halfLife'])
  })

  it('rejects NaN and ±Infinity', () => {
    expect(errorCodes(bad({ c0: p(Number.NaN, 'nM') }))).toContain('NOT_A_NUMBER')
    expect(errorCodes(bad({ time: p(Number.POSITIVE_INFINITY, 'h') }))).toContain('NOT_A_NUMBER')
    expect(errorCodes(bad({ halfLife: p(Number.NaN, 'h') }))).toContain('NOT_A_NUMBER')
  })

  it('rejects unknown, missing and incompatible units', () => {
    expect(errorCodes(bad({ c0: p(100, 'molars') }))).toEqual(['UNKNOWN_UNIT'])
    expect(errorCodes(bad({ c0: p(100, '') }))).toEqual(['MISSING_PARAMETER'])
    expect(errorCodes(bad({ time: p(1, 'nM') }))).toEqual(['INCOMPATIBLE_UNITS']) // time expected
    expect(errorCodes(bad({ halfLife: p(6, 'xyz') }))).toEqual(['UNKNOWN_UNIT'])

    const kWithConcentrationUnit = calculateFirstOrderPK({
      c0: p(1, 'nM'),
      time: p(1, 'h'),
      k: p(0.1, 'nM'),
    })
    expect(errorCodes(kWithConcentrationUnit)).toEqual(['INCOMPATIBLE_UNITS'])

    const kWithTimeUnit = calculateFirstOrderPK({
      c0: p(1, 'nM'),
      time: p(1, 'h'),
      k: p(0.1, 'h'), // an hour is not a per-hour rate
    })
    expect(errorCodes(kWithTimeUnit)).toEqual(['INCOMPATIBLE_UNITS'])

    const kMissingUnit = calculateFirstOrderPK({
      c0: p(1, 'nM'),
      time: p(1, 'h'),
      k: p(0.1, ''),
    })
    expect(errorCodes(kMissingUnit)).toEqual(['MISSING_PARAMETER'])
    expect(errorsOf(kMissingUnit)[0]?.parameter).toBe('k.unit')
  })

  it('aggregates independent problems in one report', () => {
    const report = bad({ c0: p(-1, 'molars'), time: p(Number.NaN, 'h') })
    const codes = errorCodes(report)
    expect(codes).toEqual(['NEGATIVE_VALUE', 'UNKNOWN_UNIT', 'NOT_A_NUMBER'])
    expect(errorsOf(report).map((e) => e.parameter)).toEqual(['C0', 'C0', 't'])
  })
})

describe('calculateFirstOrderPK — report structure and trace', () => {
  const report = calculateFirstOrderPK({
    c0: p(100, 'nM'),
    time: p(12, 'h'),
    halfLife: p(8, 'h'),
  })

  it('carries model identity, formula, assumptions and boundary warnings', () => {
    const result = resultOf(report)
    expect(result.model).toBe('pk.first-order-one-compartment')
    expect(result.modelLabel).toContain('one-compartment')
    expect(result.formula).toContain('C(t)')
    expect(result.assumptions.length).toBeGreaterThanOrEqual(3)
    const codes = warningCodes(report)
    expect(codes).toContain('MODEL_LIMITATION')
    expect(codes).toContain('MODEL_RESULT_NOT_CLINICAL')
  })

  it('echoes inputs with symbols, values, units — and provenance only when supplied', () => {
    const literature = { type: 'literature' as const, source: 'Synthetic fixture (test data)' }
    const result = resultOf(
      calculateFirstOrderPK({
        c0: p(100, 'nM', literature),
        time: p(12, 'h'),
        halfLife: p(8, 'h'),
      }),
    )
    expect(result.inputs.map((i) => i.symbol)).toEqual(['C0', 't', 't½'])
    expect(result.inputs[0]?.provenance).toEqual(literature)
    // Typed-in values carry no provenance claim at all:
    expect('provenance' in (result.inputs[1] ?? {})).toBe(false)
    expect('provenance' in (result.inputs[2] ?? {})).toBe(false)
  })

  it('produces an ordered, complete trace ending in the reported concentration', () => {
    const result = resultOf(report)
    expect(result.trace.length).toBeGreaterThanOrEqual(4)
    result.trace.forEach((step, i) => {
      expect(step.index).toBe(i + 1)
      expect(step.label.length).toBeGreaterThan(0)
      expect(step.expression.length).toBeGreaterThan(0)
      expect(step.substituted.length).toBeGreaterThan(0)
      expect(Number.isFinite(step.result.value)).toBe(true)
      expect(step.result.unit.length).toBeGreaterThan(0)
    })
    const elimination = result.trace.find((s) => s.label === 'Elimination constant')
    expect(elimination?.expression).toBe('k = ln(2) / t½')
    expect(elimination?.substituted).toContain('ln(2)')
    const last = result.trace[result.trace.length - 1]
    expect(last?.result.value).toBe(result.outputs[0]?.value) // trace ends at the output
  })
})

describe('calculateFirstOrderPK — purity', () => {
  it('is deterministic and does not mutate its input', () => {
    const input: FirstOrderPKInput = Object.freeze({
      c0: Object.freeze({ value: 100, unit: 'nM' }),
      time: Object.freeze({ value: 12, unit: 'h' }),
      halfLife: Object.freeze({ value: 8, unit: 'h' }),
    })
    const first = calculateFirstOrderPK(input)
    const second = calculateFirstOrderPK(input)
    expect(first).toEqual(second)
    expect(input).toEqual({
      c0: { value: 100, unit: 'nM' },
      time: { value: 12, unit: 'h' },
      halfLife: { value: 8, unit: 'h' },
    })
  })
})

describe('calculateFirstOrderPK — invariants', () => {
  it('k · t½ equals ln 2 for a range of half-lives', () => {
    for (const halfLife of [0.1, 1, 6, 24, 100]) {
      const result = resultOf(
        calculateFirstOrderPK({ c0: p(10, 'nM'), time: p(1, 'h'), halfLife: p(halfLife, 'h') }),
      )
      const k = result.outputs.find((o) => o.symbol === 'k')?.value ?? 0
      expect(k * halfLife).toBeCloseTo(Math.LN2, 8)
    }
  })

  it('concentration decays monotonically and never exceeds C0', () => {
    const result = resultOf(
      calculateFirstOrderPK({ c0: p(100, 'nM'), time: p(0, 'h'), halfLife: p(5, 'h') }),
    )
    expect(result.outputs[0]?.value).toBe(100)
    let previous = Number.POSITIVE_INFINITY
    for (const t of [0, 1, 2, 3, 5, 8, 13, 21, 34]) {
      const at = resultOf(
        calculateFirstOrderPK({ c0: p(100, 'nM'), time: p(t, 'h'), halfLife: p(5, 'h') }),
      ).outputs[0]?.value as number
      expect(at).toBeLessThan(previous)
      expect(at).toBeLessThanOrEqual(100)
      previous = at
    }
  })

  it('C(n · t½) = C0 · 2^−n for integer n', () => {
    for (const n of [1, 2, 3, 4]) {
      const result = resultOf(
        calculateFirstOrderPK({ c0: p(100, 'nM'), time: p(n * 5, 'h'), halfLife: p(5, 'h') }),
      )
      expect(result.outputs[0]?.value).toBeCloseTo(100 * Math.pow(2, -n), 9)
    }
  })

  it('t½ ↔ k equivalence: both input paths compute the same concentration', () => {
    const viaHalfLife = resultOf(
      calculateFirstOrderPK({ c0: p(100, 'nM'), time: p(7.5, 'h'), halfLife: p(6, 'h') }),
    )
    const k = Math.LN2 / 6
    const viaRate = resultOf(
      calculateFirstOrderPK({ c0: p(100, 'nM'), time: p(7.5, 'h'), k: p(k, '1/h') }),
    )
    expect(viaRate.outputs[0]?.value).toBeCloseTo(viaHalfLife.outputs[0]?.value as number, 9)
    // Each path echoes the parameter the other one derived, to full precision.
    expect(viaRate.outputs.find((o) => o.symbol === 't½')?.value).toBeCloseTo(6, 10)
    expect(viaHalfLife.outputs.find((o) => o.symbol === 'k')?.value).toBeCloseTo(k, 10)
  })
})

// Type-level guard: the union input demands exactly one of t½ / k.
describe('calculateFirstOrderPK — input typing', () => {
  it('rejects an object literal with neither t½ nor k at compile time', () => {
    // @ts-expect-error -- halfLife or k is required by the input union
    const report: CalculationReport = calculateFirstOrderPK({ c0: p(1, 'nM'), time: p(1, 'h') })
    expect(report.ok).toBe(false)
  })

  it('rejects an object literal with both t½ and k at compile time', () => {
    // @ts-expect-error -- supplying both t½ and k is a type-level conflict
    const report: CalculationReport = calculateFirstOrderPK({
      c0: p(1, 'nM'),
      time: p(1, 'h'),
      halfLife: p(6, 'h'),
      k: p(0.1, '1/h'),
    })
    expect(report.ok).toBe(false)
  })
})
