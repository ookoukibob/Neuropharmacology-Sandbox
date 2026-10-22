/**
 * Output-grid generation for the simulation scenario editor (phase 43).
 *
 * The engine requires an explicit, strictly ascending `outputTimes` array
 * (first element = startTime, last = endTime). The editor lets the user give
 * a start, an end and a uniform interval, and this pure helper expands them.
 *
 * Numerical policy (documented, and what the tests pin):
 *
 * 1. **Integer indices.** A grid point is `startTime + i·Δ`, never a repeated
 *    addition of Δ, so representation error cannot accumulate along the grid.
 * 2. **Alignment is decided on the quotient.** `n = (endTime − startTime)/Δ`
 *    "lands on" the endpoint when `n` is within a few ULPs of an integer
 *    (`BOUNDARY_ULPS`, scaled by the magnitude of `n`). This is
 *    representational slack only. Deciding it on the quotient (rather than on
 *    times near the endpoint) keeps long horizons exact: at endTime = 20 000 h
 *    one ULP of the time value alone already exceeds a 1 h interval's slack.
 *    The slack is small enough that a genuine interior point (23.75 h on a
 *    0…24 h grid at 0.25 h) is never swallowed.
 * 3. **Aligned → the last index IS `endTime`.** The computed value is
 *    replaced by the exact endpoint, so the pair "computed end" and "exact
 *    end" can never appear together.
 * 4. **Not aligned → every index point strictly below `endTime`, then the
 *    exact `endTime` appended once.**
 * 5. **The count is decided before allocating.** `planGrid` fixes the length
 *    first; a grid above `maxSamples` is REJECTED. The grid is never thinned,
 *    coarsened or truncated to fit.
 *
 * These are observation times only. Solver step sizes and dosing-event times
 * are independent of this grid; the engine inserts event boundaries.
 */

/** Documented maximum number of requested output times. */
export const MAX_OUTPUT_SAMPLES = 20000

/** Alignment slack in ULPs of the interval count (representation slack only). */
export const BOUNDARY_ULPS = 8

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

export interface GridShape {
  /** Exact number of output times: decided before any allocation. */
  readonly count: number
  /** Index points (1 … interior) emitted strictly below the endpoint. */
  readonly interior: number
  /** Whether index `interior + 1` is the endpoint itself. */
  readonly aligned: boolean
}

/**
 * Decide the grid's shape before allocating it.
 *
 * - `whole = floor(span/Δ)` is the last index that could lie below the end.
 * - `nearEnd` is the distance (in interval units) from that quotient to the
 *   nearest whole number; when it is within the ULP slack, the grid lands on
 *   the endpoint.
 * - Aligned: indices 1…nearest−1 are interior, index `nearest` is the end.
 *   Not aligned: indices 1…whole are interior and the end is appended.
 */
export function planGrid(startTime: number, endTime: number, interval: number): GridShape {
  const ratio = (endTime - startTime) / interval
  const nearest = Math.round(ratio)
  const slack = BOUNDARY_ULPS * Number.EPSILON * Math.max(Math.abs(ratio), 1)
  const aligned = Math.abs(ratio - nearest) <= slack

  if (aligned) {
    const interior = Math.max(0, nearest - 1)
    return { count: 1 + interior + 1, interior, aligned: true }
  }
  const interior = Math.max(0, Math.floor(ratio))
  return { count: 1 + interior + 1, interior, aligned: false }
}

/**
 * Build the output grid for a uniform interval.
 *
 * @param startTime  first output time (h)
 * @param endTime    last output time (h); must be > startTime
 * @param interval   spacing (h); must be > 0
 * @param maxSamples inclusive maximum number of output times
 */
export function buildOutputGrid(
  startTime: number,
  endTime: number,
  interval: number,
  maxSamples: number = MAX_OUTPUT_SAMPLES,
): OutputGridResult {
  // Messages deliberately do NOT name the field: the form's error summary
  // renders the field label (with its notation symbol) from the shared metadata
  // and then this sentence, so repeating the name here would read twice.
  const check = (field: OutputGridField, value: number) => {
    if (!Number.isFinite(value)) {
      return {
        ok: false as const,
        code: 'NOT_A_NUMBER' as const,
        field,
        message: 'Must be a finite number.',
      }
    }
    return null
  }
  const startError = check('startTime', startTime)
  if (startError) return startError
  const endError = check('endTime', endTime)
  if (endError) return endError
  const intervalError = check('outputInterval', interval)
  if (intervalError) return intervalError

  if (!(endTime > startTime)) {
    return {
      ok: false,
      code: 'HORIZON_INVALID',
      field: 'endTime',
      message: `Must be later than the start time (start ${startTime} h, end ${endTime} h).`,
    }
  }
  if (!(interval > 0)) {
    return {
      ok: false,
      code: 'INTERVAL_INVALID',
      field: 'outputInterval',
      message: `Must be greater than 0 h (got ${interval} h).`,
    }
  }

  const plan = planGrid(startTime, endTime, interval)
  // The length is decided BEFORE allocating, and the endpoint counts: a grid
  // above the maximum is rejected, never thinned.
  if (plan.count > maxSamples) {
    return {
      ok: false,
      code: 'GRID_TOO_LARGE',
      field: 'outputInterval',
      message: `The requested grid would contain ${plan.count} output times, more than the supported maximum of ${maxSamples}. Increase the output interval.`,
    }
  }

  // Fill exactly `plan.count` slots: start, interior points, endpoint.
  const times: number[] = new Array<number>(plan.count)
  times[0] = startTime
  for (let i = 1; i <= plan.interior; i += 1) {
    times[i] = startTime + i * interval
  }
  times[plan.count - 1] = endTime
  return { ok: true, times }
}