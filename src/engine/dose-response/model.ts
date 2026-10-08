/**
 * Hill / Emax dose–response.
 *
 *   E = E0 + (Emax · [D]^n) / (EC50^n + [D]^n)
 *
 * All five parameters are explicit inputs — no defaults are applied, in
 * particular no default Hill coefficient (n = 1 is *not* assumed; it must be
 * supplied like everything else).
 *
 * Parameter discipline:
 * - EC50 is a potency parameter; IC50 is a different quantity and there is no
 *   field for it — it can never be passed implicitly.
 * - EC50 and [D] must share one concentration dimension (molar ↔ mass would
 *   need a molecular weight, which the application never invents).
 * - E0/Emax share one caller-chosen effect unit, preserved into the output.
 * - n is dimensionless and must carry the explicit unit "1".
 *
 * Evaluation: for [D] > 0 the model runs in the algebraically equivalent form
 *     f = 1 / (1 + (EC50/[D])^n),   E = E0 + Emax · f
 * which avoids forming EC50^n and [D]^n separately (they overflow for large n
 * while their ratio stays well-behaved). For [D] = 0 and n > 0, [D]^n = 0 so
 * f = 0 and E = E0 exactly.
 *
 * Zero semantics (validated, documented):
 *   [D] = 0   valid — E = E0 (baseline response).
 *   EC50 = 0  invalid — degenerate step (ZERO_NOT_ALLOWED).
 *   n = 0     invalid — the model would return a constant f = 1/2
 *             (ZERO_NOT_ALLOWED); n < 0 is rejected as NEGATIVE_VALUE.
 */
import Decimal from 'decimal.js'
import type { UnitDef } from '../../domain/pharmacology/units'
import { toCalculationInput } from '../input'
import { formatDecimal, formatNumber, formatQuantity, roundForReport } from '../numeric/decimal'
import { HILL_RESPONSE } from '../registry'
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
  checkUnitParameter,
  validateEffectUnitParam,
  validateNumberParam,
  validateUnitParam,
} from '../validate/validate'
import { CONCENTRATION_DIMENSIONS, convertDecimal } from '../units/units'

export interface HillResponseInput {
  /** Baseline (zero-concentration) response, in the effect unit. */
  readonly e0: EngineParameter
  /** Maximal response increment — same effect unit as E0; sign is the caller's convention. */
  readonly emax: EngineParameter
  /** Half-maximal concentration (concentration unit) — not IC50. */
  readonly ec50: EngineParameter
  /** Hill coefficient n > 0, dimensionless unit "1" — never defaulted. */
  readonly hillCoefficient: EngineParameter
  /** Response-relevant concentration [D] (concentration unit). */
  readonly concentration: EngineParameter
}

/** n must be explicitly dimensionless: unit "1", not "%" or a physical unit. */
function validateHillCoefficientUnit(
  errors: CalculationError[],
  parameter: EngineParameter | undefined,
): UnitDef | undefined {
  if (parameter === undefined || parameter === null) return undefined
  const outcome = checkUnitParameter('n', 'Hill coefficient n', parameter.unit, ['dimensionless'])
  if (!outcome.ok) {
    errors.push(outcome.error)
    return undefined
  }
  if (outcome.def.symbol !== '1') {
    errors.push({
      code: 'INCOMPATIBLE_UNITS',
      parameter: 'n',
      message: `Hill coefficient n must use the dimensionless unit "1" (got "${outcome.def.symbol}").`,
    })
    return undefined
  }
  return outcome.def
}

