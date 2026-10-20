/**
 * Dynamic simulation contracts (phase 41).
 *
 * A simulation is a *time course*, not a scalar calculation, so it gets its
 * own report shape instead of being forced into `CalculationReport` (which
 * describes one input set → one formula → one trace → scalar outputs).
 *
 * The boundary is the same as the scalar engine's:
 * - pure: no React, no Zustand, no Dexie, no DOM, no clock, no randomness;
 * - deterministic: identical scenario + identical solver settings produce an
 *   identical report, byte for byte;
 * - failures are data: user-fixable input errors and numerical failures are
 *   returned as typed `SimulationFailure` values, never thrown for the UI to
 *   guess at, and never reported as a successful partial curve.
 *
 * The module layering is deliberate:
 *
 *   types.ts        contracts only (this file) — no imports beyond the domain
 *   solver.ts       ODE mathematics only: it knows nothing about PK or doses
 *   events.ts       dosing-event validation, ordering and infusion bookkeeping
 *   models/*        one model's states, equations and observables
 *   simulate.ts     orchestration: validate → convert → integrate → apply →
 *                   sample → diagnose → report
 *
 * Internal arithmetic is IEEE-754 double precision for integration (see
 * `docs/decisions.md` ADR-23): adaptive Runge–Kutta error estimates are
 * designed for finite-precision integration, and rounding every stage
 * through Decimal would not make the error estimate more meaningful. Values
 * leaving the engine still pass through the reporting helpers, and any value
 * that is not finite fails the simulation instead of reaching a chart.
 */
import type { Provenance } from '../../domain/provenance/provenance'

// ---------------------------------------------------------------------------
// ODE contract
// ---------------------------------------------------------------------------

/** State vector. Never empty; index i is one model state, in model order. */
export type OdeState = readonly number[]

/**
 * A right-hand side `dy/dt = f(t, y, p)`.
 *
 * `parameters` is whatever the model needs beyond the state (rate constants,
 * infusion rate, ...). The solver never inspects it; it only passes it through.
 */
export interface OdeSystem<Parameters> {
  readonly dimension: number
  derivative(time: number, state: OdeState, parameters: Parameters): OdeState
}

// ---------------------------------------------------------------------------
// Solver settings
// ---------------------------------------------------------------------------

/**
 * Explicit numerical settings. There are no hidden defaults: a simulation
 * must declare all of them. The values are *numerical* choices, not
 * pharmacological ones, and are documented in `docs/calculation-engine.md`.
 */
export interface SolverOptions {
  /** Absolute error tolerance per state component (same unit as the state). */
  readonly absoluteTolerance: number
  /** Relative error tolerance per state component (dimensionless). */
  readonly relativeTolerance: number
  /** First attempted step length (simulation time unit, hours). */
  readonly initialStep: number
  /** Smallest step the controller may take. Reaching it without progress fails. */
  readonly minStep: number
  /** Largest step the controller may take. */
  readonly maxStep: number
  /** Maximum accepted + rejected step attempts per `integrate` call. */
  readonly maxSteps: number
}

/** The only integration method implemented. Reported in every result. */
export type SolverMethodId = 'dormand-prince-rk45'

/** Controller constants — implementation defaults, not scientific parameters. */
export interface SolverControllerSettings {
  /** Multiply the estimated step factor by this (safety margin below 1). */
  readonly safetyFactor: number
  /** Smallest step-size factor applied after a rejected step. */
  readonly minScaleFactor: number
  /** Largest step-size factor applied after an accepted step. */
  readonly maxScaleFactor: number
  /** Factor applied when the estimated error is exactly 0. */
  readonly zeroErrorScaleFactor: number
}

/**
 * Numerical diagnostics of one integration: what was attempted, accepted and
 * rejected. Every field is deterministic for identical inputs.
 */
