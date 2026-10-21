/**
 * Effect-site equilibration and single-site receptor occupancy (phase 46).
 *
 * This module extends the existing dynamic simulation; it is not a second
 * calculation stack. It contributes:
 *
 *   1. validation of the three parameters the coupling needs — unbound
 *      fraction `fu`, effect-site equilibration rate `ke0` and the
 *      equilibrium dissociation constant `Kd`;
 *   2. one extra ODE state, the effect-site concentration `Ce` (in the SAME
 *      concentration unit as the PK input), integrated by the existing solver;
 *   3. the derived occupancy `Ce / (Ce + Kd)`.
 *
 * Equations (time in the scenario's canonical unit, h):
 *
 *   Cu    = fu · Cc                     unbound central concentration
 *   dCe/dt = ke0 · (Cu − Ce)            effect-site equilibration
 *   Occ   = Ce / (Ce + Kd)              single-site equilibrium occupancy
 *
 * Scientific boundaries, enforced here rather than assumed:
 *
 * - `fu` is required and must be in (0, 1]. Total concentration is never
 *   silently treated as unbound.
 * - `ke0` is required, in inverse time units, and must be > 0. `ke0 = 0`
 *   would leave `Ce` frozen at its initial value and `ke0 = ∞` would make the
 *   effect site identical to plasma; neither is a silently chosen default.
 * - `Kd` is required and must be a CONCENTRATION. It is never substituted by
 *   `Ki`, `IC50` or `EC50`: the type system here has no such field, and the
 *   caller must supply `kd` explicitly.
 * - `Kd` and `Ce` must share one concentration dimension. Molar ↔ mass
 *   conversion requires an explicit molecular weight with provenance; it is
 *   never invented.
 * - The effect site is a generic mathematical compartment. It is NOT a brain
 *   or CNS model: no blood–brain barrier, transporter, tissue binding or
 *   regional distribution is represented.
 * - Occupancy is an equilibrium binding ratio for the modelled concentration.
 *   It is not an effect, an efficacy, or a clinical prediction.
 */
import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import type { DimensionId } from '../../domain/pharmacology/units'
import type { SimulationError } from './types'

/** Canonical concentration unit of the PK model (mg/L). */
export const PK_CONCENTRATION_UNIT = 'mg/L'

/** Molar-concentration dimension id (for the molecular-weight path). */
const MOLAR: DimensionId = 'molar-concentration'
const MASS_CONCENTRATION: DimensionId = 'mass-concentration'

/**
 * Declared effect-site parameters, exactly as the caller supplies them.
 * Every field is required: there is no pharmacological default.
 */
export interface EffectSiteInput {
  /** Unbound fraction, dimensionless in (0, 1]. */
  readonly unboundFraction: number
  /** Equilibration rate constant ke0, in inverse hours (> 0). */
  readonly ke0: number
  /** Equilibrium dissociation constant Kd, with its own concentration unit. */
  readonly kd: { readonly value: number; readonly unit: string }
  /**
   * Molecular weight (g/mol) — required ONLY when Kd is declared in a molar
   * unit, because the PK concentration is a mass concentration. Never
   * inferred from any other value.
   */
  readonly molecularWeight?: { readonly value: number; readonly unit: string }
  /** Where the molecular weight came from, when one is supplied. */
  readonly molecularWeightProvenance?: string
}

export interface ResolvedEffectSite {
  readonly unboundFraction: number
  readonly ke0: number
  /** Kd converted into the PK concentration unit (mg/L). */
  readonly kdInPkUnit: number
  /** How Kd reached the PK unit: identity, unit conversion, or via MW. */
  readonly kdConversion: 'same-unit' | 'unit-conversion' | 'molecular-weight'
  /** The molecular weight used, when the molar path was taken. */
  readonly molecularWeightUsed?: number
}

export type EffectSiteResolution =
  | { readonly ok: true; readonly resolved: ResolvedEffectSite }
  | { readonly ok: false; readonly errors: readonly SimulationError[] }

/** Concentration dimensions the PK model can express. */
export const PK_CONCENTRATION_DIMENSION: DimensionId = MASS_CONCENTRATION

const fail = (
  code: SimulationError['code'],
  field: string,
  message: string,
  stage: SimulationError['stage'] = 'scenario',
): SimulationError => ({ code, stage, field, message })

