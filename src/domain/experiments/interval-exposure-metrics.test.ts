/**
 * Observed interval exposure metrics tests (phase 50D).
 *
 * Every fixture is synthetic and the expected values are hand-checkable:
 * a linear concentration gradient over one 12 h interval has area 840
 * mg·L⁻¹·h, so the interval mean is 840/12 = 70 mg/L and the peak-to-trough
 * fluctuation is 100·(100 − 40)/70 = 85.714… %.
 */
import { describe, expect, it } from 'vitest'
import type {
  AdministrationMetadata,
  ExperimentalMeasurement,
} from './experimental-dataset'
import { analyzeIntervalAuc, type IntervalAucReport } from './interval-auc'
import { analyzeIntervalExposure } from './interval-exposure-metrics'

const rows = (pairs: readonly (readonly [number, number])[]): ExperimentalMeasurement[] =>
  pairs.map(([time, concentration], index) => ({
    id: `m${index + 1}`,
    sourceRow: index + 1,
    time,
    concentration,
  }))

/** C = 100 − 5t on [0, 12]: area 840, mean 70, peak 100, trough 40. */
const linear = rows([
  [0, 100],
  [2, 90],
  [4, 80],
  [6, 70],
  [8, 60],
  [10, 50],
  [12, 40],
])

const steady: AdministrationMetadata = {
  route: 'iv-bolus',
  regimen: 'repeated-dose-steady-state',
  timeReference: 'dose-time',
  dose: { value: 84, unit: 'mg' },
  doseBasis: 'per-administration',
  dosingInterval: { value: 12, unit: 'h' },
}

interface RunOptions {
  readonly measurements?: readonly ExperimentalMeasurement[]
  readonly timeUnit?: string
  readonly concentrationUnit?: string
  readonly administration?: AdministrationMetadata
  readonly start?: number
  readonly end?: number
  readonly selection?: { startTime: number; endTime: number } | null
  readonly aligned?: boolean
  readonly integrationMethod?: 'linear' | 'linear-up-log-down'
}

function intervalReport(options: RunOptions = {}): IntervalAucReport {
  const measurements = options.measurements ?? linear
  const selection =
    options.selection === undefined
      ? { startTime: options.start ?? 0, endTime: options.end ?? 12 }
      : options.selection
  return analyzeIntervalAuc({
    measurements,
    timeUnit: options.timeUnit ?? 'h',
    concentrationUnit: options.concentrationUnit ?? 'mg/L',
    administration: options.administration ?? steady,
    integrationMethod: options.integrationMethod ?? 'linear',
    terminalPointCount: 3,
    selection,
    administrationAligned: options.aligned ?? true,
  })
}

function run(options: RunOptions = {}) {
  const measurements = options.measurements ?? linear
  const timeUnit = options.timeUnit ?? 'h'
  const concentrationUnit = options.concentrationUnit ?? 'mg/L'
  return analyzeIntervalExposure({
    measurements,
    timeUnit,
    concentrationUnit,
    administration: options.administration ?? steady,
    interval: intervalReport(options),
  })
}

