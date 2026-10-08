/**
 * Logarithmic y-axis contract (Phase 2 hardening).
 *
 * A log y-axis cannot represent 0, negative or non-finite values — but valid
 * model input legitimately produces all three (baseline zeros, signed effect
 * conventions, underflowed points). The engine's rule: never remove, clamp or
 * recompute a scientific result to satisfy an axis; report the axis conflict
 * as one structured warning and leave the curve data byte-identical to the
 * linear-axis run, so the chart layer can reject or fall back explicitly.
 */
import { describe, expect, it } from 'vitest'
import { curveOf } from '../../tests/report'
import { generateHillCurve } from '../dose-response/curve'
import type { HillResponseInput } from '../dose-response/model'
import { generateOccupancyCurve } from '../occupancy/curve'
import type { ReceptorOccupancyInput } from '../occupancy/model'
import { generatePKCurve } from '../pk/curve'
import type { FirstOrderPKInput } from '../pk/model'
import { DEFAULT_CURVE_POINTS } from './sampling'

const p = (value: number, unit: string) => ({ value, unit })

const pk = (c0: number): FirstOrderPKInput => ({
  c0: p(c0, 'nM'),
  time: p(12, 'h'),
  halfLife: p(8, 'h'),
})

const occupancy = (): ReceptorOccupancyInput => ({
  concentration: p(10, 'nM'),
  kd: p(10, 'nM'),
})

const hill = (e0: number, emax: number): HillResponseInput => ({
  e0: p(e0, '%'),
  emax: p(emax, '%'),
  ec50: p(1, 'nM'),
  hillCoefficient: p(2, '1'),
  concentration: p(1, 'nM'),
})

const logYCodes = (result: ReturnType<typeof generateHillCurve> | ReturnType<typeof generatePKCurve>) =>
  curveOf(result).warnings?.map((w) => w.code) ?? []

describe('log y-axis — valid strictly positive curve', () => {
  it('renders silently when every point is > 0 (occupancy fraction)', () => {
    const curve = curveOf(
      generateOccupancyCurve(occupancy(), { range: { min: 1e-2, max: 1e3, points: 50 }, yScale: 'log' }),
    )
    expect(curve.yScale).toBe('log')
    const points = curve.series[0]?.points ?? []
    expect(points.every((point) => Number.isFinite(point.y) && point.y > 0)).toBe(true)
    expect(curve.warnings).toBeUndefined()
  })

  it('renders silently for a Hill curve with a positive baseline', () => {
    const curve = curveOf(
      generateHillCurve(hill(1, 99), { range: { min: 1e-3, max: 1e3, points: 50 }, yScale: 'log' }),
    )
    expect(curve.warnings).toBeUndefined()
    expect(curve.series[0]?.points.every((point) => point.y > 0)).toBe(true)
  })
})

describe('log y-axis — zero-valued y', () => {
  it('warns and keeps every zero point when C0 = 0 (a mathematical zero)', () => {
    const logRun = curveOf(
      generatePKCurve(pk(0), { range: { min: 0, max: 24, points: 10 }, yScale: 'log' }),
    )
    expect(logRun.warnings?.map((w) => w.code)).toEqual(['LOG_Y_AXIS_NOT_REPRESENTABLE'])
    expect(logRun.warnings?.[0]?.message).toContain('10 of 10')
    expect(logRun.series[0]?.points).toHaveLength(10)
    expect(logRun.series[0]?.points.every((point) => point.y === 0)).toBe(true)

    // …and C0 = 0 stays a mathematical zero: no numerical-loss warning.
    expect(logRun.warnings?.map((w) => w.code)).not.toContain('NUMERICAL_UNDERFLOW')
  })

  it('warns when the Hill baseline puts the first point exactly at 0', () => {
    const logRun = curveOf(
      generateHillCurve(hill(0, 100), {
        range: { min: 0, max: 10, points: 11 },
        xScale: 'linear',
        yScale: 'log',
      }),
    )
    expect(logRun.warnings?.map((w) => w.code)).toContain('LOG_Y_AXIS_NOT_REPRESENTABLE')
    expect(logRun.series[0]?.points[0]).toEqual({ x: 0, y: 0 }) // E(0) = E0 = 0, preserved
  })
})

describe('log y-axis — negative y where the model permits them', () => {
  it('warns and preserves negative effects (signed E0/Emax convention)', () => {
    const options = { range: { min: 1e-3, max: 1e3, points: 41 }, yScale: 'log' as const }
    const logRun = curveOf(generateHillCurve(hill(-100, 200), options))
    const linearRun = curveOf(generateHillCurve(hill(-100, 200), { ...options, yScale: 'linear' as const }))

    expect(logRun.warnings?.map((w) => w.code)).toContain('LOG_Y_AXIS_NOT_REPRESENTABLE')
    expect(
      logRun.warnings?.find((w) => w.code === 'LOG_Y_AXIS_NOT_REPRESENTABLE')?.message,
    ).toContain('linear y-axis')
    // The negative values are still there — nothing was clipped away.
    expect(logRun.series[0]?.points[0]?.y).toBeLessThan(0)
    expect(logRun.series[0]?.points.filter((point) => point.y < 0).length).toBeGreaterThan(0)
    expect(logRun.series[0]?.points).toEqual(linearRun.series[0]?.points)
  })
})

describe('log y-axis — underflowed points', () => {
  it('treats underflow-to-0 points as axis conflicts without altering them', () => {
    const options = { range: { min: 1e-300, max: 1, points: 20 }, yScale: 'log' as const }
    const logRun = curveOf(generateHillCurve(hill(0, 100), options))
    const linearRun = curveOf(generateHillCurve(hill(0, 100), { ...options, yScale: 'linear' as const }))

    const codes = logRun.warnings?.map((w) => w.code) ?? []
    expect(codes).toContain('NUMERICAL_UNDERFLOW') // the scientific warning stays
    expect(codes).toContain('LOG_Y_AXIS_NOT_REPRESENTABLE') // and the axis conflict is added
    expect(logRun.series[0]?.points).toEqual(linearRun.series[0]?.points) // data untouched
    expect(logRun.series[0]?.points.some((point) => point.y === 0)).toBe(true)
  })
})

describe('log y-axis — linear behavior is unchanged', () => {
  it('emits no axis warning for the same curves on a linear y-axis', () => {
    const linear = { yScale: 'linear' as const }
    expect(logYCodes(generateHillCurve(hill(-100, 200), { range: { min: 1e-3, max: 1e3 }, ...linear })))
      .not.toContain('LOG_Y_AXIS_NOT_REPRESENTABLE')
    expect(logYCodes(generatePKCurve(pk(0), { range: { min: 0, max: 24 }, ...linear })))
      .not.toContain('LOG_Y_AXIS_NOT_REPRESENTABLE')
    expect(
      curveOf(generateOccupancyCurve(occupancy(), { range: { min: 1e-2, max: 1e3 }, ...linear })).warnings,
    ).toBeUndefined()
  })

  it('keeps the default y-axis linear and the default point count intact', () => {
    const curve = curveOf(generateHillCurve(hill(0, 100), { range: { min: 1e-3, max: 1e3 } }))
    expect(curve.yScale).toBe('linear')
    expect(curve.series[0]?.points).toHaveLength(DEFAULT_CURVE_POINTS)
    expect(curve.warnings).toBeUndefined()
  })
})
