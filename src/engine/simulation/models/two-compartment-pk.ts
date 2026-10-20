/**
 * Open, linear, two-compartment IV pharmacokinetic model (phase 41).
 *
 * States, in fixed order (amounts in mg, volumes in L, clearances in L/h):
 *
 *   A_c   amount in the central compartment
 *   A_p   amount in the peripheral compartment
 *   A_e   cumulative amount eliminated (a pure accounting integrator)
 *   A_in  cumulative amount administered (a pure accounting integrator)
 *
 * Equations (S = index of the state vector below):
 *
 *   C_c = A_c / V_c,   C_p = A_p / V_p
 *   dA_c/dt  = R_in(t) − CL·C_c − Q·(C_c − C_p)
 *   dA_p/dt  = Q·(C_c − C_p)
 *   dA_e/dt  = CL·C_c
 *   dA_in/dt = R_in(t)
 *
 * A bolus of D at time t raises A_c and A_in by D (an instantaneous jump).
 * Because both sides of
 *
 *   A_c + A_p + A_e = A_c(0) + A_p(0) + A_in(t)
 *
 * are integrated by the same method, the residual measures integration error,
 * not a modelling shortcut — elimination is never reconstructed from the
 * sampled output grid.
 *
 * Assumptions (declared in the descriptor and shown with every result):
 * elimination occurs only from the central compartment; distribution is
 * linear and unsaturable; no absorption, metabolism, receptor binding,
 * tissue-specific distribution, brain compartment or effect site is modeled.
 * Q = 0 is a valid model: the compartments are then uncoupled and the central
 * compartment follows the one-compartment solution exactly.
 */
import Decimal from 'decimal.js'
import { unitCatalog } from '../../../domain/pharmacology/unit-catalog'
import { REPORT_PRECISION_DIGITS } from '../../numeric/decimal'
import type { OdeState, OdeSystem, SampleSide, SimulationSample } from '../types'
import { STATE_INDEX } from '../units'

export const TWO_COMPARTMENT_MODEL_ID = 'pnk.two-compartment-iv' as const
export const TWO_COMPARTMENT_MODEL_VERSION = '1.0.0'

/**
 * Indices of the state vector. Order is part of the model contract; the
 * definition lives in `units.ts` so the event scheduler and the model can
 * never disagree about where a bolus writes its amount.
 */
export { STATE_INDEX }

export const STATE_NAMES: readonly string[] = [
  'centralAmount',
  'peripheralAmount',
  'cumulativeEliminated',
  'cumulativeInput',
]

export const STATE_DIMENSION = 4

/** Model parameters plus the current dosing input R_in. */
export interface TwoCompartmentParameters {
  /** V_c (L), > 0. */
  readonly centralVolume: number
  /** V_p (L), > 0. */
  readonly peripheralVolume: number
  /** CL (L/h), ≥ 0. */
  readonly clearance: number
  /** Q (L/h), ≥ 0; 0 decouples the compartments. */
  readonly intercompartmentalClearance: number
  /** Total active infusion rate R_in (mg/h), ≥ 0. */
  readonly infusionRate: number
}

export const TWO_COMPARTMENT_ASSUMPTIONS: readonly string[] = [
  'Elimination occurs only from the central compartment, with a constant (first-order, non-saturable) clearance CL.',
  'Distribution between the central and peripheral compartments is linear and driven by the intercompartmental clearance Q; the peripheral compartment does not eliminate.',
  'The model is an open two-compartment IV model: it describes IV bolus and constant-rate IV infusion only. There is no oral absorption, no metabolism to other species, no receptor binding, no tissue-specific distribution, no brain compartment and no effect site.',
  'The central concentration is the model compartment concentration; it is not an unbound (free) concentration and it is not a CNS or brain concentration.',
  'All parameters and initial amounts are supplied by the caller. The model applies no defaults and assigns no clinical meaning to any number.',
]

export const TWO_COMPARTMENT_EQUATIONS: readonly string[] = [
  'C_c = A_c / V_c',
  'C_p = A_p / V_p',
  'dA_c/dt = R_in(t) − CL·C_c − Q·(C_c − C_p)',
  'dA_p/dt = Q·(C_c − C_p)',
  'dA_e/dt = CL·C_c',
  'dA_in/dt = R_in(t)',
  'IV bolus of D at t: A_c(t+) = A_c(t−) + D, A_in(t+) = A_in(t−) + D',
  'Mass balance: A_c + A_p + A_e = A_c(0) + A_p(0) + A_in(t)',
]

