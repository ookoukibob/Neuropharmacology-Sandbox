import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOLVER_CONTROLLER,
  DP54_ERROR_WEIGHTS,
  DP54_STAGE_COUNT,
  createIntegrator,
  integrate,
  validateSolverOptions,
} from './solver'
import type { OdeState, OdeSystem, SolverOptions } from './types'

/**
 * Independent oracles: every expected value below comes from closed-form
 * mathematics (or a hand-computable limit), never from this implementation.
 */

const SETTINGS: SolverOptions = {
  absoluteTolerance: 1e-10,
  relativeTolerance: 1e-10,
  initialStep: 0.1,
  minStep: 1e-14,
  maxStep: 0.5,
  maxSteps: 100000,
}

const GRID = (start: number, end: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => start + ((end - start) * i) / (count - 1))

/** dy/dt = a: y(t) = y0 + a·t (independent of the step sequence). */
const constantSystem: OdeSystem<{ a: number }> = {
  dimension: 1,
  derivative: (_t, _y, p) => [p.a],
}

/** dy/dt = -k·y: y(t) = y0·e^(-k·t). */
const decaySystem: OdeSystem<{ k: number }> = {
  dimension: 1,
  derivative: (_t, y, p) => [-(p.k) * (y[0] ?? 0)],
}

/**
 * Coupled linear system with a known solution and no trivial fixpoint:
 *
 *   y1' = -k1·y1
 *   y2' =  k1·y1 - k2·y2
 *
 *   y1(t) = y1(0)·e^(−k1 t)
 *   y2(t) = y2(0)·e^(−k2 t) + k1·y1(0)·(e^(−k1 t) − e^(−k2 t)) / (k2 − k1)
 */
const coupledSystem: OdeSystem<{ k1: number; k2: number }> = {
  dimension: 2,
  derivative: (_t, y, p) => {
    const y1 = y[0] ?? 0
    const y2 = y[1] ?? 0
    return [-p.k1 * y1, p.k1 * y1 - p.k2 * y2]
  },
}

const coupledExact = (t: number, y10: number, y20: number, k1: number, k2: number): [number, number] => [
  y10 * Math.exp(-k1 * t),
  y20 * Math.exp(-k2 * t) + (k1 * y10 * (Math.exp(-k1 * t) - Math.exp(-k2 * t))) / (k2 - k1),
]

describe('Dormand–Prince 5(4) coefficients', () => {
  it('satisfies the consistency conditions row-sum and weight-sum = 1', () => {
    // Row sums of A equal c (plus 0 for the first stage); b5 and b4 sum to 1.
    const A_ROWS: readonly (readonly number[])[] = [
      [],
      [1 / 5],
      [3 / 40, 9 / 40],
      [44 / 45, -56 / 15, 32 / 9],
      [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
      [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
      [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
    ]
    const C_VALUES = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1]
    A_ROWS.forEach((row, i) => {
      const sum = row.reduce((acc, v) => acc + v, 0)
      expect(sum).toBeCloseTo(C_VALUES[i] ?? Number.NaN, 14)
    })
    const B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0]
    const B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40]
    expect(B5.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14)
    expect(B4.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14)
    // The error weights are exactly b5 − b4 and sum to 0 (order ≥ 1).
    expect(DP54_STAGE_COUNT).toBe(7)
    expect(DP54_ERROR_WEIGHTS.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 15)
  })
})

