import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT_SAMPLES, buildOutputGrid, parseNumericText } from './outputGrid'

/**
 * Output-grid helper: the contract is "integer indices, exact endpoints,
 * strictly ascending, and an explicit refusal instead of silent thinning".
 */

describe('parseNumericText', () => {
  it('treats blank and whitespace as no value (never 0)', () => {
    expect(parseNumericText('')).toBeNull()
    expect(parseNumericText('   ')).toBeNull()
  })

  it('parses finite numbers and rejects everything else', () => {
    expect(parseNumericText(' 2.5 ')).toBe(2.5)
    expect(parseNumericText('-3')).toBe(-3)
    expect(parseNumericText('1e-10')).toBe(1e-10)
    expect(parseNumericText('abc')).toBeNull()
    expect(parseNumericText('NaN')).toBeNull()
    expect(parseNumericText('Infinity')).toBeNull()
  })
})

describe('buildOutputGrid', () => {
  it('includes both endpoints for a divisible horizon', () => {
    const grid = buildOutputGrid(0, 24, 0.25)
    expect(grid.ok).toBe(true)
    if (!grid.ok) return
    expect(grid.times).toHaveLength(97)
    expect(grid.times[0]).toBe(0)
    expect(grid.times.at(-1)).toBe(24)
    expect(grid.times[1]).toBe(0.25)
  })

  it('appends the exact end once when the interval does not divide the horizon', () => {
    const grid = buildOutputGrid(0, 10, 3)
    expect(grid.ok).toBe(true)
    if (!grid.ok) return
    expect(grid.times).toEqual([0, 3, 6, 9, 10])
    // The end is present exactly once.
    expect(grid.times.filter((t) => t === 10)).toHaveLength(1)
  })

  it('starts exactly at a non-zero start time and stays inside the horizon', () => {
    const grid = buildOutputGrid(1.5, 8, 2)
    expect(grid.ok).toBe(true)
    if (!grid.ok) return
    expect(grid.times[0]).toBe(1.5)
    expect(grid.times.at(-1)).toBe(8)
    for (const time of grid.times) {
      expect(time).toBeGreaterThanOrEqual(1.5)
      expect(time).toBeLessThanOrEqual(8)
    }
  })

  it('uses integer indices so 0.1 steps do not drift', () => {
    const grid = buildOutputGrid(0, 1, 0.1)
    expect(grid.ok).toBe(true)
    if (!grid.ok) return
    // 0.1 is not exact in binary; index multiplication keeps values stable
    // and the list strictly ascending.
    expect(grid.times).toHaveLength(11)
    for (let i = 1; i < grid.times.length; i += 1) {
      expect(grid.times[i]!).toBeGreaterThan(grid.times[i - 1]!)
    }
    expect(grid.times[3]).toBe(0 + 3 * 0.1)
  })

  it('keeps the list strictly ascending for a horizon that lands on a boundary', () => {
    // 0 + 3·0.7 = 2.0999999999999996 < 2.1, so the third step is included and
    // the exact end 2.1 is appended: strictly ascending, no duplicate.
    const grid = buildOutputGrid(0, 2.1, 0.7)
    expect(grid.ok).toBe(true)
    if (!grid.ok) return
    expect(grid.times).toEqual([0, 0.7, 1.4, 0 + 3 * 0.7, 2.1])
    for (let i = 1; i < grid.times.length; i += 1) {
      expect(grid.times[i]!).toBeGreaterThan(grid.times[i - 1]!)
    }
  })

  it('rejects non-finite inputs and names the field', () => {
    const nan = buildOutputGrid(Number.NaN, 24, 1)
    expect(nan.ok).toBe(false)
    if (!nan.ok) expect(nan.field).toBe('startTime')
    const inf = buildOutputGrid(0, Number.POSITIVE_INFINITY, 1)
    expect(inf.ok).toBe(false)
    if (!inf.ok) expect(inf.code).toBe('NOT_A_NUMBER')
  })

  it('rejects an end time at or before the start time', () => {
    const equal = buildOutputGrid(5, 5, 1)
    expect(equal.ok).toBe(false)
    if (!equal.ok) expect(equal.code).toBe('HORIZON_INVALID')
    const backwards = buildOutputGrid(10, 2, 1)
    expect(backwards.ok).toBe(false)
    if (!backwards.ok) {
      expect(backwards.code).toBe('HORIZON_INVALID')
      expect(backwards.field).toBe('endTime')
    }
  })

  it('rejects a zero or negative interval', () => {
    for (const interval of [0, -1]) {
      const grid = buildOutputGrid(0, 24, interval)
      expect(grid.ok).toBe(false)
      if (!grid.ok) expect(grid.code).toBe('INTERVAL_INVALID')
    }
  })

  it('accepts exactly the maximum grid size and rejects one more', () => {
    const atLimit = buildOutputGrid(0, MAX_OUTPUT_SAMPLES - 1, 1)
    expect(atLimit.ok).toBe(true)
    if (atLimit.ok) expect(atLimit.times).toHaveLength(MAX_OUTPUT_SAMPLES)
    const overLimit = buildOutputGrid(0, MAX_OUTPUT_SAMPLES, 1)
    expect(overLimit.ok).toBe(false)
    if (!overLimit.ok) {
      expect(overLimit.code).toBe('GRID_TOO_LARGE')
      // The interval is never silently changed to fit.
      expect(overLimit.message).toContain('Increase the output interval')
    }
  })

  it('honours a caller-supplied maximum (used by tests, documented default otherwise)', () => {
    const grid = buildOutputGrid(0, 10, 1, 5)
    expect(grid.ok).toBe(false)
    if (!grid.ok) expect(grid.code).toBe('GRID_TOO_LARGE')
  })
})
