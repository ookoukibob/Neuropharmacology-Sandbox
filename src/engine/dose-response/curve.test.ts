import { describe, expect, it } from 'vitest'
import { curveErrorsOf, curveOf } from '../../tests/report'
import { generateHillCurve } from './curve'
import { calculateHillResponse, type HillResponseInput } from './model'

const p = (value: number, unit: string) => ({ value, unit })

const input = (): HillResponseInput => ({
  e0: p(0, '%'),
  emax: p(100, '%'),
  ec50: p(1, 'nM'),
  hillCoefficient: p(2, '1'),
  concentration: p(1, 'nM'),
})

describe('generateHillCurve — normal cases', () => {
  it('samples a log concentration axis with documented defaults', () => {
    const curve = curveOf(generateHillCurve(input(), { range: { min: 1e-3, max: 1e3, points: 60 } }))
    expect(curve.model).toBe('dose-response.hill')
    expect(curve.xScale).toBe('log')
    expect(curve.yScale).toBe('linear')
    expect(curve.xLabel).toBe('Concentration')
    expect(curve.yLabel).toBe('Response')
    expect(curve.xUnit).toBe('nM')
    expect(curve.yUnit).toBe('%')
    const series = curve.series[0]
    expect(series?.id).toBe('dose-response.hill')
    expect(series?.name).toBe('E([D])')
    expect(series?.points).toHaveLength(60)
    expect(series?.points[0]?.x).toBe(1e-3)
    expect(series?.points[59]?.x).toBe(1e3)
    expect(curve.warnings).toBeUndefined()
  })

  it('crosses exactly half-maximal at the log midpoint x = EC50', () => {
    // Log range 1e-3…1e3 with 21 points → x[10] = 1e-3 · 1e6^0.5 = 1 = EC50.
    const curve = curveOf(
      generateHillCurve(input(), { range: { min: 1e-3, max: 1e3, points: 21 } }),
    )
    const points = curve.series[0]?.points ?? []
    expect(points[10]?.x).toBe(1)
    expect(points[10]?.y).toBe(50)
  })

  it('curve points equal the scalar calculation at the same x', () => {
    const curve = curveOf(
      generateHillCurve(input(), { range: { min: 0.01, max: 100, points: 40 } }),
    )
    for (const point of curve.series[0]?.points ?? []) {
      const scalar = calculateHillResponse({
        ...input(),
        concentration: p(point.x, 'nM'),
      })
      expect(scalar.ok).toBe(true)
      if (scalar.ok) expect(point.y).toBe(scalar.result.outputs[0]?.value)
    }
  })

  it('is monotonic non-decreasing (positive Emax) and bounded by E0/E0+Emax', () => {
    const curve = curveOf(generateHillCurve(input(), { range: { min: 1e-3, max: 1e3, points: 50 } }))
    const points = curve.series[0]?.points ?? []
    for (let i = 1; i < points.length; i++) {
      expect(points[i]?.y).toBeGreaterThanOrEqual(points[i - 1]?.y as number)
    }
    expect(points[0]?.y).toBeGreaterThanOrEqual(0)
    expect(points[points.length - 1]?.y).toBeLessThanOrEqual(100)
  })

  it('supports a linear axis and both scale options', () => {
    const curve = curveOf(
      generateHillCurve(input(), {
        range: { min: 0, max: 10, points: 11 },
        xScale: 'linear',
        yScale: 'log',
      }),
    )
    expect(curve.xScale).toBe('linear')
    expect(curve.yScale).toBe('log')
    expect(curve.series[0]?.points[0]).toEqual({ x: 0, y: 0 }) // E(0) = E0
  })
})

describe('generateHillCurve — errors', () => {
  it('requires an explicit range', () => {
    const errors = curveErrorsOf(generateHillCurve(input(), undefined as never))
    expect(errors[0]?.parameter).toBe('range')
  })

  it('refuses a log axis through zero and other invalid ranges', () => {
    expect(
      curveErrorsOf(generateHillCurve(input(), { range: { min: 0, max: 100 } }))[0]?.parameter,
    ).toBe('range.min')
    expect(
      curveErrorsOf(generateHillCurve(input(), { range: { min: 10, max: 1 } }))[0]?.code,
    ).toBe('OUT_OF_RANGE')
    expect(
      curveErrorsOf(
        generateHillCurve(input(), { range: { min: -1, max: 10 }, xScale: 'linear' }),
      )[0]?.parameter,
    ).toBe('range.min')
  })

  it('propagates invalid model inputs (missing n is never defaulted)', () => {
    const { hillCoefficient: _omitted, ...withoutN } = input()
    const result = generateHillCurve(withoutN as HillResponseInput, {
      range: { min: 0.01, max: 100 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.model).toBe('dose-response.hill')
      expect(result.errors[0]?.code).toBe('MISSING_PARAMETER')
      expect(result.errors[0]?.parameter).toBe('n')
    }
  })

  it('propagates unit mismatches between [D] and EC50', () => {
    const result = generateHillCurve(
      { ...input(), ec50: p(1, 'mg/L') },
      { range: { min: 0.01, max: 100 } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.code).toBe('INCOMPATIBLE_UNITS')
  })
})

describe('generateHillCurve — numerical reporting', () => {
  it('flags underflowing tail points as curve warnings', () => {
    // Log range down to 1e-300 nM: those tails underflow to E = 0.
    const curve = curveOf(
      generateHillCurve(input(), { range: { min: 1e-300, max: 1, points: 20 } }),
    )
    expect(curve.warnings?.map((w) => w.code)).toContain('NUMERICAL_UNDERFLOW')
    const points = curve.series[0]?.points ?? []
    expect(points[points.length - 1]?.y).toBe(50) // x = EC50 → E0 + Emax/2 for every n
  })
})
