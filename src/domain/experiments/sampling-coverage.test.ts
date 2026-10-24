/**
 * Sampling coverage diagnostics tests (phase 50E).
 *
 * Fixtures are synthetic and every expectation is hand-checkable: with times
 * 0, 1, 4, 5, 12 the adjacent gaps are 1, 3, 1 and 7, so the minimum is 1, the
 * median is (1 + 3)/2 = 2, the mean is 12/4 = 3 and the maximum is 7.
 */
import { describe, expect, it } from 'vitest'
import type {
  AdministrationMetadata,
  ExperimentalMeasurement,
} from './experimental-dataset'
import { analyzeIntervalAuc } from './interval-auc'
import { analyzeIntervalExposure } from './interval-exposure-metrics'
import { analyzeSamplingCoverage } from './sampling-coverage'

const rows = (pairs: readonly (readonly [number, number])[]): ExperimentalMeasurement[] =>
  pairs.map(([time, concentration], index) => ({
    id: `m${index + 1}`,
    sourceRow: index + 1,
    time,
    concentration,
  }))

/** Regular 2 h sampling over [0, 12]; C declines 100 → 40. */
const regular = rows([
  [0, 100],
  [2, 90],
  [4, 80],
  [6, 70],
  [8, 60],
  [10, 50],
  [12, 40],
])

