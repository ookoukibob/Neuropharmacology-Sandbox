import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import type { DimensionId } from '../../domain/pharmacology/units'
import { dimensionLabel } from '../units/units'
import type { DosingQuantity, EventKind, NormalizedParameter, OdeState } from './types'

/**
 * Model-canonical units and explicit conversion (phase 41).
 *
 * A simulation integrates in ONE set of units:
 *
 *   time    h      amount   mg      volume    L
 *   clearance L/h  concentration mg/L    infusion rate mg/h
 *
 * Every value a scenario declares is converted into these units once, before
 * integration; the caller's declared value + unit is echoed unchanged in the
 * report. Nothing is converted implicitly anywhere else: the model equations
 * below rely on these units holding exactly.
 *
 * Mass-concentration and molar-concentration are *different* dimensions and
 * never convert — a molecular weight is required and the application never
 * invents one.
 */
export const CANONICAL = {
  time: 'h',
  amount: 'mg',
  volume: 'L',
  clearance: 'L/h',
  massFlowRate: 'mg/h',
  massConcentration: 'mg/L',
} as const

export type CanonicalQuantityKind = 'amount' | 'volume' | 'clearance' | 'mass-flow-rate'

/** The dimension each canonical quantity kind must declare. */
export const QUANTITY_DIMENSIONS: Readonly<Record<CanonicalQuantityKind, readonly string[]>> = {
  amount: ['mass'],
  volume: ['volume'],
  clearance: ['clearance'],
  'mass-flow-rate': ['mass-flow-rate'],
}

/**
 * Conversion factor (multiplier) from a declared unit into the canonical unit
 * of its dimension. Returns `null` when the unit is unknown or belongs to a
 * different dimension — callers turn that into a typed error.
 *
 * The conversion itself is done in double precision: it happens once, before
 * integration, and its result is what the solver integrates. (The scalar
 * models keep their Decimal path; see ADR-23.)
 */
export function canonicalFactor(kind: CanonicalQuantityKind, unit: string): number | null {
  const def = unitCatalog.get(unit)
  if (def === undefined) return null
  if (!QUANTITY_DIMENSIONS[kind].includes(def.dimension)) return null
  const target = unitCatalog.get(canonicalUnitFor(kind))
  if (target === undefined || target.dimension !== def.dimension) return null
  if (def.symbol === target.symbol) return 1
  return def.toBase / target.toBase
}

export function canonicalUnitFor(kind: CanonicalQuantityKind): string {
  switch (kind) {
    case 'amount':
      return CANONICAL.amount
    case 'volume':
      return CANONICAL.volume
    case 'clearance':
      return CANONICAL.clearance
    case 'mass-flow-rate':
      return CANONICAL.massFlowRate
  }
}

/** Expected-dimension label for an error message: "mass" etc. */
export function expectedDimensionLabel(kind: CanonicalQuantityKind): string {
  const dimension = QUANTITY_DIMENSIONS[kind][0]
  return dimension === undefined ? kind : dimensionLabel(dimension as DimensionId)
}

/** Echoed parameter: declared value/unit + canonical value. */
export function normalizeParameter(
  symbol: string,
  label: string,
  kind: CanonicalQuantityKind,
  quantity: DosingQuantity,
  factor: number,
): NormalizedParameter {
  const canonicalUnit = canonicalUnitFor(kind)
  const base: NormalizedParameter = {
    symbol,
    label,
    declaredValue: quantity.value,
    declaredUnit: quantity.unit,
    canonicalValue: quantity.value * factor,
    canonicalUnit,
    ...(quantity.unit === canonicalUnit ? {} : { conversionFactor: factor }),
  }
  return quantity.provenance === undefined ? base : { ...base, provenance: quantity.provenance }
}

/** Stable ordering used everywhere event groups are built (ADR-24). */
export const EVENT_KIND_ORDER: readonly EventKind[] = ['infusion-stop', 'iv-bolus', 'infusion-start']

/**
 * The six state components of the two-compartment model, in vector order.
 * Shared by the model and the event scheduler so a bolus always writes the
 * same two components the model integrates.
 */
export const STATE_INDEX = {
  centralAmount: 0,
  peripheralAmount: 1,
  cumulativeEliminated: 2,
  cumulativeInput: 3,
} as const

/**
 * Locale-independent code-point comparison: Array.prototype.sort would use
 * UTF-16 code units AND rely on engine sort stability for ties, neither of
 * which is a scientific specification.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0
  const left = Array.from(a)
  const right = Array.from(b)
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const ca = left[i]?.codePointAt(0) ?? 0
    const cb = right[i]?.codePointAt(0) ?? 0
    if (ca !== cb) return ca < cb ? -1 : 1
  }
  return left.length < right.length ? -1 : 1
}

/** Order key of an event inside its same-time group. */
export function eventOrderKey(event: { readonly type: EventKind; readonly eventId: string }): number {
  const kindIndex = EVENT_KIND_ORDER.indexOf(event.type)
  return kindIndex < 0 ? EVENT_KIND_ORDER.length : kindIndex
}

/** Total active infusion rate; always ≥ 0 for validated rates. */
export function sumRates(rates: readonly number[]): number {
  let total = 0
  for (const rate of rates) total += rate
  return total
}

/** Full-precision state copy, for event traces. */
export function copyState(state: OdeState): OdeState {
  return state.slice()
}