/**
 * Sampling coverage diagnostics (phase 50E).
 *
 * Descriptive statistics about the sampling TIMES inside the interval the
 * analyst selected in phase 50C. They answer "what did we actually sample?" —
 * nothing about whether that sampling was adequate.
 *
 * What these diagnostics are:
 * - counts of measurement RECORDS versus distinct sampling TIMES (they differ
 *   whenever a time is shared by several rows);
 * - the adjacent-gap distribution over the distinct times, including every gap
 *   that attains the maximum;
 * - which times were sampled more than once, with every contributing row;
 * - whether the selected boundaries were actually observed;
 * - where the phase-50D observed extremes fall relative to those boundaries;
 * - the maximum gap as a fraction of the selected window's width.
 *
 * What they are NOT, by construction:
 * - No threshold. There is no "enough"/"too sparse" verdict, no minimum point
 *   count, no maximum gap limit. Sampling adequacy depends on the drug, the
 *   regimen, the kinetics and the study design; without a justified rule this
 *   module only reports what was observed.
 * - No inference between samples. Nothing is interpolated, extrapolated,
 *   smoothed, fitted or zero-filled; no unobserved time is created.
 * - No re-derivation of AUCτ, λ_z, Cmax or Cmin. The interval comes from the
 *   phase-50C report and the extreme positions reuse the phase-50D
 *   `IntervalExposureReport`; when that report is unavailable the location
 *   diagnostic says so instead of recomputing a peak.
 * - No influence on any pharmacokinetic result. These numbers never feed AUCτ,
 *   Cmax, Cmin, Cavg,ss or the fluctuation.
 *
 * Independence: the statistics need a selected window and its observations —
 * they do NOT need τ, administration metadata, a usable AUCτ or an observed
 * boundary. A dataset whose interval length does not match τ (so no AUCτ) still
 * gets its sampling statistics, and the two statuses stay separate.
 *
 * Pure domain module: no React, no storage, no I/O. The caller's array is read,
 * never sorted in place, and derived values are ephemeral.
 */
import { unitCatalog } from '../pharmacology/unit-catalog'
import type {
  AdministrationMetadata,
  AdministrationQuantity,
  ExperimentalMeasurement,
} from './experimental-dataset'
import type { IntervalAucReport } from './interval-auc'
import type { IntervalExposureMetric, IntervalExposureReport } from './interval-exposure-metrics'

export type SamplingCoverageCode =
  /** No interval has been selected yet. */
  | 'INTERVAL_NOT_SELECTED'
  /** The selected boundaries are not finite numbers. */
  | 'INTERVAL_NOT_FINITE'
  /** The selected start is after the selected end. */
  | 'INTERVAL_ORDER'
  /** No measurement falls inside the selected window. */
  | 'NO_OBSERVATIONS_IN_INTERVAL'
  /** A measurement is not a valid finite non-negative pair. */
  | 'INVALID_MEASUREMENT'
  /** The dataset's declared time unit is not a time unit. */
  | 'TIME_UNIT_INCOMPATIBLE'
  /** Fewer than two distinct sampling times: no gap exists to measure. */
  | 'INSUFFICIENT_SAMPLING_TIMES'
  /** A computed statistic is not a finite, non-negative number. */
  | 'NUMERICAL_FAILURE'
  /** The window width is not a positive finite duration (fraction only). */
  | 'WINDOW_DURATION_INVALID'
  /** The phase-50D exposure report cannot supply the observed extremes. */
  | 'EXPOSURE_REPORT_UNAVAILABLE'

/**
 * A section of the report that can be reported or refused on its own, so an
 * unavailable fraction (say) never hides the gap statistics that are valid.
 */
export type SamplingCoverageSection<T> =
  | { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly code: SamplingCoverageCode; readonly message: string }

/** The window the statistics were computed over. */
export interface SamplingWindowSummary {
  readonly startTime: number
  readonly endTime: number
  readonly timeUnit: string
  /** `endTime − startTime`, or null if that subtraction is not positive and finite. */
  readonly duration: number | null
  /** True when a measurement record exists exactly at `startTime`. */
  readonly startObserved: boolean
  /** True when a measurement record exists exactly at `endTime`. */
  readonly endObserved: boolean
  /** Measurement RECORDS inside `[startTime, endTime]` (both included). */
  readonly observationCount: number
  /** Distinct sampling TIMES inside the window. */
  readonly distinctTimeCount: number
}