/**
 * Validate the effect-site parameters and convert Kd into the PK unit.
 *
 * Returns every problem at once; nothing is defaulted or repaired.
 */
export function resolveEffectSite(input: EffectSiteInput | undefined): EffectSiteResolution {
  if (input === undefined) {
    return {
      ok: false,
      errors: [fail('MISSING_PARAMETER', 'effectSite', 'Effect-site parameters are required when the coupling is enabled.')],
    }
  }
  const errors: SimulationError[] = []

  // --- unbound fraction ---------------------------------------------------
  if (typeof input.unboundFraction !== 'number' || !Number.isFinite(input.unboundFraction)) {
    errors.push(fail('NOT_A_NUMBER', 'effectSite.unboundFraction', 'The unbound fraction fu must be a finite number.'))
  } else if (input.unboundFraction <= 0 || input.unboundFraction > 1) {
    errors.push(
      fail(
        'OUT_OF_RANGE',
        'effectSite.unboundFraction',
        `The unbound fraction fu must be greater than 0 and at most 1 (got ${input.unboundFraction}).`,
      ),
    )
  }

  // --- ke0 ----------------------------------------------------------------
  if (typeof input.ke0 !== 'number' || !Number.isFinite(input.ke0)) {
    errors.push(fail('NOT_A_NUMBER', 'effectSite.ke0', 'The equilibration rate ke0 must be a finite number.'))
  } else if (input.ke0 <= 0) {
    errors.push(
      fail(
        'ZERO_NOT_ALLOWED',
        'effectSite.ke0',
        `The equilibration rate ke0 must be greater than 0 h⁻¹ (got ${input.ke0}); ke0 = 0 would freeze the effect site and is not assumed.`,
      ),
    )
  }

  // --- Kd -----------------------------------------------------------------
  const kd = input.kd
  if (kd === undefined || kd === null || typeof kd !== 'object') {
    errors.push(fail('MISSING_PARAMETER', 'effectSite.kd', 'Kd is required (an equilibrium dissociation constant).'))
  } else if (typeof kd.value !== 'number' || !Number.isFinite(kd.value)) {
    errors.push(fail('NOT_A_NUMBER', 'effectSite.kd.value', 'Kd must be a finite number.'))
  } else if (kd.value <= 0) {
    errors.push(
      fail('ZERO_NOT_ALLOWED', 'effectSite.kd.value', `Kd must be greater than 0 (got ${kd.value}); a zero Kd has no equilibrium.`),
    )
  }

  if (errors.length > 0) return { ok: false, errors }

  const kdDef = unitCatalog.get(kd.unit)
  if (kdDef === undefined) {
    return {
      ok: false,
      errors: [fail('UNKNOWN_UNIT', 'effectSite.kd.unit', `Kd uses unit "${kd.unit}", which is not in the supported unit set.`)],
    }
  }
  if (kdDef.dimension !== MOLAR && kdDef.dimension !== MASS_CONCENTRATION) {
    return {
      ok: false,
      errors: [
        fail(
          'INCOMPATIBLE_UNITS',
          'effectSite.kd.unit',
          `Kd must be a concentration (for example "${PK_CONCENTRATION_UNIT}"); got "${kd.unit}" (${kdDef.dimension}).`,
        ),
      ],
    }
  }

  // Same unit: the fast path, no conversion and no molecular weight.
  if (kdDef.symbol === PK_CONCENTRATION_UNIT) {
    return {
      ok: true,
      resolved: {
        unboundFraction: input.unboundFraction,
        ke0: input.ke0,
        kdInPkUnit: kd.value,
        kdConversion: 'same-unit',
      },
    }
  }

  if (kdDef.dimension === MASS_CONCENTRATION) {
    // Mass → mass: an exact catalog conversion.
    const target = unitCatalog.get(PK_CONCENTRATION_UNIT)
    if (target === undefined) {
      return { ok: false, errors: [fail('UNKNOWN_UNIT', 'effectSite.kd.unit', 'The PK concentration unit is unavailable.')] }
    }
    return {
      ok: true,
      resolved: {
        unboundFraction: input.unboundFraction,
        ke0: input.ke0,
        kdInPkUnit: (kd.value * kdDef.toBase) / target.toBase,
        kdConversion: 'unit-conversion',
      },
    }
  }

  // Molar → mass: requires an explicit molecular weight with provenance.
  const mw = input.molecularWeight
  if (mw === undefined || mw === null) {
    return {
      ok: false,
      errors: [
        fail(
          'MISSING_PARAMETER',
          'effectSite.molecularWeight',
          `Kd is declared in ${kd.unit} (molar) while the model concentration is ${PK_CONCENTRATION_UNIT} (mass); converting needs an explicit molecular weight, which is never inferred.`,
        ),
      ],
    }
  }
  if (typeof mw.value !== 'number' || !Number.isFinite(mw.value) || mw.value <= 0) {
    return {
      ok: false,
      errors: [fail('NOT_A_NUMBER', 'effectSite.molecularWeight.value', 'The molecular weight must be a finite number greater than 0.')],
    }
  }
  const mwUnit = unitCatalog.get(mw.unit)
  if (mwUnit === undefined || mwUnit.symbol !== 'g/mol') {
    return {
      ok: false,
      errors: [
        fail(
          'INCOMPATIBLE_UNITS',
          'effectSite.molecularWeight.unit',
          `The molecular weight must be declared in g/mol (got "${mw.unit}").`,
        ),
      ],
    }
  }
  if (input.molecularWeightProvenance === undefined || input.molecularWeightProvenance.trim() === '') {
    return {
      ok: false,
      errors: [
        fail(
          'MISSING_PARAMETER',
          'effectSite.molecularWeightProvenance',
          'A molecular weight used for a molar ↔ mass conversion must carry its provenance.',
        ),
      ],
    }
  }
  // molar (mol/L) → g/L via MW (g/mol); then g/L → mg/L (1e-3).
  const gramsPerLitre = (kd.value * kdDef.toBase) * mw.value
  return {
    ok: true,
    resolved: {
      unboundFraction: input.unboundFraction,
      ke0: input.ke0,
      kdInPkUnit: gramsPerLitre / 1e-3,
      kdConversion: 'molecular-weight',
      molecularWeightUsed: mw.value,
    },
  }
}

