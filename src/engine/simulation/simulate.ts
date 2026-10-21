/**
 * Simulation orchestration (phase 41).
 *
 *   validate scenario → convert to canonical units → validate/order events →
 *   initialise states → integrate to each boundary (output time or event
 *   time, whichever comes first) → sample → apply the event group and reset
 *   the solver cache → continue → validate invariants → report
 *
 * The orchestrator owns the *boundary policy*: the numerical method never
 * steps across a dosing event, and an output time never creates, moves or
 * suppresses an event. Sampling the same scenario on a different output grid
 * therefore cannot change the dosing or the trajectory.
 *
 * Failures are typed data. A failed simulation returns no samples at all, so
 * a partial trajectory can never be rendered as a result.
 */
import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import { DEFAULT_SOLVER_CONTROLLER, createIntegrator, validateSolverOptions } from './solver'
import {
  canonicalFactor,
  canonicalUnitFor,
  expectedDimensionLabel,
  normalizeParameter,
  type CanonicalQuantityKind,
} from './units'
import { createScheduler, type ValidatedEventGroup, type ValidatedSchedule } from './events'
import {
  EFFECT_SITE_ASSUMPTIONS,
  PK_CONCENTRATION_UNIT,
  initialEffectSiteConcentration,
  receptorOccupancy,
  resolveEffectSite,
  type ResolvedEffectSite,
} from './effect-site'
import { propagateEffectSite } from './effect-site-propagation'
import {
  TWO_COMPARTMENT_DESCRIPTOR,
  TWO_COMPARTMENT_MODEL_ID,
  twoCompartmentSystem,
  toSample,
  type TwoCompartmentParameters,
} from './models/two-compartment-pk'
import type {
  DosingEvent,
  DosingQuantity,
  EffectSiteResult,
  InfusionRatePoint,
  NormalizedParameter,
  OdeState,
  SimulationError,
  SimulationReport,
  SimulationResult,
  SimulationSample,
  SimulationScenario,
  SimulationWarning,
  SolverDiagnostics,
} from './types'

// ---------------------------------------------------------------------------
// Scenario validation
// ---------------------------------------------------------------------------

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

interface ValidatedParameter {
  readonly symbol: string
  readonly label: string
  readonly kind: CanonicalQuantityKind
  readonly quantity: DosingQuantity
  /** Canonical value, or NaN when invalid (never used after a failure). */
  readonly canonical: number
  /** 0 when the value must be > 0, undefined when 0 is allowed. */
  readonly requirement: 'positive' | 'non-negative'
}

interface ValidatedScenario {
  readonly startTime: number
  readonly endTime: number
  readonly outputTimes: readonly number[]
  readonly initialCentral: number
  readonly initialPeripheral: number
  readonly parameters: readonly ValidatedParameter[]
}

function checkQuantity(
  errors: SimulationError[],
  field: string,
  parameter: ValidatedParameter | undefined,
): number {
  if (parameter === undefined) {
    errors.push({
      code: 'MISSING_PARAMETER',
      stage: 'scenario',
      field,
      message: 'The parameter object is required.',
    })
    return Number.NaN
  }
  const { quantity } = parameter
  if (quantity === undefined || typeof quantity !== 'object') {
    errors.push({
      code: 'MISSING_PARAMETER',
      stage: 'scenario',
      field,
      message: `${parameter.label} is required (value and unit).`,
    })
    return Number.NaN
  }
  let ok = true
  if (!isFiniteNumber(quantity.value)) {
    errors.push({
      code: 'NOT_A_NUMBER',
      stage: 'scenario',
      field: `${field}.value`,
      message: `${parameter.label} must be a finite number (got ${String(quantity.value)}).`,
    })
    ok = false
  } else if (quantity.value < 0) {
    errors.push({
      code: 'NEGATIVE_VALUE',
      stage: 'scenario',
      field: `${field}.value`,
      message: `${parameter.label} must be 0 or greater (got ${quantity.value}).`,
    })
    ok = false
  } else if (quantity.value === 0 && parameter.requirement === 'positive') {
    errors.push({
      code: 'ZERO_NOT_ALLOWED',
      stage: 'scenario',
      field: `${field}.value`,
      message: `${parameter.label} must be greater than 0.`,
    })
    ok = false
  }
  if (typeof quantity.unit !== 'string' || quantity.unit.trim() === '') {
    errors.push({
      code: 'MISSING_PARAMETER',
      stage: 'scenario',
      field: `${field}.unit`,
      message: `A unit is required for ${parameter.label} (for example "${canonicalUnitFor(parameter.kind)}").`,
    })
    return Number.NaN
  }
  const factor = canonicalFactor(parameter.kind, quantity.unit)
  if (factor === null) {
    // A symbol outside the catalog is UNKNOWN_UNIT; a catalog unit of another
    // dimension is INCOMPATIBLE_UNITS (the same distinction as the scalar
    // engine's `checkUnitFor`).
    const known = expectedDimensionLabel(parameter.kind)
    const inCatalog = unitCatalog.has(quantity.unit)
    errors.push({
      code: inCatalog ? 'INCOMPATIBLE_UNITS' : 'UNKNOWN_UNIT',
      stage: 'units',
      field: `${field}.unit`,
      message: inCatalog
        ? `${parameter.label} must use a ${known} unit (for example "${canonicalUnitFor(parameter.kind)}"); got "${quantity.unit}".`
        : `${parameter.label} uses unit "${quantity.unit}", which is not in the supported unit set.`,
    })
    return Number.NaN
  }
  return ok ? quantity.value * factor : Number.NaN
}

