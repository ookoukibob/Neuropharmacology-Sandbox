/**
 * Small, honest normalizers for loosely-typed remote JSON.
 *
 * Remote payloads are `unknown` by construction: a source may change a
 * field's type without changing its API version. These helpers convert
 * only what the source actually supplied — a value that does not parse
 * stays absent rather than becoming `0`, `NaN` or an invented default.
 */

/** Non-empty string from a remote value, or undefined. */
export function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Finite number from a remote number or numeric string, or undefined. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Integer (e.g. a publication year) from a remote value, or undefined. */
export function intOf(value: unknown): number | undefined {
  const parsed = numberOf(value)
  if (parsed === undefined || !Number.isInteger(parsed)) return undefined
  return parsed
}

/** Unique, non-empty strings in first-seen order, capped at `limit`. */
export function uniqueStrings(values: readonly string[], limit: number): readonly string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (value.length === 0) continue
    if (seen.has(value)) continue
    seen.add(value)
    if (seen.size > limit) {
      seen.delete(value)
      break
    }
  }
  return [...seen]
}
