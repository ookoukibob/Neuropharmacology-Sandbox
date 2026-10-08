/**
 * Shared assertions for engine reports. Kept out of the engine itself: these
 * are test helpers, not production code.
 */
import type { CalculationReport, CurveGenerationResult } from '../engine/types'

/** Assert a report succeeded and return its result (for further assertions). */
export function resultOf(report: CalculationReport) {
  if (!report.ok) {
    throw new Error(
      `expected calculation to succeed, got: ${report.errors
        .map((e) => `${e.code}(${e.parameter ?? '-'})`)
        .join(', ')}`,
    )
  }
  return report.result
}

/** Assert a report failed and return its errors. */
export function errorsOf(report: CalculationReport) {
  if (report.ok) throw new Error('expected calculation to fail, but it succeeded')
  return report.errors
}

/** Assert a curve request succeeded and return the CurveData. */
export function curveOf(result: CurveGenerationResult) {
  if (!result.ok) {
    throw new Error(
      `expected curve generation to succeed, got: ${result.errors
        .map((e) => `${e.code}(${e.parameter ?? '-'})`)
        .join(', ')}`,
    )
  }
  return result.curve
}

/** Assert a curve request failed and return its errors. */
export function curveErrorsOf(result: CurveGenerationResult) {
  if (result.ok) throw new Error('expected curve generation to fail, but it succeeded')
  return result.errors
}

/** All error codes of a failed report, for `expect(...).toContain(...)`. */
export function errorCodes(report: CalculationReport): string[] {
  return errorsOf(report).map((e) => e.code)
}

/** Warning codes of a successful report. */
export function warningCodes(report: CalculationReport): string[] {
  return resultOf(report).warnings.map((w) => w.code)
}