/** The ODE system handed to the generic solver. */
export const twoCompartmentSystem: OdeSystem<TwoCompartmentParameters> = {
  dimension: STATE_DIMENSION,
  derivative(time: number, state: OdeState, p: TwoCompartmentParameters): OdeState {
    void time // autonomous system: R_in is delivered as a parameter
    const ac = state[STATE_INDEX.centralAmount] ?? 0
    const ap = state[STATE_INDEX.peripheralAmount] ?? 0
    const cc = ac / p.centralVolume
    const cp = ap / p.peripheralVolume
    const elimination = p.clearance * cc
    const distribution = p.intercompartmentalClearance * (cc - cp)
    return [p.infusionRate - elimination - distribution, distribution, elimination, p.infusionRate]
  },
}

/** Concentrations from amounts (mg / L = mg/L). */
export function concentrations(state: OdeState, p: TwoCompartmentParameters): { readonly central: number; readonly peripheral: number } {
  return {
    central: (state[STATE_INDEX.centralAmount] ?? 0) / p.centralVolume,
    peripheral: (state[STATE_INDEX.peripheralAmount] ?? 0) / p.peripheralVolume,
  }
}

/** Mass balance residual at full internal precision. */
export function massBalanceResidual(state: OdeState, initialInput: number): number {
  const physical =
    (state[STATE_INDEX.centralAmount] ?? 0) +
    (state[STATE_INDEX.peripheralAmount] ?? 0) +
    (state[STATE_INDEX.cumulativeEliminated] ?? 0)
  return physical - initialInput - (state[STATE_INDEX.cumulativeInput] ?? 0)
}

/** Round for reporting: 12 significant digits, exactly like the scalar models. */
export function roundForReport(value: number): number {
  if (!Number.isFinite(value)) return value
  if (value === 0) return 0
  return new Decimal(value).toSignificantDigits(REPORT_PRECISION_DIGITS).toNumber()
}

export interface SampleInput {
  readonly time: number
  readonly side: SampleSide
  readonly state: OdeState
  readonly parameters: TwoCompartmentParameters
  readonly initialInput: number
  readonly eventGroup?: string
}

/** Build one reported sample (all values in canonical units). */
export function toSample(input: SampleInput): SimulationSample {
  const { central, peripheral } = concentrations(input.state, input.parameters)
  return {
    time: input.time,
    side: input.side,
    centralAmount: roundForReport(input.state[STATE_INDEX.centralAmount] ?? 0),
    peripheralAmount: roundForReport(input.state[STATE_INDEX.peripheralAmount] ?? 0),
    cumulativeEliminated: roundForReport(input.state[STATE_INDEX.cumulativeEliminated] ?? 0),
    cumulativeInput: roundForReport(input.state[STATE_INDEX.cumulativeInput] ?? 0),
    centralConcentration: roundForReport(central),
    peripheralConcentration: roundForReport(peripheral),
    massBalanceResidual: massBalanceResidual(input.state, input.initialInput),
    // Present only on the samples that mark an event side, so a consumer can
    // tell which same-time event group produced a pre/post-event pair.
    ...(input.eventGroup === undefined ? {} : { eventGroup: input.eventGroup }),
  }
}

/** Model descriptor rendered into a report. */
export interface TwoCompartmentDescriptor {
  readonly id: typeof TWO_COMPARTMENT_MODEL_ID
  readonly version: string
  readonly label: string
  readonly equations: readonly string[]
  readonly assumptions: readonly string[]
}

export const TWO_COMPARTMENT_DESCRIPTOR: TwoCompartmentDescriptor = {
  id: TWO_COMPARTMENT_MODEL_ID,
  version: TWO_COMPARTMENT_MODEL_VERSION,
  label: 'Two-compartment IV pharmacokinetics',
  equations: TWO_COMPARTMENT_EQUATIONS,
  assumptions: TWO_COMPARTMENT_ASSUMPTIONS,
}

/** Convenience: is `unit` a catalog unit of the given dimension? */
export function catalogDimensionOf(unit: string): string | undefined {
  return unitCatalog.get(unit)?.dimension
}