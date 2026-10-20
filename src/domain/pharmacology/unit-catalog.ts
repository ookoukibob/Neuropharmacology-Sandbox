/**
 * Concrete unit catalog.
 *
 * Implements the `UnitCatalog` interface declared in `units.ts`. Deliberately
 * small: only the dimensions and symbols the MVP models actually convert
 * between. New units are added here, with a test, when a concrete conversion
 * need appears — never speculatively (spec §9: no premature conversion
 * framework).
 *
 * Lookup: trimmed, Greek mu unified to the micro sign, then lower-cased, so
 * "µM", "μM" and "uM" resolve to one canonical unit — while "nM" and "µM"
 * remain distinct units a factor of 1000 apart that are never interchangeable.
 *
 * This module is pure domain: no engine, no I/O, no browser.
 */
import type { DimensionId, UnitCatalog, UnitDef, UnitConversionResult } from './units'

/** Greek small letter mu (μ) → micro sign (µ) before keying. */
const GREEK_MU = /\u03bc/g

function key(symbol: string): string {
  return symbol.trim().replace(GREEK_MU, '\u00b5').toLowerCase()
}

/**
 * Supported units.
 *
 * - Molar concentration — base M (factors are exact decimal literals).
 * - Mass concentration — base g/L. A *different* dimension from molar
 *   concentration: converting between them needs a molecular weight, which
 *   the application never invents.
 * - Time — base h (1/3600 and 1/60 carry the usual double rounding; their
 *   relative error ~1e-17 is far below the engine's 12-digit report
 *   precision).
 * - Dimensionless — base 1; "%" converts to the fraction (0.01).
 * - Mass — base g; Volume — base L; Clearance — base L/h; Mass-flow rate —
 *   base mg/h (phase 41, the two-compartment IV PK model). These are four
 *   distinct dimensions: a clearance is never a rate, an infusion rate is
 *   never a clearance, and none of them converts to time or mass alone.
 *
 * Rate units ("1/h") are not catalog entries: they are parsed by the engine
 * (`src/engine/units`) because they only ever appear as k's unit.
 */
const UNITS: readonly UnitDef[] = [
  { symbol: 'M', dimension: 'molar-concentration', toBase: 1, aliases: ['mol/L'] },
  { symbol: 'mM', dimension: 'molar-concentration', toBase: 1e-3, aliases: ['mmol/L'] },
  { symbol: 'µM', dimension: 'molar-concentration', toBase: 1e-6, aliases: ['uM', 'µmol/L', 'umol/L'] },
  { symbol: 'nM', dimension: 'molar-concentration', toBase: 1e-9, aliases: ['nmol/L'] },
  { symbol: 'pM', dimension: 'molar-concentration', toBase: 1e-12, aliases: ['pmol/L'] },
  { symbol: 'fM', dimension: 'molar-concentration', toBase: 1e-15, aliases: ['fmol/L'] },

  { symbol: 'g/L', dimension: 'mass-concentration', toBase: 1 },
  { symbol: 'mg/L', dimension: 'mass-concentration', toBase: 1e-3 },
  { symbol: 'µg/mL', dimension: 'mass-concentration', toBase: 1e-3, aliases: ['ug/mL'] },

  { symbol: 's', dimension: 'time', toBase: 1 / 3600, aliases: ['sec', 'second', 'seconds'] },
  { symbol: 'min', dimension: 'time', toBase: 1 / 60, aliases: ['minute', 'minutes'] },
  { symbol: 'h', dimension: 'time', toBase: 1, aliases: ['hr', 'hour', 'hours'] },
  { symbol: 'd', dimension: 'time', toBase: 24, aliases: ['day', 'days'] },

  // Mass — base g. Phase 41 (two-compartment IV PK model).
  // SI-prefixed masses are expressed in grammes ("mg", "µg"), matching the
  // rest of the catalog where the symbol *is* the SI-prefixed unit name.
  // "ug" (ASCII) is the only lower-cased form that cannot collide with the
  // gramme-based symbols, so it is accepted as an alias.
  { symbol: 'g', dimension: 'mass', toBase: 1, aliases: ['gram', 'grams'] },
  { symbol: 'mg', dimension: 'mass', toBase: 1e-3, aliases: ['milligram', 'milligrams'] },
  { symbol: 'µg', dimension: 'mass', toBase: 1e-6, aliases: ['ug'] },

  // Volume — base L (SI-canonical volume unit). Phase 41.
  { symbol: 'L', dimension: 'volume', toBase: 1, aliases: ['l', 'liter', 'litre'] },
  { symbol: 'mL', dimension: 'volume', toBase: 1e-3, aliases: ['ml'] },

  // Clearance — volume per time, base L/h. Phase 41. 1 mL/min = 0.06 L/h.
  { symbol: 'L/h', dimension: 'clearance', toBase: 1, aliases: ['L/hr'] },
  { symbol: 'mL/h', dimension: 'clearance', toBase: 1e-3, aliases: ['mL/hr'] },
  { symbol: 'mL/min', dimension: 'clearance', toBase: 0.06 },

  // Mass-flow rate — mass per time, base mg/h. Phase 41.
  // 1 µg/min = 0.06 mg/h. `toBase` values are exact decimal literals.
  { symbol: 'mg/h', dimension: 'mass-flow-rate', toBase: 1, aliases: ['mg/hr'] },
  { symbol: 'µg/h', dimension: 'mass-flow-rate', toBase: 1e-3, aliases: ['ug/h'] },
  { symbol: 'µg/min', dimension: 'mass-flow-rate', toBase: 0.06, aliases: ['ug/min'] },
  { symbol: 'g/h', dimension: 'mass-flow-rate', toBase: 1000 },

  { symbol: '1', dimension: 'dimensionless', toBase: 1 },
  { symbol: '%', dimension: 'dimensionless', toBase: 0.01, aliases: ['percent'] },
]

const byKey = new Map<string, UnitDef>()

function register(symbol: string, def: UnitDef): void {
  const k = key(symbol)
  const existing = byKey.get(k)
  if (existing !== undefined && existing !== def) {
    // Programmer error: two catalog entries claim the same symbol. Detected
    // at module init so it can never silently shadow a unit.
    throw new Error(`unit catalog: duplicate symbol "${symbol}"`)
  }
  byKey.set(k, def)
}

for (const def of UNITS) {
  register(def.symbol, def)
  for (const alias of def.aliases ?? []) register(alias, def)
}

export const unitCatalog: UnitCatalog = {
  get(symbol: string): UnitDef | undefined {
    return byKey.get(key(symbol))
  },
  has(symbol: string): boolean {
    return byKey.has(key(symbol))
  },
  dimensionOf(symbol: string): DimensionId | undefined {
    return byKey.get(key(symbol))?.dimension
  },
  unitsOfDimension(dimension: DimensionId): readonly UnitDef[] {
    // Iterate the unique definitions, not byKey (which also holds aliases).
    return UNITS.filter((def) => def.dimension === dimension)
  },
  convert(value: number, from: string, to: string): UnitConversionResult {
    const fromDef = byKey.get(key(from))
    if (fromDef === undefined) return { ok: false, error: { kind: 'unknown-unit', symbol: from } }
    const toDef = byKey.get(key(to))
    if (toDef === undefined) return { ok: false, error: { kind: 'unknown-unit', symbol: to } }
    if (fromDef.dimension !== toDef.dimension) {
      return { ok: false, error: { kind: 'incompatible-units', from, to } }
    }
    if (fromDef.symbol === toDef.symbol) return { ok: true, value }
    return { ok: true, value: (value * fromDef.toBase) / toDef.toBase }
  },
}