export interface SolverDiagnostics {
  readonly method: SolverMethodId
  readonly settings: SolverOptions
  readonly controller: SolverControllerSettings
  /** Step attempts that were accepted. */
  readonly acceptedSteps: number
  /** Step attempts rejected by the error controller. */
  readonly rejectedSteps: number
  /** Every derivative evaluation, FSAL reuse included. */
  readonly functionEvaluations: number
  /** Largest error norm seen on an accepted step (0 when nothing to integrate). */
  readonly maxAcceptedErrorNorm: number
  /** Smallest accepted step length. */
  readonly minAcceptedStep: number
  /** Largest accepted step length. */
  readonly maxAcceptedStep: number
}

export interface SolverSample {
  readonly time: number
  readonly state: OdeState
}

/** Result of one `integrate` call: every requested target reached exactly. */
export interface SolverRunResult {
  /** Zero or more samples, in ascending time order (targets that were reached). */
  readonly samples: readonly SolverSample[]
  readonly diagnostics: SolverDiagnostics
  /** State at the last reached target. */
  readonly finalState: OdeState
  /** Last reached target time. */
  readonly finalTime: number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Simulation error categories. They extend the scalar taxonomy conceptually
 * (user-fixable input problems vs. numerical failures) without changing it:
 * `CalculationReport` and its codes are untouched and remain the contract of
 * the scalar models.
 */
export type SimulationErrorCode =
  /** A required scenario field is absent (time grid, parameter, event time...). */
  | 'MISSING_PARAMETER'
  /** A required value is NaN/±∞. */
  | 'NOT_A_NUMBER'
  /** A value is negative where the science requires ≥ 0 (amounts, rates...). */
  | 'NEGATIVE_VALUE'
  /** A value must be strictly positive (volumes/half-lives, tolerances, steps). */
  | 'ZERO_NOT_ALLOWED'
  /** A value lies outside its model/domain (tolerances, step bounds, horizon). */
  | 'OUT_OF_RANGE'
  /** A unit symbol is not in the catalog. */
  | 'UNKNOWN_UNIT'
  /** A known unit of the wrong physical dimension for this field. */
  | 'INCOMPATIBLE_UNITS'
  /** Two inputs contradict each other (overlapping intervals, bad ordering). */
  | 'CONFLICTING_PARAMETERS'
  /** The dosing schedule is not constructible (missing start, repeated stop…). */
  | 'INVALID_EVENT_SEQUENCE'
  /** Model implementation defect: derivative/state dimension mismatch. */
  | 'INCONSISTENT_DERIVATIVE_DIMENSION'
  /** Non-finite value produced by a model or by the solver. */
  | 'NUMERICAL_FAILURE'
  /** The error controller could not make progress (min step / float time). */
  | 'FAILED_TO_ADVANCE'
  /** The step budget was exhausted before reaching a target. */
  | 'MAX_STEPS_EXCEEDED'
  /** A physical invariant (non-negativity, mass balance) was violated. */
  | 'INVARIANT_VIOLATION'

/** Which side of the boundary produced the failure. */
export type SimulationFailureStage =
  | 'scenario'
  | 'units'
  | 'events'
  | 'solver'
  | 'model'
  | 'invariants'

export interface SimulationError {
  readonly code: SimulationErrorCode
  readonly stage: SimulationFailureStage
  /** Parameter/event/output field the error belongs to, when applicable. */
  readonly field?: string
  /** Dosing event id, when the error belongs to one event. */
  readonly eventId?: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// Dosing events
// ---------------------------------------------------------------------------

/** A quantity as the caller states it: number + unit, never a bare number. */
export interface DosingQuantity {
  readonly value: number
  readonly unit: string
  readonly provenance?: Provenance
}

/**
 * IV bolus: an instantaneous jump of the central compartment amount at
 * `time`. Never approximated as a very short infusion.
 */
export interface IvBolusEvent {
  readonly type: 'iv-bolus'
  /** Unique across the scenario. */
  readonly eventId: string
  /** Simulation time (hours). */
  readonly time: number
  readonly amount: DosingQuantity
}

/** Constant-rate infusion start. `infusionId` links it to exactly one stop. */
export interface InfusionStartEvent {
  readonly type: 'infusion-start'
  readonly eventId: string
  /** Unique across the scenario; identifies this infusion session. */
  readonly infusionId: string
  readonly time: number
  readonly rate: DosingQuantity
}

/** Constant-rate infusion stop. Must come strictly after its start. */
export interface InfusionStopEvent {
  readonly type: 'infusion-stop'
  readonly eventId: string
  readonly infusionId: string
  readonly time: number
}

export type DosingEvent = IvBolusEvent | InfusionStartEvent | InfusionStopEvent

/**
 * Same-time ordering policy (ADR-24), in force for every event group:
 *
 * 1. `infusion-stop` — infusions already running are stopped first;
 * 2. `iv-bolus`     — instantaneous amount jumps are applied next;
 * 3. `infusion-start` — new infusions begin last.
 *
 * Within one kind at one time, events are ordered by `eventId` using a
 * locale-independent code-point comparison — never by array position and
 * never by an engine-specific sort stability guarantee.
 */
export type EventKind = DosingEvent['type']

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/** Initial physical amounts. Non-negative and finite. */
export interface InitialState {
  /** Central compartment amount A_c (mg). */
  readonly centralAmount: number
  /** Peripheral compartment amount A_p (mg). */
  readonly peripheralAmount: number
}

/** Four-compartment-independent IV PK parameters, each with its declared unit. */
export interface TwoCompartmentParameters {
  /** V_c — central volume (> 0). */
  readonly centralVolume: DosingQuantity
  /** V_p — peripheral volume (> 0). */
  readonly peripheralVolume: DosingQuantity
  /** CL — systemic clearance (≥ 0, L/h canonical). */
  readonly clearance: DosingQuantity
  /** Q — intercompartmental clearance (≥ 0, L/h canonical; 0 = disconnected). */
  readonly intercompartmentalClearance: DosingQuantity
}

export interface SimulationScenario {
  /** Start of the time horizon (hours). */
  readonly startTime: number
  /** End of the time horizon (hours); strictly greater than `startTime`. */
  readonly endTime: number
  /**
   * Times at which reported observations are requested (hours). Strictly
   * ascending within [startTime, endTime]; `startTime` must be the first one.
   * Output times never create, move or suppress an event.
   */
  readonly outputTimes: readonly number[]
  readonly initialState: InitialState
  readonly parameters: TwoCompartmentParameters
  readonly events: readonly DosingEvent[]
  readonly solver: SolverOptions
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Simulation warning codes. They sit next to the engine's existing codes;
 * `MODEL_LIMITATION` and `MODEL_RESULT_NOT_CLINICAL` mean exactly what they
 * mean for the scalar models. Simulations also reuse `NUMERICAL_UNDERFLOW`
 * and `NUMERICAL_OVERFLOW` from `WarningCode` and add the codes below.
 */
export type SimulationWarningCode =
  | 'MODEL_LIMITATION'
  | 'MODEL_RESULT_NOT_CLINICAL'
  | 'NUMERICAL_UNDERFLOW'
  | 'NUMERICAL_OVERFLOW'
  /** At least one declared unit differed from the canonical unit and was converted. */
  | 'UNITS_CONVERTED'
  /** The integration needed a high number of steps (diagnostic, not an error). */
  | 'HIGH_STEP_COUNT'
  /** The error controller rejected at least one step. */
  | 'STEPS_REJECTED'

export interface SimulationWarning {
  readonly code: SimulationWarningCode
  readonly severity: 'info' | 'warning'
  readonly message: string
}

/** Why a sample exists at its time — the pre/post-event distinction. */
export type SampleSide = 'initial' | 'interval' | 'pre-event' | 'post-event'

/**
 * One row of the reported time series.
 *
 * A bolus at t produces a `pre-event` row and a `post-event` row with the
 * SAME `time`, in that order. A chart adapter must draw vertical jumps
 * between consecutive rows that share a time and differ in `side`, and must
 * not sort, deduplicate or average those rows.
 */
export interface SimulationSample {
  readonly time: number
  readonly side: SampleSide
  /** Reported (12-significant-digit) values, all in model-canonical units. */
  readonly centralAmount: number
  readonly peripheralAmount: number
  readonly cumulativeEliminated: number
  readonly cumulativeInput: number
  readonly centralConcentration: number
  readonly peripheralConcentration: number
  /**
   * Mass-balance residual at full internal precision (ADR-25):
   *   A_c + A_p + A_e − (A_c(0) + A_p(0)) − A_in
   * with (A_c(0), A_p(0)) the scenario's initial amounts — the state before
   * any event at startTime — and A_in the cumulative input since then.
   */
  readonly massBalanceResidual: number
  /** Event group applied at this time, when a sample marks an event side. */
  readonly eventGroup?: string
}

/** Total active infusion rate at one time ("step" series for a chart). */
export interface InfusionRatePoint {
  readonly time: number
  readonly side: 'pre-event' | 'post-event'
  readonly totalRate: number
  readonly activeInfusionIds: readonly string[]
}

/**
 * One applied event. `before`/`after` are full internal-precision states, so
 * a trace reconstructs the transition without depending on the sampled grid.
 */
export interface EventTraceEntry {
  readonly eventId: string
  readonly type: EventKind
  readonly time: number
  /** Group index (1-based) among the distinct event times of the scenario. */
  readonly groupIndex: number
  /** Position inside the group (1-based), following the ordering policy. */
  readonly orderInGroup: number
  /** Declared dose/rate exactly as the caller wrote it. */
  readonly declaredValue?: DosingQuantity
  /** Dose/rate in model-canonical units (mg, or mg/h). */
  readonly canonicalValue?: number
  readonly canonicalUnit?: 'mg' | 'mg/h'
  readonly infusionId?: string
  readonly before: OdeState
  readonly after: OdeState
  readonly activeInfusionIds: readonly string[]
  readonly totalInfusionRate: number
}

/** A parameter echoed as declared, plus its canonical value. */
export interface NormalizedParameter {
  readonly symbol: string
  readonly label: string
  readonly declaredValue: number
  readonly declaredUnit: string
  readonly canonicalValue: number
  readonly canonicalUnit: string
  /** Present when the declared unit differs from the canonical one. */
  readonly conversionFactor?: number
  readonly provenance?: Provenance
}

export interface ModelDescriptorValue {
  readonly id: ModelId
  readonly version: string
  readonly label: string
  /** Equations exactly as documented, one entry per state/observable. */
  readonly equations: readonly string[]
  readonly assumptions: readonly string[]
}

/** Result of a completed simulation. Reproduction needs only these fields. */
export interface SimulationResult {
  readonly model: ModelDescriptorValue
  /** The scenario exactly as supplied (never mutated). */
  readonly scenario: SimulationScenario
  readonly startTime: number
  readonly endTime: number
  readonly canonicalTimeUnit: 'h'
  /** Initial physical amounts (canonical mg) and the accounting start values. */
  readonly initialState: {
    readonly centralAmount: number
    readonly peripheralAmount: number
    readonly cumulativeEliminated: number
    readonly cumulativeInput: number
  }
  readonly parameters: readonly NormalizedParameter[]
  readonly samples: readonly SimulationSample[]
  readonly infusionRates: readonly InfusionRatePoint[]
  readonly eventTrace: readonly EventTraceEntry[]
  readonly solver: SolverDiagnostics
  /** Largest |residual| over reported samples. */
  readonly massBalance: {
    readonly maxAbsResidual: number
    readonly tolerance: number
    readonly ok: boolean
  }
  readonly assumptions: readonly string[]
  readonly warnings: readonly SimulationWarning[]
}

/**
 * Outcome of `simulate`. `ok: false` never carries samples: a failed
 * simulation produces no time series that could be mistaken for a result.
 */
export type SimulationReport =
  | { readonly ok: true; readonly result: SimulationResult }
  | {
      readonly ok: false
      readonly model: ModelId
      readonly errors: readonly SimulationError[]
    }

/** Stable simulation model ids (dotted "<family>.<model>" like ModelId). */
export type ModelId =
  | 'pnk.two-compartment-iv'
