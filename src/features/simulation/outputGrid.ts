/**
 * Output-grid generation for the simulation scenario editor (phase 43).
 *
 * The engine requires an explicit, strictly ascending `outputTimes` array
 * (first element = startTime, last = endTime). The editor lets the user give
 * a start, an end and a uniform interval, and this pure helper expands them.
 *
 * Design rules:
 * - Times use integer multiplication (`t0 + i·Δ`), never repeated addition of
 *   a floating-point step, so rounding cannot accumulate.
 * - The start is exactly `startTime`; the end is exactly `endTime` and
 *   appears once, even when the interval does not divide the horizon.
 * - An over-large grid is REJECTED, never quietly thinned out or coarsened:
 *   silently changing the user's sampling interval would change what the
 *   report claims to show.
 * - These are observation times only. Solver step sizes and dosing-event
 *   times are independent of this grid; the engine inserts event boundaries.
 */

/** Documented maximum number of requested output times. */
export const MAX_OUTPUT_SAMPLES = 20000

export type OutputGridErrorCode =
  /** A field is not a finite number (blank, "abc", NaN, Infinity). */
  | 'NOT_A_NUMBER'
  /** The end time is not strictly after the start time. */
  | 'HORIZON_INVALID'
  /** The interval is zero or negative. */
  | 'INTERVAL_INVALID'
  /** The requested grid would contain more than MAX_OUTPUT_SAMPLES times. */
  | 'GRID_TOO_LARGE'

/** Form fields a grid error can belong to. */
export type OutputGridField = 'startTime' | 'endTime' | 'outputInterval'

export type OutputGridResult =
  | { readonly ok: true; readonly times: readonly number[] }
  | {
      readonly ok: false
      readonly code: OutputGridErrorCode
      /** Field the error belongs to. */
      readonly field: OutputGridField
      readonly message: string
    }

/** Strict numeric parse: '' and whitespace are not numbers (never 0). */
export function parseNumericText(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/**
 * Number of index steps before the end. Uses a relative slack so an interval
 * that divides the horizon mathematically (24 / 0.25) is not split by binary
 * representation error (0.25 is exact, but 0.1 is not).
 */
function indexCount(startTime: number, endTime: number, interval: number): number {
  const ratio = (endTime - startTime) / interval
  const nearest = Math.round(ratio)
  const tolerance = 1e-9 * Math.max(1, Math.abs(ratio))
  const steps = Math.abs(ratio - nearest) <= tolerance ? nearest : Math.floor(ratio)
  return Math.max(0, steps)
}

/**
 * Build the output grid for a uniform interval.
 *
 * @param startTime  first output time (h)
 * @param endTime    last output time (h); must be > startTime
 * @param interval   spacing (h); must be > 0
 */
export function buildOutputGrid(
  startTime: number,
  endTime: number,
  interval: number,
  maxSamples: number = MAX_OUTPUT_SAMPLES,
): OutputGridResult {
  const check = (field: OutputGridField, value: number, label: string) => {
    if (!Number.isFinite(value)) {
      return {
        ok: false as const,
        code: 'NOT_A_NUMBER' as const,
        field,
        message: `${label} must be a finite number.`,
      }
    }
    return null
  }
  const startError = check('startTime', startTime, 'Start time')
  if (startError) return startError
  const endError = check('endTime', endTime, 'End time')
  if (endError) return endError
  const intervalError = check('outputInterval', interval, 'Output interval')
  if (intervalError) return intervalError

  if (!(endTime > startTime)) {
    return {
      ok: false,
      code: 'HORIZON_INVALID',
      field: 'endTime',
      message: `End time (${endTime} h) must be greater than start time (${startTime} h).`,
    }
  }
  if (!(interval > 0)) {
    return {
      ok: false,
      code: 'INTERVAL_INVALID',
      field: 'outputInterval',
      message: `Output interval must be greater than 0 h (got ${interval} h).`,
    }
  }

  const steps = indexCount(startTime, endTime, interval)
  const count = steps + 1
  if (count > maxSamples) {
    return {
      ok: false,
      code: 'GRID_TOO_LARGE',
      field: 'outputInterval',
      message: `The requested grid would contain ${count} output times, more than the supported maximum of ${maxSamples}. Increase the output interval.`,
    }
  }

  const times: number[] = []
  for (let i = 0; i < count; i += 1) {
    const t = startTime + i * interval
    // Strictly ascending and inside the horizon; the exact end is appended
    // below when the interval does not land on it.
    if (t >= endTime) break
    if (times.length === 0 || t > (times[times.length - 1] ?? Number.NEGATIVE_INFINITY)) times.push(t)
  }
  // The start is always present, even when the first index rounds above it.
  if (times[0] !== startTime) times.unshift(startTime)
  // The end appears exactly once, as the exact requested value.
  times.push(endTime)
  return { ok: true, times }
}