function validateTimeHorizon(errors: SimulationError[], scenario: SimulationScenario): number[] {
  if (!isFiniteNumber(scenario.startTime)) {
    errors.push({
      code: 'NOT_A_NUMBER',
      stage: 'scenario',
      field: 'startTime',
      message: `startTime must be a finite time (got ${String(scenario.startTime)}).`,
    })
  }
  if (!isFiniteNumber(scenario.endTime)) {
    errors.push({
      code: 'NOT_A_NUMBER',
      stage: 'scenario',
      field: 'endTime',
      message: `endTime must be a finite time (got ${String(scenario.endTime)}).`,
    })
  }
  if (errors.length > 0) return []
  if (!(scenario.endTime > scenario.startTime)) {
    errors.push({
      code: 'OUT_OF_RANGE',
      stage: 'scenario',
      field: 'endTime',
      message: `endTime (${scenario.endTime}) must be strictly greater than startTime (${scenario.startTime}).`,
    })
    return []
  }

  const outputTimes = scenario.outputTimes
  if (!Array.isArray(outputTimes) || outputTimes.length === 0) {
    errors.push({
      code: 'MISSING_PARAMETER',
      stage: 'scenario',
      field: 'outputTimes',
      message: 'At least one output time is required; the simulation never invents an output grid.',
    })
    return []
  }
  let previous = Number.NEGATIVE_INFINITY
  outputTimes.forEach((value, index) => {
    const field = `outputTimes[${index}]`
    if (!isFiniteNumber(value)) {
      errors.push({
        code: 'NOT_A_NUMBER',
        stage: 'scenario',
        field,
        message: `Output time ${field} must be finite (got ${String(value)}).`,
      })
      previous = Number.NaN
      return
    }
    // `previous` is NaN only when the preceding output time was itself
    // invalid (already reported above); a NaN comparison is never "greater",
    // so the ordering check below simply passes in that case.
    if (!(value > previous)) {
      errors.push({
        code: 'OUT_OF_RANGE',
        stage: 'scenario',
        field,
        message: `Output times must strictly increase; ${field} = ${value} does not follow ${previous}.`,
      })
    }
    if (value < scenario.startTime || value > scenario.endTime) {
      errors.push({
        code: 'OUT_OF_RANGE',
        stage: 'scenario',
        field,
        message: `Output time ${value} h lies outside the horizon [${scenario.startTime}, ${scenario.endTime}] h.`,
      })
    }
    previous = value
  })
  if (outputTimes[0] !== scenario.startTime) {
    errors.push({
      code: 'OUT_OF_RANGE',
      stage: 'scenario',
      field: 'outputTimes[0]',
      message: `The first output time must equal startTime (${scenario.startTime} h); got ${String(outputTimes[0])}.`,
    })
  }
  if (outputTimes[outputTimes.length - 1] !== scenario.endTime) {
    errors.push({
      code: 'OUT_OF_RANGE',
      stage: 'scenario',
      field: `outputTimes[${outputTimes.length - 1}]`,
      message: `The last output time must equal endTime (${scenario.endTime} h); got ${String(outputTimes[outputTimes.length - 1])}.`,
    })
  }
  return errors.length === 0 ? outputTimes.slice() : []
}

