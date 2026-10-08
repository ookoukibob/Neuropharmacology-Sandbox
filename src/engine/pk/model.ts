/**
 * First-order one-compartment elimination.
 *
 *   C(t) = C0 · e^(−k·t),   k = ln(2) / t½
 *
 * Input is either a half-life t½ or an elimination rate constant k (never
 * both); the other one is derived in the trace. Time is evaluated in the unit
 * of t½ (or of k); a t supplied in a different time unit is converted
 * explicitly as a trace step.
 *
 * Zero semantics (validated, documented):
 *   C0 = 0   valid — degenerate but correct: C(t) = 0 for all t.
 *   t   = 0  valid — C(0) = C0 by definition.
 *   t½  = 0  invalid — k = ln(2)/0 is undefined (ZERO_NOT_ALLOWED).
 *   k   = 0  invalid — implies an infinite half-life (ZERO_NOT_ALLOWED).
 */
import Decimal from 'decimal.js'
import type { UnitDef } from '../../domain/pharmacology/units'
import { toCalculationInput } from '../input'
import { LN_TWO, formatDecimal, formatQuantity, roundForReport } from '../numeric/decimal'
import { FIRST_ORDER_PK } from '../registry'
import type {
  CalculationError,
  CalculationInput,
  CalculationReport,
  CalculationValue,
  CalculationWarning,
  EngineParameter,
} from '../types'
import { TraceBuilder } from '../trace/trace'
import {
  validateNumberParam,
  validateRateUnitParam,
  validateUnitParam,
} from '../validate/validate'
import { CONCENTRATION_DIMENSIONS, TIME_DIMENSIONS, convertDecimal, rateUnitSymbol } from '../units/units'

interface FirstOrderPKBaseInput {
  /** Concentration at t = 0 (concentration unit). */
  readonly c0: EngineParameter
  /** Elapsed time (time unit). */
  readonly time: EngineParameter
}

/** Provide a half-life … */
export interface FirstOrderPKWithHalfLife extends FirstOrderPKBaseInput {
  readonly halfLife: EngineParameter
  readonly k?: undefined
}

/** … or an elimination rate constant (unit "1/h" …), never both. */
export interface FirstOrderPKWithRateConstant extends FirstOrderPKBaseInput {
  readonly halfLife?: undefined
  readonly k: EngineParameter
}

export type FirstOrderPKInput = FirstOrderPKWithHalfLife | FirstOrderPKWithRateConstant

