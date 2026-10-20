/**
 * Adaptive Dormand–Prince Runge–Kutta 5(4) integrator (phase 41).
 *
 * This module is ODE mathematics and nothing else: it knows no pharmacology,
 * no doses, no units and no user interface. It integrates `dy/dt = f(t, y, p)`
 * from a start state to a strictly increasing list of target times, landing
 * exactly on every target.
 *
 * Why double precision (ADR-23): the embedded error estimate of an adaptive
 * Runge–Kutta pair is defined for finite-precision integration; carrying every
 * intermediate through Decimal.js would neither make the estimate more
 * meaningful nor make the method exact. Full double precision is kept
 * throughout — no intermediate is rounded to reporting precision — and every
 * value crossing the API boundary is checked with `Number.isFinite`.
 *
 * Stiffness: this is a non-stiff explicit method. A stiff system makes the
 * controller reject steps until it hits `minStep`, which returns a structured
 * `FAILED_TO_ADVANCE` failure rather than a plausible-looking curve.
 */
import type {
  OdeState,
  OdeSystem,
  SolverControllerSettings,
  SolverDiagnostics,
  SolverOptions,
  SolverRunResult,
  SolverSample,
  SimulationError,
} from './types'

// ---------------------------------------------------------------------------
// Coefficients — the single place the method is spelled out
// ---------------------------------------------------------------------------

/**
 * Dormand–Prince 5(4) tableau (classical HP/DOPRI5 pair).
 *
 * `C` are the stage times; `A[i]` holds the non-zero a_ij of stage i+1;
 * `B5` are the fifth-order weights and `B4` the embedded fourth-order ones.
 * Stage 7 is evaluated at the fifth-order solution (FSAL), so `A[6] === B5`.
 * `E4 = B5 - B4` multiplies the stage derivatives to give the error vector.
 */
const C: readonly number[] = [
  0, // k1
  1 / 5, // k2
  3 / 10, // k3
  4 / 5, // k4
  8 / 9, // k5
  1, // k6
  1, // k7
]

const A: readonly (readonly (readonly [number, number])[])[] = [
  [], // k1
  [[1, 1 / 5]], // k2
  [
    [1, 3 / 40],
    [2, 9 / 40],
  ], // k3
  [
    [1, 44 / 45],
    [2, -56 / 15],
    [3, 32 / 9],
  ], // k4
  [
    [1, 19372 / 6561],
    [2, -25360 / 2187],
    [3, 64448 / 6561],
    [4, -212 / 729],
  ], // k5
  [
    [1, 9017 / 3168],
    [2, -355 / 33],
    [3, 46732 / 5247],
    [4, 49 / 176],
    [5, -5103 / 18656],
  ], // k6
  [
    [1, 35 / 384],
    [2, 0],
    [3, 500 / 1113],
    [4, 125 / 192],
    [5, -2187 / 6784],
    [6, 11 / 84],
  ], // k7 (FSAL)
]

const B5: readonly number[] = [
  35 / 384,
  0,
  500 / 1113,
  125 / 192,
  -2187 / 6784,
  11 / 84,
  0,
]

const B4: readonly number[] = [
  5179 / 57600,
  0,
  7571 / 16695,
  393 / 640,
  -92097 / 339200,
  187 / 2100,
  1 / 40,
]

export const DP54_STAGE_COUNT = 7
export const DP54_STAGE_TIMES: readonly number[] = C
export const DP54_ORDER = 5
export const DP54_EMBEDDED_ORDER = 4

/** b5 − b4 per stage: the error contribution weights. */
export const DP54_ERROR_WEIGHTS: readonly number[] = B5.map((b, i) => b - (B4[i] ?? 0))

// ---------------------------------------------------------------------------
// Controller settings
// ---------------------------------------------------------------------------

/**
 * Step-size controller defaults (numerical, not pharmacological — ADR-23).
 * Documented in `docs/calculation-engine.md` §8.3 and overridable per call.
 */
export const DEFAULT_SOLVER_CONTROLLER: SolverControllerSettings = {
  safetyFactor: 0.9,
  minScaleFactor: 0.2,
  maxScaleFactor: 5,
  zeroErrorScaleFactor: 5,
}

/** Exponent of the local error estimate: order p of the lower-order solution. */
const ERROR_EXPONENT = 1 / (DP54_EMBEDDED_ORDER + 1)

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Path name of a state component: `y[0]`, `y[1]`, ... */
export function stateComponentName(index: number): string {
  return `y[${index}]`
}

