/**
 * Public API of the calculation engine.
 *
 * Pure TypeScript: no React, no Plotly, no storage, no clock. Safe to use in
 * a Node test runner, a worker, or (later) the browser UI alike.
 *
 * Flow: model → CalculationReport (trace/assumptions/warnings included),
 * or generator → CurveData → chart adapter → Plotly.
 */
export * from './types'
export { FIRST_ORDER_PK, SINGLE_SITE_OCCUPANCY, HILL_RESPONSE, MODELS, type ModelDescriptor } from './registry'
export {
  calculateFirstOrderPK,
  type FirstOrderPKInput,
  type FirstOrderPKWithHalfLife,
  type FirstOrderPKWithRateConstant,
} from './pk/model'
export { generatePKCurve } from './pk/curve'
export { calculateReceptorOccupancy, type ReceptorOccupancyInput } from './occupancy/model'
export { generateOccupancyCurve } from './occupancy/curve'
export { calculateHillResponse, type HillResponseInput } from './dose-response/model'
export { generateHillCurve } from './dose-response/curve'
export {
  buildXValues,
  validateCurveOptions,
  DEFAULT_CURVE_POINTS,
  MAX_CURVE_POINTS,
  MIN_CURVE_POINTS,
  type CurveOptions,
  type CurveRange,
  type ValidatedCurveOptions,
} from './curve/sampling'
export { REPORT_PRECISION_DIGITS, roundForReport, type RoundedNumber, type RoundingLoss } from './numeric/decimal'
export { checkUnitFor, convertDecimal, parseRateUnit, rateUnitSymbol, dimensionLabel, CONCENTRATION_DIMENSIONS, TIME_DIMENSIONS } from './units/units'
