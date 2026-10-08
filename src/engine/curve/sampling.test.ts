import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CURVE_POINTS,
  MAX_CURVE_POINTS,
  MIN_CURVE_POINTS,
  buildXValues,
  checkLogYAxis,
  validateCurveOptions,
} from './sampling'
import type { CurvePoint } from '../types'

function check(options: Parameters<typeof validateCurveOptions>[0], xScale: 'linear' | 'log' = 'linear') {
  const result = validateCurveOptions(options, xScale)
  if (!result.ok) throw new Error(`expected options to be valid: ${result.errors.map((e) => e.code).join(', ')}`)
  return result.options
}

describe('validateCurveOptions', () => {
  it('requires an explicit range (the engine never invents a domain)', () => {
    const result = validateCurveOptions(undefined, 'linear')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['MISSING_PARAMETER'])
      expect(result.errors[0]?.parameter).toBe('range')
    }
  })

  it('applies documented defaults', () => {
    const options = check({ range: { min: 0, max: 24 } })
    expect(options.count).toBe(DEFAULT_CURVE_POINTS)
    expect(options.xScale).toBe('linear')
    expect(options.yScale).toBe('linear')
    const logged = check({ range: { min: 0.01, max: 100 } }, 'log')
    expect(logged.xScale).toBe('log')
    expect(check({ range: { min: 0, max: 10 }, yScale: 'log' }).yScale).toBe('log')
    expect(check({ range: { min: 1, max: 10 }, xScale: 'linear' }).xScale).toBe('linear')
    expect(check({ range: { min: 1, max: 10, points: 50 } }).count).toBe(50)
  })

  it('rejects non-finite bounds', () => {
    const result = validateCurveOptions(
      { range: { min: Number.NaN, max: Number.POSITIVE_INFINITY } },
      'linear',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(['NOT_A_NUMBER', 'NOT_A_NUMBER'])
  })

  it('rejects inverted or empty ranges', () => {
    for (const range of [
      { min: 5, max: 5 },
      { min: 9, max: 3 },
    ]) {
      const result = validateCurveOptions({ range }, 'linear')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors[0]?.code).toBe('OUT_OF_RANGE')
    }
  })

  it('rejects negative x bounds (time and concentration are non-negative)', () => {
    const result = validateCurveOptions({ range: { min: -1, max: 10 } }, 'linear')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['OUT_OF_RANGE'])
      expect(result.errors[0]?.parameter).toBe('range.min')
    }
  })

  it('requires a positive minimum on a log axis', () => {
    const result = validateCurveOptions({ range: { min: 0, max: 100 } }, 'log')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.parameter).toBe('range.min')

    const explicitLog = validateCurveOptions({ range: { min: 0, max: 100 }, xScale: 'log' }, 'linear')
    expect(explicitLog.ok).toBe(false)
  })

  it('rejects out-of-spec point counts', () => {
    for (const points of [0, 1, 2.5, -5, MAX_CURVE_POINTS + 1, Number.NaN, 'abc' as unknown as number]) {
      const result = validateCurveOptions({ range: { min: 0, max: 1, points } }, 'linear')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors[0]?.code).toBe('OUT_OF_RANGE')
        expect(result.errors[0]?.parameter).toBe('points')
      }
    }
    expect(MIN_CURVE_POINTS).toBe(2)
  })

  it('aggregates multiple problems in one pass', () => {
    const result = validateCurveOptions(
      { range: { min: -1, max: Number.NaN, points: 1 } },
      'linear',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveLength(3)
  })

  it('rejects unknown scale values from untyped callers', () => {
    // null/undefined mean "not provided" (?? default) — anything else must be linear | log.
    for (const scale of ['banana', '', 3, {}]) {
      const xResult = validateCurveOptions(
        { range: { min: 0, max: 10 }, xScale: scale as never },
        'linear',
      )
      expect(xResult.ok).toBe(false)
      if (!xResult.ok) expect(xResult.errors[0]?.parameter).toBe('xScale')

      const yResult = validateCurveOptions(
        { range: { min: 0, max: 10 }, yScale: scale as never },
        'linear',
      )
      expect(yResult.ok).toBe(false)
      if (!yResult.ok) expect(yResult.errors[0]?.parameter).toBe('yScale')
    }
  })
})