function validateScenario(scenario: SimulationScenario, errors: SimulationError[]): ValidatedScenario | null {
  const outputTimes = validateTimeHorizon(errors, scenario)

  const initial = scenario.initialState
  let initialCentral = Number.NaN
  let initialPeripheral = Number.NaN
  if (initial === undefined || initial === null) {
    errors.push({
      code: 'MISSING_PARAMETER',
      stage: 'scenario',
      field: 'initialState',
      message: 'The initial state (centralAmount, peripheralAmount) is required; no amount is assumed.',
    })
  } else {
    for (const [field, value] of [
      ['initialState.centralAmount', initial.centralAmount],
      ['initialState.peripheralAmount', initial.peripheralAmount],
    ] as const) {
      if (!isFiniteNumber(value)) {
        errors.push({
          code: 'NOT_A_NUMBER',
          stage: 'scenario',
          field,
          message: `The initial amount ${field} must be a finite number in mg (got ${String(value)}).`,
        })
      } else if (value < 0) {
        errors.push({
          code: 'NEGATIVE_VALUE',
          stage: 'scenario',
          field,
          message: `The initial amount ${field} must be 0 or greater (got ${value} mg).`,
        })
      }
    }
    initialCentral = initial.centralAmount
    initialPeripheral = initial.peripheralAmount
  }

  const p = scenario.parameters
  const definitions: readonly ValidatedParameter[] = [
    { symbol: 'Vc', label: 'Central volume V_c', kind: 'volume', requirement: 'positive', quantity: p?.centralVolume },
    { symbol: 'Vp', label: 'Peripheral volume V_p', kind: 'volume', requirement: 'positive', quantity: p?.peripheralVolume },
    { symbol: 'CL', label: 'Systemic clearance CL', kind: 'clearance', requirement: 'non-negative', quantity: p?.clearance },
    {
      symbol: 'Q',
      label: 'Intercompartmental clearance Q',
      kind: 'clearance',
      requirement: 'non-negative',
      quantity: p?.intercompartmentalClearance,
    },
  ].map((d) => ({ ...d, canonical: Number.NaN })) as readonly ValidatedParameter[]

  const withValues = definitions.map((definition) => {
    const field = `parameters.${parameterFieldName(definition.symbol)}`
    return { ...definition, canonical: checkQuantity(errors, field, definition) }
  })

  if (errors.length > 0) return null
  return {
    startTime: scenario.startTime,
    endTime: scenario.endTime,
    outputTimes,
    initialCentral,
    initialPeripheral,
    parameters: withValues,
  }
}

/** Stable, order-independent label of a same-time event group (e.g. "group-1"). */
function eventGroupLabel(schedule: ValidatedSchedule, group: ValidatedEventGroup): string {
  return `group-${schedule.groups.indexOf(group) + 1}`
}

function parameterFieldName(symbol: string): string {
  switch (symbol) {
    case 'Vc':
      return 'centralVolume'
    case 'Vp':
      return 'peripheralVolume'
    case 'CL':
      return 'clearance'
    default:
      return 'intercompartmentalClearance'
  }
}

function parameterValue(validated: ValidatedScenario, symbol: string): number {
  return validated.parameters.find((p) => p.symbol === symbol)?.canonical ?? Number.NaN
}

// ---------------------------------------------------------------------------
// Event conversion adapters
// ---------------------------------------------------------------------------

