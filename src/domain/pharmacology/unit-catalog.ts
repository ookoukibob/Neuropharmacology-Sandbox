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
