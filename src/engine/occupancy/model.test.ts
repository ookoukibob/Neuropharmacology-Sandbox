import { describe, expect, it } from 'vitest'
import type { Provenance } from '../../domain/provenance/provenance'
import { errorCodes, errorsOf, resultOf, warningCodes } from '../../tests/report'
import { calculateReceptorOccupancy, type ReceptorOccupancyInput } from './model'

/** Synthetic test values chosen for exact or independently checkable math. */
const p = (value: number, unit: string, provenance?: Provenance) =>
  provenance === undefined ? { value, unit } : { value, unit, provenance }

const occ = (concentration: number, kd: number, unit = 'nM') =>
  calculateReceptorOccupancy({
    concentration: p(concentration, unit),
    kd: p(kd, unit),
  })

describe('calculateReceptorOccupancy — normal cases', () => {
  it('matches the specification worked example', () => {
    // [D] = 12.4 nM, Kd = 4.7 nM → 12.4 / (12.4 + 4.7) = 12.4/17.1
    // 12.4/17.1 = 124/171 = 0.7251461988304093…
    const report = occ(12.4, 4.7)
    const result = resultOf(report)
    const fraction = result.outputs.find((o) => o.symbol === 'Occ')
    const percent = result.outputs.find((o) => o.symbol === 'Occ%')

    expect(fraction?.value).toBeCloseTo(124 / 171, 9)
    expect(fraction?.unit).toBe('1')
    expect(percent?.value).toBeCloseTo(12400 / 171, 8)
    expect(percent?.unit).toBe('%')

    // The denominator step shows the spec's 17.1 nM explicitly.
    const denominator = result.trace.find((step) => step.label === 'Denominator')
    expect(denominator?.result.value).toBe(17.1)
  })

  it('is exactly 50% when [D] equals Kd', () => {
    for (const kd of [0.001, 4.7, 500]) {
      const result = resultOf(occ(kd, kd))
      expect(result.outputs[0]?.value).toBe(0.5)
      expect(result.outputs[1]?.value).toBe(50)
    }
  })

  it('is 0 at [D] = 0 and approaches 1 at saturating [D]', () => {
    expect(resultOf(occ(0, 4.7)).outputs[0]?.value).toBe(0)
    expect(resultOf(occ(0, 4.7)).outputs[1]?.value).toBe(0)

    const saturated = resultOf(occ(1e300, 1))
    expect(saturated.outputs[0]?.value).toBe(1)
    expect(saturated.outputs[1]?.value).toBe(100)
  })

  it('converts Kd into the [D] unit explicitly (1 µM vs 4.7 nM)', () => {
    // Kd 4.7 nM = 0.0047 µM → 1/(1.0047) = 10000/10047
    const report = calculateReceptorOccupancy({
      concentration: p(1, 'µM'),
      kd: p(4.7, 'nM'),
    })
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBeCloseTo(10000 / 10047, 9)

    const conversion = result.trace.find((step) => step.label === 'Unit conversion')
    expect(conversion).toBeDefined()
    expect(conversion?.result.unit).toBe('µM')
    expect(conversion?.result.value).toBe(0.0047)
    // Inputs echo the caller's units, not the converted ones.
    expect(result.inputs[1]).toMatchObject({ value: 4.7, unit: 'nM' })
  })

  it('accepts mass-concentration units when both parameters share them', () => {
    const result = resultOf(occ(1, 3, 'mg/L'))
    expect(result.outputs[0]?.value).toBe(0.25) // 1/(1+3)
  })

  it('keeps the percentage consistent with the fraction', () => {
    for (const [d, kd] of [
      [0.01, 4.7],
      [12.4, 4.7],
      [80, 7],
    ]) {
      const result = resultOf(occ(d as number, kd as number))
      const fraction = result.outputs[0]?.value as number
      const percent = result.outputs[1]?.value as number
      expect(percent).toBeCloseTo(fraction * 100, 9)
      expect(percent).toBeLessThanOrEqual(100)
    }
  })
})