function convertEventQuantity(
  event: DosingEvent,
  kind: CanonicalQuantityKind,
  field: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: SimulationError } {
  const quantity = event.type === 'iv-bolus' ? event.amount : event.type === 'infusion-start' ? event.rate : undefined
  const canonicalUnit = canonicalUnitFor(kind)
  const label = kind === 'amount' ? 'IV bolus amount' : 'Infusion rate'
  if (quantity === undefined) {
    return {
      ok: false,
      error: {
        code: 'MISSING_PARAMETER',
        stage: 'events',
        field: `${field}`,
        message: `${label} is required.`,
      },
    }
  }
  if (typeof quantity.unit !== 'string' || quantity.unit.trim() === '') {
    return {
      ok: false,
      error: {
        code: 'MISSING_PARAMETER',
        stage: 'events',
        field,
        message: `A unit is required for the ${label} (for example "${canonicalUnit}").`,
      },
    }
  }
  const factor = canonicalFactor(kind, quantity.unit)
  if (factor === null) {
    return {
      ok: false,
      error: {
        code: unitCatalog.has(quantity.unit) ? 'INCOMPATIBLE_UNITS' : 'UNKNOWN_UNIT',
        stage: 'units',
        field,
        message: `The ${label} must use a ${expectedDimensionLabel(kind)} unit (for example "${canonicalUnit}"); got "${quantity.unit}".`,
      },
    }
  }
  return { ok: true, value: quantity.value * factor }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Build the boundary list: every output time and every event time, merged. */
function boundariesFor(outputTimes: readonly number[], groups: readonly ValidatedEventGroup[], endTime: number): number[] {
  const all = new Set<number>(outputTimes)
  for (const group of groups) all.add(group.time)
  all.add(endTime)
  return [...all].sort((a, b) => a - b)
}

export function simulate(scenario: SimulationScenario): SimulationReport {
  const errors: SimulationError[] = []
  const warnings: SimulationWarning[] = []

  // 1. Scenario and constants.
  const validated = validateScenario(scenario, errors)
  errors.push(...validateSolverOptions(scenario.solver, 'scenario'))
  // Opt-in effect-site configuration: validated HERE, by the authoritative
  // resolver, before any sample exists — so a rejected configuration can never
  // produce a partial successful report.
  let effectSite: ResolvedEffectSite | undefined
  if (scenario.effectSite !== undefined) {
    const resolution = resolveEffectSite(scenario.effectSite)
    if (!resolution.ok) errors.push(...resolution.errors)
    else effectSite = resolution.resolved
  }
  if (validated === null || errors.length > 0) {
    return { ok: false, model: TWO_COMPARTMENT_MODEL_ID, errors }
  }

  // 2. Canonical parameters.
  const centralVolume = parameterValue(validated, 'Vc')
  const peripheralVolume = parameterValue(validated, 'Vp')
  const clearance = parameterValue(validated, 'CL')
  const intercompartmentalClearance = parameterValue(validated, 'Q')

  // 3. Events (validation, canonical conversion, ordering, sessions).
  const scheduleInput = {
    startTime: validated.startTime,
    endTime: validated.endTime,
    events: scenario.events ?? [],
    convertRate: (eventId: string, event: DosingEvent) => {
      void eventId
      return convertEventQuantity(event, 'mass-flow-rate', 'events.rate')
    },
    convertAmount: (eventId: string, event: DosingEvent) => {
      void eventId
      return convertEventQuantity(event, 'amount', 'events.amount')
    },
  }
  const schedulerResult = createScheduler(scheduleInput)
  if (!schedulerResult.ok) {
    return { ok: false, model: TWO_COMPARTMENT_MODEL_ID, errors: schedulerResult.errors }
  }
  const { scheduler, schedule } = schedulerResult

  // 4. Initial state and accounting states — one reference point.
  //
  // CONVENTION (ADR-25): the scenario's initial physical state IS the state
  // at `startTime` before any event. The reference initial physical amount is
  // therefore A_c(0) + A_p(0) with no dose added, and the cumulative-input
  // accounting state starts at exactly 0 mg. Every dose — including a bolus
  // or an infusion start at `startTime` — is then applied ONCE by the event
  // scheduler, which adds it to both the physical amount and A_in. Nothing
  // is counted twice: the reference contains no dose, and A_in contains every
  // dose. The invariant checked for every sample is
  //
  //   A_c + A_p + A_e − (A_c(0) + A_p(0)) − A_in = 0
  //
  // so the initial (pre-event) sample reads 0 mg on both sides.
  const referencePhysicalAmount = validated.initialCentral + validated.initialPeripheral
  const initialState: OdeState = [
    validated.initialCentral,
    validated.initialPeripheral,
    0, // A_e starts at 0: the eliminated amount since the reference point.
    0, // A_in starts at 0: input accumulated since the reference point.
  ]

  // 5–10. Integration loop.
  const parameters: TwoCompartmentParameters = {
    centralVolume,
    peripheralVolume,
    clearance,
    intercompartmentalClearance,
    infusionRate: 0,
  }
  const created = createIntegrator<TwoCompartmentParameters>(
    {
      system: twoCompartmentSystem,
      parameters: { ...parameters, infusionRate: scheduler.options.infusionRate },
      startTime: validated.startTime,
      startState: initialState,
      targets: [],
    },
    { settings: scenario.solver, controller: DEFAULT_SOLVER_CONTROLLER },
  )
  if (!created.ok) return { ok: false, model: TWO_COMPARTMENT_MODEL_ID, errors: created.errors }
  const integrator = created.integrator

  const samples: SimulationSample[] = []
  const infusionRates: InfusionRatePoint[] = []
  const eventTrace: SimulationResult['eventTrace'][number][] = []
  const outputSet = new Set(validated.outputTimes)
  const boundaries = boundariesFor(validated.outputTimes, schedule.groups, validated.endTime)
  const groupByTime = new Map<number, ValidatedEventGroup>(schedule.groups.map((g) => [g.time, g]))

  const diagnosticsAcc = {
    acceptedSteps: 0,
    rejectedSteps: 0,
    functionEvaluations: 0,
    maxAcceptedErrorNorm: 0,
    minAcceptedStep: Number.POSITIVE_INFINITY,
    maxAcceptedStep: 0,
  }

  let cached = false // stage 1 of the carried state is valid for the current parameters

  /**
   * Materialise one sample from an EXPLICIT state.
   *
   * The state is always captured at the moment of the call — never read
   * lazily from the integrator later — so a pre-event sample can never show
   * a post-event state.
   */
  const emit = (
    time: number,
    side: 'initial' | 'interval' | 'pre-event' | 'post-event',
    state: OdeState,
    parameters: TwoCompartmentParameters,
    eventGroup?: string,
  ): void => {
    samples.push(
      toSample({
        time,
        side,
        state: state.slice(),
        parameters,
        initialInput: referencePhysicalAmount,
        ...(eventGroup === undefined ? {} : { eventGroup }),
      }),
    )
  }

  // The start state is always the first observation.
  const initialGroup = groupByTime.get(validated.startTime)
  if (initialGroup !== undefined) {
    // An event at t0 is applied after the (pre-event) start state is recorded
    // — the same pre/post semantics as every other event time.
    infusionRates.push(
      scheduler.ratePoint(validated.startTime, 'pre-event', { rate: 0, activeInfusionIds: [] }),
    )
    // The pre-event sample is taken from the state BEFORE the jump; it is
    // materialised eagerly because `emit` reads the live integrator state.
    const preState = integrator.snapshot()
    const preParameters = { ...integrator.parameters }
    emit(validated.startTime, 'pre-event', preState, preParameters, eventGroupLabel(schedule, initialGroup))
    const applied = scheduler.applyGroup(validated.startTime, initialGroup, preState)
    eventTrace.push(...applied.trace)
    integrator.state = applied.state
    integrator.parameters = { ...parameters, infusionRate: scheduler.options.infusionRate }
    cached = false
    infusionRates.push(scheduler.ratePoint(validated.startTime, 'post-event', { rate: 0, activeInfusionIds: [] }))
    emit(validated.startTime, 'post-event', integrator.state, integrator.parameters, eventGroupLabel(schedule, initialGroup))
  } else {

    emit(validated.startTime, 'initial', integrator.state, integrator.parameters)
    infusionRates.push(scheduler.ratePoint(validated.startTime, 'post-event', { rate: 0, activeInfusionIds: [] }))
  }

  const remaining = boundaries.filter((t) => t > validated.startTime)
  let index = 0
  while (index < remaining.length) {
    const boundary = remaining[index]
    if (boundary === undefined) break
    // Integrate only as far as the next boundary that changes something: the
    // next dosing event when it comes first, otherwise the next output time.
    // Output times lying before that event are reached with cache reuse.
    const nextGroup = scheduler.groupAfter(integrator.time)
    const stopTime = nextGroup !== undefined && nextGroup.time < boundary ? nextGroup.time : boundary
    const run = integrator.integrate([stopTime], cached)
    if (!run.ok) return { ok: false, model: TWO_COMPARTMENT_MODEL_ID, errors: run.errors }
    cached = true
    accumulate(diagnosticsAcc, run.diagnostics)

    const group = groupByTime.get(boundary)
    if (group !== undefined && boundary === stopTime) {
      const preRate = scheduler.totalRate
      const preActive = scheduler.activeInfusionIds
      emit(boundary, 'pre-event', integrator.state, integrator.parameters, eventGroupLabel(schedule, group))
      infusionRates.push(scheduler.ratePoint(boundary, 'pre-event', { rate: preRate, activeInfusionIds: preActive }))
      const applied = scheduler.applyGroup(boundary, group, integrator.state)
      eventTrace.push(...applied.trace)
      integrator.state = applied.state
      integrator.parameters = { ...parameters, infusionRate: scheduler.options.infusionRate }
      // The right-hand side may have changed: never reuse a pre-event stage 1.
      cached = false
      emit(boundary, 'post-event', integrator.state, integrator.parameters, eventGroupLabel(schedule, group))
      infusionRates.push(scheduler.ratePoint(boundary, 'post-event', { rate: preRate, activeInfusionIds: preActive }))
    } else if (outputSet.has(boundary)) {
      emit(boundary, 'interval', integrator.state, integrator.parameters)
    }
    index += 1
  }

  // 11. Invariants over the reported trajectory.
  //
  // The tolerance scale is the largest mass the run can legitimately hold at
  // any reported instant — initial amounts plus every amount administered —
  // never a constant.
  const scale = Math.max(
    referencePhysicalAmount,
    ...samples.map((s) => referencePhysicalAmount + Math.abs(s.cumulativeInput)),
  )
  const tolerance = massBalanceTolerance(
    scenario.solver,
    diagnosticsAcc.acceptedSteps + diagnosticsAcc.rejectedSteps,
    scale,
  )
  const invariantErrors = checkInvariants(samples, integrator.state, tolerance, scenario.solver)
  if (invariantErrors.length > 0) {
    return { ok: false, model: TWO_COMPARTMENT_MODEL_ID, errors: invariantErrors }
  }

  // 11b. Effect-site sidecar (phase 46), derived from the PK samples the
  // engine actually emitted. Ce is NOT a drug amount: it never enters the
  // state vector, `initialState`, the cumulative input or the mass-balance
  // residual computed above. The series is aligned positionally with
  // `samples`, so duplicate-time pre/post-event rows are preserved in order.
  let effectSiteResult: EffectSiteResult | undefined
  if (effectSite !== undefined) {
    // Ce(startTime) = fu·Cc(startTime, pre-event): the FIRST emitted sample is
    // the initial pre-event state (ADR-25), before any startTime event.
    const first = samples[0]
    if (first === undefined) {
      return {
        ok: false,
        model: TWO_COMPARTMENT_MODEL_ID,
        errors: [
          {
            code: 'MISSING_PARAMETER',
            stage: 'scenario',
            field: 'samples',
            message: 'Effect-site analysis requires at least the initial PK sample.',
          },
        ],
      }
    }
    const initialCe = initialEffectSiteConcentration(
      first.centralConcentration,
      effectSite.unboundFraction,
    )
    const propagated = propagateEffectSite({
      samples: samples.map((sample, index) => ({
        time: sample.time,
        centralConcentration: sample.centralConcentration,
        side: sample.side,
        ...(sample.eventGroup === undefined ? {} : { eventGroup: sample.eventGroup }),
        index,
      })),
      unboundFraction: effectSite.unboundFraction,
      ke0: effectSite.ke0,
      initialCe,
    })
    // A failed propagation publishes NO report at all — never a partial series.
    if (!propagated.ok) {
      return { ok: false, model: TWO_COMPARTMENT_MODEL_ID, errors: propagated.errors }
    }
    effectSiteResult = {
      series: propagated.series.map((entry, index) => {
        const sample = samples[index]
        return {
          time: sample?.time ?? entry.sample.time,
          side: entry.sample.side as SimulationSample['side'],
          ...(entry.sample.eventGroup === undefined ? {} : { eventGroup: entry.sample.eventGroup }),
          effectSiteConcentration: entry.effectSiteConcentration,
          occupancy: receptorOccupancy(entry.effectSiteConcentration, effectSite.kdInPkUnit),
        }
      }),
      unboundFraction: effectSite.unboundFraction,
      ke0: effectSite.ke0,
      kdInPkUnit: effectSite.kdInPkUnit,
      kdConversion: effectSite.kdConversion,
      ...(effectSite.molecularWeightUsed === undefined
        ? {}
        : { molecularWeightUsed: effectSite.molecularWeightUsed }),
      concentrationUnit: PK_CONCENTRATION_UNIT,
      assumptions: EFFECT_SITE_ASSUMPTIONS,
    }
  }

  const diagnostics = finalizeDiagnostics(diagnosticsAcc, scenario.solver)
  const maxAbsResidual = Math.max(...samples.map((s) => Math.abs(s.massBalanceResidual)))

  // 12. Report.
  const normalizedParameters: NormalizedParameter[] = validated.parameters.map((definition) => {
    const factor = canonicalFactor(definition.kind, definition.quantity.unit) ?? 1
    return normalizeParameter(definition.symbol, definition.label, definition.kind, definition.quantity, factor)
  })
  warnings.push(...limitationWarnings(scenario, normalizedParameters, diagnostics))

  const result: SimulationResult = {
    model: {
      id: TWO_COMPARTMENT_DESCRIPTOR.id,
      version: TWO_COMPARTMENT_DESCRIPTOR.version,
      label: TWO_COMPARTMENT_DESCRIPTOR.label,
      equations: TWO_COMPARTMENT_DESCRIPTOR.equations,
      assumptions: TWO_COMPARTMENT_DESCRIPTOR.assumptions,
    },
    scenario,
    startTime: validated.startTime,
    endTime: validated.endTime,
    canonicalTimeUnit: 'h',
    initialState: {
      centralAmount: validated.initialCentral,
      peripheralAmount: validated.initialPeripheral,
      cumulativeEliminated: 0,
      cumulativeInput: 0,
    },
    parameters: normalizedParameters,
    samples,
    infusionRates,
    eventTrace,
    solver: diagnostics,
    massBalance: { maxAbsResidual, tolerance, ok: maxAbsResidual <= tolerance },
    assumptions: TWO_COMPARTMENT_DESCRIPTOR.assumptions,
    warnings,
    ...(effectSiteResult === undefined ? {} : { effectSite: effectSiteResult }),
  }
  return { ok: true, result }
}

interface DiagnosticAccumulator {
  acceptedSteps: number
  rejectedSteps: number
  functionEvaluations: number
  maxAcceptedErrorNorm: number
  minAcceptedStep: number
  maxAcceptedStep: number
}

function accumulate(acc: DiagnosticAccumulator, diagnostics: SolverDiagnostics): void {
  acc.acceptedSteps += diagnostics.acceptedSteps
  acc.rejectedSteps += diagnostics.rejectedSteps
  acc.functionEvaluations += diagnostics.functionEvaluations
  acc.maxAcceptedErrorNorm = Math.max(acc.maxAcceptedErrorNorm, diagnostics.maxAcceptedErrorNorm)
  if (diagnostics.acceptedSteps > 0) {
    acc.minAcceptedStep = Math.min(acc.minAcceptedStep, diagnostics.minAcceptedStep)
    acc.maxAcceptedStep = Math.max(acc.maxAcceptedStep, diagnostics.maxAcceptedStep)
  }
}

function finalizeDiagnostics(acc: DiagnosticAccumulator, settings: SimulationResult['solver']['settings']): SolverDiagnostics {
  return {
    method: 'dormand-prince-rk45',
    settings,
    controller: DEFAULT_SOLVER_CONTROLLER,
    acceptedSteps: acc.acceptedSteps,
    rejectedSteps: acc.rejectedSteps,
    functionEvaluations: acc.functionEvaluations,
    maxAcceptedErrorNorm: acc.maxAcceptedErrorNorm,
    minAcceptedStep: Number.isFinite(acc.minAcceptedStep) ? acc.minAcceptedStep : 0,
    maxAcceptedStep: acc.maxAcceptedStep,
  }
}

/**
 * Mass-balance tolerance, derived from the solver settings and the scale of
 * the administered mass rather than from a fixed percentage:
 *
 *   tol = K · (accepted steps + 1) · (atol + rtol · scale)
 *
 * Each accepted step contributes at most its own local error, and the
 * residual is a sum of those local errors, so a bound proportional to the
 * number of steps is the honest one. K = 50 leaves room for the imperfect
 * cancellation of propagated errors. `scale` is the largest mass the run can
 * legitimately hold (initial amounts, cumulative input), never a constant.
 */
const MASS_BALANCE_STEP_FACTOR = 50

export function massBalanceTolerance(
  settings: SimulationResult['solver']['settings'],
  acceptedSteps: number,
  scale: number,
): number {
  const effectiveScale = Math.max(scale, 1)
  return (
    MASS_BALANCE_STEP_FACTOR *
    (acceptedSteps + 1) *
    (settings.absoluteTolerance + settings.relativeTolerance * effectiveScale)
  )
}

/**
 * Physical invariants checked on every reported sample:
 *  - every reported value is finite (nothing NaN/Infinity reaches a chart);
 *  - amounts and cumulative quantities are not negative beyond a bounded
 *    round-off allowance (the allowance is `atol + rtol·|y|` of that
 *    component — an explicit, documented bound, never a silent clamp);
 *  - the mass-balance residual is inside the derived tolerance.
 */
export function checkInvariants(
  samples: readonly SimulationSample[],
  finalState: OdeState,
  tolerance: number,
  settings: SimulationResult['solver']['settings'],
): readonly SimulationError[] {
  const errors: SimulationError[] = []
  const roundOff = (value: number): number =>
    settings.absoluteTolerance + settings.relativeTolerance * Math.abs(value)

  for (const sample of samples) {
    const values: readonly (readonly [string, number])[] = [
      ['centralAmount', sample.centralAmount],
      ['peripheralAmount', sample.peripheralAmount],
      ['cumulativeEliminated', sample.cumulativeEliminated],
      ['cumulativeInput', sample.cumulativeInput],
      ['centralConcentration', sample.centralConcentration],
      ['peripheralConcentration', sample.peripheralConcentration],
    ]
    for (const [name, value] of values) {
      if (!Number.isFinite(value)) {
        errors.push({
          code: 'INVARIANT_VIOLATION',
          stage: 'invariants',
          field: name,
          message: `${name} is not finite (${String(value)}) at t = ${sample.time} h (${sample.side}).`,
        })
        continue
      }
      if (value < 0) {
        // The bound applies to the sampling-grid value; the internal state is
        // checked separately below at full precision.
        if (Math.abs(value) > roundOff(value)) {
          errors.push({
            code: 'INVARIANT_VIOLATION',
            stage: 'invariants',
            field: name,
            message: `${name} is negative (${value}) at t = ${sample.time} h (${sample.side}), beyond the round-off allowance ${roundOff(value)}.`,
          })
        }
      }
    }
    if (!Number.isFinite(sample.massBalanceResidual)) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        stage: 'invariants',
        field: 'massBalanceResidual',
        message: `The mass-balance residual is not finite at t = ${sample.time} h (${sample.side}).`,
      })
    } else if (Math.abs(sample.massBalanceResidual) > tolerance) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        stage: 'invariants',
        field: 'massBalanceResidual',
        message: `The mass-balance residual ${sample.massBalanceResidual} mg at t = ${sample.time} h exceeds the tolerance ${tolerance} mg.`,
      })
    }
  }

  // Internal state at full precision, component by component.
  for (let i = 0; i < finalState.length; i += 1) {
    const value = finalState[i]
    if (value === undefined || !Number.isFinite(value)) {
      errors.push({
        code: 'NUMERICAL_FAILURE',
        stage: 'solver',
        field: `state[${i}]`,
        message: `The final state component ${i} is not finite (${String(value)}).`,
      })
      continue
    }
    if (value < 0 && Math.abs(value) > roundOff(value)) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        stage: 'invariants',
        field: `state[${i}]`,
        message: `The internal state component ${i} ended negative (${value}) beyond the round-off allowance ${roundOff(value)}.`,
      })
    }
  }
  return errors
}