/**
 * Validate solver settings. Returns every problem found (all of them, not the
 * first one) in scenario/stage terms the orchestrator can surface directly.
 */
export function validateSolverOptions(
  options: SolverOptions,
  stage: 'scenario' | 'solver' = 'scenario',
): readonly SimulationError[] {
  const errors: SimulationError[] = []
  const finite = (field: string, value: number, what: string): boolean => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({
        code: 'NOT_A_NUMBER',
        stage,
        field,
        message: `${what} must be a finite number (got ${String(value)}).`,
      })
      return false
    }
    return true
  }

  if (finite('solver.absoluteTolerance', options.absoluteTolerance, 'The absolute tolerance')) {
    if (options.absoluteTolerance < 0) {
      errors.push({
        code: 'NEGATIVE_VALUE',
        stage,
        field: 'solver.absoluteTolerance',
        message: `The absolute tolerance must be 0 or greater (got ${options.absoluteTolerance}).`,
      })
    }
  }
  if (finite('solver.relativeTolerance', options.relativeTolerance, 'The relative tolerance')) {
    if (options.relativeTolerance <= 0) {
      errors.push({
        code: options.relativeTolerance < 0 ? 'NEGATIVE_VALUE' : 'ZERO_NOT_ALLOWED',
        stage,
        field: 'solver.relativeTolerance',
        message: `The relative tolerance must be greater than 0 (got ${options.relativeTolerance}).`,
      })
    }
  }
  if (options.absoluteTolerance === 0 && options.relativeTolerance > 0 && Number.isFinite(options.relativeTolerance)) {
    errors.push({
      code: 'CONFLICTING_PARAMETERS',
      stage,
      field: 'solver.absoluteTolerance',
      message:
        'An absolute tolerance of 0 with a positive relative tolerance cannot control a state component that stays at 0.',
    })
  }
  if (finite('solver.initialStep', options.initialStep, 'The initial step')) {
    if (options.initialStep <= 0) {
      errors.push({
        code: options.initialStep < 0 ? 'NEGATIVE_VALUE' : 'ZERO_NOT_ALLOWED',
        stage,
        field: 'solver.initialStep',
        message: `The initial step must be greater than 0 (got ${options.initialStep}).`,
      })
    }
  }
  if (finite('solver.minStep', options.minStep, 'The minimum step')) {
    if (options.minStep <= 0) {
      errors.push({
        code: options.minStep < 0 ? 'NEGATIVE_VALUE' : 'ZERO_NOT_ALLOWED',
        stage,
        field: 'solver.minStep',
        message: `The minimum step must be greater than 0 (got ${options.minStep}).`,
      })
    }
  }
  if (finite('solver.maxStep', options.maxStep, 'The maximum step')) {
    if (options.maxStep <= 0) {
      errors.push({
        code: options.maxStep < 0 ? 'NEGATIVE_VALUE' : 'ZERO_NOT_ALLOWED',
        stage,
        field: 'solver.maxStep',
        message: `The maximum step must be greater than 0 (got ${options.maxStep}).`,
      })
    }
  }
  if (finite('solver.maxSteps', options.maxSteps, 'The step budget')) {
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
      errors.push({
        code: 'OUT_OF_RANGE',
        stage,
        field: 'solver.maxSteps',
        message: `The step budget must be a positive integer (got ${options.maxSteps}).`,
      })
    }
  }

  // Cross-field ordering only once both sides are individually valid.
  const stepsValid = errors.every(
    (e) => e.field !== 'solver.initialStep' && e.field !== 'solver.minStep' && e.field !== 'solver.maxStep',
  )
  if (stepsValid) {
    if (options.minStep > options.maxStep) {
      errors.push({
        code: 'CONFLICTING_PARAMETERS',
        stage,
        field: 'solver.minStep',
        message: `The minimum step (${options.minStep}) must not exceed the maximum step (${options.maxStep}).`,
      })
    } else if (options.initialStep > options.maxStep || options.initialStep < options.minStep) {
      errors.push({
        code: 'CONFLICTING_PARAMETERS',
        stage,
        field: 'solver.initialStep',
        message: `The initial step (${options.initialStep}) must lie within [${options.minStep}, ${options.maxStep}].`,
      })
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

/** Options of one integration run (settings + optional controller override). */
export interface IntegrateOptions {
  readonly settings: SolverOptions
  /** Controller constants; defaults to `DEFAULT_SOLVER_CONTROLLER`. */
  readonly controller?: SolverControllerSettings
}

export interface IntegrateRequest<Parameters> {
  readonly system: OdeSystem<Parameters>
  readonly parameters: Parameters
  readonly startTime: number
  readonly startState: OdeState
  /** Strictly increasing, strictly greater than `startTime`. */
  readonly targets: readonly number[]
}

export type IntegrateOutcome<Parameters> =
  | { readonly ok: true; readonly run: SolverRunResult; readonly parameters: Parameters }
  | { readonly ok: false; readonly errors: readonly SimulationError[] }

/**
 * A mutable integration context. `parameters` and `time` may be replaced by
 * the caller between `integrate` calls (a dosing event changes the infusion
 * rate); the cached FSAL derivative is only ever reused when the caller
 * declares the system unchanged.
 */
export interface Integrator<Parameters> {
  /** Current time of the carried state. */
  readonly time: number
  /**
   * Current state. Assignable only by the orchestrator, which replaces it
   * with the post-event state of an instantaneous jump (a bolus).
   */
  state: OdeState
  /** Current model parameters. */
  parameters: Parameters
  /** Total derivative evaluations so far, across calls. */
  readonly functionEvaluations: number
  /**
   * Defensive copy of the carried state. Callers that record samples MUST use
   * it: `state` returns the live array that the next step overwrites.
   */
  snapshot(): OdeState
  /**
   * Integrate to each target in order, landing on each exactly.
   * `hasCachedDerivative`: true when the derivative at (time, state) with
   * the CURRENT parameters is already known (FSAL from the previous call).
   * A dosing event MUST pass false — a cached derivative computed before an
   * infusion change belongs to a different right-hand side.
   */
  integrate(
    targets: readonly number[],
    hasCachedDerivative: boolean,
  ): { readonly ok: true; readonly samples: readonly SolverSample[]; readonly diagnostics: SolverDiagnostics } | { readonly ok: false; readonly errors: readonly SimulationError[] }
}

/**
 * Create an integrator.
 *
 * Validates everything the method depends on BEFORE the first derivative is
 * evaluated: settings, dimensions, start time/state finiteness, target
 * ordering. Problems return `ok: false`; nothing is thrown.
 */
export function createIntegrator<Parameters>(
  request: IntegrateRequest<Parameters>,
  options: IntegrateOptions,
): { readonly ok: true; readonly integrator: Integrator<Parameters> } | { readonly ok: false; readonly errors: readonly SimulationError[] } {
  const settings = options.settings
  const controller = options.controller ?? DEFAULT_SOLVER_CONTROLLER
  const errors: SimulationError[] = []

  errors.push(...validateSolverOptions(settings, 'solver'))
  validateController(controller, errors)

  const { system, startState, startTime, targets } = request
  const dimension = system.dimension
  if (!Number.isInteger(dimension) || dimension < 1) {
    errors.push({
      code: 'INCONSISTENT_DERIVATIVE_DIMENSION',
      stage: 'model',
      field: 'system.dimension',
      message: `An ODE system must declare a positive integer dimension (got ${String(dimension)}).`,
    })
  }
  if (startState.length !== dimension) {
    errors.push({
      code: 'INCONSISTENT_DERIVATIVE_DIMENSION',
      stage: 'model',
      field: 'state',
      message: `The initial state has ${startState.length} component(s); the system declares ${dimension}.`,
    })
  }
  for (let i = 0; i < startState.length; i += 1) {
    const value = startState[i]
    if (value === undefined || !Number.isFinite(value)) {
      errors.push({
        code: 'NUMERICAL_FAILURE',
        stage: 'solver',
        field: `state.${stateComponentName(i)}`,
        message: `The initial state component ${stateComponentName(i)} is not finite (${String(value)}).`,
      })
    }
  }
  if (!Number.isFinite(startTime)) {
    errors.push({
      code: 'NOT_A_NUMBER',
      stage: 'solver',
      field: 'startTime',
      message: `The start time must be finite (got ${String(startTime)}).`,
    })
  }
  let previous = startTime
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]
    const name = `targets[${i}]`
    if (target === undefined || !Number.isFinite(target)) {
      errors.push({
        code: 'NOT_A_NUMBER',
        stage: 'solver',
        field: name,
        message: `Target ${name} must be a finite time (got ${String(target)}).`,
      })
      previous = Number.NaN
      continue
    }
    if (!(target > previous)) {
      errors.push({
        code: 'OUT_OF_RANGE',
        stage: 'solver',
        field: name,
        message: `Targets must strictly increase; ${name} = ${target} is not after ${previous}.`,
      })
    }
    previous = target
  }

  if (errors.length > 0) return { ok: false, errors }

  // ---- mutable integration context ---------------------------------------
  const { absoluteTolerance: atol, relativeTolerance: rtol, minStep, maxStep, maxSteps } = settings
  let time = startTime
  let state: OdeState = startState.slice()
  let parameters = request.parameters
  let evaluations = 0
  /** FSAL derivative at (time, state) for the current parameters, if known. */
  let cachedDerivative: OdeState | undefined

  const derivativeAt = (t: number, y: OdeState): OdeState => {
    const d = system.derivative(t, y, parameters)
    evaluations += 1
    if (d.length !== dimension) {
      throw new DerivativeDimensionError(d.length)
    }
    for (let i = 0; i < d.length; i += 1) {
      const value = d[i]
      if (value === undefined || !Number.isFinite(value)) {
        throw new NonFiniteDerivativeError(i, value)
      }
    }
    return d
  }

  /** Try the step to (time+h) from (time, y0) with derivative k1 known. */
  const attempt = (
    y0: OdeState,
    k1: OdeState,
    h: number,
  ):
    | { readonly accepted: true; readonly y5: OdeState; readonly k7: OdeState; readonly errorNorm: number }
    | { readonly accepted: false; readonly errorNorm: number }
    | { readonly nonFinite: true } => {
    const stages: OdeState[] = [k1]
    for (let s = 1; s < DP54_STAGE_COUNT; s += 1) {
      const row = A[s] ?? []
      const yStage: number[] = new Array<number>(dimension)
      for (let i = 0; i < dimension; i += 1) {
        let sum = y0[i] ?? 0
        for (const [j, a] of row) {
          if (a === 0) continue
          sum += h * a * (stages[j - 1]?.[i] ?? 0)
        }
        yStage[i] = sum
      }
      stages.push(derivativeAt(time + h * (C[s] ?? 0), yStage))
    }
    const y5 = new Array<number>(dimension)
    const k7 = stages[6] ?? []
    for (let i = 0; i < dimension; i += 1) {
      let sum = y0[i] ?? 0
      for (let s = 0; s < DP54_STAGE_COUNT; s += 1) {
        const b = B5[s] ?? 0
        if (b === 0) continue
        sum += h * b * (stages[s]?.[i] ?? 0)
      }
      y5[i] = sum
    }
    // Normalized RMS error over the state components.
    let sumSquares = 0
    for (let i = 0; i < dimension; i += 1) {
      let errorSum = 0
      for (let s = 0; s < DP54_STAGE_COUNT; s += 1) {
        const w = DP54_ERROR_WEIGHTS[s] ?? 0
        if (w === 0) continue
        errorSum += w * (stages[s]?.[i] ?? 0)
      }
      const e = h * errorSum
      const y0i = y0[i] ?? 0
      const y5i = y5[i] ?? 0
      if (!Number.isFinite(y5i)) return { nonFinite: true }
      const scale = atol + rtol * Math.max(Math.abs(y0i), Math.abs(y5i))
      const normalized = e / scale
      if (!Number.isFinite(normalized)) return { nonFinite: true }
      sumSquares += normalized * normalized
    }
    const errorNorm = Math.sqrt(sumSquares / dimension)
    if (!Number.isFinite(errorNorm)) return { nonFinite: true }
    if (errorNorm <= 1) return { accepted: true, y5, k7, errorNorm }
    return { accepted: false, errorNorm }
  }

  const nextStepFactor = (errorNorm: number, previousFactor: number): number => {
    const raw = errorNorm === 0 ? controller.zeroErrorScaleFactor : controller.safetyFactor * Math.pow(errorNorm, -ERROR_EXPONENT)
    const bounded = Math.min(controller.maxScaleFactor, Math.max(controller.minScaleFactor, raw))
    // Never let a rejected step grow the step size (classic controller guard).
    return Math.min(bounded, previousFactor)
  }

  const integrate = (
    targetList: readonly number[],
    hasCachedDerivative: boolean,
  ): { readonly ok: true; readonly samples: readonly SolverSample[]; readonly diagnostics: SolverDiagnostics } | { readonly ok: false; readonly errors: readonly SimulationError[] } => {
    const samples: SolverSample[] = []
    let acceptedSteps = 0
    let rejectedSteps = 0
    let maxErrorNorm = 0
    let minAccepted = Number.POSITIVE_INFINITY
    let maxAccepted = 0
    const evaluationsAtStart = evaluations

    let k1: OdeState | undefined = hasCachedDerivative ? cachedDerivative : undefined
    let h = Math.min(maxStep, Math.max(minStep, settings.initialStep))

    for (let t = 0; t < targetList.length; t += 1) {
      const target = targetList[t] ?? Number.NaN
      const targetName = `targets[${t}]`
      if (!Number.isFinite(target) || !(target > time)) {
        return {
          ok: false,
          errors: [
            {
              code: 'OUT_OF_RANGE',
              stage: 'solver',
              field: targetName,
              message: `The target ${targetName} = ${target} is not after the current time ${time}.`,
            },
          ],
        }
      }
      let guard = 0
      while (time < target) {
        if (guard >= maxSteps) {
          return {
            ok: false,
            errors: [
              {
                code: 'MAX_STEPS_EXCEEDED',
                stage: 'solver',
                field: targetName,
                message: `The step budget of ${maxSteps} was exhausted before reaching ${targetName} = ${target} (current time ${time}).`,
              },
            ],
          }
        }
        guard += 1

        const remaining = target - time
        // Clip to the target; the last part of the interval must land exactly.
        let step = Math.min(h, remaining)
        if (!(step > 0)) {
          return {
            ok: false,
            errors: [
              {
                code: 'FAILED_TO_ADVANCE',
                stage: 'solver',
                field: targetName,
                message: `Time cannot advance from ${time} towards ${target} in double precision.`,
              },
            ],
          }
        }

        try {
          if (k1 === undefined) k1 = derivativeAt(time, state)
          const outcome = attempt(state, k1, step)
          if ('nonFinite' in outcome) {
            return {
              ok: false,
              errors: [
                {
                  code: 'NUMERICAL_FAILURE',
                  stage: 'solver',
                  field: targetName,
                  message: `Non-finite values at time ${time} (step ${step}); the model became unrepresentable.`,
                },
              ],
            }
          }
          if (outcome.accepted) {
            const nextTime = time + step
            if (!(nextTime > time) || !Number.isFinite(nextTime)) {
              return {
                ok: false,
                errors: [
                  {
                    code: 'FAILED_TO_ADVANCE',
                    stage: 'solver',
                    field: targetName,
                    message: `The step ${step} from ${time} does not advance time in double precision.`,
                  },
                ],
              }
            }
            state = outcome.y5
            time = nextTime
            cachedDerivative = outcome.k7
            k1 = outcome.k7
            acceptedSteps += 1
            maxErrorNorm = Math.max(maxErrorNorm, outcome.errorNorm)
            minAccepted = Math.min(minAccepted, step)
            maxAccepted = Math.max(maxAccepted, step)

            // Land exactly on the target rather than a rounded equivalent.
            const reached = time >= target
            if (reached) time = target
            h = Math.min(maxStep, Math.max(minStep, step * nextStepFactor(outcome.errorNorm, controller.maxScaleFactor)))
            if (reached) {
              samples.push({ time, state: state.slice() })
              break
            }
          } else {
            rejectedSteps += 1
            k1 = undefined
            const shrunk = step * nextStepFactor(outcome.errorNorm, 1)
            if (shrunk < minStep) {
              return {
                ok: false,
                errors: [
                  {
                    code: 'FAILED_TO_ADVANCE',
                    stage: 'solver',
                    field: targetName,
                    message: `The error controller needs a step below the minimum step ${minStep} at time ${time} (error norm ${outcome.errorNorm}).`,
                  },
                ],
              }
            }
            if (!(shrunk < step)) {
              return {
                ok: false,
                errors: [
                  {
                    code: 'FAILED_TO_ADVANCE',
                    stage: 'solver',
                    field: targetName,
                    message: `The error controller cannot shrink the step ${step} at time ${time}.`,
                  },
                ],
              }
            }
            h = shrunk
          }
        } catch (error) {
          if (error instanceof DerivativeDimensionError) {
            return {
              ok: false,
              errors: [
                {
                  code: 'INCONSISTENT_DERIVATIVE_DIMENSION',
                  stage: 'model',
                  field: targetName,
                  message: `The model returned ${error.actual} derivative component(s) for a ${dimension}-dimensional state.`,
                },
              ],
            }
          }
          if (error instanceof NonFiniteDerivativeError) {
            return {
              ok: false,
              errors: [
                {
                  code: 'NUMERICAL_FAILURE',
                  stage: 'solver',
                  field: `derivative.${stateComponentName(error.index)}`,
                  message: `The derivative component ${stateComponentName(error.index)} became non-finite (${String(error.value)}) at time ${time}.`,
                },
              ],
            }
          }
          throw error
        }
      }
    }

    const diagnostics: SolverDiagnostics = {
      method: 'dormand-prince-rk45',
      settings,
      controller,
      acceptedSteps,
      rejectedSteps,
      functionEvaluations: evaluations - evaluationsAtStart,
      maxAcceptedErrorNorm: maxErrorNorm,
      minAcceptedStep: acceptedSteps > 0 ? minAccepted : 0,
      maxAcceptedStep: maxAccepted,
    }
    return { ok: true, samples, diagnostics }
  }

  const integrator: Integrator<Parameters> = {
    get time(): number {
      return time
    },
    get state(): OdeState {
      return state
    },
    set state(next: OdeState) {
      if (next.length !== dimension) {
        throw new Error(
          `simulation: cannot replace a ${dimension}-dimensional state with ${next.length} component(s)`,
        )
      }
      state = next.slice()
      // A replaced state has no derivative history at all.
      cachedDerivative = undefined
    },
    get parameters(): Parameters {
      return parameters
    },
    set parameters(next: Parameters) {
      parameters = next
    },
    get functionEvaluations(): number {
      return evaluations
    },
    snapshot(): OdeState {
      return state.slice()
    },
    integrate,
  }
  return { ok: true, integrator }
}