describe('integrate — analytical single-component cases', () => {
  it('integrates a constant derivative exactly against y(t) = y0 + a·t', () => {
    const targets = GRID(0.5, 10, 11)
    const outcome = integrate(
      { system: constantSystem, parameters: { a: 2.5 }, startTime: 0, startState: [1], targets },
      { settings: SETTINGS },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    outcome.run.samples.forEach((sample, i) => {
      const t = targets[i] ?? Number.NaN
      expect(sample.time).toBe(t) // landed exactly
      expect(Math.abs((sample.state[0] ?? 0) - (1 + 2.5 * t))).toBeLessThanOrEqual(1e-12)
    })
  })

  it('reproduces exponential decay to tolerance and lands on every target', () => {
    const targets = GRID(0.5, 24, 48)
    const outcome = integrate(
      { system: decaySystem, parameters: { k: 0.2 }, startTime: 0, startState: [100], targets },
      { settings: { ...SETTINGS, maxStep: 1 } },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.samples).toHaveLength(targets.length)
    outcome.run.samples.forEach((sample, i) => {
      const t = targets[i] ?? Number.NaN
      const exact = 100 * Math.exp(-0.2 * t)
      expect(sample.time).toBe(t)
      // Relative/absolute tolerance is respected by construction of the
      // controller; assert a margin well inside it.
      expect(Math.abs((sample.state[0] ?? 0) - exact)).toBeLessThanOrEqual(1e-8 * Math.max(1, exact))
    })
    expect(outcome.run.finalTime).toBe(targets[targets.length - 1])
  })

  it('solves the coupled two-component system against its closed form', () => {
    const k1 = 0.7
    const k2 = 0.05
    const targets = GRID(0.5, 12, 24)
    const outcome = integrate(
      {
        system: coupledSystem,
        parameters: { k1, k2 },
        startTime: 0,
        startState: [80, 0],
        targets,
      },
      { settings: { ...SETTINGS, maxStep: 0.5 } },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    outcome.run.samples.forEach((sample, i) => {
      const [exact1, exact2] = coupledExact(targets[i] ?? Number.NaN, 80, 0, k1, k2)
      expect(Math.abs((sample.state[0] ?? 0) - exact1)).toBeLessThanOrEqual(1e-7 * Math.max(1, Math.abs(exact1)))
      expect(Math.abs((sample.state[1] ?? 0) - exact2)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(exact2)))
    })
  })

  it('integrates the quarter circle to give π (an order-sensitive oracle)', () => {
    // y1' = -y2, y2' = y1 with y(0) = (1, 0): y1 = cos t, y2 = sin t,
    // and 2·y2(π/2) = 2 = ... the classic check is 2·y2(2) ≈ 2·sin 2.
    const circle: OdeSystem<null> = {
      dimension: 2,
      derivative: (_t, y) => [-(y[1] ?? 0), y[0] ?? 0],
    }
    const outcome = integrate(
      { system: circle, parameters: null, startTime: 0, startState: [1, 0], targets: [Math.PI] },
      { settings: { ...SETTINGS, maxStep: 0.25 } },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const last = outcome.run.samples[0]
    expect(last?.state[0]).toBeCloseTo(-1, 9) // cos π
    expect(Math.abs(last?.state[1] ?? Number.NaN)).toBeLessThan(1e-9) // sin π
  })
})

describe('integrate — adaptive error control', () => {
  it('tightening the tolerances reduces the error against the exact solution', () => {
    const exact = (t: number): number => 100 * Math.exp(-0.2 * t)
    // A coarse tolerance is released by the `maxStep` cap (one step per
    // hour is already accurate to ~1e-7 here), so the contrast starts where
    // the controller actually binds.
    const errors = [1e-8, 1e-10, 1e-12].map((tol) => {
      const outcome = integrate(
        { system: decaySystem, parameters: { k: 0.2 }, startTime: 0, startState: [100], targets: [24] },
        { settings: { ...SETTINGS, absoluteTolerance: tol, relativeTolerance: tol, maxStep: 1 } },
      )
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return Number.NaN
      return Math.abs((outcome.run.samples[0]?.state[0] ?? 0) - exact(24))
    })
    const [e8, e10, e12] = errors
    expect(e10 ?? Number.NaN).toBeLessThan(e8 ?? Number.NaN)
    expect(e12 ?? Number.NaN).toBeLessThan(e10 ?? Number.NaN)
    // Fifth order: two extra digits per two orders of tolerance, generously.
    expect(e12 ?? Number.NaN).toBeLessThan((e8 ?? Number.NaN) / 100)
  })

  it('adapts the step size (accepted steps are not one per output target)', () => {
    const targets = GRID(0.5, 10, 3) // only three targets; many internal steps
    const outcome = integrate(
      { system: decaySystem, parameters: { k: 1 }, startTime: 0, startState: [1], targets },
      { settings: { ...SETTINGS, maxStep: 10 } },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.diagnostics.acceptedSteps).toBeGreaterThan(3)
    expect(outcome.run.diagnostics.maxAcceptedStep).toBeGreaterThan(outcome.run.diagnostics.minAcceptedStep)
    expect(outcome.run.diagnostics.rejectedSteps).toBeGreaterThan(0)
  })

  it('cuts the step at a target instead of stepping past it', () => {
    const outcome = integrate(
      { system: decaySystem, parameters: { k: 1 }, startTime: 0, startState: [1], targets: [0.003, 0.007] },
      { settings: { ...SETTINGS, maxStep: 5 } },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.run.samples.map((s) => s.time)).toEqual([0.003, 0.007])
    // First accepted step was clipped to the first target.
    expect(outcome.run.diagnostics.maxAcceptedStep).toBeLessThanOrEqual(0.007)
  })
})

describe('integrate — invalid configuration is data, not an exception', () => {
  const valid = { system: decaySystem, parameters: { k: 1 }, startTime: 0, startState: [1], targets: [1] }

  it('rejects non-finite and non-positive tolerances', () => {
    for (const tolerance of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const errors = validateSolverOptions({ ...SETTINGS, absoluteTolerance: tolerance })
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]?.stage).toBe('scenario')
    }
    expect(validateSolverOptions({ ...SETTINGS, relativeTolerance: 0 })[0]?.code).toBe('ZERO_NOT_ALLOWED')
    expect(
      validateSolverOptions({ ...SETTINGS, absoluteTolerance: 0, relativeTolerance: 1e-6 })[0]?.code,
    ).toBe('CONFLICTING_PARAMETERS')
  })

  it('rejects non-positive or misordered step settings and a bad budget', () => {
    expect(validateSolverOptions({ ...SETTINGS, initialStep: 0 })[0]?.code).toBe('ZERO_NOT_ALLOWED')
    expect(validateSolverOptions({ ...SETTINGS, minStep: -1 })[0]?.code).toBe('NEGATIVE_VALUE')
    expect(validateSolverOptions({ ...SETTINGS, minStep: 1, maxStep: 0.5 })[0]?.code).toBe('CONFLICTING_PARAMETERS')
    expect(validateSolverOptions({ ...SETTINGS, initialStep: 2, maxStep: 1 })[0]?.code).toBe(
      'CONFLICTING_PARAMETERS',
    )
    expect(validateSolverOptions({ ...SETTINGS, maxSteps: 0 })[0]?.code).toBe('OUT_OF_RANGE')
    expect(validateSolverOptions({ ...SETTINGS, maxSteps: 2.5 })[0]?.code).toBe('OUT_OF_RANGE')
    expect(validateSolverOptions({ ...SETTINGS, maxStep: Number.NaN })[0]?.code).toBe('NOT_A_NUMBER')
  })

  it('rejects unordered, non-finite or non-increasing targets before integrating', () => {
    const backwards = createIntegrator({ ...valid, targets: [1, 0.5] }, { settings: SETTINGS })
    expect(backwards.ok).toBe(false)
    if (!backwards.ok) expect(backwards.errors[0]?.code).toBe('OUT_OF_RANGE')

    const repeated = createIntegrator({ ...valid, targets: [1, 1] }, { settings: SETTINGS })
    expect(repeated.ok).toBe(false)

    const behindStart = createIntegrator({ ...valid, startTime: 5, targets: [4] }, { settings: SETTINGS })
    expect(behindStart.ok).toBe(false)

    const notFinite = createIntegrator({ ...valid, targets: [Number.NaN] }, { settings: SETTINGS })
    expect(notFinite.ok).toBe(false)
    if (!notFinite.ok) expect(notFinite.errors[0]?.code).toBe('NOT_A_NUMBER')
  })

  it('rejects a start state that is not finite or has the wrong length', () => {
    const wrongLength = createIntegrator({ ...valid, startState: [1, 2] }, { settings: SETTINGS })
    expect(wrongLength.ok).toBe(false)
    if (!wrongLength.ok) expect(wrongLength.errors[0]?.code).toBe('INCONSISTENT_DERIVATIVE_DIMENSION')

    const notFinite = createIntegrator({ ...valid, startState: [Number.POSITIVE_INFINITY] }, { settings: SETTINGS })
    expect(notFinite.ok).toBe(false)
    if (!notFinite.ok) expect(notFinite.errors[0]?.code).toBe('NUMERICAL_FAILURE')
  })

  it('reports a derivative of the wrong length as an implementation error', () => {
    const broken: OdeSystem<null> = { dimension: 2, derivative: () => [1] }
    const outcome = integrate(
      { system: broken, parameters: null, startTime: 0, startState: [0, 0], targets: [1] },
      { settings: SETTINGS },
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.errors[0]?.code).toBe('INCONSISTENT_DERIVATIVE_DIMENSION')
      expect(outcome.errors[0]?.stage).toBe('model')
    }
  })

  it('reports non-finite derivative values as a numerical failure', () => {
    // y' = y² with y(0) = 1 has a genuine finite-time singularity at t = 1;
    // the stages overflow to ±Infinity long before the target.
    const overflow: OdeSystem<null> = { dimension: 1, derivative: (_t, y) => [(y[0] ?? 0) ** 2] }
    const overflowOutcome = integrate(
      { system: overflow, parameters: null, startTime: 0, startState: [1], targets: [100] },
      { settings: SETTINGS },
    )
    expect(overflowOutcome.ok).toBe(false)
    if (!overflowOutcome.ok) {
      expect(overflowOutcome.errors[0]?.stage).toBe('solver')
    }

    const nanDerivative: OdeSystem<null> = { dimension: 1, derivative: () => [Number.NaN] }
    const nanOutcome = integrate(
      { system: nanDerivative, parameters: null, startTime: 0, startState: [1], targets: [1] },
      { settings: SETTINGS },
    )
    expect(nanOutcome.ok).toBe(false)
    if (!nanOutcome.ok) expect(nanOutcome.errors[0]?.code).toBe('NUMERICAL_FAILURE')
  })

  it('fails with MAX_STEPS_EXCEEDED when the budget is exhausted', () => {
    const outcome = integrate(
      { system: decaySystem, parameters: { k: 1 }, startTime: 0, startState: [1], targets: [100] },
      { settings: { ...SETTINGS, maxSteps: 3, absoluteTolerance: 1e-14, relativeTolerance: 1e-14 } },
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.errors[0]?.code).toBe('MAX_STEPS_EXCEEDED')
  })

  it('fails with FAILED_TO_ADVANCE at a floating-point time wall', () => {
    // Near 1e17 the double spacing is 16 and the controller's steps stay far
    // below it (initial 2, max 4): the difference 1e17 + 64 − 1e17 is real,
    // but no admissible step can reach it, so the solver must stop.
    const big = 1e17
    const target = big + 64
    expect(target - big).toBe(64)
    expect(big + 1).toBe(big) // a step of 1 is invisible at this magnitude
    const outcome = integrate(
      { system: constantSystem, parameters: { a: 1 }, startTime: big, startState: [0], targets: [target] },
      { settings: { ...SETTINGS, minStep: 1, maxStep: 4, initialStep: 2 } },
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.errors[0]?.code).toBe('FAILED_TO_ADVANCE')
  })

  it('never reports success after a failure', () => {
    const outcome = integrate(
      { system: decaySystem, parameters: { k: 1 }, startTime: 0, startState: [1], targets: [100] },
      { settings: { ...SETTINGS, maxSteps: 2 } },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome).not.toHaveProperty('run')
  })
})