/** Warnings attached to every successful simulation. */
function limitationWarnings(
  scenario: SimulationScenario,
  parameters: readonly NormalizedParameter[],
  diagnostics: SolverDiagnostics,
): SimulationWarning[] {
  const warnings: SimulationWarning[] = [
    {
      code: 'MODEL_LIMITATION',
      severity: 'info',
      message:
        'Open linear two-compartment IV model: no absorption, metabolism, receptor binding, tissue-specific distribution, brain compartment or effect site.',
    },
    {
      code: 'MODEL_RESULT_NOT_CLINICAL',
      severity: 'warning',
      message:
        'Simulated model trajectory from the supplied parameters and doses; not a prediction of clinical drug exposure or effect.',
    },
  ]
  const converted = parameters.filter((p) => p.conversionFactor !== undefined)
  if (converted.length > 0) {
    warnings.push({
      code: 'UNITS_CONVERTED',
      severity: 'info',
      message: `Converted to canonical units before integration: ${converted
        .map((p) => `${p.symbol} ${p.declaredValue} ${p.declaredUnit} → ${p.canonicalValue} ${p.canonicalUnit}`)
        .join('; ')}.`,
    })
  }
  if (diagnostics.acceptedSteps > 0 && diagnostics.rejectedSteps > diagnostics.acceptedSteps) {
    warnings.push({
      code: 'STEPS_REJECTED',
      severity: 'info',
      message: `The error controller rejected ${diagnostics.rejectedSteps} of ${diagnostics.acceptedSteps + diagnostics.rejectedSteps} step attempts; the system may be stiff for these settings.`,
    })
  }
  if (diagnostics.acceptedSteps > 10000) {
    warnings.push({
      code: 'HIGH_STEP_COUNT',
      severity: 'info',
      message: `${diagnostics.acceptedSteps} accepted steps were needed; check the tolerances and the time horizon.`,
    })
  }
  void scenario
  return warnings
}

export type { ValidatedSchedule }