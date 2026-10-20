import { describe, expect, it } from 'vitest'
import { simulate } from './simulate'
import type { DosingEvent, SimulationScenario, SimulationReport, SolverOptions } from './types'

/**
 * Orchestration tests. Oracles are the analytical Q = 0 solution, the
 * documented event-ordering policy and mass balance — never the
 * implementation's own output.
 */

const SOLVER: SolverOptions = {
  absoluteTolerance: 1e-10,
  relativeTolerance: 1e-10,
  initialStep: 0.01,
  minStep: 1e-12,
  maxStep: 0.25,
  maxSteps: 500000,
}

const baseScenario = (overrides: Partial<SimulationScenario> = {}): SimulationScenario => ({
  startTime: 0,
  endTime: 24,
  outputTimes: [0, 1, 2, 4, 8, 12, 24],
  initialState: { centralAmount: 100, peripheralAmount: 0 },
  parameters: {
    centralVolume: { value: 10, unit: 'L' },
    peripheralVolume: { value: 20, unit: 'L' },
    clearance: { value: 2, unit: 'L/h' },
    intercompartmentalClearance: { value: 0, unit: 'L/h' },
  },
  events: [],
  solver: SOLVER,
  ...overrides,
})

const expectOk = (report: SimulationReport) => {
  if (!report.ok) throw new Error('simulation failed: ' + JSON.stringify(report.errors, null, 1))
  return report.result
}

const expectFail = (report: SimulationReport) => {
  if (report.ok) throw new Error('simulation unexpectedly succeeded')
  return report.errors
}

const bolus = (eventId: string, time: number, value: number, unit = 'mg'): DosingEvent => ({
  type: 'iv-bolus',
  eventId,
  time,
  amount: { value, unit },
})
const start = (eventId: string, infusionId: string, time: number, value: number, unit = 'mg/h'): DosingEvent => ({
  type: 'infusion-start',
  eventId,
  infusionId,
  time,
  rate: { value, unit },
})
const stop = (eventId: string, infusionId: string, time: number): DosingEvent => ({
  type: 'infusion-stop',
  eventId,
  infusionId,
  time,
})

const sidesAt = (
  result: { readonly samples: readonly { readonly time: number; readonly side: string }[] },
  time: number,
): string[] => result.samples.filter((s) => s.time === time).map((s) => s.side)