describe('calculateReceptorOccupancy — boundary and extreme values', () => {
  it('stays exact at decimal extremes shared by both parameters', () => {
    expect(resultOf(occ(1e-300, 1e-300)).outputs[0]?.value).toBe(0.5)
    expect(resultOf(occ(1e300, 1e300)).outputs[0]?.value).toBe(0.5)
  })

  it('reports 0 with a warning when the fraction underflows', () => {
    // 1e-300 / (1e300 + 1e-300) = 1e-600 → below the double range.
    const report = occ(1e-300, 1e300)
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBe(0)
    expect(result.outputs[1]?.value).toBe(0)
    expect(warningCodes(report)).toContain('NUMERICAL_UNDERFLOW')
  })

  it('warns (not fails) when [D] + Kd overflows the report range', () => {
    // Both ~1e300: the sum 2e300 is beyond the double range for display,
    // while the ratio itself stays representable.
    const report = occ(1.5e308, 1.5e308)
    const result = resultOf(report)
    expect(result.outputs[0]?.value).toBe(0.5)
    expect(warningCodes(report)).toContain('NUMERICAL_OVERFLOW')
    const denominator = result.trace.find((step) => step.label === 'Denominator')
    expect(denominator?.result.value).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('calculateReceptorOccupancy — invalid inputs', () => {
  it('rejects Kd = 0 (degenerate denominator) with an explicit code', () => {
    const report = occ(12.4, 0)
    expect(errorCodes(report)).toEqual(['ZERO_NOT_ALLOWED'])
    expect(errorsOf(report)[0]?.parameter).toBe('Kd')
  })

  it('rejects negative values', () => {
    expect(errorCodes(occ(-1, 4.7))).toEqual(['NEGATIVE_VALUE'])
    expect(errorCodes(occ(12.4, -4.7))).toEqual(['NEGATIVE_VALUE'])
  })

  it('rejects NaN and ±Infinity', () => {
    expect(errorCodes(occ(Number.NaN, 4.7))).toEqual(['NOT_A_NUMBER'])
    expect(errorCodes(occ(12.4, Number.POSITIVE_INFINITY))).toEqual(['NOT_A_NUMBER'])
  })

  it('reports missing parameters without cascading unit errors', () => {
    const empty = calculateReceptorOccupancy({} as ReceptorOccupancyInput)
    expect(errorCodes(empty)).toEqual(['MISSING_PARAMETER', 'MISSING_PARAMETER'])
    expect(errorsOf(empty).map((e) => e.parameter)).toEqual(['[D]', 'Kd'])

    const missingKd = calculateReceptorOccupancy({ concentration: p(12.4, 'nM') } as never)
    expect(errorCodes(missingKd)).toEqual(['MISSING_PARAMETER'])
    expect(errorsOf(missingKd)[0]?.parameter).toBe('Kd')
  })

  it('rejects unknown, missing and incompatible units', () => {
    expect(
      errorCodes(
        calculateReceptorOccupancy({ concentration: p(12.4, 'xyz'), kd: p(4.7, 'nM') }),
      ),
    ).toEqual(['UNKNOWN_UNIT'])

    expect(
      errorCodes(calculateReceptorOccupancy({ concentration: p(12.4, 'nM'), kd: p(4.7, '') })),
    ).toEqual(['MISSING_PARAMETER'])

    const timeUnitKd = calculateReceptorOccupancy({
      concentration: p(12.4, 'nM'),
      kd: p(4.7, 'h'),
    })
    expect(errorCodes(timeUnitKd)).toEqual(['INCOMPATIBLE_UNITS'])
    expect(errorsOf(timeUnitKd)[0]?.parameter).toBe('Kd')
  })

  it('refuses molar [D] with mass Kd (would need a molecular weight)', () => {
    const report = calculateReceptorOccupancy({
      concentration: p(12.4, 'nM'),
      kd: p(4.7, 'mg/L'),
    })
    expect(errorCodes(report)).toEqual(['INCOMPATIBLE_UNITS'])
    expect(errorsOf(report)[0]?.parameter).toBe('Kd')
  })

  it('has no field for Ki — Ki can never be substituted for Kd', () => {
    const report = calculateReceptorOccupancy({
      concentration: p(12.4, 'nM'),
      kd: p(4.7, 'nM'),
      // @ts-expect-error -- `ki` is deliberately absent from the occupancy input
      ki: p(2, 'nM'),
    })
    const result = resultOf(report)
    expect(result.inputs.map((i) => i.symbol)).toEqual(['[D]', 'Kd'])
    // The calculation used Kd, not the foreign `ki` value.
    expect(result.outputs[0]?.value).toBeCloseTo(124 / 171, 9)
  })
})

describe('calculateReceptorOccupancy — report structure and trace', () => {
  const report = occ(12.4, 4.7)

  it('carries model identity, formula, assumptions and boundary warnings', () => {
    const result = resultOf(report)
    expect(result.model).toBe('occupancy.single-site')
    expect(result.modelLabel).toContain('occupancy')
    expect(result.formula).toBe('Occupancy = [D] / ([D] + Kd)')
    expect(result.assumptions.some((a) => a.includes('occupancy% = occupancy × 100'))).toBe(true)
    expect(result.assumptions.some((a) => a.includes('never derives concentration from a dose'))).toBe(true)
    const codes = warningCodes(report)
    expect(codes).toContain('MODEL_LIMITATION')
    expect(codes).toContain('MODEL_RESULT_NOT_CLINICAL')
  })

  it('echoes inputs with provenance only when supplied', () => {
    const literature = { type: 'literature' as const, source: 'Synthetic fixture (test data)' }
    const result = resultOf(
      calculateReceptorOccupancy({
        concentration: p(12.4, 'nM'),
        kd: p(4.7, 'nM', literature),
      }),
    )
    expect(result.inputs[1]?.provenance).toEqual(literature)
    expect('provenance' in (result.inputs[0] ?? {})).toBe(false)
  })

  it('traces fraction and percentage with the ×100 relationship explicit', () => {
    const result = resultOf(report)
    const fraction = result.trace.find((s) => s.label === 'Occupancy (fraction)')
    const percent = result.trace.find((s) => s.label === 'Occupancy (percent)')
    expect(fraction?.expression).toBe('Occ = [D] / ([D] + Kd)')
    expect(fraction?.substituted).toContain('17.1 nM')
    expect(percent?.expression).toBe('Occ% = Occ × 100')
    expect(percent?.result.value).toBe(result.outputs[1]?.value)
    // Ordered, 1-based indices:
    result.trace.forEach((step, i) => expect(step.index).toBe(i + 1))
  })
})

describe('calculateReceptorOccupancy — purity', () => {
  it('is deterministic and does not mutate its input', () => {
    const input: ReceptorOccupancyInput = Object.freeze({
      concentration: Object.freeze({ value: 12.4, unit: 'nM' }),
      kd: Object.freeze({ value: 4.7, unit: 'nM' }),
    })
    expect(calculateReceptorOccupancy(input)).toEqual(calculateReceptorOccupancy(input))
    expect(input).toEqual({
      concentration: { value: 12.4, unit: 'nM' },
      kd: { value: 4.7, unit: 'nM' },
    })
  })
})

describe('calculateReceptorOccupancy — invariants', () => {
  const kdValues = [0.1, 4.7, 100]
  const dValues = [1e-6, 1e-3, 0.1, 1, 10, 1e3, 1e6]

  it('occupancy stays within [0, 1] and is monotonic in [D]', () => {
    for (const kd of kdValues) {
      let previous = -1
      for (const d of dValues) {
        const fraction = resultOf(occ(d, kd)).outputs[0]?.value as number
        expect(fraction).toBeGreaterThanOrEqual(0)
        expect(fraction).toBeLessThanOrEqual(1)
        expect(fraction).toBeGreaterThanOrEqual(previous)
        previous = fraction
      }
    }
  })

  it('occupancy is exactly 0.5 when [D] = Kd, for every Kd', () => {
    for (const kd of kdValues) expect(occ(kd, kd).ok).toBe(true)
    for (const kd of kdValues) expect(resultOf(occ(kd, kd)).outputs[0]?.value).toBe(0.5)
  })

  it('is symmetric around Kd: occ(Kd²/d) = 1 − occ(d)', () => {
    const kd = 4.7
    for (const d of [0.1, 1, 10]) {
      const below = resultOf(occ((kd * kd) / d, kd)).outputs[0]?.value as number
      const above = resultOf(occ(d, kd)).outputs[0]?.value as number
      expect(below).toBeCloseTo(1 - above, 10)
    }
  })
})