/** One adjacent pair of distinct sampling times. */
export interface SamplingGap {
  readonly fromTime: number
  readonly toTime: number
  readonly gapDuration: number
  /** Every source row observed at `fromTime`. */
  readonly fromSourceRows: readonly number[]
  /** Every source row observed at `toTime`. */
  readonly toSourceRows: readonly number[]
  /** True when `gapDuration` equals the largest gap in the window. */
  readonly isMaximum: boolean
}

export interface SamplingGapStatistics {
  /** Number of adjacent gaps = distinctTimeCount − 1. */
  readonly gapCount: number
  readonly minimumGap: number
  /** Median of the gaps; for an even count, the mean of the two middle gaps. */
  readonly medianGap: number
  readonly meanGap: number
  readonly maximumGap: number
  /** Every adjacent gap, ascending by `fromTime` (complete, not truncated). */
  readonly gaps: readonly SamplingGap[]
  /** Every gap attaining `maximumGap` — all ties, never only the first. */
  readonly maximumGaps: readonly SamplingGap[]
}

/** A sampling time shared by more than one measurement record. */
export interface RepeatedSamplingTime {
  readonly time: number
  readonly observationCount: number
  /** Every source row recorded at this time, in dataset order. */
  readonly sourceRows: readonly number[]
}

/** Where an observed concentration sits relative to the selected boundaries. */
export type SamplingPosition = 'start' | 'end' | 'inside'

export interface ObservedExtremePosition {
  readonly time: number
  readonly concentration: number
  readonly sourceRow: number
  readonly position: SamplingPosition
}

export interface ObservedExtremeLocations {
  readonly extreme: 'maximum' | 'minimum'
  readonly concentration: number
  readonly concentrationUnit: string
  /** Distinct positions where this extreme was observed, in start/inside/end order. */
  readonly positions: readonly SamplingPosition[]
  readonly atStart: boolean
  readonly atEnd: boolean
  readonly inside: boolean
  /** Every observation attaining the extreme, with its position. */
  readonly observations: readonly ObservedExtremePosition[]
}

export interface SamplingGapFraction {
  readonly percent: number
  readonly maximumGap: number
  readonly windowDuration: number
  readonly timeUnit: string
}

export interface SamplingCoverageInput {
  readonly measurements: readonly ExperimentalMeasurement[]
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly administration: AdministrationMetadata | undefined
  /** The phase-50C analysis: its selection defines the window. */
  readonly interval: IntervalAucReport
  /** The phase-50D report: its observed extremes define the location diagnostic. */
  readonly exposure: IntervalExposureReport
}

export interface SamplingCoverageReport {
  /** `available` when the window and its counts could be established. */
  readonly status: 'available' | 'unavailable'
  readonly code?: SamplingCoverageCode
  readonly message?: string
  readonly timeUnit: string
  readonly window: SamplingWindowSummary | null
  readonly gaps: SamplingCoverageSection<SamplingGapStatistics>
  /** Times shared by more than one record; empty when none (or no window). */
  readonly repeatedTimes: readonly RepeatedSamplingTime[]
  readonly maximumGapFraction: SamplingCoverageSection<SamplingGapFraction>
  readonly extremeLocations: SamplingCoverageSection<{
    readonly maximum: ObservedExtremeLocations
    readonly minimum: ObservedExtremeLocations
  }>
  /** The recorded τ converted to the dataset time unit, when a valid one exists. */
  readonly dosingInterval: {
    readonly recorded: AdministrationQuantity
    readonly inDatasetTimeUnit: number
  } | null
  /** Standing limitations, authored here so the UI cannot soften them. */
  readonly limits: readonly string[]
  readonly summary: string
}

/** Stated once; the UI renders these verbatim. */
const LIMITS: readonly string[] = [
  'These diagnostics describe the sampling TIMES only. They do not show that the true peak or trough was captured, and they do not show that the data are adequate for any particular analysis.',
  'No threshold is applied and no verdict is implied: sampling adequacy depends on the drug, the regimen, the kinetics and the study design.',
  'Nothing is inferred between samples — no concentration, peak, trough, Tmax/Tmin or integration error is estimated, and no unobserved time is created.',
  'The maximum-gap percentage is a proportion of the selected window, not a coverage score.',
]

