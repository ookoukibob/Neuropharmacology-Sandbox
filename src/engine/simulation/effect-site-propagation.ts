/**
 * Effect-site PROPAGATION over emitted PK samples (phase 46).
 *
 * Pure numerical primitive: no I/O, no storage, no React, no mutable state.
 * It consumes the PK series the engine already emits and reports an
 * effect-site concentration for every sample, preserving order and side.
 *
 * Model (see ./effect-site.ts for validation and occupancy):
 *
 *   dCe/dt = ke0·(Cu − Ce),   Cu = fu·Cc
 *
 * NUMERICAL CONTRACT — read before relying on a result:
 *
 * - Between two adjacent PK output samples, Cu is RECONSTRUCTED as a
 *   piecewise-linear function of time. That is an approximation of the PK
 *   trajectory between output samples, not a claim that the true trajectory is
 *   linear.
 * - With r = −expm1(−x), x = ke0·h, phi(x) = 1 − r/x, the exact solution of
 *   the ODE under THAT reconstruction is
 *
 *       Ce1 = Ce0·e^(−x) + u0·(r − phi(x)) + u1·phi(x)
 *
 *   This is exact for the reconstructed input. It is NOT numerically identical
 *   to jointly integrating the PK and effect-site ODEs; the difference is the
 *   reconstruction error, which shrinks as the PK output interval shrinks
 *   (see the convergence tests).
 * - h = 0 (a dosing event's pre-event and post-event samples share a time)
 *   keeps Ce unchanged. Ce is continuous across a bolus: the bolus changes Cc,
 *   and therefore the slope of the reconstruction that follows, but never jumps
 *   the effect-site state.
 * - Ce is a concentration, never a drug amount: it is not part of the PK
 *   mass-balance accounting.
 */
import type { SimulationError } from './types'

/** One PK output sample, as far as propagation is concerned. */
export interface EffectSiteSample {
  readonly time: number
  /** Central concentration in the PK concentration unit (mg/L). */
  readonly centralConcentration: number
  /** The sample's original identity, copied through untouched. */
  readonly side: string
  readonly eventGroup?: string
}

export interface PropagateEffectSiteInput<TSample extends EffectSiteSample> {
  /** Samples in the order the engine emitted them (chronological). */
  readonly samples: readonly TSample[]
  /** Unbound fraction fu, dimensionless (0, 1] — already validated. */
  readonly unboundFraction: number
  /** Equilibration rate ke0 in inverse time units (h⁻¹) — already validated. */
  readonly ke0: number
  /**
   * Ce at the first sample. Use `initialEffectSiteConcentration` from
   * ./effect-site.ts with the PRE-EVENT central concentration at startTime.
   */
  readonly initialCe: number
  /**
   * Ce is reported in the PK concentration unit (mg/L). A caller that wants
   * molar output converts afterwards; this function never converts units.
   */
}

export interface PropagatedSample<TSample extends EffectSiteSample> {
  /** The original sample, unchanged, including time, side and eventGroup. */
  readonly sample: TSample
  /** Effect-site concentration at this sample, in the same unit as Ce input. */
  readonly effectSiteConcentration: number
}

export type PropagateEffectSiteResult<TSample extends EffectSiteSample> =
  | { readonly ok: true; readonly series: readonly PropagatedSample<TSample>[] }
  | { readonly ok: false; readonly errors: readonly SimulationError[] }

/**
 * Below this x = ke0·h the series for phi(x) is used instead of 1 − r/x.
 *
 * Chosen from measured floating-point error, not intuition: comparing the
 * direct expression against the truncated series shows direct evaluation
 * accurate to ≤ 1.4e-13 relative at x ≥ 1e-2 but degrading to 8.9e-5 at
 * x = 1e-12 (negative powers of the r/x cancellation). The 6-term series has
 * a truncation error of x^7/40320, which is 5e-17 relative at x = 1e-2 and
 * 5e-11 at x = 0.1 — so 1e-2 is where the series is already ≳ 3 orders of
 * magnitude more accurate than the direct quotient, with a wide safety margin
 * on both sides. The branch is continuous to ~1e-14 across the threshold
 * (see effect-site-propagation.test.ts).
 */
export const PHI_SERIES_THRESHOLD = 1e-2

