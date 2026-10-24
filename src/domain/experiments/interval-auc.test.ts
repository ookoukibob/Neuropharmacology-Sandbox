/**
 * Interval AUCτ tests (phase 50C).
 *
 * Every fixture is synthetic and the expected values are hand-checkable:
 * a linear concentration gradient integrates exactly with the linear
 * trapezoid, so the assertions are arithmetic rather than tolerances.
 */
import { describe, expect, it } from 'vitest'
import type {
  AdministrationMetadata,
  ExperimentalMeasurement,
} from './experimental-dataset'
import { analyzeIntervalAuc, observedTimeChoices, type IntervalAucInput } from './interval-auc'
import { analyzeNca } from './nca'

const rows = (pairs: readonly (readonly [number, number])[]): ExperimentalMeasurement[] =>
  pairs.map(([time, concentration], index) => ({
    id: `m${index + 1}`,
    sourceRow: index + 1,
    time,
    concentration,
  }))

/** C = 100 − 10t on [0, 12]: linear trapezoids are exact (area = mean × width). */
const linear = rows([
  [0, 100],
  [2, 80],
  [4, 60],
  [6, 40],
  [8, 20],
  [10, 0],
])

const repeated: AdministrationMetadata = {
  route: 'iv-bolus',
  regimen: 'repeated-dose',
  timeReference: 'dose-time',
  dose: { value: 50, unit: 'mg' },
  doseBasis: 'per-administration',
  dosingInterval: { value: 8, unit: 'h' },
}

function run(overrides: Partial<IntervalAucInput> = {}): ReturnType<typeof analyzeIntervalAuc> {
  return analyzeIntervalAuc({
    measurements: linear,
    timeUnit: 'h',
    concentrationUnit: 'mg/L',
    administration: repeated,
    integrationMethod: 'linear',
    terminalPointCount: 3,
    selection: { startTime: 0, endTime: 8 },
    administrationAligned: false,
    ...overrides,
  })
}

