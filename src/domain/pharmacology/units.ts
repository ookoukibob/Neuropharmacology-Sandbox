/**
 * Unit design.
 *
 * Units are explicit strings attached to every scientific value. This module
 * defines the *interface* of a unit catalog plus the dimensions relevant to
 * the MVP. The concrete catalog (the actual set of supported symbols and
 * conversion factors) is implemented in phase 2 next to this file.
 *
 * Design rules:
 * - A bare number never represents a scientific quantity.
 * - Units of different dimensions are never implicitly compatible.
 * - Mass-concentration (mg/L) and molar-concentration (nM) are *different*
 *   dimensions: converting between them requires a molecular weight, which
 *   the application must never invent.
 */

/**
 * Dimensions the MVP needs. Kept deliberately small; extend only with a
 * concrete conversion need.
 */
export type DimensionId =
  /** Molar concentration: M, mM, µM, nM, pM */
  | 'molar-concentration'
  /** Mass concentration: mg/L, µg/mL */
  | 'mass-concentration'
  /** Absolute amount: mol, mmol, nmol */
  | 'amount'
  /** Mass: g, mg, µg */
  | 'mass'
  /** Time: s, min, h, d */
  | 'time'
  /** Volume: L, mL */
  | 'volume'
  /** Dimensionless ratio with a base of 1 (unit "1") */
  | 'dimensionless'
  /** Per-time rate denominators such as 1/h are expressed via unit strings
   *  produced by the engine (e.g. "1/h"); they are not catalog-converted. */
  | 'rate'

export interface UnitDef {
  /** Canonical display symbol, e.g. "nM". */
  readonly symbol: string
  readonly dimension: DimensionId
  /**
   * Multiply a value in this unit by `toBase` to obtain the dimension's base
   * unit (M for molar-concentration, h for time, ...).
   */
  readonly toBase: number
  /** Alternative spellings accepted on import, e.g. ["nanomolar", "nmol/L"]. */
  readonly aliases?: readonly string[]
}

export type UnknownUnitError = {
  readonly kind: 'unknown-unit'
  readonly symbol: string
}

export type IncompatibleUnitsError = {
  readonly kind: 'incompatible-units'
  readonly from: string
  readonly to: string
}

export type UnitConversionResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: UnknownUnitError | IncompatibleUnitsError }

/**
 * The unit catalog contract. The engine depends only on this interface, so
 * the catalog can be extended or replaced without touching calculations.
 */
export interface UnitCatalog {
  get(symbol: string): UnitDef | undefined
  /** All known symbols (canonical + aliases), lower-cased keys. */
  has(symbol: string): boolean
  dimensionOf(symbol: string): DimensionId | undefined
  /** Lossy-safe conversion; fails loudly instead of guessing. */
  convert(value: number, from: string, to: string): UnitConversionResult
}
