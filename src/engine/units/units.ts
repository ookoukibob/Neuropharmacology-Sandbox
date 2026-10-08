/**
 * Engine-side unit helpers.
 *
 * Builds on the domain `UnitCatalog` with exactly what the models need:
 * dimension-checked lookups (feeding the typed error taxonomy), exact
 * Decimal conversions, and the "1/h" rate-unit parsing that k uses.
 *
 * Rules enforced here:
 * - unknown symbol → caller reports UNKNOWN_UNIT;
 * - known symbol of the wrong dimension → caller reports INCOMPATIBLE_UNITS;
 * - conversions happen only between units of the same dimension and are
 *   always explicit (visible in the trace), never silent;
 * - molar vs mass concentration never convert (needs a molecular weight).
 */
import Decimal from 'decimal.js'
import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import type { DimensionId, UnitDef } from '../../domain/pharmacology/units'

/** Dimensions the MVP models accept wherever "a concentration" is required. */
export const CONCENTRATION_DIMENSIONS: readonly DimensionId[] = [
  'molar-concentration',
  'mass-concentration',
]

export const TIME_DIMENSIONS: readonly DimensionId[] = ['time']
export const DIMENSIONLESS_DIMENSIONS: readonly DimensionId[] = ['dimensionless']

export type UnitCheck =
  | { readonly reason: 'ok'; readonly def: UnitDef }
  /** No unit supplied (undefined or blank). */
  | { readonly reason: 'missing' }
  /** Unit string not in the catalog. */
  | { readonly reason: 'unknown' }
  /** Catalog unit, but of a dimension the parameter does not accept. */
  | { readonly reason: 'wrong-dimension'; readonly def: UnitDef; readonly actual: DimensionId }

/** Look up a unit and verify it has one of the expected dimensions. */
export function checkUnitFor(
  unit: string | undefined,
  expected: readonly DimensionId[],
): UnitCheck {
  if (unit === undefined || unit.trim() === '') return { reason: 'missing' }
  const def = unitCatalog.get(unit)
  if (def === undefined) return { reason: 'unknown' }
  if (!expected.includes(def.dimension)) {
    return { reason: 'wrong-dimension', def, actual: def.dimension }
  }
  return { reason: 'ok', def }
}

/** Human-readable dimension name for error messages. */
export function dimensionLabel(dimension: DimensionId): string {
  switch (dimension) {
    case 'molar-concentration':
      return 'molar concentration'
    case 'mass-concentration':
      return 'mass concentration'
    case 'amount':
      return 'amount'
    case 'mass':
      return 'mass'
    case 'time':
      return 'time'
    case 'volume':
      return 'volume'
    case 'dimensionless':
      return 'dimensionless'
    case 'rate':
      return 'rate'
  }
}

/**
 * Convert a Decimal value between two units of the same dimension.
 * Dimension compatibility is the caller's responsibility: this helper is only
 * reachable from code paths that validated both units first.
 *
 * The M-family converts exactly (factors are exact decimal literals such as
 * 1e-9). Time factors that are repeating fractions (1/3600) carry the double's
 * ~1e-17 relative error — orders of magnitude below the 12-significant-digit
 * reporting precision.
 */
export function convertDecimal(value: Decimal, from: UnitDef, to: UnitDef): Decimal {
  if (from.symbol === to.symbol || from.toBase === to.toBase) return value
  return value.times(new Decimal(from.toBase)).div(new Decimal(to.toBase))
}

/**
 * Parse a per-time rate unit: "1/h", "1/min", "h^-1" … Returns the time unit
 * behind the rate (h for "1/h") or undefined when the string is not a rate
 * over a supported time unit.
 */
export function parseRateUnit(unit: string): UnitDef | undefined {
  const trimmed = unit.trim()
  const perForm = /^1\/(.+)$/.exec(trimmed)
  const expForm = /^([A-Za-zµμ%]+)\s*\^-1$/.exec(trimmed)
  const inner = perForm?.[1] ?? expForm?.[1]
  if (inner === undefined) return undefined
  const def = unitCatalog.get(inner)
  return def?.dimension === 'time' ? def : undefined
}

/** Canonical rate symbol for a time unit: h → "1/h". */
export function rateUnitSymbol(timeDef: UnitDef): string {
  return `1/${timeDef.symbol}`
}