/**
 * The effect-site derivative, as an extension of the PK state vector.
 *
 * `ce` is the current effect-site concentration in the PK concentration unit.
 * The caller integrates it with the same solver and the same tolerances as the
 * PK states; nothing here is post-processed from sparse output.
 */
export function effectSiteDerivative(
  centralConcentration: number,
  ce: number,
  resolved: Pick<ResolvedEffectSite, 'unboundFraction' | 'ke0'>,
): number {
  const unbound = resolved.unboundFraction * centralConcentration
  return resolved.ke0 * (unbound - ce)
}

/**
 * Single-site equilibrium occupancy `Ce / (Ce + Kd)`.
 *
 * Bounded in [0, 1) for Ce ≥ 0 and Kd > 0; returns 0 for a zero effect-site
 * concentration. The caller must have validated Kd and Ce units already.
 */
export function receptorOccupancy(ce: number, kdInPkUnit: number): number {
  if (!(ce > 0)) return 0
  return ce / (ce + kdInPkUnit)
}

/**
 * Initial effect-site concentration.
 *
 * The effect site starts at equilibrium with the INITIAL unbound central
 * concentration (`Ce(0) = fu · Cc(0)`), which is the only defensible start
 * when the caller supplies no separate effect-site amount. Declared in the
 * result's assumptions; never a hidden constant.
 */
export function initialEffectSiteConcentration(
  initialCentralConcentration: number,
  unboundFraction: number,
): number {
  return unboundFraction * initialCentralConcentration
}

/** Structural assumptions shown with every coupled result. */
export const EFFECT_SITE_ASSUMPTIONS: readonly string[] = [
  'The effect site is a generic equilibration compartment (dCe/dt = ke0·(Cu − Ce)); it is NOT a brain or CNS model — no blood–brain barrier, transporter, tissue binding or regional distribution is represented.',
  'Unbound central concentration is Cu = fu·Cc with the explicitly supplied unbound fraction fu; total concentration is never treated as unbound.',
  'Occupancy is the single-site equilibrium ratio Ce/(Ce + Kd) for the modelled effect-site concentration; it is a binding ratio, not an effect, efficacy or clinical prediction.',
  'Kd is an equilibrium dissociation constant. Ki, IC50 and EC50 are different quantities and are never substituted for it.',
  'The effect-site compartment starts at equilibrium with the initial unbound central concentration: Ce(0) = fu·Cc(0).',
]
