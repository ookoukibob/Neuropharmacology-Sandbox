/**
 * Shared curve sampling: x-range validation and x-value generation.
 *
 * Independent of Plotly and of any model — generators pass their validated
 * model inputs through this, then evaluate the model at each sampled x.
 * Doubles are used for sampling (visualization, per ADR-6); every *reported*
 * y-value still comes from the model's Decimal path, so a curve point at x
 * equals the scalar calculation at the same x.
 */
import type { CalculationError, CalculationWarning, CurvePoint } from '../types'

export const MIN_CURVE_POINTS = 2
export const DEFAULT_CURVE_POINTS = 200
export const MAX_CURVE_POINTS = 5000

export interface CurveRange {
  readonly min: number
  readonly max: number
  /** Sample count; defaults to DEFAULT_CURVE_POINTS. */
  readonly points?: number
}

export interface CurveOptions {
  /**
   * Required: the engine never invents a plotting domain. The x-axis is time
   * or concentration for every MVP model, so min/max must be finite and ≥ 0.
   */
  readonly range: CurveRange
  /** Defaults per model: linear for PK, log for concentration axes. */
  readonly xScale?: 'linear' | 'log'
  readonly yScale?: 'linear' | 'log'
}

export interface ValidatedCurveOptions {
  readonly min: number
  readonly max: number
  readonly count: number
  readonly xScale: 'linear' | 'log'
  readonly yScale: 'linear' | 'log'
}

export type CurveOptionsCheck =
  | { readonly ok: true; readonly options: ValidatedCurveOptions }
  | { readonly ok: false; readonly errors: readonly CalculationError[] }

/**
 * Validate curve options for a model whose x-axis is non-negative
 * (time or concentration). Aggregates all problems, using the same error
 * taxonomy as scalar calculations.
 */
export function validateCurveOptions(
  options: CurveOptions | undefined,
  defaultXScale: 'linear' | 'log',
): CurveOptionsCheck {
  const errors: CalculationError[] = []
  const range = options?.range
  if (range === undefined) {
    errors.push({
      code: 'MISSING_PARAMETER',
      parameter: 'range',
      message: 'A curve range (min, max) is required; the engine never invents a plotting domain.',
    })
    return { ok: false, errors }
  }

  const { min, max, points } = range
  if (!Number.isFinite(min)) {
    errors.push({
      code: 'NOT_A_NUMBER',
      parameter: 'range.min',
      message: `range.min must be a finite number (got ${String(min)}).`,
    })
  }
  if (!Number.isFinite(max)) {
    errors.push({
      code: 'NOT_A_NUMBER',
      parameter: 'range.max',
      message: `range.max must be a finite number (got ${String(max)}).`,
    })
  }
  if (Number.isFinite(min) && Number.isFinite(max) && min >= max) {
    errors.push({
      code: 'OUT_OF_RANGE',
      parameter: 'range',
      message: `range.min (${min}) must be less than range.max (${max}).`,
    })
  }
  if (Number.isFinite(min) && min < 0) {
    errors.push({
      code: 'OUT_OF_RANGE',
      parameter: 'range.min',
      message: 'The model x-axis (time or concentration) cannot be negative.',
    })
  }

  const xScale = options?.xScale ?? defaultXScale
  if (xScale !== 'linear' && xScale !== 'log') {
    errors.push({
      code: 'OUT_OF_RANGE',
      parameter: 'xScale',
      message: `xScale must be "linear" or "log" (got ${JSON.stringify(xScale)}).`,
    })
  }
  if (xScale === 'log' && Number.isFinite(min) && min <= 0) {
    errors.push({
      code: 'OUT_OF_RANGE',
      parameter: 'range.min',
      message: 'A log x-axis requires range.min > 0.',
    })
  }

  const yScale = options?.yScale ?? 'linear'
  if (yScale !== 'linear' && yScale !== 'log') {
    errors.push({
      code: 'OUT_OF_RANGE',
      parameter: 'yScale',
      message: `yScale must be "linear" or "log" (got ${JSON.stringify(yScale)}).`,
    })
  }

  let count = DEFAULT_CURVE_POINTS
  if (points !== undefined) {
    if (!Number.isInteger(points) || points < MIN_CURVE_POINTS || points > MAX_CURVE_POINTS) {
      errors.push({
        code: 'OUT_OF_RANGE',
        parameter: 'points',
        message: `points must be an integer between ${MIN_CURVE_POINTS} and ${MAX_CURVE_POINTS} (got ${String(points)}).`,
      })
    } else {
      count = points
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    options: { min, max, count, xScale, yScale },
  }
}

/**
 * Post-sampling log y-axis check.
 *
 * Valid model input legitimately produces y ≤ 0: baseline zeros (E = E0 at
 * [D] = 0 with E0 = 0), underflowed points reported as 0, negative effects
 * (signed E0/Emax conventions), C0 = 0. A logarithmic axis cannot represent
 * any of those, but the science must not be edited to satisfy a chart:
 * points are never removed, clamped or recomputed here. Instead the engine
 * reports one structured warning so the chart layer can reject the log axis
 * or fall back to linear with an explicit message. Linear y-axes never warn.
 */
export function checkLogYAxis(
  points: readonly CurvePoint[],
  yScale: 'linear' | 'log',
): CalculationWarning | undefined {
  if (yScale !== 'log') return undefined
  let count = 0
  for (const point of points) {
    if (!Number.isFinite(point.y) || point.y <= 0) count++
  }
  if (count === 0) return undefined
  return {
    code: 'LOG_Y_AXIS_NOT_REPRESENTABLE',
    severity: 'warning',
    message: `A logarithmic y-axis cannot represent ${count} of ${points.length} sampled points (y ≤ 0 or non-finite). The curve data is reported unchanged; use a linear y-axis for this curve.`,
  }
}

/**
 * Sample the x-axis: evenly spaced for linear, evenly spaced in log space for
 * log. Endpoints are pinned to the requested min/max so declared ranges are
 * exact despite floating-point drift.
 */
export function buildXValues(options: ValidatedCurveOptions): number[] {
  const { min, max, count, xScale } = options
  const values: number[] = []
  const denominator = count - 1
  for (let i = 0; i < count; i++) {
    const fraction = i / denominator
    values.push(
      xScale === 'log' ? min * Math.pow(max / min, fraction) : min + (max - min) * fraction,
    )
  }
  values[0] = min
  values[values.length - 1] = max
  return values
}
