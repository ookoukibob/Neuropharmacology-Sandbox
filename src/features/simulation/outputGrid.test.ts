import { describe, expect, it } from 'vitest'
import {
  BOUNDARY_ULPS,
  MAX_OUTPUT_SAMPLES,
  buildOutputGrid,
  parseNumericText,
  planGrid,
} from './outputGrid'

/**
 * Output-grid contract (phase 43): exact endpoints, no near-duplicate
 * endpoint created by representation error, strictly ascending times, and an
 * explicit refusal instead of silent thinning. Expected lengths and values
 * below are computed by hand from the stated rule, never read back from the
 * implementation.
 */

const okTimes = (result: ReturnType<typeof buildOutputGrid>): readonly number[] => {
  if (!result.ok) throw new Error('expected a grid, received ' + result.code)
  return result.times
}

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

describe('buildOutputGrid — endpoints and alignment', () => {
  it('includes both endpoints for a divisible horizon', () => {
    const times = okTimes(buildOutputGrid(0, 24, 0.25))
    expect(times).toHaveLength(97)
    expect(times[0]).toBe(0)
    expect(times.at(-1)).toBe(24)
    expect(times[1]).toBe(0.25)
  })

  it('keeps the genuine interior point 23.75 on a divisible 0..24 h grid (interval 0.25 h)', () => {
    const times = okTimes(buildOutputGrid(0, 24, 0.25))
    // The endpoint is mathematically reached at index 96; index 95 (23.75 h)
    // is a real observation point and must not be mistaken for the end.
    expect(times).toContain(23.75)
    expect(times.slice(-3)).toEqual([23.5, 23.75, 24])
  })

  it('replaces the near-duplicate endpoint instead of appending it (0..2.1 h, 0.7 h)', () => {
    const times = okTimes(buildOutputGrid(0, 2.1, 0.7))
    expect(times).toHaveLength(4)
    expect(times).toEqual([0, 0.7, 1.4, 2.1])
    // The computed index value 0 + 3*0.7 = 2.0999999999999996 must not appear
    // as a second point next to the exact endpoint.
    expect(times).not.toContain(0 + 3 * 0.7)
    expect(times.filter((t) => t === 2.1)).toHaveLength(1)
  })

  it('appends the exact end once when the interval does not divide the horizon', () => {
    const times = okTimes(buildOutputGrid(0, 10, 3))
    expect(times).toHaveLength(5)
    expect(times).toEqual([0, 3, 6, 9, 10])
    expect(times.filter((t) => t === 10)).toHaveLength(1)
  })

  it('starts exactly at a non-zero start time and stays inside the horizon', () => {
    const times = okTimes(buildOutputGrid(1.5, 8, 2))
    expect(times).toHaveLength(5)
    expect(times[0]).toBe(1.5)
    expect(times.at(-1)).toBe(8)
    expect(times).toEqual([1.5, 3.5, 5.5, 7.5, 8])
  })

  it('uses integer indices so 0.1 steps do not drift', () => {
    const times = okTimes(buildOutputGrid(0, 1, 0.1))
    expect(times).toHaveLength(11)
    expect(times[3]).toBe(0 + 3 * 0.1)
    expect(times.at(-1)).toBe(1)
    for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeGreaterThan(times[i - 1]!)
  })

  it('handles a long horizon aligned at its boundary without losing a sample', () => {
    const times = okTimes(buildOutputGrid(1, 20000, 1))
    // 1, 2, … 19999, 20000 → 20 000 points, exactly at the default limit.
    expect(times).toHaveLength(20000)
    expect(times[0]).toBe(1)
    expect(times.at(-1)).toBe(20000)
    expect(times.slice(-3)).toEqual([19998, 19999, 20000])
    expect(times.filter((t) => t === 20000)).toHaveLength(1)
  })
})

