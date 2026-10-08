import type { Provenance } from '../domain/provenance/provenance'

/**
 * Calculation engine contract.
 *
 * The engine is a pure layer: no React, no Zustand, no IndexedDB, no DOM,
 * no Date-dependent behaviour beyond optional ISO timestamps. Every model is
 * a pure function from explicit inputs to a structured, inspectable report.
 *
 * A result is never just a number. It always carries:
 *   inputs -> formula -> intermediate steps (trace) -> outputs,
 * plus the assumptions and warnings that qualify the result.
 */

/**
 * Stable model identifiers. Dotted ids read as "<family>.<model>" and are
 * used in provenance (`CalculatedProvenance.model`) and round-trip tests.
 */
export type ModelId =
  | 'pk.first-order-one-compartment'
  | 'occupancy.single-site'
  | 'dose-response.hill'

/** One declared input of a calculation, with its provenance when known. */
export interface CalculationInput {
  /** Symbol as written in the formula, e.g. "[D]", "t½". */
  readonly symbol: string
  readonly label: string
  readonly value: number
  readonly unit: string
  /** Present when the input came from a library record; absent for typed-in values. */
  readonly provenance?: Provenance
}

/**
 * A caller-supplied model parameter: value + unit, with provenance when the
 * value came from a library record. Unlike the domain `ScientificValue`,
 * provenance is optional here — a number typed into a calculator carries no
 * provenance claim at all. The engine echoes provenance verbatim in
 * `CalculationInput`; it never creates or upgrades it.
 */
export interface EngineParameter {
  readonly value: number
  readonly unit: string
  readonly provenance?: Provenance
}

/** Any value the calculation emits: scalar outputs and trace intermediates. */
export interface CalculationValue {
  readonly symbol?: string
  readonly label?: string
  readonly value: number
  readonly unit: string
}

/**
 * One ordered step of the calculation. `expression` is the symbolic rule,
 * `substituted` shows the actual inputs, `result` is what that step yields.
 * The trace is the primary transparency mechanism of the application.
 */
export interface TraceStep {
  readonly index: number
  readonly label: string
  readonly expression: string
  readonly substituted: string
  readonly result: CalculationValue
}

export type WarningSeverity = 'info' | 'warning'

/**
 * Machine-readable warning categories. Warnings never invalidate a result;
 * they qualify it (model limitations, numerical loss, clinical boundaries).
 */
export type WarningCode =
  /** The model is a simplification of real pharmacology. */
  | 'MODEL_LIMITATION'
  /** The result must not be read as a clinical or subjective effect. */
  | 'MODEL_RESULT_NOT_CLINICAL'
  /** A result is smaller than the numeric range and is reported as 0. */
  | 'NUMERICAL_UNDERFLOW'
  /** An intermediate step exceeded the numeric range of the result type. */
  | 'NUMERICAL_OVERFLOW'

/**
 * Model-level caveats that do not invalidate the result, e.g.
 * "One-compartment model; not a representation of human pharmacokinetics."
 */
export interface CalculationWarning {
  readonly code: WarningCode
  readonly severity: WarningSeverity
  readonly message: string
}

/**
 * Machine-readable reasons a calculation cannot be performed. The engine
 * reports these instead of inventing missing parameters.
 */
export type CalculationErrorCode =
  | 'MISSING_PARAMETER'
  | 'NOT_A_NUMBER'
  | 'NEGATIVE_VALUE'
  | 'ZERO_NOT_ALLOWED'
  | 'OUT_OF_RANGE'
  | 'UNKNOWN_UNIT'
  | 'INCOMPATIBLE_UNITS'
  | 'MODEL_NOT_APPLICABLE'
  /** Two parameters were supplied that the model cannot use together. */
  | 'CONFLICTING_PARAMETERS'
  /** A reported value exceeded the numeric range and cannot be represented. */
  | 'NUMERICAL_ERROR'

export interface CalculationError {
  readonly code: CalculationErrorCode
  /** Symbol/label of the offending input, when applicable. */
  readonly parameter?: string
  readonly message: string
}

export interface CalculationResult {
  readonly model: ModelId
  readonly modelLabel: string
  /** The formula exactly as displayed to the user, e.g. "Occupancy = [D] / ([D] + Kd)". */
  readonly formula: string
  readonly inputs: readonly CalculationInput[]
  /** Ordered, human-readable derivation from inputs to outputs. */
  readonly trace: readonly TraceStep[]
  readonly outputs: readonly CalculationValue[]
  readonly assumptions: readonly string[]
  readonly warnings: readonly CalculationWarning[]
}

/**
 * Every model returns a report. Failures are data, not exceptions: callers
 * render the errors; tests assert on them.
 */
export type CalculationReport =
  | { readonly ok: true; readonly result: CalculationResult }
  | {
      readonly ok: false
      readonly model: ModelId
      readonly errors: readonly CalculationError[]
    }

/** The shape every engine model satisfies. `I` is the model's input type. */
export interface EngineModel<I> {
  readonly id: ModelId
  readonly label: string
  readonly formula: string
  /** Assumptions always attached to results of this model. */
  readonly assumptions: readonly string[]
  calculate(input: I): CalculationReport
}

// ---------------------------------------------------------------------------
// Curve data (calculation engine -> chart layer)
// ---------------------------------------------------------------------------

export interface CurvePoint {
  readonly x: number
  readonly y: number
}

/**
 * A series to plot. `seriesType` distinguishes the mathematical model curve
 * from user/literature observations so charts can style them differently —
 * calculated and observed data must never look identical.
 */
export interface CurveSeries {
  /** Stable identifier, e.g. "pk.concentration". */
  readonly id: string
  readonly name: string
  readonly seriesType: 'model' | 'observed'
  readonly points: readonly CurvePoint[]
  readonly xUnit: string
  readonly yUnit: string
  readonly provenance?: Provenance
  readonly source?: string
}

/**
 * Chart-agnostic curve description. The engine emits this; a thin adapter in
 * `components/charts` converts it to Plotly traces. Plotly never computes
 * pharmacology.
 */
export interface CurveData {
  readonly model: ModelId
  readonly xLabel: string
  readonly yLabel: string
  readonly xUnit: string
  readonly yUnit: string
  readonly xScale: 'linear' | 'log'
  readonly yScale: 'linear' | 'log'
  readonly series: readonly CurveSeries[]
  /** Numerical observations about the sampled points (e.g. underflow to 0). */
  readonly warnings?: readonly CalculationWarning[]
}

/**
 * Result of a curve request. Failures reuse the calculation error taxonomy
 * so the UI reports them exactly like scalar calculation failures.
 */
export type CurveGenerationResult =
  | { readonly ok: true; readonly curve: CurveData }
  | {
      readonly ok: false
      readonly model: ModelId
      readonly errors: readonly CalculationError[]
    }