describe('buildXValues', () => {
  it('samples linearly with exact endpoints', () => {
    const values = buildXValues(check({ range: { min: 0, max: 10, points: 5 } }))
    expect(values).toEqual([0, 2.5, 5, 7.5, 10])
  })

  it('samples two points as exactly the range endpoints', () => {
    expect(buildXValues(check({ range: { min: 3, max: 7, points: 2 } }))).toEqual([3, 7])
  })

  it('samples logarithmically with exact endpoints and strict increase', () => {
    const options = check({ range: { min: 0.001, max: 1000, points: 7 } }, 'log')
    const values = buildXValues(options)
    expect(values[0]).toBe(0.001)
    expect(values[values.length - 1]).toBe(1000)
    // Powers of ten: 1e-3 … 1e3, one decade per step.
    const decades = [1e-3, 1e-2, 1e-1, 1, 10, 100, 1000]
    values.forEach((value, i) => expect(value).toBeCloseTo(decades[i] as number, 9))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1] as number)
    }
  })

  it('produces strictly increasing values for a dense linear range', () => {
    const values = buildXValues(check({ range: { min: 0, max: 1, points: 100 } }))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1] as number)
    }
  })
})

describe('checkLogYAxis — log y-axis validation', () => {
  const points = (...y: number[]): CurvePoint[] => y.map((value, i) => ({ x: i, y: value }))

  it('accepts a log y-axis when every y is strictly positive and finite', () => {
    expect(checkLogYAxis(points(0.5, 1, 12.4), 'log')).toBeUndefined()
  })

  it('never warns for a linear y-axis, whatever the y values are', () => {
    expect(checkLogYAxis(points(0, -5, Number.MIN_VALUE, Number.POSITIVE_INFINITY), 'linear')).toBeUndefined()
    expect(checkLogYAxis([], 'linear')).toBeUndefined()
  })

  it('warns — without touching the data — when zero-valued y meet a log y-axis', () => {
    const data = points(0, 1, 0)
    const warning = checkLogYAxis(data, 'log')
    expect(warning?.code).toBe('LOG_Y_AXIS_NOT_REPRESENTABLE')
    expect(warning?.severity).toBe('warning')
    expect(warning?.message).toContain('2 of 3')
    // The engine never removes or clamps points to satisfy an axis.
    expect(data).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }])
  })

  it('warns for negative y (a model convention may permit negative effects)', () => {
    const warning = checkLogYAxis(points(-100, -0.5, 50), 'log')
    expect(warning?.code).toBe('LOG_Y_AXIS_NOT_REPRESENTABLE')
    expect(warning?.message).toContain('2 of 3')
    expect(warning?.message).toContain('linear y-axis')
  })

  it('warns for non-finite y (overflowed points cannot be plotted either)', () => {
    const warning = checkLogYAxis(points(1, Number.POSITIVE_INFINITY), 'log')
    expect(warning?.code).toBe('LOG_Y_AXIS_NOT_REPRESENTABLE')
    expect(warning?.message).toContain('1 of 2')
  })

  it('treats an underflowed 0 exactly like a mathematical 0 — reported, never repaired', () => {
    // Both arrive as y = 0; the axis contract depends only on the value.
    expect(checkLogYAxis(points(0), 'log')?.code).toBe('LOG_Y_AXIS_NOT_REPRESENTABLE')
  })

  it('does not warn for an empty curve (no points, no axis conflict)', () => {
    expect(checkLogYAxis([], 'log')).toBeUndefined()
  })
})
