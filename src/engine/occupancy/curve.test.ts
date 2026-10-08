import { describe, expect, it } from 'vitest'
import { curveErrorsOf, curveOf } from '../../tests/report'
import { generateOccupancyCurve } from './curve'
import { calculateReceptorOccupancy } from './model'

const p = (value: number, unit: string) => ({ value, unit })

const input = () => ({
  concentration: p(1, 'nM'),
  kd: p(4.7, 'nM'),
})

describe('generateOccupancyCurve — normal cases', () => {
  it('samples a log concentration axis with documented defaults', () => {
    const curve = curveOf(
      generateOccupancyCurve(input(), { range: { min: 0.01, max: 1000, points: 100 } }),
    )
    expect(curve.model).toBe('occupancy.single-site')
    expect(curve.xScale).toBe('log') // concentration axes default to log
    expect(curve.yScale).toBe('linear')
    expect(curve.xLabel).toBe('Concentration')
    expect(curve.yLabel).toBe('Occupancy (fraction)')
    expect(curve.xUnit).toBe('nM')
    expect(curve.yUnit).toBe('1')

    const series = curve.series[0]
    expect(series?.id).toBe('occupancy.fraction')
    expect(series?.seriesType).toBe('model')
    expect(series?.points).toHaveLength(100)
    expect(series?.points[0]?.x).toBe(0.01)
    expect(series?.points[99]?.x).toBe(1000)
    expect(curve.warnings).toBeUndefined()
  })

  it('is monotonic and bounded, and equals 0.5 exactly at x = Kd', () => {
    // Log range 0.1…10 with 21 points steps by 10^(2/20) per decade half:
    // x[i] = 0.1 · 100^(i/20) → x[10] = 0.1 · 10 = 1 = Kd.
    const curve = curveOf(
      generateOccupancyCurve({ concentration: p(1, 'nM'), kd: p(1, 'nM') }, {
        range: { min: 0.1, max: 10, points: 21 },
      }),
    )
    const points = curve.series[0]?.points ?? []
    for (let i = 1; i < points.length; i++) {
      expect(points[i]?.y).toBeGreaterThanOrEqual(points[i - 1]?.y as number)
      expect(points[i]?.y).toBeLessThanOrEqual(1)
    }
    expect(points[10]?.x).toBe(1)
    expect(points[10]?.y).toBe(0.5)
  })

  it('curve points equal the scalar calculation at the same x', () => {
    const curve = curveOf(
      generateOccupancyCurve(input(), { range: { min: 0.01, max: 100, points: 30 } }),
    )
    for (const point of curve.series[0]?.points ?? []) {
      const scalar = calculateReceptorOccupancy({
        concentration: p(point.x, 'nM'),
        kd: p(4.7, 'nM'),
      })
      expect(scalar.ok).toBe(true)
      if (scalar.ok) expect(point.y).toBe(scalar.result.outputs[0]?.value)
    }
  })

  it('supports a linear axis including x = 0 (where occupancy is 0)', () => {
    const curve = curveOf(
      generateOccupancyCurve(input(), {
        range: { min: 0, max: 50, points: 11 },
        xScale: 'linear',
      }),
    )
    expect(curve.xScale).toBe('linear')
    const points = curve.series[0]?.points ?? []
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points[10]?.x).toBe(50)
  })
})

describe('generateOccupancyCurve — errors', () => {
  it('requires an explicit range', () => {
    const errors = curveErrorsOf(generateOccupancyCurve(input(), undefined as never))
    expect(errors[0]?.parameter).toBe('range')
  })

  it('refuses a log axis through zero', () => {
    const errors = curveErrorsOf(
      generateOccupancyCurve(input(), { range: { min: 0, max: 100 } }),
    )
    expect(errors[0]?.code).toBe('OUT_OF_RANGE')
    expect(errors[0]?.parameter).toBe('range.min')
  })

  it('propagates invalid model inputs with the model id', () => {
    const result = generateOccupancyCurve(
      { concentration: p(1, 'nM'), kd: p(0, 'nM') },
      { range: { min: 0.1, max: 10 } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.model).toBe('occupancy.single-site')
      expect(result.errors[0]?.code).toBe('ZERO_NOT_ALLOWED')
    }
  })

  it('propagates incompatible units between [D] and Kd', () => {
    const result = generateOccupancyCurve(
      { concentration: p(1, 'nM'), kd: p(4.7, 'mg/L') },
      { range: { min: 0.1, max: 10 } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.code).toBe('INCOMPATIBLE_UNITS')
  })
})
