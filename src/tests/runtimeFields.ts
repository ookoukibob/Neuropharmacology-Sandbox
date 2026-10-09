/**
 * Runtime field probing for extension (unknown-field) assertions in tests.
 *
 * Extension fields are, by definition, invisible to the compile-time types
 * — that is the whole point of the loose-schema contract. Tests therefore
 * read them through `unknown` with path segments instead of weakening any
 * production type or reaching for `any`.
 *
 * All fixtures used with this helper are synthetic test data.
 */
export function fieldAt(source: unknown, ...path: readonly string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