describe('interval exposure metrics', () => {
  it('reports the observed peak and trough with their source rows', () => {
    const report = run()

    expect(report.cmaxObs.status).toBe('available')
    expect(report.cmaxObs.kind).toBe('observed')
    expect(report.cmaxObs.value).toBe(100)
    expect(report.cmaxObs.unit).toBe('mg/L')
    expect(report.cmaxObs.observations).toEqual([{ time: 0, concentration: 100, sourceRow: 1 }])

    expect(report.tmaxObs.status).toBe('available')
    expect(report.tmaxObs.value).toBe(0)
    expect(report.tmaxObs.unit).toBe('h')

    expect(report.cminObs.status).toBe('available')
    expect(report.cminObs.value).toBe(40)
    expect(report.cminObs.observations).toEqual([{ time: 12, concentration: 40, sourceRow: 7 }])

    expect(report.tminObs.value).toBe(12)
    expect(report.tminObs.unit).toBe('h')
  })

  it('computes the interval mean from the AUCτ and the interval duration', () => {
    const report = run()
    expect(report.aucTauUsed).toEqual({ value: 840, unit: 'mg/L·h' })
    expect(report.window?.duration).toBe(12)
    expect(report.window?.observationCount).toBe(7)

    expect(report.cavgInterval.status).toBe('available')
    expect(report.cavgInterval.kind).toBe('calculated')
    // 840 mg/L·h ÷ 12 h = 70 mg/L.
    expect(report.cavgInterval.value).toBeCloseTo(70, 12)
    expect(report.cavgInterval.unit).toBe('mg/L')
    expect(report.cavgInterval.formula).toContain('t_end')
    expect(report.cavgInterval.substitution).toContain('840')
    expect(report.cavgInterval.assumptions.join(' ')).toMatch(/not an AUCτ-based steady-state average/i)
  })

  it('reports Cavg,ss and the fluctuation for a declared steady state', () => {
    const report = run()
    expect(report.dosingInterval).toEqual({
      recorded: { value: 12, unit: 'h' },
      hours: 12,
      inDatasetTimeUnit: 12,
    })

    expect(report.cavgSs.status).toBe('available')
    // 840 mg/L·h ÷ 12 h = 70 mg/L.
    expect(report.cavgSs.value).toBeCloseTo(70, 12)
    expect(report.cavgSs.unit).toBe('mg/L')
    expect(report.cavgSs.formula).toBe('Cavg,ss = AUCτ / τ')

    expect(report.fluctuation.status).toBe('available')
    // 100 · (100 − 40) / 70 = 85.714285…
    expect(report.fluctuation.value).toBeCloseTo(6000 / 70, 10)
    expect(report.fluctuation.unit).toBe('%')
    expect(report.fluctuation.substitution).toContain('70')
    expect(report.fluctuation.assumptions.join(' ')).toMatch(/lower bound/i)
  })

  it('keeps every observation that attains a tied maximum or minimum', () => {
    // 100 at 0 h and 2 h; 40 at 6 h and 12 h.
    const tied = rows([
      [0, 100],
      [2, 100],
      [4, 80],
      [6, 40],
      [8, 60],
      [10, 50],
      [12, 40],
    ])
    const report = run({ measurements: tied })

    expect(report.cmaxObs.status).toBe('conditional')
    expect(report.cmaxObs.observations).toEqual([
      { time: 0, concentration: 100, sourceRow: 1 },
      { time: 2, concentration: 100, sourceRow: 2 },
    ])
    expect(report.cmaxObs.message).toMatch(/2 sampling times/i)

    // A single Tmax would misrepresent the data: the earliest is shown and all
    // attaining rows stay attached.
    expect(report.tmaxObs.status).toBe('conditional')
    expect(report.tmaxObs.value).toBe(0)
    expect(report.tmaxObs.observations).toHaveLength(2)
    expect(report.tmaxObs.message).toMatch(/earliest/i)

    expect(report.cminObs.status).toBe('conditional')
    expect(report.cminObs.observations).toEqual([
      { time: 6, concentration: 40, sourceRow: 4 },
      { time: 12, concentration: 40, sourceRow: 7 },
    ])
    expect(report.tminObs.value).toBe(6)
    expect(report.warnings.some((warning) => /attained at 2 sampling times/.test(warning))).toBe(true)
  })

  it('ignores concentrations outside the selected interval', () => {
    // A much higher and a much lower concentration exist after the interval.
    const extended = rows([
      [0, 100],
      [2, 90],
      [4, 80],
      [6, 70],
      [8, 60],
      [10, 50],
      [12, 40],
      [16, 900],
      [20, 1],
    ])
    const report = run({ measurements: extended })

    expect(report.cmaxObs.value).toBe(100)
    expect(report.cminObs.value).toBe(40)
    expect(report.window?.observations.map((observation) => observation.sourceRow)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ])
    expect(report.window?.endTime).toBe(12)
    // The out-of-interval rows never appear in any metric.
    for (const metric of report.metrics) {
      expect(metric.observations ?? []).not.toContainEqual(
        expect.objectContaining({ sourceRow: 8 }),
      )
    }
  })

  it('keeps the mean a concentration when the time unit is minutes', () => {
    // τ = 1 h and a 60 min interval: AUC = (100+70)/2·30 + (70+40)/2·30 = 4200.
    const minuteRows = rows([
      [0, 100],
      [30, 70],
      [60, 40],
    ])
    const report = run({
      measurements: minuteRows,
      timeUnit: 'min',
      administration: { ...steady, dosingInterval: { value: 1, unit: 'h' } },
      end: 60,
    })

    expect(report.cavgInterval.status).toBe('available')
    // 4200 mg/L·min ÷ 60 min = 70 mg/L.
    expect(report.cavgInterval.value).toBeCloseTo(70, 12)
    expect(report.cavgInterval.unit).toBe('mg/L')

    expect(report.dosingInterval?.hours).toBe(1)
    expect(report.dosingInterval?.inDatasetTimeUnit).toBeCloseTo(60, 10)
    expect(report.cavgSs.status).toBe('available')
    expect(report.cavgSs.value).toBeCloseTo(70, 10)
    expect(report.fluctuation.value).toBeCloseTo((100 * (100 - 40)) / 70, 8)
  })

  it('keeps the observed metrics but refuses steady-state ones off steady state', () => {
    const report = run({ administration: { ...steady, regimen: 'repeated-dose' } })

    expect(report.cmaxObs.status).toBe('available')
    expect(report.cmaxObs.value).toBe(100)
    expect(report.cavgInterval.status).toBe('available')
    expect(report.cavgInterval.value).toBeCloseTo(70, 12)

    expect(report.cavgSs.status).toBe('not-applicable')
    expect(report.cavgSs.code).toBe('REGIMEN_NOT_STEADY_STATE')
    expect(report.cavgSs.message).toMatch(/not declared to be at steady state/i)
    expect(report.fluctuation.status).toBe('not-applicable')
    expect(report.fluctuation.code).toBe('REGIMEN_NOT_STEADY_STATE')
    expect(report.fluctuation.value).toBeUndefined()
  })

  it('refuses the steady-state metrics without the alignment confirmation', () => {
    const report = run({ aligned: false })
    expect(report.cmaxObs.status).toBe('available')
    expect(report.cavgInterval.status).toBe('available')
    expect(report.cavgSs.status).toBe('unavailable')
    expect(report.cavgSs.code).toBe('INTERVAL_NOT_ALIGNED')
    expect(report.fluctuation.status).toBe('unavailable')
    expect(report.fluctuation.code).toBe('CAVG_SS_UNAVAILABLE')
    expect(report.fluctuation.message).toMatch(/requires a usable Cavg,ss/i)
  })

  it('keeps the regimen verdict when the interval itself is unusable', () => {
    const unknown = run({ administration: { ...steady, regimen: 'unknown' } })
    expect(unknown.cmaxObs.status).toBe('unavailable')
    expect(unknown.cmaxObs.code).toBe('INTERVAL_AUC_UNAVAILABLE')
    expect(unknown.cmaxObs.message).toMatch(/regimen is recorded as unknown/i)
    // The steady-state verdict is still the specific one.
    expect(unknown.cavgSs.status).toBe('not-applicable')
    expect(unknown.cavgSs.code).toBe('REGIMEN_UNKNOWN')

    const single = run({ administration: { ...steady, regimen: 'single-dose' } })
    expect(single.cavgSs.code).toBe('REGIMEN_NOT_STEADY_STATE')
    expect(single.fluctuation.code).toBe('REGIMEN_NOT_STEADY_STATE')
  })

  it('refuses everything when no interval is selected', () => {
    const report = run({ selection: null })
    expect(report.window).toBeNull()
    expect(report.aucTauUsed).toBeNull()
    expect(report.dosingInterval).toBeNull()
    for (const metric of report.metrics) {
      expect(metric.status).toBe('unavailable')
      expect(metric.code).toBe('INTERVAL_NOT_SELECTED')
      expect(metric.value).toBeUndefined()
    }
  })

  it('reports an invalid measurement by source row', () => {
    const invalid = [...linear, { id: 'bad', sourceRow: 9, time: 14, concentration: Number.NaN }]
    const report = run({ measurements: invalid })
    expect(report.cmaxObs.code).toBe('INVALID_MEASUREMENT')
    expect(report.cmaxObs.message).toMatch(/Source row\(s\) 9/)
  })

  it('handles a zero observed trough without inventing a value', () => {
    // 100 → 50 → 10 → 0 on [0, 12]; area 440, mean 36.666…, trough 0 at 12 h.
    const decaying = rows([
      [0, 100],
      [4, 50],
      [8, 10],
      [12, 0],
    ])
    const report = run({ measurements: decaying })
    expect(report.cminObs.status).toBe('available')
    expect(report.cminObs.value).toBe(0)
    expect(report.tminObs.value).toBe(12)
    expect(report.cavgInterval.value).toBeCloseTo(440 / 12, 12)
    expect(report.fluctuation.status).toBe('available')
    expect(report.fluctuation.value).toBeCloseTo((100 * 100) / (440 / 12), 8)
  })

  it('refuses the fluctuation rather than dividing by a zero mean', () => {
    // A guarded state the interval module already refuses upstream (an AUCτ of
    // exactly zero is never "available"); the contract is pinned here so a
    // future change cannot turn it into Infinity.
    const real = intervalReport()
    if (real.aucTau.status !== 'available') throw new Error('setup')
    const zeroArea: IntervalAucReport = {
      ...real,
      aucTau: { ...real.aucTau, value: 0 },
    }
    const report = analyzeIntervalExposure({
      measurements: linear,
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      administration: steady,
      interval: zeroArea,
    })
    expect(report.cavgInterval).toMatchObject({ status: 'available', value: 0 })
    expect(report.cavgSs.status).toBe('available')
    expect(report.cavgSs.value).toBe(0)
    expect(report.fluctuation.status).toBe('unavailable')
    expect(report.fluctuation.code).toBe('NUMERICAL_FAILURE')
    expect(report.fluctuation.value).toBeUndefined()
    expect(report.fluctuation.message).toMatch(/cannot be expressed as a percentage/i)
  })

  it('refuses when the interval rows and the AUCτ rows disagree', () => {
    const real = intervalReport()
    if (real.aucTau.status !== 'available') throw new Error('setup')
    const inconsistent: IntervalAucReport = {
      ...real,
      aucTau: { ...real.aucTau, contributingSourceRows: [1, 2, 3] },
    }
    const report = analyzeIntervalExposure({
      measurements: linear,
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      administration: steady,
      interval: inconsistent,
    })
    expect(report.cmaxObs.status).toBe('unavailable')
    expect(report.cmaxObs.code).toBe('OBSERVATIONS_INCONSISTENT')
    expect(report.cmaxObs.message).toMatch(/do not match the rows the AUCτ/i)
  })

  it('exposes the metrics in a stable order with their units and kinds', () => {
    const report = run()
    expect(report.metrics.map((metric) => metric.id)).toEqual([
      'cmax-obs',
      'tmax-obs',
      'cmin-obs',
      'tmin-obs',
      'cavg-interval',
      'cavg-ss',
      'fluctuation',
    ])
    expect(report.metrics.filter((metric) => metric.kind === 'observed')).toHaveLength(4)
    expect(report.metrics.filter((metric) => metric.kind === 'calculated')).toHaveLength(3)
    for (const metric of report.metrics) {
      expect(metric.status === 'available' || metric.status === 'conditional').toBe(true)
      expect(metric.unit === undefined || metric.unit.length > 0).toBe(true)
    }
    expect(report.summary).toMatch(/declares steady state/i)
  })

  it('does not mutate the measurements it reads', () => {
    const snapshot = JSON.stringify(linear)
    run()
    run({ aligned: false })
    expect(JSON.stringify(linear)).toBe(snapshot)
  })
})
