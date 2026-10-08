import { describe, expect, it } from 'vitest'
import { curveErrorsOf, curveOf } from '../../tests/report'
import { generatePKCurve } from './curve'
import { calculateFirstOrderPK, type FirstOrderPKInput } from './model'

const p = (value: number, unit: string) => ({ value, unit })

const input = (): FirstOrderPKInput => ({
  c0: p(100, 'nM'),
  time: p(0, 'h'),
  halfLife: p(8, 'h'),
})

describe('generatePKCurve — normal cases', () => {
  it('samples the requested range with documented defaults', () => {
    const curve = curveOf(generatePKCurve(input(), { range: { min: 0, max: 24 } }))
    expect(curve.model).toBe('pk.first-order-one-compartment')
    expect(curve.xScale).toBe('linear')
    expect(curve.yScale).toBe('linear')
    expect(curve.xLabel).toBe('Time')
    expect(curve.yLabel).toBe('Concentration')
    expect(curve.xUnit).toBe('h')
    expect(curve.yUnit).toBe('nM')

    expect(curve.series).toHaveLength(1)
    const series = curve.series[0]
    expect(series?.id).toBe('pk.concentration')
    expect(series?.seriesType).toBe('model')
    expect(series?.name).toBe('C(t)')
    expect(series?.points).toHaveLength(200)
    expect(series?.points[0]).toEqual({ x: 0, y: 100 }) // C(0) = C0
    expect(series?.points[series.points.length - 1]?.x).toBe(24)
    expect(curve.warnings).toBeUndefined()
  })

  it('honours the requested point count and range endpoints', () => {
    const curve = curveOf(
      generatePKCurve(input(), { range: { min: 2, max: 10, points: 9 } }),
    )
    const points = curve.series[0]?.points ?? []
    expect(points).toHaveLength(9)
    expect(points[0]?.x).toBe(2)
    expect(points[points.length - 1]?.x).toBe(10)
  })

  it('curve points equal the scalar calculation at the same t', () => {
    // 25 points over 0–24 h → every hour is sampled exactly.
    const curve = curveOf(
      generatePKCurve(input(), { range: { min: 0, max: 24, points: 25 } }),
    )
    for (const point of curve.series[0]?.points ?? []) {
      const scalar = calculateFirstOrderPK({
        c0: p(100, 'nM'),
        time: p(point.x, 'h'),
        halfLife: p(8, 'h'),
      })
      expect(scalar.ok).toBe(true)
      if (scalar.ok) expect(point.y).toBe(scalar.result.outputs[0]?.value)
    }
  })

  it('decays monotonically along the curve', () => {
    const curve = curveOf(generatePKCurve(input(), { range: { min: 0, max: 48, points: 50 } }))
    const points = curve.series[0]?.points ?? []
    for (let i = 1; i < points.length; i++) {
      expect(points[i]?.y).toBeLessThan(points[i - 1]?.y as number)
    }
  })

  it('supports a log time axis and echoes both scale options', () => {
    const curve = curveOf(
      generatePKCurve(input(), {
        range: { min: 0.1, max: 100, points: 40 },
        xScale: 'log',
        yScale: 'log',
      }),
    )
    expect(curve.xScale).toBe('log')
    expect(curve.yScale).toBe('log')
    const points = curve.series[0]?.points ?? []
    expect(points[0]?.x).toBe(0.1)
    expect(points[points.length - 1]?.x).toBe(100)
    for (let i = 1; i < points.length; i++) {
      expect(points[i]?.x).toBeGreaterThan(points[i - 1]?.x as number)
    }
  })
})

describe('generatePKCurve — errors', () => {
  it('requires an explicit range', () => {
    const errors = curveErrorsOf(generatePKCurve(input(), undefined as never))
    expect(errors[0]?.code).toBe('MISSING_PARAMETER')
    expect(errors[0]?.parameter).toBe('range')
  })

  it('rejects invalid ranges with the shared taxonomy', () => {
    expect(
      curveErrorsOf(generatePKCurve(input(), { range: { min: 10, max: 2 } }))[0]?.code,
    ).toBe('OUT_OF_RANGE')
    expect(
      curveErrorsOf(generatePKCurve(input(), { range: { min: -1, max: 10 } }))[0]?.code,
    ).toBe('OUT_OF_RANGE')
    expect(
      curveErrorsOf(generatePKCurve(input(), { range: { min: 0, max: 10 }, xScale: 'log' }))[0]
        ?.parameter,
    ).toBe('range.min')
    expect(
      curveErrorsOf(generatePKCurve(input(), { range: { min: Number.NaN, max: 10 } }))[0]?.code,
    ).toBe('NOT_A_NUMBER')
  })

  it('propagates model validation failures with the model id', () => {
    const broken: FirstOrderPKInput = {
      c0: p(100, 'nM'),
      time: p(0, 'h'),
      k: p(0, '1/h'), // zero rate is invalid
    }
    const result = generatePKCurve(broken, { range: { min: 0, max: 24 } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.model).toBe('pk.first-order-one-compartment')
      expect(result.errors[0]?.code).toBe('ZERO_NOT_ALLOWED')
    }
  })

  it('propagates non-finite model inputs', () => {
    const broken = { ...input(), c0: p(Number.NaN, 'nM') } as FirstOrderPKInput
    const result = generatePKCurve(broken, { range: { min: 0, max: 24 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.code).toBe('NOT_A_NUMBER')
  })
})

describe('generatePKCurve — numerical reporting', () => {
  it('flags underflowing points as curve warnings instead of hiding them', () => {
    // t½ = 1 µs: beyond the first sample every point underflows to 0.
    const curve = curveOf(
      generatePKCurve(
        { c0: p(100, 'nM'), time: p(0, 's'), halfLife: p(1e-6, 's') },
        { range: { min: 0, max: 2, points: 20 } },
      ),
    )
    const points = curve.series[0]?.points ?? []
    expect(points[0]?.y).toBe(100) // t = 0 is exact
    expect(points[points.length - 1]?.y).toBe(0)
    expect(curve.warnings?.map((w) => w.code)).toContain('NUMERICAL_UNDERFLOW')
    const warning = curve.warnings?.find((w) => w.code === 'NUMERICAL_UNDERFLOW')
    expect(warning?.message).toContain('19 of 20')
  })
})

describe('generatePKCurve — failure paths', () => {
  it('fails fast when the input type is malformed (missing halfLife/k)', () => {
    const result = generatePKCurve({ c0: p(1, 'nM'), time: p(0, 'h') } as never, {
      range: { min: 0, max: 1 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.code).toBe('MISSING_PARAMETER')
  })
})