/** phi(x) = 1 − (1 − e^−x)/x, evaluated without catastrophic cancellation. */
export function phi(x: number): number {
  if (x < PHI_SERIES_THRESHOLD) {
    // x/2 − x²/6 + x³/24 − x⁴/120 + x⁵/720 − x⁶/5040
    // Horner form: one multiply per term, no power recomputation.
    return x * (0.5 + x * (-1 / 6 + x * (1 / 24 + x * (-1 / 120 + x * (1 / 720 + x * (-1 / 5040))))))
  }
  return 1 - -Math.expm1(-x) / x
}

/** r(x) = 1 − e^−x, stable for small x. */
export function decayComplement(x: number): number {
  return -Math.expm1(-x)
}

const fail = (
  code: SimulationError['code'],
  field: string,
  message: string,
): SimulationError => ({ code, stage: 'scenario', field, message })

/**
 * Propagate the effect-site concentration across an ordered PK series.
 *
 * Deterministic and pure: identical inputs give identical outputs. Samples are
 * never sorted, deduplicated or dropped — every input sample yields exactly one
 * output entry carrying the original sample object.
 */
export function propagateEffectSite<TSample extends EffectSiteSample>(
  input: PropagateEffectSiteInput<TSample>,
): PropagateEffectSiteResult<TSample> {
  const { samples, unboundFraction, ke0, initialCe } = input
  const errors: SimulationError[] = []

  if (!Number.isFinite(unboundFraction) || unboundFraction <= 0 || unboundFraction > 1) {
    errors.push(
      Number.isFinite(unboundFraction)
        ? fail('OUT_OF_RANGE', 'unboundFraction', 'The unbound fraction fu must be greater than 0 and at most 1.')
        : fail('NOT_A_NUMBER', 'unboundFraction', 'The unbound fraction fu must be a finite number.'),
    )
  }
  if (!Number.isFinite(ke0) || ke0 <= 0) {
    errors.push(
      Number.isFinite(ke0)
        ? fail('ZERO_NOT_ALLOWED', 'ke0', 'ke0 must be greater than 0.')
        : fail('NOT_A_NUMBER', 'ke0', 'ke0 must be a finite number.'),
    )
  }
  if (!Number.isFinite(initialCe) || initialCe < 0) {
    errors.push(
      Number.isFinite(initialCe)
        ? fail('NEGATIVE_VALUE', 'initialCe', 'The initial effect-site concentration must be non-negative.')
        : fail('NOT_A_NUMBER', 'initialCe', 'The initial effect-site concentration must be finite.'),
    )
  }
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    if (sample === undefined) continue
    if (!Number.isFinite(sample.time)) {
      errors.push(fail('NOT_A_NUMBER', `samples[${index}].time`, 'Sample times must be finite.'))
    }
    if (!Number.isFinite(sample.centralConcentration)) {
      errors.push(
        fail('NOT_A_NUMBER', `samples[${index}].centralConcentration`, 'Central concentrations must be finite.'),
      )
    }
    if (Number.isFinite(sample.centralConcentration) && sample.centralConcentration < 0) {
      errors.push(
        fail(
          'NEGATIVE_VALUE',
          `samples[${index}].centralConcentration`,
          'Central concentrations must be non-negative.',
        ),
      )
    }
    if (index > 0) {
      const previous = samples[index - 1]
      if (previous !== undefined && sample.time < previous.time) {
        errors.push(
          fail(
            'CONFLICTING_PARAMETERS',
            `samples[${index}].time`,
            `Samples must be in non-decreasing time order; ${sample.time} follows ${previous.time}.`,
          ),
        )
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const series: PropagatedSample<TSample>[] = []
  let ce = initialCe
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    if (sample === undefined) continue
    if (index > 0) {
      const previous = samples[index - 1]
      if (previous !== undefined) {
        const h = sample.time - previous.time
        if (h > 0) {
          const x = ke0 * h
          const r = decayComplement(x)
          const p = phi(x)
          const u0 = unboundFraction * previous.centralConcentration
          const u1 = unboundFraction * sample.centralConcentration
          // Ce1 = Ce0·e^(−x) + u0·(r − phi) + u1·phi. e^(−x) = 1 − r, and
          // (1 − r) is formed from r so a tiny x does not lose the decay.
          ce = ce * (1 - r) + u0 * (r - p) + u1 * p
        }
        // h === 0: a dosing event's two sides. Ce is unchanged — no division,
        // and no discontinuity propagated from Cc.
      }
    }
    series.push({ sample, effectSiteConcentration: ce })
  }
  return { ok: true, series }
}