describe('interval AUCτ', () => {
  it('integrates exactly the selected interval and records its provenance', () => {
    const report = run()

    expect(report.status).toBe('available')
    expect(report.aucTau.status).toBe('available')
    if (report.aucTau.status !== 'available') return
    // Mean concentration 60 mg/L over 8 h.
    expect(report.aucTau.value).toBeCloseTo(480, 10)
    expect(report.aucTau.unit).toBe('mg/L·h')
    expect(report.aucTau.name).toBe('AUCτ')
    expect(report.aucTau.segments).toHaveLength(4)
    expect(report.aucTau.contributingSourceRows).toEqual([1, 2, 3, 4, 5])

    expect(report.interval).toMatchObject({
      startTime: 0,
      endTime: 8,
      timeUnit: 'h',
      startSourceRow: 1,
      endSourceRow: 5,
      observedDurationHours: 8,
      declaredIntervalHours: 8,
      observationCount: 5,
    })
    expect(report.interval?.declaredInterval).toEqual({ value: 8, unit: 'h' })
    expect(report.interval?.observedTimes).toEqual([0, 2, 4, 6, 8])
  })

  it('integrates only the window the analyst selected, not the whole dataset', () => {
    // τ = 4 h so [4, 8] is a valid interval inside a longer dataset.
    const report = run({
      administration: { ...repeated, dosingInterval: { value: 4, unit: 'h' } },
      selection: { startTime: 4, endTime: 8 },
    })
    expect(report.aucTau.status).toBe('available')
    if (report.aucTau.status !== 'available') return
    // Mean of 60 and 20 over 4 h.
    expect(report.aucTau.value).toBeCloseTo(160, 10)
    expect(report.aucTau.contributingSourceRows).toEqual([3, 4, 5])
    expect(report.interval?.startSourceRow).toBe(3)
    expect(report.interval?.endSourceRow).toBe(5)
  })

  it('gives a different area and provenance for a different candidate interval', () => {
    const first = run({ selection: { startTime: 0, endTime: 8 } })
    const second = run({ selection: { startTime: 2, endTime: 10 } })
    expect(first.aucTau.status).toBe('available')
    expect(second.aucTau.status).toBe('available')
    if (first.aucTau.status !== 'available' || second.aucTau.status !== 'available') return
    // Mean 60 over 8 h vs mean 40 over 8 h (80, 60, 40, 20, 0).
    expect(first.aucTau.value).toBeCloseTo(480, 10)
    expect(second.aucTau.value).toBeCloseTo(320, 10)
    expect(second.aucTau.contributingSourceRows).toEqual([2, 3, 4, 5, 6])
  })

  it('compares the interval length with τ across different time units', () => {
    const minuteRows = rows([
      [0, 100],
      [30, 80],
      [60, 60],
      [90, 40],
      [120, 20],
    ])
    const report = run({
      measurements: minuteRows,
      timeUnit: 'min',
      administration: { ...repeated, dosingInterval: { value: 2, unit: 'h' } },
      selection: { startTime: 0, endTime: 120 },
    })
    expect(report.status).toBe('available')
    expect(report.interval?.observedDurationHours).toBe(2)
    expect(report.interval?.declaredIntervalHours).toBe(2)
    expect(report.aucTau.status).toBe('available')
    if (report.aucTau.status !== 'available') return
    expect(report.aucTau.unit).toBe('mg/L·min')
    expect(report.aucTau.value).toBeCloseTo(7200, 6)
  })

  it('absorbs binary float noise in the τ comparison but not a real difference', () => {
    // 0.3 − 0.1 = 0.19999999999999998 in binary64; τ = 0.2 h is the same
    // interval for any scientific purpose.
    const noisy = rows([
      [0.1, 100],
      [0.2, 90],
      [0.3, 80],
    ])
    const accepted = run({
      measurements: noisy,
      administration: { ...repeated, dosingInterval: { value: 0.2, unit: 'h' } },
      selection: { startTime: 0.1, endTime: 0.3 },
    })
    expect(accepted.status).toBe('available')

    // 1e-7 h (0.36 ms) is well beyond binary noise and is refused.
    const shifted = rows([
      [0, 100],
      [0.2, 90],
      [0.2000001, 80],
    ])
    const refused = run({
      measurements: shifted,
      administration: { ...repeated, dosingInterval: { value: 0.2, unit: 'h' } },
      selection: { startTime: 0, endTime: 0.2000001 },
    })
    expect(refused.status).toBe('unavailable')
    expect(refused.code).toBe('INTERVAL_LENGTH_MISMATCH')
    if (refused.aucTau.status === 'unavailable') {
      expect(refused.aucTau.message).toMatch(/is not one τ wide/i)
    }
  })

  it('refuses a boundary that has no observation instead of interpolating it', () => {
    const report = run({ selection: { startTime: 1, endTime: 9 } })
    expect(report.status).toBe('unavailable')
    expect(report.code).toBe('INTERVAL_BOUNDARY_NOT_OBSERVED')
    expect(report.message).toMatch(/Interpolating, extrapolating or zero-filling/i)
    expect(report.interval).toBeNull()
  })

  it('refuses an interval that is not one τ wide', () => {
    const report = run({ selection: { startTime: 0, endTime: 6 } })
    expect(report.code).toBe('INTERVAL_LENGTH_MISMATCH')
    expect(report.aucTau.status).toBe('unavailable')
  })

  it('refuses duplicate sampling times inside the interval only', () => {
    const duplicated = rows([
      [0, 100],
      [4, 60],
      [4, 58],
      [8, 20],
    ])
    const inside = run({ measurements: duplicated })
    expect(inside.code).toBe('DUPLICATE_SAMPLING_TIMES')
    expect(inside.message).toMatch(/never averaged/i)

    // The same duplicate outside the selected window does not block it.
    const outside = rows([
      [0, 100],
      [4, 60],
      [8, 20],
      [12, 10],
      [12, 9],
    ])
    const report = run({
      measurements: outside,
      administration: { ...repeated, dosingInterval: { value: 8, unit: 'h' } },
      selection: { startTime: 0, endTime: 8 },
    })
    expect(report.status).toBe('available')
    expect(report.aucTau.status).toBe('available')
    if (report.aucTau.status !== 'available') return
    expect(report.aucTau.contributingSourceRows).toEqual([1, 2, 3])
  })

  it('refuses an unselected interval rather than defaulting to the dataset span', () => {
    const report = run({ selection: null })
    expect(report.code).toBe('INTERVAL_NOT_SELECTED')
    expect(report.message).toMatch(/default is never applied/i)
  })

  it('requires a recorded repeated regimen and a recorded τ', () => {
    const { dosingInterval: _omitted, ...withoutTau } = repeated
    expect(run({ administration: undefined }).code).toBe('ADMINISTRATION_MISSING')
    expect(run({ administration: { ...repeated, regimen: 'unknown' } }).code).toBe('REGIMEN_UNKNOWN')
    expect(run({ administration: { ...repeated, regimen: 'single-dose' } }).code).toBe(
      'REGIMEN_NOT_REPEATED',
    )
    expect(run({ administration: withoutTau }).code).toBe('DOSING_INTERVAL_MISSING')
    expect(
      run({ administration: { ...repeated, dosingInterval: { value: 0, unit: 'h' } } }).code,
    ).toBe('DOSING_INTERVAL_NOT_POSITIVE')
    expect(
      run({ administration: { ...repeated, dosingInterval: { value: 8, unit: 'mg' } } }).code,
    ).toBe('DOSING_INTERVAL_UNIT_INCOMPATIBLE')
  })

  it('rejects an invalid interval order and an invalid dataset time unit', () => {
    expect(run({ selection: { startTime: 8, endTime: 8 } }).code).toBe('INTERVAL_ORDER')
    expect(run({ selection: { startTime: 8, endTime: 0 } }).code).toBe('INTERVAL_ORDER')
    expect(run({ timeUnit: 'mg/L' }).code).toBe('TIME_UNIT_INCOMPATIBLE')
    expect(run({ selection: { startTime: Number.NaN, endTime: 8 } }).code).toBe('INTERVAL_NOT_FINITE')
  })

  it('rejects invalid measurements before integrating anything', () => {
    const invalid = [...linear, { id: 'bad', sourceRow: 9, time: 10, concentration: Number.NaN }]
    const report = run({ measurements: invalid, selection: { startTime: 0, endTime: 8 } })
    expect(report.code).toBe('INVALID_MEASUREMENT')
    expect(report.message).toMatch(/row\(s\) 9/)
  })

  it('takes λ_z from the selected interval only, never from the whole dataset', () => {
    // Exponential decay: λ_z = 0.5 h⁻¹ everywhere, but the interval [0, 4] has
    // only 3 positive points, so the terminal regression is limited to them.
    const decay = rows([
      [0, 100],
      [1, 60.653],
      [2, 36.788],
      [4, 13.534],
      [8, 1.8316],
      [12, 0.2479],
    ])
    const interval = run({
      measurements: decay,
      administration: { ...repeated, dosingInterval: { value: 4, unit: 'h' } },
      selection: { startTime: 0, endTime: 4 },
      terminalPointCount: 3,
    })
    expect(interval.status).toBe('available')
    expect(interval.lambdaZ?.status).toBe('available')
    if (interval.lambdaZ?.status !== 'available') return
    expect(interval.lambdaZ.value).toBeCloseTo(0.5, 3)
    // The regression used only rows inside the interval: the last three of the
    // interval's four positive observations (t = 1, 2, 4), never the rows at
    // t = 8 or 12 that lie outside it.
    expect(interval.terminalPhase?.selectedSourceRows).toEqual([2, 3, 4])
    expect(interval.intervalNca).not.toBeNull()

    // The whole-dataset λ_z also exists, and it is a different regression; the
    // interval report must not be the whole-dataset one.
    const whole = analyzeNca(decay, 'h', 'mg/L', {
      integrationMethod: 'linear',
      terminalPointCount: 3,
    })
    if (!whole.ok) throw new Error('setup')
    if (whole.terminalPhase.status !== 'available') throw new Error('setup')
    expect(whole.terminalPhase.selectedSourceRows).toEqual([4, 5, 6])
    expect(interval.terminalPhase?.selectedSourceRows).not.toEqual(
      whole.terminalPhase.selectedSourceRows,
    )
  })

  it('still reports AUCτ when the interval cannot yield a terminal slope', () => {
    const twoPoints = rows([
      [0, 100],
      [8, 20],
    ])
    const report = run({ measurements: twoPoints })
    expect(report.status).toBe('available')
    expect(report.aucTau.status).toBe('available')
    if (report.aucTau.status !== 'available') return
    expect(report.aucTau.value).toBeCloseTo(480, 10)
    expect(report.lambdaZ?.status).toBe('unavailable')
    expect(report.preconditions.some((entry) => entry.id === 'interval-lambda-z' && entry.status === 'not-met')).toBe(true)
  })

  it('never uses an extrapolated area as AUCτ', () => {
    const decay = rows([
      [0, 100],
      [2, 36.788],
      [4, 13.534],
      [6, 4.9787],
      [8, 1.8316],
    ])
    const report = run({ measurements: decay })
    const whole = analyzeNca(decay, 'h', 'mg/L', { integrationMethod: 'linear', terminalPointCount: 3 })
    if (!whole.ok) throw new Error('setup')
    if (report.aucTau.status !== 'available') throw new Error('setup')
    // AUCτ is the observed area only; AUC(0→∞) includes an extrapolated tail.
    expect(report.aucTau.value).toBeLessThan(whole.aucInf.status === 'available' ? whole.aucInf.value : 0)
    expect(report.aucTau.method).toMatch(/observed intervals only/i)
    expect(report.aucTau.method).not.toMatch(/→∞/)
  })

  it('follows the selected integration method exactly', () => {
    const decay = rows([
      [0, 100],
      [4, 50],
      [8, 25],
    ])
    const linearRun = run({ measurements: decay, integrationMethod: 'linear' })
    const logRun = run({ measurements: decay, integrationMethod: 'linear-up-log-down' })
    if (linearRun.aucTau.status !== 'available' || logRun.aucTau.status !== 'available') {
      throw new Error('setup')
    }
    // Linear: (100+50)/2·4 + (50+25)/2·4 = 300 + 150.
    expect(linearRun.aucTau.value).toBeCloseTo(450, 10)
    // Log-down: (100−50)/ln(2)·4 + (50−25)/ln(2)·4 = 300/ln(2).
    expect(logRun.aucTau.value).toBeCloseTo(300 / Math.LN2, 8)
    expect(logRun.aucTau.integrationMethod).toBe('linear-up-log-down')
  })

  it('never mutates the measurements it analyses', () => {
    const snapshot = JSON.stringify(linear)
    run()
    expect(JSON.stringify(linear)).toBe(snapshot)
  })

  it('echoes the analyst confirmation without treating it as a steady-state claim', () => {
    const aligned = run({ administrationAligned: true })
    expect(aligned.administrationAligned).toBe(true)
    expect(aligned.regimen).toBe('repeated-dose')
    // Nothing about the area depends on the confirmation.
    const plain = run({ administrationAligned: false })
    if (aligned.aucTau.status !== 'available' || plain.aucTau.status !== 'available') {
      throw new Error('setup')
    }
    expect(aligned.aucTau.value).toBe(plain.aucTau.value)
  })

  it('lists observed sampling times without rounding or generating any', () => {
    expect(observedTimeChoices(linear)).toEqual([0, 2, 4, 6, 8, 10])
    expect(observedTimeChoices([...linear, linear[0] as ExperimentalMeasurement])).toEqual([
      0, 2, 4, 6, 8, 10,
    ])
  })
})
