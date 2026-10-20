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
export {
  checkUnitFor,
  convertDecimal,
  parseRateUnit,
  rateUnitSymbol,
  dimensionLabel,
  CONCENTRATION_DIMENSIONS,
  TIME_DIMENSIONS,
  MASS_DIMENSIONS,
  VOLUME_DIMENSIONS,
  CLEARANCE_DIMENSIONS,
  MASS_FLOW_RATE_DIMENSIONS,
} from './units/units'
// ---------------------------------------------------------------------------
// Dynamic simulation (phase 41) — a separate boundary from the scalar models.
// ---------------------------------------------------------------------------
export type {
  OdeState,
  OdeSystem,
  SolverOptions,
  SolverMethodId,
  SolverControllerSettings,
  SolverDiagnostics,
  SolverSample,
  SolverRunResult,
  SimulationErrorCode,
  SimulationFailureStage,
  SimulationError,
  DosingQuantity,
  IvBolusEvent,
  InfusionStartEvent,
  InfusionStopEvent,
  DosingEvent,
  EventKind,
  InitialState,
  TwoCompartmentParameters,
  SimulationScenario,
  SampleSide,
  SimulationSample,
  InfusionRatePoint,
  EventTraceEntry,
  NormalizedParameter,
  ModelDescriptorValue,
  SimulationResult,
  SimulationReport,
  SimulationWarning,
  SimulationWarningCode,
} from './simulation/types'
export type { ModelId as SimulationModelId } from './simulation/types'
export {
  DEFAULT_SOLVER_CONTROLLER,
  DP54_STAGE_COUNT,
  DP54_ORDER,
  DP54_EMBEDDED_ORDER,
  DP54_STAGE_TIMES,
  DP54_ERROR_WEIGHTS,
  createIntegrator,
  integrate,
  validateSolverOptions,
  stateComponentName,
  type Integrator,
  type IntegrateOptions,
  type IntegrateRequest,
  type IntegrateOutcome,
} from './simulation/solver'
export {
  EventScheduler,
  createScheduler,
  orderEvents,
  validateSchedule,
  type ValidatedSchedule,
  type ValidatedEventGroup,
  type ScheduleInputs,
  type ScheduleValidation,
  type DosingOptions,
} from './simulation/events'
export {
  EVENT_KIND_ORDER,
  CANONICAL,
  canonicalFactor,
  canonicalUnitFor,
  compareCodePoints,
  normalizeParameter,
  type CanonicalQuantityKind,
} from './simulation/units'
export { simulate, massBalanceTolerance, checkInvariants } from './simulation/simulate'
export {
  TWO_COMPARTMENT_MODEL_ID,
  TWO_COMPARTMENT_MODEL_VERSION,
  TWO_COMPARTMENT_ASSUMPTIONS,
  TWO_COMPARTMENT_EQUATIONS,
  TWO_COMPARTMENT_DESCRIPTOR,
  STATE_INDEX,
  STATE_NAMES,
  STATE_DIMENSION,
  twoCompartmentSystem,
  concentrations,
  massBalanceResidual,
} from './simulation/models/two-compartment-pk'