describe('simulate — analytical Q = 0 scenarios', () => {
  it('reproduces the closed form of a single bolus and every sample is finite', () => {
    const result = expectOk(simulate(baseScenario()))
    const D = 100
    const k = 2 / 10
    for (const sample of result.samples) {
      const exact = D * Math.exp(-k * sample.time)
      expect(Math.abs(sample.centralAmount - exact)).toBeLessThanOrEqual(1e-7 * Math.max(1, exact))
      for (const value of [
        sample.centralAmount,
        sample.peripheralAmount,
        sample.cumulativeEliminated,
        sample.cumulativeInput,
        sample.centralConcentration,
        sample.peripheralConcentration,
        sample.massBalanceResidual,
      ]) {
        expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('reports model identity, initial state, parameters and solver settings', () => {
    const result = expectOk(simulate(baseScenario()))
    expect(result.model.id).toBe('pnk.two-compartment-iv')
    expect(result.model.version).toBe('1.0.0')
    expect(result.model.equations.length).toBeGreaterThan(4)
    expect(result.initialState).toEqual({
      centralAmount: 100,
      peripheralAmount: 0,
      cumulativeEliminated: 0,
      cumulativeInput: 0,
    })
    expect(result.parameters.map((p) => p.symbol)).toEqual(['Vc', 'Vp', 'CL', 'Q'])
    expect(result.solver.method).toBe('dormand-prince-rk45')
    expect(result.solver.settings).toEqual(SOLVER)
    expect(result.massBalance.ok).toBe(true)
    expect(result.warnings.map((w) => w.code)).toContain('MODEL_RESULT_NOT_CLINICAL')
    expect(result.samples[0]?.side).toBe('initial')
  })

  it('produces exactly the requested output grid when no event lies on it', () => {
    const result = expectOk(simulate(baseScenario()))
    expect(result.samples.map((s) => s.time)).toEqual([0, 1, 2, 4, 8, 12, 24])
  })

  it('maps equivalent units onto the same trajectory and echoes declared values', () => {
    const metric = expectOk(simulate(baseScenario()))
    const converted = expectOk(
      simulate(
        baseScenario({
          parameters: {
            centralVolume: { value: 10000, unit: 'mL' },
            peripheralVolume: { value: 20, unit: 'L' },
            clearance: { value: 2000, unit: 'mL/h' },
            intercompartmentalClearance: { value: 0, unit: 'L/h' },
          },
        }),
      ),
    )
    expect(converted.parameters[0]).toEqual({
      symbol: 'Vc',
      label: 'Central volume V_c',
      declaredValue: 10000,
      declaredUnit: 'mL',
      canonicalValue: 10,
      canonicalUnit: 'L',
      conversionFactor: 1e-3,
    })
    expect(converted.samples.map((s) => s.centralAmount)).toEqual(metric.samples.map((s) => s.centralAmount))
    expect(converted.warnings.map((w) => w.code)).toContain('UNITS_CONVERTED')
    expect(metric.warnings.map((w) => w.code)).not.toContain('UNITS_CONVERTED')
  })
})

describe('simulate — event semantics', () => {
  it('marks a bolus with pre-event and post-event samples at the same time', () => {
    const result = expectOk(simulate(baseScenario({ events: [bolus('d1', 2, 50)] })))
    expect(sidesAt(result, 2)).toEqual(['pre-event', 'post-event'])
    const [pre, post] = result.samples.filter((s) => s.time === 2)
    expect(post!.centralAmount - pre!.centralAmount).toBeCloseTo(50, 6)
    expect(post!.cumulativeInput - pre!.cumulativeInput).toBeCloseTo(50, 6)
    expect(pre!.eventGroup).toBe('group-1')
    expect(post!.eventGroup).toBe('group-1')
    // The output grid still contributes nothing extra at t = 2.
    expect(result.samples.filter((s) => s.time === 2)).toHaveLength(2)
  })

  it('never lets the solver step across an event, even between output times', () => {
    // An output grid that does NOT contain the event time: the trajectory
    // after the event must equal the same scenario computed in closed form
    // from the post-event state.
    const withEvent = expectOk(
      simulate(baseScenario({ outputTimes: [0, 1, 4, 8, 12, 24], events: [bolus('d1', 2.5, 50)] })),
    )
    const at4 = withEvent.samples.find((s) => s.time === 4)!
    const expected =
      100 * Math.exp(-0.2 * 2.5) * Math.exp(-0.2 * 1.5) + 50 * Math.exp(-0.2 * 1.5)
    expect(Math.abs(at4.centralAmount - expected)).toBeLessThan(1e-6)
    expect(withEvent.samples.filter((s) => s.time === 2.5).map((s) => s.side)).toEqual(['pre-event', 'post-event'])
  })

  it('keeps the scientific scenario independent of the output grid', () => {
    const events = [bolus('d1', 2, 50), start('s1', 'A', 3, 10), stop('t1', 'A', 9)]
    const dense = expectOk(simulate(baseScenario({ events, outputTimes: Array.from({ length: 25 }, (_, i) => i) })))
    const sparse = expectOk(simulate(baseScenario({ events, outputTimes: [0, 6, 12, 18, 24] })))
    // Same events, same order, same jump sizes — only the step sequence used
    // to reach them differs (and with it the last digits of round-off).
    expect(dense.eventTrace.map((e) => [e.eventId, e.type, e.groupIndex, e.orderInGroup])).toEqual(
      sparse.eventTrace.map((e) => [e.eventId, e.type, e.groupIndex, e.orderInGroup]),
    )
    dense.eventTrace.forEach((entry, index) => {
      const other = sparse.eventTrace[index]!
      for (let i = 0; i < entry.after.length; i += 1) {
        expect(Math.abs((entry.after[i] ?? 0) - (other.after[i] ?? 0))).toBeLessThan(1e-8)
      }
    })
    // Reported science agrees wherever both grids sample the same time.
    for (const t of [6, 12, 18, 24]) {
      const a = dense.samples.find((x) => x.time === t && x.side === 'interval')!
      const b = sparse.samples.find((x) => x.time === t && x.side === 'interval')!
      expect(Math.abs(a.centralAmount - b.centralAmount)).toBeLessThan(1e-6)
      expect(Math.abs(a.cumulativeEliminated - b.cumulativeEliminated)).toBeLessThan(1e-6)
    }
    expect(sparse.massBalance.ok).toBe(true)
    expect(dense.massBalance.ok).toBe(true)
  })

  it('applies each event exactly once', () => {
    const result = expectOk(simulate(baseScenario({ events: [bolus('d1', 2, 50)] })))
    expect(result.eventTrace).toHaveLength(1)
    const totalInput = result.samples.at(-1)!.cumulativeInput
    expect(totalInput).toBeCloseTo(50, 9)
  })

  it('orders same-time events deterministically: stop, bolus, start', () => {
    const result = expectOk(
      simulate(
        baseScenario({
          outputTimes: [0, 2, 4, 8],
          endTime: 8,
          events: [
            start('s0', 'OLD', 0, 5),
            stop('t1', 'OLD', 2),
            bolus('b1', 2, 20),
            start('s2', 'NEW', 2, 3),
            stop('t2', 'NEW', 6),
          ],
        }),
      ),
    )
    const group = result.eventTrace.filter((e) => e.time === 2)
    expect(group.map((e) => e.eventId)).toEqual(['t1', 'b1', 's2'])
    expect(group.map((e) => e.orderInGroup)).toEqual([1, 2, 3])
    expect(group.map((e) => e.type)).toEqual(['infusion-stop', 'iv-bolus', 'infusion-start'])
    // One pre-event and one post-event sample for the whole group.
    expect(sidesAt(result, 2)).toEqual(['pre-event', 'post-event'])
    // The trace reconstructs the transition unambiguously.
    for (let i = 1; i < group.length; i += 1) expect(group[i]!.before).toEqual(group[i - 1]!.after)
  })

  it('sums simultaneous infusions and removes each at its own stop', () => {
    const result = expectOk(
      simulate(
        baseScenario({
          outputTimes: [0, 4, 8],
          endTime: 8,
          parameters: {
            centralVolume: { value: 10, unit: 'L' },
            peripheralVolume: { value: 20, unit: 'L' },
            clearance: { value: 0, unit: 'L/h' },
            intercompartmentalClearance: { value: 0, unit: 'L/h' },
          },
          initialState: { centralAmount: 0, peripheralAmount: 0 },
          events: [start('s1', 'A', 0, 2), start('s2', 'B', 0, 3), stop('t2', 'B', 4), stop('t1', 'A', 8)],
        }),
      ),
    )
    // CL = 0, Q = 0: A_c(t) = ∫R dt. Over [0,4]: 5 mg/h → 20 mg; [4,8]: 2 mg/h → 8 mg; total 28.
    // The stop group closes the run, so the last sample is its post-event side.
    const last = result.samples.at(-1)!
    expect(last.time).toBe(8)
    expect(last.centralAmount).toBeCloseTo(28, 6)
    const rateAt = (t: number, side: 'pre-event' | 'post-event'): number =>
      result.infusionRates.find((p) => p.time === t && p.side === side)?.totalRate ?? Number.NaN
    expect(rateAt(0, 'post-event')).toBe(5)
    expect(rateAt(4, 'pre-event')).toBe(5)
    expect(rateAt(4, 'post-event')).toBe(2)
  })

  it('applies an event at startTime to the initial state and says so by the sample sides', () => {
    // A bolus at t0 is a bolus at startTime (the scenario's own initial
    // amount is the pre-event state); Q = 0 keeps this to one compartment.
    const result = expectOk(
      simulate(baseScenario({ startTime: 2, endTime: 24, outputTimes: [2, 4, 24], events: [bolus('d1', 2, 30)] })),
    )
    expect(sidesAt(result, 2)).toEqual(['pre-event', 'post-event'])
    const [pre, post] = result.samples.filter((s) => s.time === 2)
    expect(pre!.centralAmount).toBeCloseTo(100, 9)
    expect(post!.centralAmount).toBeCloseTo(130, 9)
    // A_in carries the carried-in bolus so the invariant holds from t0
    // (positive when reported to 12 significant digits).
    expect(post!.cumulativeInput).toBeGreaterThan(0)
    expect(result.massBalance.ok).toBe(true)
  })

  it('supports repeated boluses and repeated infusion sessions with unique ids', () => {
    const result = expectOk(
      simulate(
        baseScenario({
          outputTimes: [0, 6, 12, 24],
          events: [
            bolus('d1', 1, 10),
            bolus('d2', 6, 10),
            start('s1', 'A', 1, 2),
            stop('t1', 'A', 3),
            start('s2', 'A', 6, 2),
            stop('t2', 'A', 8),
          ],
        }),
      ),
    )
    expect(result.eventTrace.map((e) => e.eventId)).toEqual(['d1', 's1', 't1', 'd2', 's2', 't2'])
    expect(result.samples.at(-1)!.cumulativeInput).toBeCloseTo(10 + 2 * 2 + 10 + 2 * 2, 6)
  })
})

describe('simulate — mass-balance reference point (ADR-25)', () => {
  // Every expectation below is computed by hand from the stated convention:
  //   reference physical amount = initialCentral + initialPeripheral
  //   residual = A_c + A_p + A_e − reference − A_in
  // It never calls the production residual helper, so a regression in the
  // helper cannot make these tests pass by agreeing with itself.

  /** Closed form for Q = 0, CL = 2 L/h, V_c = 10 L: A_c(t) = A_c(t_ref)·e^(−0.2·Δt). */
  const decay = (amount: number, deltaHours: number): number => amount * Math.exp(-0.2 * deltaHours)

  it('a bolus at startTime is counted exactly once: reference is the pre-event amount', () => {
    // Initial physical state 100 mg central, no peripheral; bolus 30 mg at t0.
    const result = expectOk(
      simulate(
        baseScenario({
          startTime: 2,
          endTime: 24,
          outputTimes: [2, 4, 24],
          initialState: { centralAmount: 100, peripheralAmount: 0 },
          events: [bolus('d1', 2, 30)],
        }),
      ),
    )
    const [pre, post] = result.samples.filter((s) => s.time === 2)
    const reference = 100 + 0

    // Hand-computed table: before / after the bolus.
    expect(pre!.centralAmount).toBeCloseTo(100, 9)
    expect(pre!.cumulativeInput).toBe(0)
    expect(Math.abs(pre!.centralAmount - reference - pre!.cumulativeInput)).toBe(0)
    expect(post!.centralAmount).toBeCloseTo(130, 9)
    expect(post!.cumulativeInput).toBeCloseTo(30, 9)
    expect(Math.abs(post!.centralAmount - reference - post!.cumulativeInput)).toBeLessThan(1e-12)

    // Reference state is declared as the pre-event amount, not a post-bolus total.
    expect(result.initialState.centralAmount).toBe(100)
    expect(result.initialState.cumulativeInput).toBe(0)

    // Every later sample: central + eliminated must equal 100 + 30 in total.
    for (const sample of result.samples) {
      const accounted =
        sample.centralAmount + sample.peripheralAmount + sample.cumulativeEliminated
      expect(Math.abs(accounted - (reference + sample.cumulativeInput))).toBeLessThan(1e-9)
    }
    // …and the trajectory follows the closed form from the post-bolus amount.
    const at4 = result.samples.find((s) => s.time === 4)!
    expect(Math.abs(at4.centralAmount - decay(130, 2))).toBeLessThan(1e-6)
  })

  it('a bolus strictly after startTime follows the same convention (no special case)', () => {
    // 100 mg at t0; 40 mg bolus at t = 3 on a 10 h horizon.
    const result = expectOk(
      simulate(
        baseScenario({
          startTime: 0,
          endTime: 10,
          outputTimes: [0, 3, 6, 10],
          initialState: { centralAmount: 100, peripheralAmount: 0 },
          events: [bolus('d1', 3, 40)],
        }),
      ),
    )
    const [pre, post] = result.samples.filter((s) => s.time === 3)
    const reference = 100
    expect(pre!.cumulativeInput).toBe(0)
    expect(pre!.centralAmount).toBeCloseTo(decay(100, 3), 6)
    // 100 mg at t0, 2 mg/L/h clearance over 3 h: 100·(1 − e^(−0.6)) ≈ 45.1 mg
    // has already been eliminated, so the generic identity below includes A_e.
    expect(pre!.cumulativeEliminated).toBeCloseTo(100 * (1 - Math.exp(-0.6)), 5)
    expect(
      Math.abs(pre!.centralAmount + pre!.cumulativeEliminated - reference - pre!.cumulativeInput),
    ).toBeLessThan(1e-9)

    expect(post!.cumulativeInput).toBeCloseTo(40, 9)
    expect(post!.centralAmount).toBeCloseTo(decay(100, 3) + 40, 6)
    expect(
      Math.abs(post!.centralAmount + post!.cumulativeEliminated - reference - post!.cumulativeInput),
    ).toBeLessThan(1e-9)

    // A later sample still balances with the same reference (100 mg).
    const at6 = result.samples.find((s) => s.time === 6)!
    expect(at6.cumulativeInput).toBeCloseTo(40, 9)
    expect(Math.abs(at6.centralAmount + at6.cumulativeEliminated - (reference + 40))).toBeLessThan(1e-9)
  })

  it('keeps the reference at the initial amounts when the initial state is non-zero in both compartments', () => {
    // Q = 0 keeps the peripheral amount inert, so the hand arithmetic stays exact.
    const result = expectOk(
      simulate(
        baseScenario({
          startTime: 0,
          endTime: 6,
          outputTimes: [0, 6],
          initialState: { centralAmount: 30, peripheralAmount: 70 },
          events: [bolus('d1', 2, 10)],
        }),
      ),
    )
    const reference = 30 + 70
    for (const sample of result.samples) {
      const accounted = sample.centralAmount + sample.peripheralAmount + sample.cumulativeEliminated
      expect(Math.abs(accounted - reference - sample.cumulativeInput)).toBeLessThan(1e-9)
    }
    const last = result.samples.at(-1)!
    expect(last.peripheralAmount).toBeCloseTo(70, 9) // Q = 0: never leaves
    expect(last.cumulativeInput).toBeCloseTo(10, 9)
  })

  it('reports zero residual at the pre-event start sample of an event-free scenario', () => {
    const result = expectOk(simulate(baseScenario({ outputTimes: [0, 12], endTime: 12 })))
    expect(result.initialState.cumulativeInput).toBe(0)
    expect(result.samples[0]!.massBalanceResidual).toBe(0)
  })
})

describe('simulate — mass balance', () => {
  const scenarios: ReadonlyArray<readonly [string, Partial<SimulationScenario>]> = [
    ['bolus', { events: [bolus('d1', 1, 40)] }],
    ['single infusion', { events: [start('s1', 'A', 0, 5), stop('t1', 'A', 10)] }],
    ['overlapping infusions', { events: [start('s1', 'A', 0, 3), start('s2', 'B', 1, 4), stop('t1', 'A', 6), stop('t2', 'B', 9)] }],
    ['repeated events', { events: [bolus('d1', 1, 10), bolus('d2', 5, 20), start('s1', 'A', 2, 1), stop('t1', 'A', 4)] }],
    ['non-zero initial amounts', { initialState: { centralAmount: 30, peripheralAmount: 70 } }],
    ['distribution', { parameters: { centralVolume: { value: 8, unit: 'L' }, peripheralVolume: { value: 30, unit: 'L' }, clearance: { value: 4, unit: 'L/h' }, intercompartmentalClearance: { value: 6, unit: 'L/h' } } }],
  ]

  for (const [label, overrides] of scenarios) {
    it(`holds A_c + A_p + A_e = A_c(0) + A_p(0) + A_in(t) — ${label}`, () => {
      const result = expectOk(simulate(baseScenario(overrides)))
      expect(result.massBalance.ok).toBe(true)
      for (const sample of result.samples) {
        expect(Math.abs(sample.massBalanceResidual)).toBeLessThanOrEqual(result.massBalance.tolerance)
      }
    })
  }

  it('derives the tolerance from the solver settings and the mass scale', () => {
    const small = expectOk(simulate(baseScenario({ solver: { ...SOLVER, absoluteTolerance: 1e-6, relativeTolerance: 1e-6 } })))
    const tight = expectOk(simulate(baseScenario({ solver: { ...SOLVER, absoluteTolerance: 1e-12, relativeTolerance: 1e-12 } })))
    expect(small.massBalance.tolerance).toBeGreaterThan(tight.massBalance.tolerance)
    // The residual itself is far inside the tolerance in both cases.
    expect(tight.massBalance.maxAbsResidual).toBeLessThan(tight.massBalance.tolerance)
  })

  it('integrates elimination as a state, not from the sampled grid', () => {
    // A very coarse output grid must still report the correct A_e at the end:
    // it comes from integrating dA_e/dt, not from summing reported points.
    const coarse = expectOk(simulate(baseScenario({ outputTimes: [0, 24] })))
    const dense = expectOk(simulate(baseScenario({ outputTimes: Array.from({ length: 25 }, (_, i) => i) })))
    const coarseEnd = coarse.samples.at(-1)!.cumulativeEliminated
    const denseEnd = dense.samples.at(-1)!.cumulativeEliminated
    expect(Math.abs(coarseEnd - denseEnd)).toBeLessThan(1e-6)
    expect(coarseEnd).toBeCloseTo(100 * (1 - Math.exp(-0.2 * 24)), 6)
  })
})

describe('simulate — scenario validation is data', () => {
  const codes = (report: SimulationReport) => expectFail(report).map((e) => e.code)

  it('rejects an invalid time horizon', () => {
    expect(codes(simulate(baseScenario({ endTime: 0 })))).toContain('OUT_OF_RANGE')
    expect(codes(simulate(baseScenario({ startTime: Number.NaN })))).toContain('NOT_A_NUMBER')
  })

  it('rejects output grids that are empty, unsorted, outside the horizon or not anchored', () => {
    expect(codes(simulate(baseScenario({ outputTimes: [] })))).toContain('MISSING_PARAMETER')
    expect(codes(simulate(baseScenario({ outputTimes: [0, 5, 5, 24] })))).toContain('OUT_OF_RANGE')
    expect(codes(simulate(baseScenario({ outputTimes: [0, 30, 24] })))).toContain('OUT_OF_RANGE')
    expect(codes(simulate(baseScenario({ outputTimes: [1, 24] })))).toContain('OUT_OF_RANGE')
    expect(codes(simulate(baseScenario({ outputTimes: [0, 12] })))).toContain('OUT_OF_RANGE')
  })

  it('rejects negative or non-finite initial amounts', () => {
    expect(codes(simulate(baseScenario({ initialState: { centralAmount: -1, peripheralAmount: 0 } })))).toContain(
      'NEGATIVE_VALUE',
    )
    expect(
      codes(simulate(baseScenario({ initialState: { centralAmount: Number.POSITIVE_INFINITY, peripheralAmount: 0 } }))),
    ).toContain('NOT_A_NUMBER')
  })

  it('rejects zero or negative volumes, negative clearances and incompatible units', () => {
    const p = baseScenario().parameters
    expect(codes(simulate(baseScenario({ parameters: { ...p, centralVolume: { value: 0, unit: 'L' } } })))).toContain(
      'ZERO_NOT_ALLOWED',
    )
    expect(codes(simulate(baseScenario({ parameters: { ...p, peripheralVolume: { value: -1, unit: 'L' } } })))).toContain(
      'NEGATIVE_VALUE',
    )
    expect(codes(simulate(baseScenario({ parameters: { ...p, clearance: { value: -1, unit: 'L/h' } } })))).toContain(
      'NEGATIVE_VALUE',
    )
    // mg/h is an infusion rate, not a clearance — different dimensions.
    expect(codes(simulate(baseScenario({ parameters: { ...p, clearance: { value: 1, unit: 'mg/h' } } })))).toContain(
      'INCOMPATIBLE_UNITS',
    )
    // mg is a mass, not a volume.
    expect(codes(simulate(baseScenario({ parameters: { ...p, centralVolume: { value: 1, unit: 'mg' } } })))).toContain(
      'INCOMPATIBLE_UNITS',
    )
    // A count-per-time rate ("1/h") is not a catalog unit at all: CL needs a
    // volume per time (a rate constant would need a volume to become one).
    expect(codes(simulate(baseScenario({ parameters: { ...p, clearance: { value: 1, unit: '1/h' } } })))).toContain(
      'UNKNOWN_UNIT',
    )
    // An unknown symbol is reported as such.
    expect(codes(simulate(baseScenario({ parameters: { ...p, clearance: { value: 1, unit: 'furlongs' } } })))).toContain(
      'UNKNOWN_UNIT',
    )
    // A missing unit is never assumed.
    expect(codes(simulate(baseScenario({ parameters: { ...p, clearance: { value: 1, unit: ' ' } } })))).toContain(
      'MISSING_PARAMETER',
    )
  })

  it('rejects invalid event quantities and units', () => {
    expect(codes(simulate(baseScenario({ events: [bolus('d1', 1, 5, 'L')] })))).toContain('INCOMPATIBLE_UNITS')
    expect(codes(simulate(baseScenario({ events: [bolus('d1', 1, -5)] })))).toContain('NEGATIVE_VALUE')
    expect(codes(simulate(baseScenario({ events: [start('s1', 'A', 0, 5, 'mg')] })))).toContain('INCOMPATIBLE_UNITS')
    expect(codes(simulate(baseScenario({ events: [stop('t1', 'ghost', 1)] })))).toContain('INVALID_EVENT_SEQUENCE')
  })

  it('rejects invalid solver settings', () => {
    expect(codes(simulate(baseScenario({ solver: { ...SOLVER, relativeTolerance: 0 } })))).toContain('ZERO_NOT_ALLOWED')
    expect(codes(simulate(baseScenario({ solver: { ...SOLVER, maxSteps: 0 } })))).toContain('OUT_OF_RANGE')
  })

  it('never returns samples with a failure', () => {
    const report = simulate(baseScenario({ endTime: 0 }))
    expect(report.ok).toBe(false)
    expect(report).not.toHaveProperty('result')
  })
})

describe('simulate — numerical failures are structured', () => {
  it('reports a solver failure instead of a partial curve', () => {
    const report = simulate(
      baseScenario({
        solver: { ...SOLVER, maxSteps: 2 },
      }),
    )
    const errors = expectFail(report)
    expect(errors.some((e) => e.code === 'MAX_STEPS_EXCEEDED' || e.code === 'FAILED_TO_ADVANCE')).toBe(true)
    expect(report).not.toHaveProperty('result')
  })
})

describe('simulate — determinism and immutability', () => {
  it('returns byte-identical results for identical scenarios', () => {
    const scenario = baseScenario({ events: [bolus('d1', 2, 50), start('s1', 'A', 4, 2), stop('t1', 'A', 9)] })
    const a = expectOk(simulate(scenario))
    const b = expectOk(simulate(scenario))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not mutate the caller-owned scenario', () => {
    const scenario = baseScenario({ events: [bolus('d1', 2, 50)] })
    const snapshot = JSON.stringify(scenario)
    expectOk(simulate(scenario))
    expect(JSON.stringify(scenario)).toBe(snapshot)
  })
})