/** Irregular times 0, 1, 4, 5, 12 (gaps 1, 3, 1, 7). */
const irregular = rows([
  [0, 100],
  [1, 92],
  [4, 70],
  [5, 62],
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
  readonly administration?: AdministrationMetadata | undefined
  readonly start?: number
  readonly end?: number
  readonly selection?: { startTime: number; endTime: number } | null
}

function run(options: RunOptions = {}) {
  const measurements = options.measurements ?? regular
  const timeUnit = options.timeUnit ?? 'h'
  const concentrationUnit = options.concentrationUnit ?? 'mg/L'
  const administration = 'administration' in options ? options.administration : steady
  const selection =
    options.selection === undefined
      ? { startTime: options.start ?? 0, endTime: options.end ?? 12 }
      : options.selection
  const interval = analyzeIntervalAuc({
    measurements,
    timeUnit,
    concentrationUnit,
    administration,
    integrationMethod: 'linear',
    terminalPointCount: 3,
    selection,
    administrationAligned: true,
  })
  const exposure = analyzeIntervalExposure({
    measurements,
    timeUnit,
    concentrationUnit,
    administration,
    interval,
  })
  return analyzeSamplingCoverage({
    measurements,
    timeUnit,
    concentrationUnit,
    administration,
    interval,
    exposure,
  })
}

describe('sampling coverage diagnostics', () => {
  it('reports record and distinct-time counts separately for regular sampling', () => {
    const report = run()
    expect(report.status).toBe('available')
    expect(report.window).toMatchObject({
      startTime: 0,
      endTime: 12,
      timeUnit: 'h',
      duration: 12,
      observationCount: 7,
      distinctTimeCount: 7,
      startObserved: true,
      endObserved: true,
    })
    expect(report.repeatedTimes).toEqual([])

    expect(report.gaps.status).toBe('available')
    if (report.gaps.status !== 'available') return
    // Six adjacent gaps of 2 h each.
    expect(report.gaps.value.gapCount).toBe(6)
    expect(report.gaps.value.minimumGap).toBe(2)
    expect(report.gaps.value.medianGap).toBe(2)
    expect(report.gaps.value.meanGap).toBe(2)
    expect(report.gaps.value.maximumGap).toBe(2)
    // Every gap ties for the maximum, and every tie is returned.
    expect(report.gaps.value.maximumGaps).toHaveLength(6)
    expect(report.gaps.value.gaps.map((gap) => gap.fromTime)).toEqual([0, 2, 4, 6, 8, 10])
    expect(report.gaps.value.gaps.every((gap) => gap.isMaximum)).toBe(true)
  })

  it('matches hand-calculated statistics for irregular sampling', () => {
    const report = run({ measurements: irregular })
    expect(report.window?.observationCount).toBe(5)
    expect(report.window?.distinctTimeCount).toBe(5)

    expect(report.gaps.status).toBe('available')
    if (report.gaps.status !== 'available') return
    const gaps = report.gaps.value
    expect(gaps.gapCount).toBe(4)
    expect(gaps.minimumGap).toBe(1)
    // Sorted gaps 1, 1, 3, 7 → median (1 + 3)/2 = 2.
    expect(gaps.medianGap).toBe(2)
    // Total 12 over 4 gaps.
    expect(gaps.meanGap).toBe(3)
    expect(gaps.maximumGap).toBe(7)
    expect(gaps.gaps.map((gap) => [gap.fromTime, gap.toTime, gap.gapDuration])).toEqual([
      [0, 1, 1],
      [1, 4, 3],
      [4, 5, 1],
      [5, 12, 7],
    ])
    expect(gaps.maximumGaps).toHaveLength(1)
    expect(gaps.maximumGaps[0]).toMatchObject({
      fromTime: 5,
      toTime: 12,
      gapDuration: 7,
      fromSourceRows: [4],
      toSourceRows: [5],
    })
  })

  it('uses the median of the two middle gaps for an even count', () => {
    // Times 0, 2, 6, 12 → gaps 2, 4, 6 → odd; use 0, 2, 6, 10, 12 → 2, 4, 4, 2.
    const even = rows([
      [0, 100],
      [2, 90],
      [6, 70],
      [10, 50],
      [12, 40],
    ])
    const report = run({ measurements: even })
    expect(report.gaps.status).toBe('available')
    if (report.gaps.status !== 'available') return
    // Sorted 2, 2, 4, 4 → median (2 + 4)/2 = 3.
    expect(report.gaps.value.medianGap).toBe(3)
    expect(report.gaps.value.maximumGaps).toHaveLength(2)
  })

  it('never lets records outside the window enter the statistics', () => {
    const extended = rows([
      [0, 100],
      [2, 90],
      [4, 80],
      [6, 70],
      [8, 60],
      [10, 50],
      [12, 40],
      [16, 999],
      [16, 998],
      [20, 1],
    ])
    const report = run({ measurements: extended, start: 0, end: 12 })
    expect(report.window?.observationCount).toBe(7)
    expect(report.window?.distinctTimeCount).toBe(7)
    expect(report.repeatedTimes).toEqual([])
    if (report.gaps.status !== 'available') throw new Error('setup')
    expect(report.gaps.value.maximumGap).toBe(2)
    // No gap ever reaches the out-of-window times.
    expect(report.gaps.value.gaps.every((gap) => gap.toTime <= 12)).toBe(true)
  })

  it('includes the boundary records and reports whether each was observed', () => {
    const insideOnly = run({ start: 1, end: 11 })
    expect(insideOnly.window).toMatchObject({
      startObserved: false,
      endObserved: false,
      // Times 2, 4, 6, 8, 10 fall inside (1, 11): five records, five times.
      observationCount: 5,
      distinctTimeCount: 5,
      duration: 10,
    })
    if (insideOnly.gaps.status !== 'available') throw new Error('setup')
    expect(insideOnly.gaps.value.gaps.map((gap) => gap.fromTime)).toEqual([2, 4, 6, 8])

    const observed = run()
    expect(observed.window?.startObserved).toBe(true)
    expect(observed.window?.endObserved).toBe(true)
  })

  it('refuses to invent a window when nothing is selected', () => {
    const report = run({ selection: null })
    expect(report.status).toBe('unavailable')
    expect(report.code).toBe('INTERVAL_NOT_SELECTED')
    expect(report.window).toBeNull()
    expect(report.gaps.status).toBe('unavailable')
    expect(report.maximumGapFraction.status).toBe('unavailable')
    expect(report.extremeLocations.status).toBe('unavailable')
    expect(report.repeatedTimes).toEqual([])
    expect(report.summary).toMatch(/default window is never applied/i)
  })

  it('keeps every source row for a repeated sampling time instead of averaging it', () => {
    // Two records at 0 h, one at 4 h and 8 h: 4 records over 3 distinct times.
    const duplicated = rows([
      [0, 100],
      [0, 96],
      [4, 70],
      [8, 40],
    ])
    const report = run({ measurements: duplicated })
    expect(report.window).toMatchObject({ observationCount: 4, distinctTimeCount: 3 })
    expect(report.repeatedTimes).toEqual([{ time: 0, observationCount: 2, sourceRows: [1, 2] }])

    if (report.gaps.status !== 'available') throw new Error('setup')
    expect(report.gaps.value.gapCount).toBe(2)
    // The first gap starts at a duplicated time and names both rows.
    expect(report.gaps.value.gaps[0]?.fromSourceRows).toEqual([1, 2])
    expect(report.gaps.value.gaps[0]?.gapDuration).toBe(4)
    // Both gaps are 4 h, so both tie for the maximum.
    expect(report.gaps.value.maximumGaps).toHaveLength(2)
  })

  it('refuses gap statistics when only one distinct time exists', () => {
    const single = rows([
      [0, 100],
      [0, 90],
    ])
    const report = run({ measurements: single })
    // The window itself is still described.
    expect(report.status).toBe('available')
    expect(report.window).toMatchObject({ observationCount: 2, distinctTimeCount: 1, startObserved: true })
    expect(report.gaps.status).toBe('unavailable')
    if (report.gaps.status !== 'unavailable') return
    expect(report.gaps.code).toBe('INSUFFICIENT_SAMPLING_TIMES')
    expect(report.gaps.message).toMatch(/at least two are required/i)
    // No fabricated zero gap anywhere.
    expect(JSON.stringify(report)).not.toContain('"minimumGap":0')
    expect(report.maximumGapFraction.status).toBe('unavailable')
    expect(report.repeatedTimes).toEqual([{ time: 0, observationCount: 2, sourceRows: [1, 2] }])
  })

  it('computes the maximum gap as a share of the window width', () => {
    const report = run({ measurements: irregular })
    expect(report.maximumGapFraction.status).toBe('available')
    if (report.maximumGapFraction.status !== 'available') return
    // 100 × 7 / 12.
    expect(report.maximumGapFraction.value.percent).toBeCloseTo((100 * 7) / 12, 10)
    expect(report.maximumGapFraction.value.maximumGap).toBe(7)
    expect(report.maximumGapFraction.value.windowDuration).toBe(12)
    expect(report.maximumGapFraction.value.timeUnit).toBe('h')
  })

  it('keeps sampling statistics when the AUCτ is refused', () => {
    // τ = 8 h but a 12 h window: phase 50C refuses the length, and the exposure
    // report with it — the sampling statistics must survive.
    const report = run({ administration: { ...steady, dosingInterval: { value: 8, unit: 'h' } } })
    expect(report.status).toBe('available')
    expect(report.window?.observationCount).toBe(7)
    if (report.gaps.status !== 'available') throw new Error('setup')
    expect(report.gaps.value.maximumGap).toBe(2)
    // The extreme positions cannot be sourced without the exposure report.
    expect(report.extremeLocations.status).toBe('unavailable')
    if (report.extremeLocations.status !== 'unavailable') return
    expect(report.extremeLocations.code).toBe('EXPOSURE_REPORT_UNAVAILABLE')
    expect(report.extremeLocations.message).toMatch(/cannot be classified/i)
  })

  it('keeps sampling statistics without any dosing metadata or τ', () => {
    const report = run({ administration: undefined })
    expect(report.status).toBe('available')
    if (report.gaps.status !== 'available') throw new Error('setup')
    expect(report.gaps.value.gapCount).toBe(6)
    expect(report.dosingInterval).toBeNull()
  })

  it('reports τ converted to the dataset time unit when it is valid', () => {
    const inMinutes = rows([
      [0, 100],
      [120, 90],
      [240, 60],
      [480, 40],
    ])
    const report = run({
      measurements: inMinutes,
      timeUnit: 'min',
      administration: { ...steady, dosingInterval: { value: 8, unit: 'h' } },
      end: 480,
    })
    expect(report.timeUnit).toBe('min')
    expect(report.dosingInterval).toEqual({
      recorded: { value: 8, unit: 'h' },
      inDatasetTimeUnit: 480,
    })
    if (report.gaps.status !== 'available') throw new Error('setup')
    // Gaps are reported in minutes, never silently in hours.
    expect(report.gaps.value.gaps.map((gap) => gap.gapDuration)).toEqual([120, 120, 240])
    expect(report.gaps.value.maximumGap).toBe(240)
  })

  it('classifies an observed maximum at the start and inside, listing every row', () => {
    // 100 at 0 h (start) and 6 h (inside); 40 at 12 h (end).
    const report = run({
      measurements: rows([
        [0, 100],
        [3, 50],
        [6, 100],
        [9, 70],
        [12, 40],
      ]),
    })
    expect(report.extremeLocations.status).toBe('available')
    if (report.extremeLocations.status !== 'available') return
    const { maximum, minimum } = report.extremeLocations.value
    expect(maximum.concentration).toBe(100)
    expect(maximum.positions).toEqual(['start', 'inside'])
    expect(maximum.atStart).toBe(true)
    expect(maximum.inside).toBe(true)
    expect(maximum.atEnd).toBe(false)
    expect(maximum.observations).toEqual([
      { time: 0, concentration: 100, sourceRow: 1, position: 'start' },
      { time: 6, concentration: 100, sourceRow: 3, position: 'inside' },
    ])
    expect(minimum.positions).toEqual(['end'])
    expect(minimum.atEnd).toBe(true)
  })

  it('classifies a maximum at the end and a minimum at the start', () => {
    const report = run({
      measurements: rows([
        [0, 10],
        [6, 50],
        [12, 100],
      ]),
    })
    if (report.extremeLocations.status !== 'available') throw new Error('setup')
    expect(report.extremeLocations.value.maximum.positions).toEqual(['end'])
    expect(report.extremeLocations.value.minimum.positions).toEqual(['start'])
  })

  it('keeps the positions of every tied extreme in the window', () => {
    // 100 at both boundaries, 40 at 0 h… no: build distinct extremes.
    // Times 0, 2, 5, 9, 12 with 80 at 0 and 12 (start + end), 20 at 5 (inside).
    const report = run({
      measurements: rows([
        [0, 80],
        [2, 55],
        [5, 20],
        [9, 55],
        [12, 80],
      ]),
    })
    if (report.extremeLocations.status !== 'available') throw new Error('setup')
    expect(report.extremeLocations.value.maximum.positions).toEqual(['start', 'end'])
    expect(report.extremeLocations.value.maximum.observations).toHaveLength(2)
    expect(report.extremeLocations.value.minimum.positions).toEqual(['inside'])
  })

  it('rejects invalid measurements, units and window order with stable codes', () => {
    const invalid = [...regular, { id: 'bad', sourceRow: 9, time: 6, concentration: Number.NaN }]
    const invalidReport = run({ measurements: invalid })
    expect(invalidReport.code).toBe('INVALID_MEASUREMENT')
    expect(invalidReport.message).toMatch(/Source row\(s\) 9/)

    expect(run({ timeUnit: 'mg/L' }).code).toBe('TIME_UNIT_INCOMPATIBLE')
    expect(run({ start: 12, end: 0 }).code).toBe('INTERVAL_ORDER')
    expect(run({ start: Number.NaN, end: 12 }).code).toBe('INTERVAL_NOT_FINITE')
    expect(run({ start: 100, end: 200 }).code).toBe('NO_OBSERVATIONS_IN_INTERVAL')
  })

  it('keeps record diagnostics for a zero-width selection without inventing a gap', () => {
    const report = run({ start: 12, end: 12 })
    expect(report.status).toBe('available')
    expect(report.window).toMatchObject({
      startTime: 12,
      endTime: 12,
      duration: null,
      observationCount: 1,
      distinctTimeCount: 1,
      startObserved: true,
      endObserved: true,
    })
    expect(report.gaps.status).toBe('unavailable')
    if (report.gaps.status !== 'unavailable') return
    expect(report.gaps.code).toBe('INSUFFICIENT_SAMPLING_TIMES')
    expect(report.maximumGapFraction.status).toBe('unavailable')
  })

  it('keeps independent statistics available when a derived window width overflows', () => {
    const report = run({ start: -Number.MAX_VALUE, end: Number.MAX_VALUE })
    expect(report.status).toBe('available')
    expect(report.window?.duration).toBeNull()
    expect(report.gaps.status).toBe('available')
    expect(report.maximumGapFraction.status).toBe('unavailable')
    if (report.maximumGapFraction.status !== 'unavailable') return
    expect(report.maximumGapFraction.code).toBe('WINDOW_DURATION_INVALID')
    expect(report.summary).not.toMatch(/Infinity|NaN/)
  })

  it('avoids intermediate overflow in the maximum-gap percentage', () => {
    const wide = rows([
      [0, 100],
      [Number.MAX_VALUE, 40],
    ])
    const report = run({ measurements: wide, start: 0, end: Number.MAX_VALUE })
    expect(report.maximumGapFraction.status).toBe('available')
    if (report.maximumGapFraction.status !== 'available') return
    expect(report.maximumGapFraction.value.percent).toBe(100)
    expect(report.maximumGapFraction.value.maximumGap).toBe(Number.MAX_VALUE)
  })

  it('preserves the dataset row order and never mutates the input', () => {
    // Deliberately unsorted input: the same time appears twice, out of order.
    const unsorted = rows([
      [12, 40],
      [0, 100],
      [4, 70],
      [0, 96],
    ])
    const snapshot = JSON.stringify(unsorted)
    const report = run({ measurements: unsorted, start: 0, end: 12 })
    expect(JSON.stringify(unsorted)).toBe(snapshot)

    // Times are sorted for the statistics, but each time keeps dataset order.
    expect(report.repeatedTimes).toEqual([{ time: 0, observationCount: 2, sourceRows: [2, 4] }])
    if (report.gaps.status !== 'available') throw new Error('setup')
    expect(report.gaps.value.gaps.map((gap) => [gap.fromTime, gap.toTime])).toEqual([
      [0, 4],
      [4, 12],
    ])
    expect(report.gaps.value.gaps[0]?.fromSourceRows).toEqual([2, 4])
  })

  it('states the standing limitations and never issues a verdict', () => {
    const report = run()
    expect(report.limits.length).toBeGreaterThanOrEqual(3)
    const limits = report.limits.join(' ')
    expect(limits).toMatch(/do not show that the true peak or trough was captured/i)
    expect(limits).toMatch(/No threshold is applied and no verdict is implied/i)
    expect(limits).toMatch(/not a coverage score/i)
    // No pass/fail vocabulary anywhere in the report.
    const serialized = JSON.stringify(report).toLowerCase()
    for (const word of ['adequate', 'insufficient sampling', 'pass', 'fail']) {
      expect(serialized.includes(`"${word}"`)).toBe(false)
    }
  })

  it('reports distinct counts and record counts differently when they differ', () => {
    const duplicated = rows([
      [0, 100],
      [0, 98],
      [0, 96],
      [6, 60],
      [12, 40],
    ])
    const report = run({ measurements: duplicated })
    expect(report.window?.observationCount).toBe(5)
    expect(report.window?.distinctTimeCount).toBe(3)
    if (report.gaps.status !== 'available') throw new Error('setup')
    // Two gaps over the three distinct times, not four.
    expect(report.gaps.value.gapCount).toBe(2)
    expect(report.summary).toMatch(/5 measurement record\(s\) at 3 distinct sampling time\(s\)/)
  })
})
