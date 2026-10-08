/**
 * Decimal helpers for the engine (ADR-6).
 *
 * Scalar arithmetic runs through Decimal.js so traces and results never show
 * binary floating-point artifacts (0.1 + 0.2 → 0.3, not 0.30000000000000004).
 * Every value that leaves the engine as a `number` passes through
 * `roundForReport`, which also detects the two ways a result can fall outside
 * the numeric range (underflow to 0, overflow to ±Infinity).
 */
import Decimal from 'decimal.js'
import type { CalculationWarning } from '../types'

/**
 * Reporting precision: significant decimal digits applied to outputs and
 * trace step results as the *last* step of a calculation. Chosen to absorb
 * unit-factor noise (~1e-16 from double factors such as 1/60) while keeping
 * traces readable. Computation itself runs at Decimal.js precision.
 */
export const REPORT_PRECISION_DIGITS = 12

/** ln(2), shared by the models that convert between k and t½. */
export const LN_TWO = new Decimal(2).ln()

export type RoundingLoss = 'none' | 'underflow' | 'overflow'

export interface RoundedNumber {
  readonly value: number
  /**
   * - `underflow`: the true value is non-zero but rounds to 0 as a double.
   *   Callers surface this as a NUMERICAL_UNDERFLOW warning.
   * - `overflow`: the value exceeds the double range and is reported as
   *   ±Infinity (never silently clamped).
   * - `none`: the double represents the rounded value faithfully.
   */
  readonly loss: RoundingLoss
}

export function roundForReport(value: Decimal): RoundedNumber {
  if (!value.isFinite()) {
    return {
      value: value.isNegative() ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      loss: 'overflow',
    }
  }
  const n = value.toSignificantDigits(REPORT_PRECISION_DIGITS).toNumber()
  if (!Number.isFinite(n)) return { value: n, loss: 'overflow' }
  if (n === 0) {
    return value.isZero() ? { value: 0, loss: 'none' } : { value: 0, loss: 'underflow' }
  }
  return { value: n, loss: 'none' }
}

/**
 * roundForReport for quantities that are mathematically non-zero by
 * construction regardless of arithmetic (e^(−k·t), r = EC50/[D] with both
 * > 0, r^n with r > 0).
 *
 * Decimal.js `exp`/`pow` can collapse such a value to an *exact* Decimal
 * zero (or ∞) once the result falls outside its own exponent range — before
 * `roundForReport` ever sees it, which would classify the collapse as a
 * faithful zero. This wrapper reclassifies an exact zero as `underflow`, so
 * a mathematically non-zero value can never be reported as a silently exact
 * 0, while genuine mathematical zeros still go through `roundForReport`
 * unchanged.
 */
export function roundNonZero(value: Decimal): RoundedNumber {
  if (value.isZero()) return { value: 0, loss: 'underflow' }
  return roundForReport(value)
}

/**
 * One consistent numerical-loss policy for every model: each reported value
 * (scalar output or trace step result) is checked for rounding loss, and each
 * loss becomes a structured warning naming the quantity. Mathematical zeros
 * (loss `'none'`) never warn — that is what keeps "exactly 0" distinguishable
 * from "non-zero but unrepresentable".
 *
 * `overflowHint` appends model-specific context to an overflow warning (for
 * example that the calculation continues through an exact limiting form).
 */
export function noteRoundingLoss(
  warnings: CalculationWarning[],
  rounded: RoundedNumber,
  what: string,
  overflowHint?: string,
): void {
  if (rounded.loss === 'underflow') {
    warnings.push({
      code: 'NUMERICAL_UNDERFLOW',
      severity: 'info',
      message: `${what} is mathematically non-zero but smaller than the numeric range; it is reported as 0.`,
    })
  } else if (rounded.loss === 'overflow') {
    warnings.push({
      code: 'NUMERICAL_OVERFLOW',
      severity: 'warning',
      message: `${what} exceeds the numeric range of the result; it is reported as ±Infinity.${
        overflowHint === undefined ? '' : ` ${overflowHint}`
      }`,
    })
  }
}

/**
 * Format a Decimal for trace substitution: 12 significant digits. Decimal
 * has a huge exponent range, so tiny values keep their exponential form
 * ("1e-400") instead of collapsing to 0 — substitution strings never lie
 * about an unrepresentable value.
 */
export function formatDecimal(value: Decimal): string {
  return value.toSignificantDigits(REPORT_PRECISION_DIGITS).toString()
}

/** Format a plain number for trace substitution (also normalizes -0). */
export function formatNumber(value: number): string {
  if (value === 0) return '0'
  return formatDecimal(new Decimal(value))
}

/** "12.4 nM"; dimensionless values print bare ("0.5", never "0.5 1"). */
export function formatQuantity(value: number | Decimal, unit: string): string {
  const text = value instanceof Decimal ? formatDecimal(value) : formatNumber(value)
  return unit === '1' || unit === '' ? text : `${text} ${unit}`
}