export function calculateHillResponse(input: HillResponseInput): CalculationReport {
  const errors: CalculationError[] = []

  const e0Value = validateNumberParam(errors, 'E0', 'Baseline effect E0', input.e0, 'finite')
  const emaxValue = validateNumberParam(errors, 'Emax', 'Maximal effect Emax', input.emax, 'finite')
  const e0Unit = validateEffectUnitParam(errors, 'E0', 'Baseline effect E0', input.e0)
  const emaxUnit = validateEffectUnitParam(errors, 'Emax', 'Maximal effect Emax', input.emax)
  if (e0Unit !== undefined && emaxUnit !== undefined && e0Unit !== emaxUnit) {
    errors.push({
      code: 'INCOMPATIBLE_UNITS',
      parameter: 'Emax',
      message: `E0 and Emax must share one effect unit (E0 "${e0Unit}", Emax "${emaxUnit}").`,
    })
  }

  const nValue = validateNumberParam(errors, 'n', 'Hill coefficient n', input.hillCoefficient, 'positive')
  validateHillCoefficientUnit(errors, input.hillCoefficient)

  const ec50Value = validateNumberParam(errors, 'EC50', 'Half-maximal concentration EC50', input.ec50, 'positive')
  const ec50Unit = validateUnitParam(errors, 'EC50', 'Half-maximal concentration EC50', input.ec50, CONCENTRATION_DIMENSIONS)

  const dValue = validateNumberParam(errors, '[D]', 'Concentration [D]', input.concentration, 'non-negative')
  const dUnit = validateUnitParam(errors, '[D]', 'Concentration [D]', input.concentration, CONCENTRATION_DIMENSIONS)

  if (dUnit !== undefined && ec50Unit !== undefined && dUnit.dimension !== ec50Unit.dimension) {
    errors.push({
      code: 'INCOMPATIBLE_UNITS',
      parameter: 'EC50',
      message:
        '[D] and EC50 must use the same concentration dimension; converting between molar and mass concentration requires a molecular weight, which the application never invents.',
    })
  }

  if (errors.length > 0) return { ok: false, model: HILL_RESPONSE.id, errors }

  const dDef = dUnit as UnitDef
  const ec50Def = ec50Unit as UnitDef
  const effectUnit = e0Unit as string

  const trace = new TraceBuilder()
  const warnings: CalculationWarning[] = [...HILL_RESPONSE.warnings]

  const dDecimal = new Decimal(dValue)
  let ec50Decimal = new Decimal(ec50Value)
  if (ec50Def.symbol !== dDef.symbol) {
    ec50Decimal = convertDecimal(ec50Decimal, ec50Def, dDef)
    const converted = roundForReport(ec50Decimal)
    trace.add(
      'Unit conversion',
      `EC50 → ${dDef.symbol}`,
      formatQuantity(ec50Value, ec50Def.symbol),
      { value: converted.value, unit: dDef.symbol },
    )
  }

  let fractional: Decimal
  if (dDecimal.isZero()) {
    // n > 0 validated, so [D]^n = 0 and the fractional response vanishes.
    fractional = new Decimal(0)
    trace.add(
      'Fractional response',
      'f = [D]^n / (EC50^n + [D]^n)',
      'for [D] = 0 and n > 0: f = 0',
      { value: 0, unit: '1' },
    )
  } else {
    const ratio = ec50Decimal.div(dDecimal)
    trace.add(
      'Concentration ratio',
      'r = EC50 / [D]',
      `${formatQuantity(ec50Decimal, dDef.symbol)} / ${formatQuantity(dDecimal, dDef.symbol)}`,
      { value: roundForReport(ratio).value, unit: '1' },
    )

    const ratioPower = ratio.pow(nValue)
    const ratioPowerRounded = roundForReport(ratioPower)
    if (ratioPowerRounded.loss === 'overflow') {
      warnings.push({
        code: 'NUMERICAL_OVERFLOW',
        severity: 'info',
        message:
          'r^n exceeded the numeric range of the result; the fractional response is reported through its limiting value (0 for r > 1).',
      })
    }
    trace.add(
      'Ratio to the power n',
      'r^n',
      `(${formatDecimal(ratio)})^${formatNumber(nValue)}`,
      { value: ratioPowerRounded.value, unit: '1' },
    )

    // r^n > 1 can only happen for r > 1, whose limit for f is 0; taking the
    // explicit branch keeps 1/(1+∞) out of the arithmetic entirely.
    fractional = ratioPower.isFinite()
      ? new Decimal(1).div(new Decimal(1).plus(ratioPower))
      : new Decimal(0)
    trace.add(
      'Fractional response',
      'f = 1 / (1 + r^n)   (≡ [D]^n / (EC50^n + [D]^n))',
      `1 / (1 + ${formatDecimal(ratioPower)})`,
      { value: roundForReport(fractional).value, unit: '1' },
    )
  }

  const response = new Decimal(e0Value).plus(new Decimal(emaxValue).times(fractional))
  const responseRounded = roundForReport(response)
  if (responseRounded.loss === 'underflow') {
    warnings.push({
      code: 'NUMERICAL_UNDERFLOW',
      severity: 'info',
      message: 'The response E is smaller than the numeric range of the result and is reported as 0.',
    })
  }
  trace.add(
    'Response',
    'E = E0 + Emax · f',
    `${formatQuantity(e0Value, effectUnit)} + ${formatQuantity(emaxValue, effectUnit)} × ${formatDecimal(fractional)}`,
    { value: responseRounded.value, unit: effectUnit },
  )

  const outputs: readonly CalculationValue[] = [
    { symbol: 'E', label: 'Response at [D]', value: responseRounded.value, unit: effectUnit },
    { symbol: 'f', label: 'Fractional response', value: roundForReport(fractional).value, unit: '1' },
  ]

  const inputs: readonly CalculationInput[] = [
    toCalculationInput('E0', 'Baseline effect', input.e0),
    toCalculationInput('Emax', 'Maximal effect', input.emax),
    toCalculationInput('EC50', 'Half-maximal concentration', input.ec50),
    toCalculationInput('n', 'Hill coefficient', input.hillCoefficient),
    toCalculationInput('[D]', 'Concentration', input.concentration),
  ]

  return {
    ok: true,
    result: {
      model: HILL_RESPONSE.id,
      modelLabel: HILL_RESPONSE.label,
      formula: HILL_RESPONSE.formula,
      inputs,
      trace: trace.build(),
      outputs,
      assumptions: HILL_RESPONSE.assumptions,
      warnings,
    },
  }
}
