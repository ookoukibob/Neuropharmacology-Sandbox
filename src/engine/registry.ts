import type { CalculationWarning, ModelId } from './types'

/**
 * Model registry: one descriptor per model — the single source of truth for
 * label, formula, and the assumptions/constant warnings attached to every
 * result of that model.
 *
 * This module deliberately imports nothing from the model implementations
 * (they import *it*), so there are no module cycles. Typed `calculate`
 * wrappers in the shape of `EngineModel<I>` arrive with the calculator's
 * input schemas in a later phase: a heterogeneous calculate-map without
 * schemas could not be called safely, and phase 2 ships functions
 * (`calculateFirstOrderPK`, …) as the public API.
 */
export interface ModelDescriptor {
  readonly id: ModelId
  readonly label: string
  /** The formula exactly as displayed to the user. */
  readonly formula: string
  /** Assumptions shown with every successful result of this model. */
  readonly assumptions: readonly string[]
  /** Constant warnings attached to every successful result of this model. */
  readonly warnings: readonly CalculationWarning[]
}

export const FIRST_ORDER_PK: ModelDescriptor = {
  id: 'pk.first-order-one-compartment',
  label: 'First-order one-compartment elimination',
  formula: 'C(t) = C0 · e^(−k·t),  where k = ln(2) / t½',
  assumptions: [
    'One-compartment model with first-order (mono-exponential) elimination; C0 is the concentration at t = 0 as supplied by the caller.',
    'No absorption phase, distribution phases, metabolites or multi-compartment kinetics are represented.',
    'Time is computed in the unit of the supplied half-life (or of k); a t given in another time unit is converted explicitly in the trace.',
    'The calculation is mathematics on the supplied inputs; it does not describe any specific organism, drug or dosing regimen.',
  ],
  warnings: [
    {
      code: 'MODEL_LIMITATION',
      severity: 'info',
      message:
        'One-compartment first-order model; real pharmacokinetics may be multi-compartmental.',
    },
    {
      code: 'MODEL_RESULT_NOT_CLINICAL',
      severity: 'warning',
      message: 'Calculated model output only; not a prediction of clinical drug exposure.',
    },
  ],
}

export const SINGLE_SITE_OCCUPANCY: ModelDescriptor = {
  id: 'occupancy.single-site',
  label: 'Single-site receptor occupancy',
  formula: 'Occupancy = [D] / ([D] + Kd)',
  assumptions: [
    'Single-site equilibrium binding: one ligand, one site — no competition, cooperativity, receptor turnover or binding kinetics.',
    '[D] is a free equilibrium concentration supplied by the caller. The model never derives concentration from a dose; dose → concentration requires an explicit, separate PK model.',
    'Kd is an equilibrium dissociation constant supplied by the caller. Ki, IC50 and EC50 are distinct parameters and are never substituted for Kd.',
    'Percentage is a display form of the fraction: occupancy% = occupancy × 100.',
  ],
  warnings: [
    {
      code: 'MODEL_LIMITATION',
      severity: 'info',
      message:
        'Equilibrium single-site model; does not cover binding kinetics, multiple sites, or tissue-specific free concentrations.',
    },
    {
      code: 'MODEL_RESULT_NOT_CLINICAL',
      severity: 'warning',
      message: 'Occupancy is a model quantity; it is not a clinical or subjective effect.',
    },
  ],
}

export const HILL_RESPONSE: ModelDescriptor = {
  id: 'dose-response.hill',
  label: 'Hill / Emax dose–response',
  formula: 'E = E0 + (Emax · [D]^n) / (EC50^n + [D]^n)',
  assumptions: [
    'All five parameters (E0, Emax, EC50, n, [D]) are explicit inputs — no defaults are applied, in particular no default Hill coefficient.',
    'EC50 is a potency parameter distinct from IC50; IC50 is never accepted in its place.',
    'E0 and Emax use the caller-chosen effect unit; the model assigns no pharmacological or clinical meaning to the response E.',
    'For [D] > 0 the model is evaluated in the algebraically equivalent form E = E0 + Emax / (1 + (EC50/[D])^n), which is numerically stable at extreme concentrations and exponents.',
  ],
  warnings: [
    {
      code: 'MODEL_LIMITATION',
      severity: 'info',
      message:
        'Empirical sigmoid relationship; it does not model mechanism, kinetics, variability or data scatter.',
    },
    {
      code: 'MODEL_RESULT_NOT_CLINICAL',
      severity: 'warning',
      message: 'Mathematical model output; not an efficacy, safety or clinical effect prediction.',
    },
  ],
}

/** All descriptors, keyed by their stable model id. */
export const MODELS: Readonly<Record<ModelId, ModelDescriptor>> = {
  'pk.first-order-one-compartment': FIRST_ORDER_PK,
  'occupancy.single-site': SINGLE_SITE_OCCUPANCY,
  'dose-response.hill': HILL_RESPONSE,
}
