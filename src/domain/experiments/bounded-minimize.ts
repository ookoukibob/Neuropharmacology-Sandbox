/**
 * Deterministic bounded one-dimensional minimisation shared by the
 * experimental fits (phases 47B and 47C).
 *
 * Golden-section search is a bracketing method: it assumes the supplied
 * interval contains a single minimum. Both callers establish that bracket with
 * a deterministic coarse scan over the whole documented rate range and then
 * refine only inside the bracket around the best scanned point, so the
 * assumption is explicit and the result is reproducible.
 *
 * The returned point is the midpoint of the final bracket and `value` is the
 * objective re-evaluated there — never a scanned value carried over as if it
 * were refined.
 */

/** Relative tolerance on the bracket width, and the iteration cap. */
export const REFINE_RELATIVE_TOLERANCE = 1e-12
export const REFINE_MAX_ITERATIONS = 200

export interface BoundedMinimum {
  readonly x: number
  readonly value: number
}

/**
 * Minimise `f` on `[lo, hi]`.
 *
 * `f` must return a finite value for every point in the bracket; callers that
 * can produce non-finite values must substitute an explicit sentinel and check
 * the returned `value` themselves.
 */
export function goldenSectionMinimize(
  f: (x: number) => number,
  lo: number,
  hi: number,
): BoundedMinimum {
  const invPhi = (Math.sqrt(5) - 1) / 2
  let a = lo
  let b = hi
  let c = b - invPhi * (b - a)
  let d = a + invPhi * (b - a)
  let fc = f(c)
  let fd = f(d)
  for (let i = 0; i < REFINE_MAX_ITERATIONS; i += 1) {
    if (Math.abs(b - a) <= REFINE_RELATIVE_TOLERANCE * (Math.abs(a) + Math.abs(b) + 1e-300)) break
    if (fc <= fd) {
      b = d
      d = c
      fd = fc
      c = b - invPhi * (b - a)
      fc = f(c)
    } else {
      a = c
      c = d
      fc = fd
      d = a + invPhi * (b - a)
      fd = f(d)
    }
  }
  const x = (a + b) / 2
  return { x, value: f(x) }
}