function baseFactor(unit: string, dimension: 'time'): number | null {
  const def = unitCatalog.get(unit)
  if (def === undefined || def.dimension !== dimension) return null
  return def.toBase
}

const exact = (value: number): string => String(value)

function ascending(values: readonly number[]): readonly number[] {
  return [...values].sort((a, b) => a - b)
}

/**
 * Median of an already-ascending list. Even counts average the two middle
 * values, as documented in `docs/experimental-data.md` §21.
 */
function medianOf(sorted: readonly number[]): number {
  const count = sorted.length
  const middle = Math.floor(count / 2)
  if (count % 2 === 1) return sorted[middle] as number
  const lower = sorted[middle - 1] as number
  const upper = sorted[middle] as number
  return (lower + upper) / 2
}

export function analyzeSamplingCoverage(input: SamplingCoverageInput): SamplingCoverageReport {
  const { measurements, timeUnit, concentrationUnit, administration, interval, exposure } = input

  const refuse = (code: SamplingCoverageCode, message: string): SamplingCoverageReport => ({
    status: 'unavailable',
    code,
    message,
    timeUnit,
    window: null,
    gaps: { status: 'unavailable', code, message },
    repeatedTimes: [],
    maximumGapFraction: { status: 'unavailable', code, message },
    extremeLocations: { status: 'unavailable', code, message },
    dosingInterval: null,
    limits: LIMITS,
    summary: message,
  })

  // --- 1. The analyst's selection defines the window ----------------------
  // Deliberately NOT `interval.interval`: that object only exists when the
  // interval passed every phase-50C check, including the τ length. Sampling
  // diagnostics must survive an unusable AUCτ, so the window comes from the
  // selection itself and τ is not consulted here.
  const selection = interval.selection
  if (selection === null) {
    return refuse(
      'INTERVAL_NOT_SELECTED',
      'No interval has been selected, so there is no window to describe. A default window is never applied.',
    )
  }
  if (!Number.isFinite(selection.startTime) || !Number.isFinite(selection.endTime)) {
    return refuse('INTERVAL_NOT_FINITE', 'The selected interval boundaries must be finite numbers.')
  }
  if (selection.startTime > selection.endTime) {
    return refuse(
      'INTERVAL_ORDER',
      `The selected start (${exact(selection.startTime)} ${timeUnit}) must not be later than its end (${exact(selection.endTime)} ${timeUnit}).`,
    )
  }

  if (baseFactor(timeUnit, 'time') === null) {
    return refuse(
      'TIME_UNIT_INCOMPATIBLE',
      `The dataset time unit "${timeUnit}" is not a time unit, so the interval width cannot be interpreted.`,
    )
  }

  const invalidRows: number[] = []
  for (const measurement of measurements) {
    if (
      typeof measurement.time !== 'number' ||
      typeof measurement.concentration !== 'number' ||
      !Number.isFinite(measurement.time) ||
      !Number.isFinite(measurement.concentration) ||
      measurement.time < 0 ||
      measurement.concentration < 0
    ) {
      invalidRows.push(measurement.sourceRow)
    }
  }
  if (invalidRows.length > 0) {
    return refuse(
      'INVALID_MEASUREMENT',
      `Source row(s) ${invalidRows.join(', ')} are not finite non-negative time/concentration pairs, so the sampling summary is refused.`,
    )
  }

  // --- 2. Rows inside the closed window -----------------------------------
  const inside = measurements.filter(
    (measurement) => measurement.time >= selection.startTime && measurement.time <= selection.endTime,
  )
  if (inside.length === 0) {
    return refuse(
      'NO_OBSERVATIONS_IN_INTERVAL',
      'No measurement falls inside the selected interval, so there is no sampling to describe.',
    )
  }

  // Distinct times ascending, and the rows recorded at each time (dataset order).
  const rowsByTime = new Map<number, number[]>()
  for (const measurement of inside) {
    const rows = rowsByTime.get(measurement.time)
    if (rows === undefined) rowsByTime.set(measurement.time, [measurement.sourceRow])
    else rows.push(measurement.sourceRow)
  }
  const times = ascending([...rowsByTime.keys()])
  const calculatedWindowDuration = selection.endTime - selection.startTime
  const windowDuration =
    Number.isFinite(calculatedWindowDuration) && calculatedWindowDuration > 0
      ? calculatedWindowDuration
      : null

  const window: SamplingWindowSummary = {
    startTime: selection.startTime,
    endTime: selection.endTime,
    timeUnit,
    duration: windowDuration,
    startObserved: rowsByTime.has(selection.startTime),
    endObserved: rowsByTime.has(selection.endTime),
    observationCount: inside.length,
    distinctTimeCount: times.length,
  }

  const repeatedTimes: RepeatedSamplingTime[] = times
    .filter((time) => (rowsByTime.get(time) as number[]).length > 1)
    .map((time) => {
      const sourceRows = rowsByTime.get(time) as number[]
      return { time, observationCount: sourceRows.length, sourceRows: [...sourceRows] }
    })

  // --- 3. Adjacent gaps over the distinct times ---------------------------
  let gaps: SamplingCoverageSection<SamplingGapStatistics>
  if (times.length < 2) {
    const message = `The interval contains ${times.length} distinct sampling time(s); at least two are required before a gap can be measured.`
    gaps = { status: 'unavailable', code: 'INSUFFICIENT_SAMPLING_TIMES', message }
  } else {
    const durations: number[] = []
    for (let index = 1; index < times.length; index += 1) {
      durations.push((times[index] as number) - (times[index - 1] as number))
    }
    const maximumGap = Math.max(...durations)
    const recordGaps: SamplingGap[] = durations.map((gapDuration, offset) => {
      const fromTime = times[offset] as number
      const toTime = times[offset + 1] as number
      return {
        fromTime,
        toTime,
        gapDuration,
        fromSourceRows: [...(rowsByTime.get(fromTime) as number[])],
        toSourceRows: [...(rowsByTime.get(toTime) as number[])],
        isMaximum: gapDuration === maximumGap,
      }
    })
    const sum = durations.reduce((total, duration) => total + duration, 0)
    const meanGap = sum / durations.length
    const sortedDurations = ascending(durations)
    const minimumGap = sortedDurations[0] as number
    const medianGap = medianOf(sortedDurations)

    if (
      !Number.isFinite(minimumGap) ||
      !Number.isFinite(medianGap) ||
      !Number.isFinite(meanGap) ||
      !Number.isFinite(maximumGap) ||
      minimumGap < 0 ||
      maximumGap < 0
    ) {
      const message = 'A sampling-gap statistic is not a finite, non-negative duration, so the gap summary is refused.'
      gaps = { status: 'unavailable', code: 'NUMERICAL_FAILURE', message }
    } else {
      gaps = {
        status: 'available',
        value: {
          gapCount: durations.length,
          minimumGap,
          medianGap,
          meanGap,
          maximumGap,
          gaps: recordGaps,
          maximumGaps: recordGaps.filter((gap) => gap.isMaximum),
        },
      }
    }
  }

  // --- 4. Maximum gap as a fraction of the window -------------------------
  let maximumGapFraction: SamplingCoverageSection<SamplingGapFraction>
  if (gaps.status !== 'available') {
    maximumGapFraction = {
      status: 'unavailable',
      code: gaps.code,
      message: `The maximum-gap proportion needs a gap statistic. ${gaps.message}`.trim(),
    }
  } else if (windowDuration === null) {
    maximumGapFraction = {
      status: 'unavailable',
      code: 'WINDOW_DURATION_INVALID',
      message: 'The window width is not a positive finite duration, so the proportion cannot be formed.',
    }
  } else {
    // Divide first so a large but valid ratio does not overflow at `100 * gap`.
    const percent = (gaps.value.maximumGap / windowDuration) * 100
    maximumGapFraction = Number.isFinite(percent)
      ? {
          status: 'available',
          value: {
            percent,
            maximumGap: gaps.value.maximumGap,
            windowDuration,
            timeUnit,
          },
        }
      : {
          status: 'unavailable',
          code: 'NUMERICAL_FAILURE',
          message: 'The maximum-gap proportion is not a finite number.',
        }
  }

  // --- 5. Observed extremes relative to the boundaries (reused, not recomputed)
  const extremeLocations = locateExtremes(
    exposure.cmaxObs,
    exposure.cminObs,
    selection.startTime,
    selection.endTime,
    concentrationUnit,
  )

  // --- 6. τ for description only ------------------------------------------
  const tau = administration?.dosingInterval
  let dosingInterval: SamplingCoverageReport['dosingInterval'] = null
  if (tau !== undefined && Number.isFinite(tau.value) && tau.value > 0) {
    const tauToH = baseFactor(tau.unit, 'time')
    const timeToH = baseFactor(timeUnit, 'time')
    if (tauToH !== null && timeToH !== null) {
      const inDatasetTimeUnit = (tau.value * tauToH) / timeToH
      if (Number.isFinite(inDatasetTimeUnit) && inDatasetTimeUnit > 0) {
        dosingInterval = { recorded: tau, inDatasetTimeUnit }
      }
    }
  }

  const durationSummary =
    windowDuration === null ? 'an unavailable window width' : `${exact(windowDuration)} ${timeUnit}`
  const summary =
    gaps.status === 'available'
      ? `${window.observationCount} measurement record(s) at ${window.distinctTimeCount} distinct sampling time(s) over ${durationSummary}; ${gaps.value.gapCount} adjacent gap(s), largest ${exact(gaps.value.maximumGap)} ${timeUnit}.`
      : `${window.observationCount} measurement record(s) at ${window.distinctTimeCount} distinct sampling time(s) over ${durationSummary}; gap statistics unavailable.`

  return {
    status: 'available',
    timeUnit,
    window,
    gaps,
    repeatedTimes,
    maximumGapFraction,
    extremeLocations,
    dosingInterval,
    limits: LIMITS,
    summary,
  }
}

