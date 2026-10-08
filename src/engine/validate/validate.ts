/**
 * Input validation helpers shared by all models.
 *
 * Every helper either returns a typed `CalculationError` (aggregated by the
 * model and returned as data) or pushes it into the model's error list.
 * `validate*Param` variants additionally hand back a usable placeholder on
 * failure; models return early when any error was collected, so placeholders
 * are never read — no exceptions are thrown for user-fixable conditions.
 */
import type { CalculationError, EngineParameter } from '../types'
import type { DimensionId, UnitDef } from '../../domain/pharmacology/units'
import { TIME_DIMENSIONS, checkUnitFor, dimensionLabel, parseRateUnit } from '../units/units'

export type UnitCheckOutcome =
  | { readonly ok: true; readonly def: UnitDef }
  | { readonly ok: false; readonly error: CalculationError }

/**
 * Validate a supplied unit string against expected dimensions and turn the
 * lookup result into the engine's typed error taxonomy:
 * blank → MISSING_PARAMETER (`<symbol>.unit`),
 * unrecognized → UNKNOWN_UNIT,
 * recognized but wrong dimension → INCOMPATIBLE_UNITS.
 */
export function checkUnitParameter(
  symbol: string,
  label: string,
  unit: string | undefined,
  expected: readonly DimensionId[],
): UnitCheckOutcome {
  const check = checkUnitFor(unit, expected)
  switch (check.reason) {
    case 'ok':
      return { ok: true, def: check.def }
    case 'missing':
      return {
        ok: false,
        error: {
          code: 'MISSING_PARAMETER',
          parameter: `${symbol}.unit`,
          message: `A unit is required for ${label}.`,
        },
      }
    case 'unknown':
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_UNIT',
          parameter: symbol,
          message: `${label} uses unit "${String(unit)}", which is not in the supported unit set.`,
        },
      }
    case 'wrong-dimension':
      return {
        ok: false,
        error: {
          code: 'INCOMPATIBLE_UNITS',
          parameter: symbol,
          message: `${label} must use a ${expected
            .map(dimensionLabel)
            .join(' or ')} unit; got ${dimensionLabel(check.actual)} unit "${String(unit)}".`,
        },
      }
  }
}

export type NumberRequirement =
  /** Any finite number (sign irrelevant), e.g. E0/Emax. */
  | 'finite'
  /** ≥ 0 — zero is mathematically valid, negatives are not (C0, t, [D]). */
  | 'non-negative'
  /** > 0 — zero degenerates the model (t½, k, Kd, EC50, n). */
  | 'positive'

/**
 * Validate one numeric parameter. Returns null when valid.
 * `symbol` is the machine key (form field / error `parameter`); `label` is
 * the human name used in messages.
 */
export function checkNumber(
  symbol: string,
  label: string,
  parameter: EngineParameter | undefined,
  requirement: NumberRequirement,
): CalculationError | null {
  if (parameter === undefined || parameter === null) {
    return { code: 'MISSING_PARAMETER', parameter: symbol, message: `${label} is required.` }
  }
  const { value } = parameter
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      code: 'NOT_A_NUMBER',
      parameter: symbol,
      message: `${label} must be a finite number (got ${String(value)}).`,
    }
  }
  if (value < 0 && requirement !== 'finite') {
    const bound = requirement === 'positive' ? 'greater than 0' : '0 or greater'
    return {
      code: 'NEGATIVE_VALUE',
      parameter: symbol,
      message: `${label} must be ${bound} (got ${value}).`,
    }
  }
  if (value === 0 && requirement === 'positive') {
    return {
      code: 'ZERO_NOT_ALLOWED',
      parameter: symbol,
      message: `${label} must be greater than 0; 0 is not a valid value for this parameter.`,
    }
  }
  return null
}

/** Collect `checkNumber`'s error (if any); placeholder is never read. */
export function validateNumberParam(
  errors: CalculationError[],
  symbol: string,
  label: string,
  parameter: EngineParameter | undefined,
  requirement: NumberRequirement,
): number {
  const error = checkNumber(symbol, label, parameter, requirement)
  if (error !== null) {
    errors.push(error)
    return Number.NaN
  }
  return parameter?.value ?? Number.NaN
}

/**
 * Validate that a supplied parameter carries a unit of an expected dimension;
 * returns the resolved `UnitDef` (canonical symbol, factors) for conversion.
 * When the parameter itself is missing, the number check already reported it —
 * no cascading unit error is added.
 */
export function validateUnitParam(
  errors: CalculationError[],
  symbol: string,
  label: string,
  parameter: EngineParameter | undefined,
  expected: readonly DimensionId[],
): UnitDef | undefined {
  if (parameter === undefined || parameter === null) return undefined
  const outcome = checkUnitParameter(symbol, label, parameter.unit, expected)
  if (!outcome.ok) {
    errors.push(outcome.error)
    return undefined
  }
  return outcome.def
}

/**
 * Validate k's per-time unit ("1/h", "h^-1"); returns the time unit behind
 * the rate so the model can anchor t½'s unit to it.
 */
export function validateRateUnitParam(
  errors: CalculationError[],
  symbol: string,
  label: string,
  parameter: EngineParameter | undefined,
): UnitDef | undefined {
  if (parameter === undefined || parameter === null) return undefined
  const unit = parameter.unit
  if (unit === undefined || unit.trim() === '') {
    errors.push({
      code: 'MISSING_PARAMETER',
      parameter: `${symbol}.unit`,
      message: `A unit is required for ${label} (for example "1/h").`,
    })
    return undefined
  }
  const timeDef = parseRateUnit(unit)
  if (timeDef !== undefined) return timeDef
  const check = checkUnitFor(unit, TIME_DIMENSIONS)
  if (check.reason === 'unknown') {
    errors.push({
      code: 'UNKNOWN_UNIT',
      parameter: symbol,
      message: `${label} must use a per-time unit such as "1/h"; unit "${unit}" is not in the supported unit set.`,
    })
  } else if (check.reason === 'missing') {
    // Unreachable: the blank-unit case returned above; kept exhaustive.
    errors.push({
      code: 'MISSING_PARAMETER',
      parameter: `${symbol}.unit`,
      message: `A unit is required for ${label} (for example "1/h").`,
    })
  } else {
    const got =
      check.reason === 'wrong-dimension' ? dimensionLabel(check.actual) : dimensionLabel(check.def.dimension)
    errors.push({
      code: 'INCOMPATIBLE_UNITS',
      parameter: symbol,
      message: `${label} must use a per-time unit such as "1/h"; got ${got} unit "${unit}".`,
    })
  }
  return undefined
}

/**
 * Effect units (E0/Emax) are caller-chosen labels, not catalog units — the
 * engine requires them only to be present and identical to each other, and
 * preserves them into the output unit. Returns the trimmed unit.
 */
export function validateEffectUnitParam(
  errors: CalculationError[],
  symbol: string,
  label: string,
  parameter: EngineParameter | undefined,
): string | undefined {
  if (parameter === undefined || parameter === null) return undefined
  const unit = parameter.unit
  if (unit === undefined || unit.trim() === '') {
    errors.push({
      code: 'MISSING_PARAMETER',
      parameter: `${symbol}.unit`,
      message: `A unit is required for ${label} (for example "%").`,
    })
    return undefined
  }
  return unit.trim()
}
