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