function validateController(controller: SolverControllerSettings, errors: SimulationError[]): void {
  const check = (field: string, value: number, ok: (v: number) => boolean, message: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !ok(value)) {
      errors.push({ code: 'OUT_OF_RANGE', stage: 'solver', field, message })
    }
  }
  check(
    'controller.safetyFactor',
    controller.safetyFactor,
    (v) => v > 0 && v <= 1,
    'The safety factor must lie in (0, 1].',
  )
  check(
    'controller.minScaleFactor',
    controller.minScaleFactor,
    (v) => v > 0 && v <= 1,
    'The minimum scale factor must lie in (0, 1].',
  )
  check(
    'controller.maxScaleFactor',
    controller.maxScaleFactor,
    (v) => v >= 1,
    'The maximum scale factor must be 1 or greater.',
  )
  check(
    'controller.zeroErrorScaleFactor',
    controller.zeroErrorScaleFactor,
    (v) => v >= 1 && v <= controller.maxScaleFactor,
    'The zero-error scale factor must lie in [1, maxScaleFactor].',
  )
}

/** Programmer-error signals raised inside the integration loop. */
class DerivativeDimensionError extends Error {
  readonly actual: number
  constructor(actual: number) {
    super('derivative dimension mismatch')
    this.actual = actual
  }
}

