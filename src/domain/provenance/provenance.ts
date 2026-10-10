/**
 * Provenance model.
 *
 * Every scientific value in the application carries a `Provenance` object that
 * states how the value came to exist. Provenance is never flattened into a
 * plain number and is never silently upgraded (user data never becomes
 * "verified" without an explicit literature source).
 *
 * This module is pure domain: no React, no I/O, no engine imports.
 */

/** The five provenance states defined by the specification. */
export type ProvenanceType =
  | 'literature'
  | 'user'
  | 'calculated'
  | 'derived'
  | 'unknown'

/**
 * ISO 8601 date-time string (e.g. "2026-10-08T09:30:00Z").
 * Stored as a string so the domain does not depend on Date parsing.
 */
export type IsoDateTime = string

/**
 * The value was taken from a documented, citable source.
 * `source` is required: a literature claim without a source is meaningless.
 * Optional citation/doi/url strengthen traceability when available.
 */
export interface LiteratureProvenance {
  readonly type: 'literature'
  /** e.g. "ChEMBL", "PubChem", "Journal of Pharmacology 1998;284(3)..." */
  readonly source: string
  readonly citation?: string
  readonly doi?: string
  readonly url?: string
  /** When the source was last consulted (ISO 8601). */
  readonly accessedAt?: IsoDateTime
  /**
   * Reference to the stored experimental observation (Layer B) this value
   * was taken from — the explicit Layer B → Layer C link. Set only when
   * the user applied a specific stored observation to this parameter;
   * absent for hand-entered or legacy literature values.
   */
  readonly observationId?: string
  readonly notes?: string
}

/** The value was entered or confirmed by the user. Never "verified". */
export interface UserProvenance {
  readonly type: 'user'
  readonly recordedAt?: IsoDateTime
  readonly notes?: string
}

/**
 * The value was produced by a calculation in this application.
 * `model` is the engine model id (e.g. "pk.first-order-one-compartment");
 * full details live in the calculation trace, not here.
 */
export interface CalculatedProvenance {
  readonly type: 'calculated'
  readonly model: string
  readonly recordedAt?: IsoDateTime
  readonly notes?: string
}

/**
 * The value was derived from other values in the library (e.g. elimination
 * rate constant derived from half-life via k = ln(2)/t½).
 */
export interface DerivedProvenance {
  readonly type: 'derived'
  /** Human-readable derivation rule, e.g. "k = ln(2) / t½" */
  readonly method: string
  /** Labels of the source parameters this value was derived from. */
  readonly from: readonly string[]
  readonly recordedAt?: IsoDateTime
  readonly notes?: string
}

/** Origin of the value is not known. This is a valid, displayable state. */
export interface UnknownProvenance {
  readonly type: 'unknown'
  readonly notes?: string
}

export type Provenance =
  | LiteratureProvenance
  | UserProvenance
  | CalculatedProvenance
  | DerivedProvenance
  | UnknownProvenance

/**
 * Runtime guard used by UI code to branch on provenance without widening the
 * discriminated union.
 */
export function isLiterature(
  provenance: Provenance,
): provenance is LiteratureProvenance {
  return provenance.type === 'literature'
}

/** Short human-readable label for badges/status indicators. */
export function provenanceLabel(provenance: Provenance): string {
  switch (provenance.type) {
    case 'literature':
      return 'Literature'
    case 'user':
      return 'User-provided'
    case 'calculated':
      return 'Calculated'
    case 'derived':
      return 'Derived'
    case 'unknown':
      return 'Unknown'
  }
}