describe('buildOutputGrid — sample limit counts the endpoint', () => {
  it('rejects a non-divisible horizon whose endpoint pushes the count over the limit', () => {
    // 0, 1, 2, 3, 4 + the exact 4.5 → six points, one more than five.
    const result = buildOutputGrid(0, 4.5, 1, 5)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('GRID_TOO_LARGE')
    expect(result.field).toBe('outputInterval')
    expect(result.message).toContain('6')
  })

  it('accepts a non-divisible grid that exactly reaches the limit', () => {
    const result = buildOutputGrid(0, 3.5, 1, 5)
    const times = okTimes(result)
    expect(times).toHaveLength(5)
    expect(times).toEqual([0, 1, 2, 3, 3.5])
  })

  it('rejects that same non-divisible grid one sample over the limit', () => {
    const result = buildOutputGrid(0, 3.5, 1, 4)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('GRID_TOO_LARGE')
    expect(result.message).toContain('5')
  })

  it('accepts exactly the default maximum and rejects one more', () => {
    const atLimit = okTimes(buildOutputGrid(0, MAX_OUTPUT_SAMPLES - 1, 1))
    expect(atLimit).toHaveLength(MAX_OUTPUT_SAMPLES)
    const over = buildOutputGrid(0, MAX_OUTPUT_SAMPLES, 1)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.code).toBe('GRID_TOO_LARGE')
  })
})

describe('buildOutputGrid — invariants across a range of inputs', () => {
  const starts = [0, 1, 2.5, 100]
  const horizons = [3, 24, 100.5]
  const intervals = [0.1, 0.25, 0.5, 1, 3, 7]

  it('every successful grid is bounded, anchored and strictly ascending', () => {
    for (const startTime of starts) {
      for (const horizon of horizons) {
        for (const interval of intervals) {
          const endTime = startTime + horizon
          const result = buildOutputGrid(startTime, endTime, interval)
          if (!result.ok) {
            // The only acceptable failure here is an explicit size refusal.
            expect(['GRID_TOO_LARGE', 'INTERVAL_INVALID', 'HORIZON_INVALID']).toContain(result.code)
            continue
          }
          const times = result.times
          expect(times.length).toBeGreaterThanOrEqual(2)
          expect(times.length).toBeLessThanOrEqual(MAX_OUTPUT_SAMPLES)
          expect(times[0]).toBe(startTime)
          expect(times[times.length - 1]).toBe(endTime)
          for (let i = 1; i < times.length; i += 1) {
            expect(times[i]!).toBeGreaterThan(times[i - 1]!)
          }
          // No near-duplicate of the endpoint: the endpoint occurs once and
          // nothing else sits within the alignment slack of it.
          expect(times.filter((t) => t === endTime)).toHaveLength(1)
          const slack = BOUNDARY_ULPS * Number.EPSILON * Math.max(Math.abs((endTime - startTime) / interval), 1) * interval
          const near = times.filter((t) => t !== endTime && Math.abs(t - endTime) <= slack)
          expect(near).toEqual([])
        }
      }
    }
  })

  it('never returns more than the configured maximum for any maxSamples', () => {
    for (const maxSamples of [2, 3, 5, 10, 97, 20000]) {
      const result = buildOutputGrid(0, 24, 0.25, maxSamples)
      if (result.ok) expect(result.times.length).toBeLessThanOrEqual(maxSamples)
      else expect(result.code).toBe('GRID_TOO_LARGE')
    }
  })

  it('reports the planned count the limit is applied to', () => {
    // planGrid is the single authority for the length.
    // 96 intervals in 0..24 at 0.25: indices 1…95 (0.25 … 23.75) are
    // interior, index 96 is the endpoint — 97 times in total.
    expect(planGrid(0, 24, 0.25)).toEqual({ count: 97, interior: 95, aligned: true })
    // 3.33 intervals: indices 1…3 (3, 6, 9) are interior, 10 is appended.
    expect(planGrid(0, 10, 3)).toEqual({ count: 5, interior: 3, aligned: false })
    // 3 intervals to 2.1 (within slack): indices 1…2 (0.7, 1.4), index 3 is the end.
    expect(planGrid(0, 2.1, 0.7)).toEqual({ count: 4, interior: 2, aligned: true })
    // 4.5 intervals: indices 1…4 (1…4), 4.5 is appended — six times, which is
    // why a limit of five must reject this grid.
    expect(planGrid(0, 4.5, 1)).toEqual({ count: 6, interior: 4, aligned: false })
  })
})

describe('buildOutputGrid — invalid input', () => {
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
    if (!backwards.ok) expect(backwards.field).toBe('endTime')
  })

  it('rejects a zero or negative interval', () => {
    for (const interval of [0, -1]) {
      const grid = buildOutputGrid(0, 24, interval)
      expect(grid.ok).toBe(false)
      if (!grid.ok) expect(grid.code).toBe('INTERVAL_INVALID')
    }
  })
})