class NonFiniteDerivativeError extends Error {
  readonly index: number
  readonly value: number | undefined
  constructor(index: number, value: number | undefined) {
    super('non-finite derivative')
    this.index = index
    this.value = value
  }
}

/**
 * Convenience wrapper: integrate once from a start state to increasing targets.
 * Returns a read-only run result or structured errors.
 */
export function integrate<Parameters>(
  request: Omit<IntegrateRequest<Parameters>, 'parameters'> & { readonly parameters: Parameters },
  options: IntegrateOptions,
): IntegrateOutcome<Parameters> {
  // Integrating from a start state implies the system is already in force at
  // that state. Two calls with different parameters would otherwise chain
  // silently (the second call's targets would start mid-reaction), so the
  // start must be an explicit target rather than an implicit zero-length step.
  const first = request.targets[0]
  if (first === undefined || !(first > request.startTime)) {
    return {
      ok: false,
      errors: [
        {
          code: 'OUT_OF_RANGE',
          stage: 'solver',
          field: 'targets[0]',
          message: `integrate() needs a first target strictly after startTime (${request.startTime}); got ${String(first)}.`,
        },
      ],
    }
  }
  const created = createIntegrator(request, options)
  if (!created.ok) return created
  const run = created.integrator.integrate(request.targets, false)
  if (!run.ok) return run
  return {
    ok: true,
    run: {
      samples: run.samples,
      diagnostics: run.diagnostics,
      finalState: created.integrator.state,
      finalTime: created.integrator.time,
    },
    parameters: request.parameters,
  }
}