describe('integrate — determinism, immutability and FSAL', () => {
  it('produces identical results on repeated runs', () => {
    const runOnce = (): unknown =>
      integrate(
        { system: coupledSystem, parameters: { k1: 0.4, k2: 0.1 }, startTime: 0, startState: [5, 1], targets: GRID(0, 8, 9) },
        { settings: SETTINGS },
      )
    expect(runOnce()).toEqual(runOnce())
  })

  it('does not mutate the caller-owned start state or parameters', () => {
    const startState: OdeState = Object.freeze([10, 2])
    const parameters = Object.freeze({ k1: 0.4, k2: 0.1 })
    const targets = Object.freeze([1, 2, 3])
    const outcome = integrate({ system: coupledSystem, parameters, startTime: 0, startState, targets }, { settings: SETTINGS })
    expect(outcome.ok).toBe(true)
    expect(startState).toEqual([10, 2])
    expect(parameters).toEqual({ k1: 0.4, k2: 0.1 })
    expect(targets).toEqual([1, 2, 3])
  })

  it('uses a fixed table of derivative evaluations per step attempt', () => {
    // Cost of one attempt: stages 1…7 = 7 evaluations when stage 1 must be
    // recomputed; 6 when the caller declares the system unchanged and the
    // FSAL stage 7 can serve as stage 1. A rejected attempt additionally
    // recomputes stage 1 for the next try (+1). With A accepted steps and R
    // rejections the total is therefore 6·A + 8·R.
    const created = createIntegrator(
      { system: decaySystem, parameters: { k: 1 }, startTime: 0, startState: [1], targets: [] },
      { settings: SETTINGS },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const { integrator } = created

    const first = integrator.integrate([0.5], false)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const { acceptedSteps, rejectedSteps, functionEvaluations } = first.diagnostics
    expect(rejectedSteps).toBeGreaterThan(0) // exercises both branches below
    expect(functionEvaluations).toBe(6 * acceptedSteps + 8 * rejectedSteps)
    expect(integrator.functionEvaluations).toBe(functionEvaluations)

    const run = (hasCached: boolean): { cost: number; accepted: number; rejected: number } => {
      const before = integrator.functionEvaluations
      const result = integrator.integrate([integrator.time + 0.4], hasCached)
      expect(result.ok).toBe(true)
      if (!result.ok) return { cost: 0, accepted: 0, rejected: 0 }
      return {
        cost: integrator.functionEvaluations - before,
        accepted: result.diagnostics.acceptedSteps,
        rejected: result.diagnostics.rejectedSteps,
      }
    }
    const cached = run(true)
    const uncached = run(false)
    // Identical work except that the cached run skips exactly one evaluation
    // (stage 1 of its first attempt).
    expect(cached.accepted).toBe(uncached.accepted)
    expect(cached.rejected).toBe(uncached.rejected)
    expect(uncached.cost - cached.cost).toBe(1)
    expect(cached.cost).toBe(6 * cached.accepted + 8 * cached.rejected - 1)
  })

  it('gives the same trajectory whether or not one long interval is split into many calls', () => {
    const whole = integrate(
      { system: decaySystem, parameters: { k: 0.3 }, startTime: 0, startState: [1], targets: [6] },
      { settings: SETTINGS },
    )
    expect(whole.ok).toBe(true)
    if (!whole.ok) return

    const created = createIntegrator(
      { system: decaySystem, parameters: { k: 0.3 }, startTime: 0, startState: [1], targets: [] },
      { settings: SETTINGS },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    let last = 1
    for (let t = 0.5; t <= 6; t += 0.5) {
      const part = created.integrator.integrate([t], last === 1 ? false : true)
      expect(part.ok).toBe(true)
      if (part.ok) last = part.samples[0]?.state[0] ?? last
    }
    // Splitting changes the step sequence (and therefore the round-off), not
    // the scientific result.
    expect(Math.abs(last - (whole.run.samples[0]?.state[0] ?? 0))).toBeLessThan(1e-9)
  })
})

describe('controller settings', () => {
  it('exposes documented defaults and rejects invalid overrides', () => {
    expect(DEFAULT_SOLVER_CONTROLLER).toEqual({
      safetyFactor: 0.9,
      minScaleFactor: 0.2,
      maxScaleFactor: 5,
      zeroErrorScaleFactor: 5,
    })
    const created = createIntegrator(
      { system: decaySystem, parameters: { k: 1 }, startTime: 0, startState: [1], targets: [1] },
      { settings: SETTINGS, controller: { ...DEFAULT_SOLVER_CONTROLLER, safetyFactor: 2 } },
    )
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.errors[0]?.field).toBe('controller.safetyFactor')
  })
})