export function calculateFirstOrderPK(input: FirstOrderPKInput): CalculationReport {
  const errors: CalculationError[] = []

  const c0Value = validateNumberParam(errors, 'C0', 'Initial concentration C0', input.c0, 'non-negative')
  const c0Unit = validateUnitParam(errors, 'C0', 'Initial concentration C0', input.c0, CONCENTRATION_DIMENSIONS)

  const tValue = validateNumberParam(errors, 't', 'Time t', input.time, 'non-negative')
  const tUnit = validateUnitParam(errors, 't', 'Time t', input.time, TIME_DIMENSIONS)

  const halfLifeParam = input.halfLife
  const rateParam = input.k

  let halfLifeValue = Number.NaN
  let halfLifeUnit: UnitDef | undefined
  let kValue = Number.NaN
  let kTimeUnit: UnitDef | undefined

  if (halfLifeParam === undefined && rateParam === undefined) {
    errors.push({
      code: 'MISSING_PARAMETER',
      parameter: 'halfLife',
      message: 'Either a half-life (t½) or an elimination rate constant (k) is required.',
    })
  } else if (halfLifeParam !== undefined && rateParam !== undefined) {
    errors.push({
      code: 'CONFLICTING_PARAMETERS',
      parameter: 'k',
      message: 'Provide either a half-life (t½) or an elimination rate constant (k), not both.',
    })
  } else if (halfLifeParam !== undefined) {
    halfLifeValue = validateNumberParam(errors, 't½', 'Half-life t½', halfLifeParam, 'positive')
    halfLifeUnit = validateUnitParam(errors, 't½', 'Half-life t½', halfLifeParam, TIME_DIMENSIONS)
  } else {
    kValue = validateNumberParam(errors, 'k', 'Elimination rate constant k', rateParam, 'positive')
    kTimeUnit = validateRateUnitParam(errors, 'k', 'Elimination rate constant k', rateParam)
  }

  if (errors.length > 0) return { ok: false, model: FIRST_ORDER_PK.id, errors }

  // Everything above validated; the casts are invariants of that early
  // return — no computation runs before it.
  const c0Def = c0Unit as UnitDef
  const tDef = tUnit as UnitDef
  const baseTimeDef =
    halfLifeParam !== undefined ? (halfLifeUnit as UnitDef) : (kTimeUnit as UnitDef)
  const rateSymbol = rateUnitSymbol(baseTimeDef)

  const trace = new TraceBuilder()
  const warnings: CalculationWarning[] = [...FIRST_ORDER_PK.warnings]

  // Evaluate in the model's time unit (t½'s unit, or the unit inside k).
  const usesBaseTimeUnit = tDef.symbol === baseTimeDef.symbol
  const tInBaseUnit = usesBaseTimeUnit
    ? new Decimal(tValue)
    : convertDecimal(new Decimal(tValue), tDef, baseTimeDef)
  if (!usesBaseTimeUnit) {
    const converted = roundForReport(tInBaseUnit)
    trace.add(
      'Unit conversion',
      `t → ${baseTimeDef.symbol}`,
      formatQuantity(tValue, tDef.symbol),
      { value: converted.value, unit: baseTimeDef.symbol },
    )
  }

  let kDecimal: Decimal
  let halfLifeDecimal: Decimal
  if (halfLifeParam !== undefined) {
    halfLifeDecimal = new Decimal(halfLifeValue)
    kDecimal = LN_TWO.div(halfLifeDecimal)
    trace.add(
      'Elimination constant',
      'k = ln(2) / t½',
      `ln(2) / ${formatQuantity(halfLifeValue, baseTimeDef.symbol)}`,
      { value: roundForReport(kDecimal).value, unit: rateSymbol },
    )
  } else {
    kDecimal = new Decimal(kValue)
    halfLifeDecimal = LN_TWO.div(kDecimal)
    trace.add(
      'Half-life',
      't½ = ln(2) / k',
      `ln(2) / ${formatQuantity(kValue, rateSymbol)}`,
      { value: roundForReport(halfLifeDecimal).value, unit: baseTimeDef.symbol },
    )
  }

  const exponent = kDecimal.times(tInBaseUnit).negated()
  trace.add(
    'Normalized time',
    '−k · t',
    `${formatQuantity(kDecimal, rateSymbol)} × ${formatQuantity(tInBaseUnit, baseTimeDef.symbol)}`,
    { value: roundForReport(exponent).value, unit: '1' },
  )

  // Decimal.exp never throws: extreme arguments produce exact (tiny) values
  // whose loss shows up in roundForReport instead.
  const survival = exponent.exp()
  trace.add(
    'Surviving fraction',
    'e^(−k·t)',
    `exp(${formatDecimal(exponent)})`,
    { value: roundForReport(survival).value, unit: '1' },
  )

  const concentration = new Decimal(c0Value).times(survival)
  const concentrationRounded = roundForReport(concentration)
  // e^(−k·t) > 0 for finite inputs, so a non-zero C0 rounding to 0 here means
  // the true value fell below the numeric range — reported, never silent.
  if (concentrationRounded.loss === 'underflow') {
    warnings.push({
      code: 'NUMERICAL_UNDERFLOW',
      severity: 'info',
      message: 'C(t) is smaller than the numeric range of the result and is reported as 0.',
    })
  }
  trace.add(
    'Concentration',
    'C(t) = C0 · e^(−k·t)',
    `${formatQuantity(c0Value, c0Def.symbol)} × ${formatDecimal(survival)}`,
    { value: concentrationRounded.value, unit: c0Def.symbol },
  )

  const outputs: readonly CalculationValue[] = [
    { symbol: 'C(t)', label: 'Concentration at time t', value: concentrationRounded.value, unit: c0Def.symbol },
    { symbol: 'k', label: 'Elimination rate constant', value: roundForReport(kDecimal).value, unit: rateSymbol },
    { symbol: 't½', label: 'Half-life', value: roundForReport(halfLifeDecimal).value, unit: baseTimeDef.symbol },
  ]

  const inputs: readonly CalculationInput[] = [
    toCalculationInput('C0', 'Initial concentration', input.c0),
    toCalculationInput('t', 'Time', input.time),
    halfLifeParam !== undefined
      ? toCalculationInput('t½', 'Half-life', halfLifeParam)
      : // Exactly one of t½ / k was validated above.
        toCalculationInput('k', 'Elimination rate constant', rateParam as EngineParameter),
  ]

  return {
    ok: true,
    result: {
      model: FIRST_ORDER_PK.id,
      modelLabel: FIRST_ORDER_PK.label,
      formula: FIRST_ORDER_PK.formula,
      inputs,
      trace: trace.build(),
      outputs,
      assumptions: FIRST_ORDER_PK.assumptions,
      warnings,
    },
  }
}
