/**
 * Single-site receptor occupancy.
 *
 *   Occupancy = [D] / ([D] + Kd)
 *
 * Returned both as a fraction (unit "1") and as a percentage (unit "%") with
 * the relationship occupancy% = occupancy × 100 stated in the trace and in
 * the model assumptions.
 *
 * Parameter discipline:
 * - `kd` is a Kd — an equilibrium dissociation constant. Ki, IC50 and EC50
 *   are different parameters; the input type has no field for them, so they
 *   can never be passed implicitly.
 * - [D] is a free equilibrium concentration; nothing here derives it from a
 *   dose (dose → concentration requires an explicit PK model).
 * - [D] and Kd must share one concentration dimension; molar ↔ mass
 *   concentration is rejected (it would need a molecular weight).
 *
 * Zero semantics (validated, documented):
 *   [D] = 0  valid — occupancy = 0 (given Kd > 0).
 *   Kd  = 0  invalid — not physically meaningful; it would make the
 *            denominator degenerate at [D] = 0 (ZERO_NOT_ALLOWED).
 */
import Decimal from 'decimal.js'
import type { UnitDef } from '../../domain/pharmacology/units'
import { toCalculationInput } from '../input'
import { formatDecimal, formatQuantity, noteRoundingLoss, roundForReport } from '../numeric/decimal'
import { SINGLE_SITE_OCCUPANCY } from '../registry'
import type {
  CalculationError,
  CalculationInput,
  CalculationReport,
  CalculationValue,
  CalculationWarning,
  EngineParameter,
} from '../types'
import { TraceBuilder } from '../trace/trace'
import { validateNumberParam, validateUnitParam } from '../validate/validate'
import { CONCENTRATION_DIMENSIONS, convertDecimal } from '../units/units'

export interface ReceptorOccupancyInput {
  /** Free equilibrium ligand concentration [D] (concentration unit). */
  readonly concentration: EngineParameter
  /** Equilibrium dissociation constant Kd (concentration unit) — never Ki. */
  readonly kd: EngineParameter
}

export function calculateReceptorOccupancy(input: ReceptorOccupancyInput): CalculationReport {
  const errors: CalculationError[] = []

  const dValue = validateNumberParam(errors, '[D]', 'Ligand concentration [D]', input.concentration, 'non-negative')
  const dUnit = validateUnitParam(errors, '[D]', 'Ligand concentration [D]', input.concentration, CONCENTRATION_DIMENSIONS)

  const kdValue = validateNumberParam(errors, 'Kd', 'Equilibrium dissociation constant Kd', input.kd, 'positive')
  const kdUnit = validateUnitParam(errors, 'Kd', 'Equilibrium dissociation constant Kd', input.kd, CONCENTRATION_DIMENSIONS)

  if (dUnit !== undefined && kdUnit !== undefined && dUnit.dimension !== kdUnit.dimension) {
    errors.push({
      code: 'INCOMPATIBLE_UNITS',
      parameter: 'Kd',
      message:
        '[D] and Kd must use the same concentration dimension; converting between molar and mass concentration requires a molecular weight, which the application never invents.',
    })
  }

  if (errors.length > 0) return { ok: false, model: SINGLE_SITE_OCCUPANCY.id, errors }

  const dDef = dUnit as UnitDef
  const kdDef = kdUnit as UnitDef

  const trace = new TraceBuilder()
  const warnings: CalculationWarning[] = [...SINGLE_SITE_OCCUPANCY.warnings]

  const dDecimal = new Decimal(dValue)
  let kdDecimal = new Decimal(kdValue)
  if (kdDef.symbol !== dDef.symbol) {
    kdDecimal = convertDecimal(kdDecimal, kdDef, dDef)
    const converted = roundForReport(kdDecimal)
    noteRoundingLoss(warnings, converted, `The converted Kd (${dDef.symbol})`)
    trace.add(
      'Unit conversion',
      `Kd → ${dDef.symbol}`,
      formatQuantity(kdValue, kdDef.symbol),
      { value: converted.value, unit: dDef.symbol },
    )
  }

  const denominator = dDecimal.plus(kdDecimal)
  const denominatorRounded = roundForReport(denominator)
  noteRoundingLoss(
    warnings,
    denominatorRounded,
    '[D] + Kd',
    'The occupancy fraction itself is a quotient ≤ 1 and remains representable.',
  )
  trace.add(
    'Denominator',
    '[D] + Kd',
    `${formatQuantity(dDecimal, dDef.symbol)} + ${formatQuantity(kdDecimal, dDef.symbol)}`,
    { value: denominatorRounded.value, unit: dDef.symbol },
  )

  // [D] = 0 → Occ = 0 is a mathematical zero (roundForReport: loss 'none',
  // no warning); [D] > 0 → any zero here is below the numeric range.
  const fraction = dDecimal.div(denominator)
  const fractionRounded = roundForReport(fraction)
  noteRoundingLoss(warnings, fractionRounded, 'The occupancy fraction')
  trace.add(
    'Occupancy (fraction)',
    'Occ = [D] / ([D] + Kd)',
    `${formatQuantity(dDecimal, dDef.symbol)} / ${formatQuantity(denominator, dDef.symbol)}`,
    { value: fractionRounded.value, unit: '1' },
  )

  const percent = fraction.times(100)
  const percentRounded = roundForReport(percent)
  noteRoundingLoss(warnings, percentRounded, 'Occupancy (percent)')
  trace.add(
    'Occupancy (percent)',
    'Occ% = Occ × 100',
    `${formatDecimal(fraction)} × 100`,
    { value: percentRounded.value, unit: '%' },
  )

  const outputs: readonly CalculationValue[] = [
    { symbol: 'Occ', label: 'Occupancy (fraction)', value: fractionRounded.value, unit: '1' },
    { symbol: 'Occ%', label: 'Occupancy (percent)', value: percentRounded.value, unit: '%' },
  ]

  const inputs: readonly CalculationInput[] = [
    toCalculationInput('[D]', 'Ligand concentration', input.concentration),
    toCalculationInput('Kd', 'Equilibrium dissociation constant', input.kd),
  ]

  return {
    ok: true,
    result: {
      model: SINGLE_SITE_OCCUPANCY.id,
      modelLabel: SINGLE_SITE_OCCUPANCY.label,
      formula: SINGLE_SITE_OCCUPANCY.formula,
      inputs,
      trace: trace.build(),
      outputs,
      assumptions: SINGLE_SITE_OCCUPANCY.assumptions,
      warnings,
    },
  }
}
