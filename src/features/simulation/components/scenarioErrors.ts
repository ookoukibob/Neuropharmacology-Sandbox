import type { DraftError } from '../draft'

/**
 * First message per draft field, for inline display next to the control. The
 * full list stays in the form-level error summary.
 */
export function errorMessages(errors: readonly DraftError[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const error of errors) if (!map.has(error.field)) map.set(error.field, error.message)
  return map
}