/**
 * Classify every observation attaining an observed extreme as at the start, at
 * the end, or inside. Built from the phase-50D observations — never from the
 * scalar `Tmax,obs`/`Tmin,obs`, which reports only the earliest tied time.
 */
function locateExtremes(
  maximum: IntervalExposureMetric,
  minimum: IntervalExposureMetric,
  startTime: number,
  endTime: number,
  concentrationUnit: string,
): SamplingCoverageSection<{
  readonly maximum: ObservedExtremeLocations
  readonly minimum: ObservedExtremeLocations
}> {
  const unavailable = (code: SamplingCoverageCode, message: string) => ({
    status: 'unavailable' as const,
    code,
    message,
  })

  const usable = (metric: IntervalExposureMetric): boolean =>
    (metric.status === 'available' || metric.status === 'conditional') &&
    metric.value !== undefined &&
    (metric.observations?.length ?? 0) > 0

  if (!usable(maximum) || !usable(minimum)) {
    const reason =
      maximum.status === 'unavailable' || maximum.status === 'not-applicable'
        ? maximum.message
        : minimum.status === 'unavailable' || minimum.status === 'not-applicable'
          ? minimum.message
          : undefined
    return unavailable(
      'EXPOSURE_REPORT_UNAVAILABLE',
      `The observed extremes are not available from the exposure analysis, so their positions cannot be classified.${reason === undefined ? '' : ` ${reason}`}`.trim(),
    )
  }

  const classify = (
    metric: IntervalExposureMetric,
    extreme: 'maximum' | 'minimum',
  ): ObservedExtremeLocations => {
    const observations = (metric.observations ?? []).map((observation) => ({
      time: observation.time,
      concentration: observation.concentration,
      sourceRow: observation.sourceRow,
      position: (observation.time === startTime
        ? 'start'
        : observation.time === endTime
          ? 'end'
          : 'inside') as SamplingPosition,
    }))
    const present = (position: SamplingPosition) =>
      observations.some((observation) => observation.position === position)
    const order: readonly SamplingPosition[] = ['start', 'inside', 'end']
    return {
      extreme,
      concentration: metric.value as number,
      concentrationUnit,
      positions: order.filter(present),
      atStart: present('start'),
      atEnd: present('end'),
      inside: present('inside'),
      observations,
    }
  }

  return {
    status: 'available',
    value: { maximum: classify(maximum, 'maximum'), minimum: classify(minimum, 'minimum') },
  }
}
