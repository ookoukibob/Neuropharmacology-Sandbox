/**
 * Observed interval exposure metrics (phase 50D).
 *
 * Seven metrics over the SAME explicitly selected interval that phase 50C
 * integrates, all derived from observations inside it (both boundaries
 * included) and from that interval's `AUCτ`:
 *
 *   Cmax,obs        max observed concentration inside the interval   (observed)
 *   Tmax,obs        the time(s) that attain it                       (observed)
 *   Cmin,obs        min observed concentration inside the interval   (observed)
 *   Tmin,obs        the time(s) that attain it                       (observed)
 *   Cavg,interval   AUCτ / (t_end − t_start)                         (calculated)
 *   Cavg,ss         AUCτ / τ                 (steady state only)     (calculated)
 *   Fluctuation     100 · (Cmax,obs − Cmin,obs) / Cavg,ss            (calculated)
 *
 * Scientific contract:
 * - `Cmax,obs` is the largest concentration the sampling scheme happened to
 *   observe, not the true peak; `Cmin,obs` is likewise not the true trough.
 *   Nothing is interpolated, extrapolated, smoothed or fitted to invent a peak
 *   or a trough between samples. The labels carry `obs` for that reason.
 * - Ties are structural, not incidental: when several observations attain the
 *   maximum (or minimum), EVERY attaining observation (time, concentration,
 *   source row) is returned, the earliest time is the reported scalar, and the
 *   metric becomes `conditional` because a single Tmax would misrepresent the
 *   data. Nothing is silently collapsed to the first row.
 * - Only rows inside the selected interval contribute. A higher concentration
 *   elsewhere in the dataset must never leak into the interval peak.
 * - `Cavg,interval` divides by the interval's own duration in the dataset's
 *   time unit, so the result stays a concentration. It is an interval mean, not
 *   a steady-state average, and is never labelled as one.
 * - `Cavg,ss` and the fluctuation require a RECORDED steady-state declaration
 *   plus the analyst's interval-to-dose alignment confirmation. Steady state is
 *   never inferred from the shape of the curve, from similar adjacent intervals
 *   or from the number of doses. Without those, the two metrics are
 *   `not-applicable` — the quantity is not defined for that dataset — while the
 *   observed metrics stay available as descriptive values.
 * - A missing/zero/non-finite `Cavg,ss` yields a structured refusal for the
 *   fluctuation; `Infinity`, `NaN` and fabricated zeros are never returned.
 *
 * Reuse, not reimplementation: the interval, its `AUCτ`, its source rows and
 * its λ_z all come from the phase-50C `IntervalAucReport`; the unit catalog —
 * not a second conversion table — supplies the time factor. This module never
 * integrates, never sorts the caller's array in place and never writes.
 *
 * Pure domain module: no React, no storage, no I/O.
 */
import { unitCatalog } from '../pharmacology/unit-catalog'
import type {
  AdministrationMetadata,
  AdministrationQuantity,
  AdministrationRegimen,
  ExperimentalMeasurement,
} from './experimental-dataset'
import { auditNumber, exact } from './dose-dependent-nca'
import type { IntervalAucReport } from './interval-auc'

export type IntervalExposureMetricId =
  | 'cmax-obs'
  | 'tmax-obs'
  | 'cmin-obs'
  | 'tmin-obs'
  | 'cavg-interval'
  | 'cavg-ss'
  | 'fluctuation'

/**
 * Four distinct outcomes, so the UI never collapses "cannot be computed" into
 * one state:
 * - `available`       — value reported, no material caveat;
 * - `conditional`     — value reported, but it is not unique or a documented
 *                       limitation applies (a tied maximum, for instance);
 * - `unavailable`     — a structured reason explains why it cannot be computed;
 * - `not-applicable`  — the metric is not defined for this dataset (a
 *                       steady-state metric without a steady-state declaration).
 */
export type IntervalExposureStatus = 'available' | 'conditional' | 'unavailable' | 'not-applicable'

/** Whether the reported number is a sampled value or computed from sampled values. */
export type IntervalExposureKind = 'observed' | 'calculated'

export type IntervalExposureUnavailableCode =
  /** No interval has been selected yet. */
  | 'INTERVAL_NOT_SELECTED'
  /** The selected interval produced no usable AUCτ (carries the upstream reason). */
  | 'INTERVAL_AUC_UNAVAILABLE'
  /** The interval's observations do not match the rows the AUCτ used. */
  | 'OBSERVATIONS_INCONSISTENT'
  /** No observation falls inside the interval. */
  | 'NO_OBSERVATIONS_IN_INTERVAL'
  /** A measurement is not a valid finite non-negative pair. */
  | 'INVALID_MEASUREMENT'
  /** The dataset's time unit is not a time unit. */
  | 'TIME_UNIT_INCOMPATIBLE'
  /** The concentration unit is not a concentration dimension. */
  | 'CONCENTRATION_UNIT_INCOMPATIBLE'
  /** The regimen is recorded as unknown: no steady state can be read from it. */
  | 'REGIMEN_UNKNOWN'
  /** The dataset is not declared to be at steady state. */
  | 'REGIMEN_NOT_STEADY_STATE'
  /** The analyst has not confirmed the interval starts at a dose. */
  | 'INTERVAL_NOT_ALIGNED'
  /** No dosing interval τ is recorded. */
  | 'DOSING_INTERVAL_MISSING'
  /** The recorded τ is not a positive finite number. */
  | 'DOSING_INTERVAL_NOT_POSITIVE'
  /** The recorded τ is not a time quantity. */
  | 'DOSING_INTERVAL_UNIT_INCOMPATIBLE'
  /** The fluctuation's `Cavg,ss` input is unavailable. */
  | 'CAVG_SS_UNAVAILABLE'
  /** The computed value is not a finite, non-negative number. */
  | 'NUMERICAL_FAILURE'

/** One observation inside the interval, tied back to its source row. */
export interface IntervalExposureObservation {
  readonly time: number
  readonly concentration: number
  readonly sourceRow: number
}

export interface IntervalExposureMetric {
  readonly id: IntervalExposureMetricId
  readonly label: string
  readonly status: IntervalExposureStatus
  readonly kind: IntervalExposureKind
  readonly value?: number
  readonly unit?: string
  /** Symbolic definition, stated once for every metric. */
  readonly formula: string
  /** Declared values substituted into the formula, plus the result. */
  readonly substitution?: string
  /**
   * Every observation that attains the reported extreme (peak/trough metrics
   * only). Ties are all listed here — never only the first one.
   */
  readonly observations?: readonly IntervalExposureObservation[]
  readonly assumptions: readonly string[]
  readonly notes: readonly string[]
  readonly code?: IntervalExposureUnavailableCode
  readonly message?: string
}

export interface IntervalExposurePrecondition {
  readonly id: string
  readonly status: 'met' | 'not-met' | 'not-applicable'
  readonly message: string
}

/** The interval window the metrics were computed over, for audit. */
export interface IntervalExposureWindow {
  readonly startTime: number
  readonly endTime: number
  readonly timeUnit: string
  readonly duration: number
  /** Every observation inside `[startTime, endTime]`, ascending by time. */
  readonly observations: readonly IntervalExposureObservation[]
  readonly observationCount: number
}

export interface IntervalExposureInput {
  readonly measurements: readonly ExperimentalMeasurement[]
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly administration: AdministrationMetadata | undefined
  /** The phase-50C analysis of the SAME interval; never recomputed here. */
  readonly interval: IntervalAucReport
}

export interface IntervalExposureReport {
  readonly regimen: AdministrationRegimen | 'not-recorded'
  readonly administrationRecorded: boolean
  readonly intervalAligned: boolean
  /** Null when no validated interval exists (nothing was measured over). */
  readonly window: IntervalExposureWindow | null
  readonly cmaxObs: IntervalExposureMetric
  readonly tmaxObs: IntervalExposureMetric
  readonly cminObs: IntervalExposureMetric
  readonly tminObs: IntervalExposureMetric
  readonly cavgInterval: IntervalExposureMetric
  readonly cavgSs: IntervalExposureMetric
  readonly fluctuation: IntervalExposureMetric
  /** Fixed display order, identical to the properties above. */
  readonly metrics: readonly IntervalExposureMetric[]
  /** The AUCτ the derived metrics consumed, exactly as reported by phase 50C. */
  readonly aucTauUsed: { readonly value: number; readonly unit: string } | null
  /** τ as recorded and as used for the division, in the dataset's time unit. */
  readonly dosingInterval: {
    readonly recorded: AdministrationQuantity
    readonly hours: number
    readonly inDatasetTimeUnit: number
  } | null
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly preconditions: readonly IntervalExposurePrecondition[]
  readonly warnings: readonly string[]
  readonly summary: string
}

const TIE_NOTE = 'A single Tmax would misrepresent the data, so every attaining observation is listed.'

function baseFactor(unit: string, dimension: 'time'): number | null {
  const def = unitCatalog.get(unit)
  if (def === undefined || def.dimension !== dimension) return null
  return def.toBase
}

function metricBase(
  id: IntervalExposureMetricId,
  label: string,
  kind: IntervalExposureKind,
  formula: string,
): Pick<IntervalExposureMetric, 'id' | 'label' | 'kind' | 'formula'> {
  return { id, label, kind, formula }
}

function unavailableMetric(
  base: Pick<IntervalExposureMetric, 'id' | 'label' | 'kind' | 'formula'>,
  status: 'unavailable' | 'not-applicable',
  code: IntervalExposureUnavailableCode,
  message: string,
  assumptions: readonly string[] = [],
): IntervalExposureMetric {
  return { ...base, status, assumptions, notes: [], code, message }
}

export function analyzeIntervalExposure(input: IntervalExposureInput): IntervalExposureReport {
  const { measurements, timeUnit, concentrationUnit, administration, interval } = input
  const preconditions: IntervalExposurePrecondition[] = []
  const warnings: string[] = []

  // Formulas are stated once, exactly as they are audited in the UI.
  const definitions = {
    cmax: metricBase('cmax-obs', 'Cmax,obs (maximum observed concentration)', 'observed', 'Cmax,obs = max(C) for t in [t_start, t_end]'),
    tmax: metricBase('tmax-obs', 'Tmax,obs (observed time of the maximum)', 'observed', 'Tmax,obs = t where C = Cmax,obs'),
    cmin: metricBase('cmin-obs', 'Cmin,obs (minimum observed concentration)', 'observed', 'Cmin,obs = min(C) for t in [t_start, t_end]'),
    tmin: metricBase('tmin-obs', 'Tmin,obs (observed time of the minimum)', 'observed', 'Tmin,obs = t where C = Cmin,obs'),
    cavgInterval: metricBase(
      'cavg-interval',
      'Cavg,interval (mean concentration over the selected interval)',
      'calculated',
      'Cavg,interval = AUCτ / (t_end − t_start)',
    ),
    cavgSs: metricBase(
      'cavg-ss',
      'Cavg,ss (steady-state mean concentration over one τ)',
      'calculated',
      'Cavg,ss = AUCτ / τ',
    ),
    fluctuation: metricBase(
      'fluctuation',
      'Observed peak-to-trough fluctuation',
      'calculated',
      '100 × (Cmax,obs − Cmin,obs) / Cavg,ss',
    ),
  } as const

  // --- 0. Steady state is a declaration, independent of any interval ------
  // Resolved first so a dataset that is not declared steady state reports the
  // precise `not-applicable` verdict for the steady-state metrics even when the
  // interval itself is unusable (an unusable interval must not mask the reason
  // the steady-state quantity does not exist).
  const regimen = administration?.regimen ?? 'not-recorded'
  const declaredSteadyState = regimen === 'repeated-dose-steady-state'
  const steadyStateVerdict: { readonly code: IntervalExposureUnavailableCode; readonly message: string } | null =
    regimen === 'unknown'
      ? {
          code: 'REGIMEN_UNKNOWN',
          message:
            'Cavg,ss is not defined: the regimen is recorded as unknown, so no steady-state interval can be identified. Steady state is never inferred from the curve, the sampling times or the number of doses.',
        }
      : !declaredSteadyState
        ? {
            code: 'REGIMEN_NOT_STEADY_STATE',
            message:
              regimen === 'single-dose'
                ? 'Cavg,ss is not defined for a single-dose dataset: there is no steady-state interval.'
                : 'Cavg,ss is not defined for this dataset: the regimen is not declared to be at steady state. The interval mean (Cavg,interval) is reported instead.',
          }
        : null

  if (steadyStateVerdict === null) {
    preconditions.push({
      id: 'steady-state',
      status: 'met',
      message: 'The dataset declares repeated dosing at steady state (a recorded declaration, not an inference).',
    })
  } else {
    preconditions.push({ id: 'steady-state', status: 'not-met', message: steadyStateVerdict.message })
  }

  if (interval.administrationAligned) {
    preconditions.push({
      id: 'interval-alignment',
      status: 'met',
      message: 'The analyst confirmed the interval starts at the recorded administration time of the analysed dose.',
    })
  } else {
    preconditions.push({
      id: 'interval-alignment',
      status: 'not-met',
      message:
        'The analyst has not confirmed that the selected interval starts at the recorded administration time of the dose it describes.',
    })
  }

  const refuseAll = (
    code: IntervalExposureUnavailableCode,
    message: string,
  ): IntervalExposureReport => {
    const refuse = (base: Pick<IntervalExposureMetric, 'id' | 'label' | 'kind' | 'formula'>) =>
      unavailableMetric(base, 'unavailable', code, message)
    // The steady-state metrics keep their own verdict when the regimen alone
    // already rules them out.
    const refused = {
      cmaxObs: refuse(definitions.cmax),
      tmaxObs: refuse(definitions.tmax),
      cminObs: refuse(definitions.cmin),
      tminObs: refuse(definitions.tmin),
      cavgInterval: refuse(definitions.cavgInterval),
      cavgSs:
        steadyStateVerdict === null
          ? refuse(definitions.cavgSs)
          : unavailableMetric(
              definitions.cavgSs,
              'not-applicable',
              steadyStateVerdict.code,
              steadyStateVerdict.message,
            ),
      fluctuation:
        steadyStateVerdict === null
          ? refuse(definitions.fluctuation)
          : unavailableMetric(
              definitions.fluctuation,
              'not-applicable',
              steadyStateVerdict.code,
              'The fluctuation is a steady-state metric, so it is not defined without a steady-state declaration.',
            ),
    }
    const metrics = [
      refused.cmaxObs,
      refused.tmaxObs,
      refused.cminObs,
      refused.tminObs,
      refused.cavgInterval,
      refused.cavgSs,
      refused.fluctuation,
    ]
    return {
      regimen,
      administrationRecorded: interval.administrationRecorded,
      intervalAligned: interval.administrationAligned,
      window: null,
      ...refused,
      metrics,
      aucTauUsed: null,
      dosingInterval: null,
      timeUnit,
      concentrationUnit,
      preconditions,
      warnings,
      summary: message,
    }
  }

  // --- 0b. Measurement validity, reported before anything else ------------
  // Checked first so an invalid row is named as such rather than being hidden
  // behind an upstream "AUCτ unavailable" verdict.
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
    const message = `Source row(s) ${invalidRows.join(', ')} are not finite non-negative time/concentration pairs, so the interval exposure metrics are refused.`
    preconditions.push({ id: 'measurements', status: 'not-met', message })
    return refuseAll('INVALID_MEASUREMENT', message)
  }

  // --- 1. A validated interval is the only basis for every metric ---------
  if (interval.selection === null) {
    const message =
      'No interval has been selected. Every exposure metric is defined over an explicitly selected interval with observed start and end times; no default is applied.'
    preconditions.push({ id: 'interval', status: 'not-met', message })
    return refuseAll('INTERVAL_NOT_SELECTED', message)
  }
  if (interval.status !== 'available' || interval.interval === null || interval.aucTau.status !== 'available') {
    const reason =
      interval.aucTau.status === 'unavailable' ? interval.aucTau.message : interval.summary
    const message = `The selected interval has no usable AUCτ, so no interval exposure metric is reported. ${reason}`.trim()
    preconditions.push({ id: 'interval', status: 'not-met', message })
    return refuseAll('INTERVAL_AUC_UNAVAILABLE', message)
  }
  const coverage = interval.interval
  const aucTau = interval.aucTau
  preconditions.push({
    id: 'interval',
    status: 'met',
    message: `Interval ${exact(coverage.startTime)} → ${exact(coverage.endTime)} ${coverage.timeUnit}; AUCτ = ${exact(aucTau.value)} ${aucTau.unit}.`,
  })

  // --- 2. The observations inside the interval ----------------------------
  const timeToH = baseFactor(timeUnit, 'time')
  if (timeToH === null) {
    const message = `The dataset time unit "${timeUnit}" is not a time unit, so the interval duration cannot be interpreted.`
    preconditions.push({ id: 'time-unit', status: 'not-met', message })
    return refuseAll('TIME_UNIT_INCOMPATIBLE', message)
  }
  const concentrationDimension = unitCatalog.get(concentrationUnit)?.dimension
  if (concentrationDimension !== 'mass-concentration' && concentrationDimension !== 'molar-concentration') {
    const message = `The concentration unit "${concentrationUnit}" is not a concentration, so a concentration mean cannot be reported.`
    preconditions.push({ id: 'concentration-unit', status: 'not-met', message })
    return refuseAll('CONCENTRATION_UNIT_INCOMPATIBLE', message)
  }

  const inside: IntervalExposureObservation[] = []
  for (const measurement of measurements) {
    // Both boundaries are included: the interval is closed. Validity was
    // established above, before the interval was consulted.
    if (measurement.time >= coverage.startTime && measurement.time <= coverage.endTime) {
      inside.push({
        time: measurement.time,
        concentration: measurement.concentration,
        sourceRow: measurement.sourceRow,
      })
    }
  }
  inside.sort((a, b) => a.time - b.time)

  if (inside.length === 0) {
    const message = 'No observation falls inside the selected interval.'
    preconditions.push({ id: 'observations', status: 'not-met', message })
    return refuseAll('NO_OBSERVATIONS_IN_INTERVAL', message)
  }

  // The exposure window must cover exactly the rows the AUCτ was integrated
  // from; otherwise the peak/trough and the area would describe different data.
  const aucRows = [...aucTau.contributingSourceRows].sort((a, b) => a - b)
  const windowRows = inside.map((observation) => observation.sourceRow).sort((a, b) => a - b)
  if (
    aucRows.length !== windowRows.length ||
    aucRows.some((row, index) => row !== windowRows[index])
  ) {
    const message = `The interval's observations (source rows ${windowRows.join(', ')}) do not match the rows the AUCτ was integrated from (source rows ${aucRows.join(', ')}); the exposure metrics would describe a different dataset.`
    preconditions.push({ id: 'observations', status: 'not-met', message })
    return refuseAll('OBSERVATIONS_INCONSISTENT', message)
  }
  preconditions.push({
    id: 'observations',
    status: 'met',
    message: `${inside.length} observation(s) inside the interval, matching the AUCτ source rows.`,
  })

  const window: IntervalExposureWindow = {
    startTime: coverage.startTime,
    endTime: coverage.endTime,
    timeUnit,
    duration: coverage.endTime - coverage.startTime,
    observations: inside,
    observationCount: inside.length,
  }

  // --- 3. Observed peak and trough ---------------------------------------
  const extrema = (direction: 'max' | 'min'): { value: number; observations: IntervalExposureObservation[] } => {
    let extreme = direction === 'max' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
    for (const observation of inside) {
      if (direction === 'max' ? observation.concentration > extreme : observation.concentration < extreme) {
        extreme = observation.concentration
      }
    }
    return {
      value: extreme,
      observations: inside.filter((observation) => observation.concentration === extreme),
    }
  }

  const peak = extrema('max')
  const trough = extrema('min')
  const peakTimes = [...new Set(peak.observations.map((observation) => observation.time))]
  const troughTimes = [...new Set(trough.observations.map((observation) => observation.time))]

  const observedNotes = [
    'This is the concentration actually observed at a sampling time, not the true peak/trough between samples; nothing is interpolated or fitted.',
  ]

  const peakTied = peakTimes.length > 1
  if (peakTied) {
    warnings.push(
      `Cmax,obs is attained at ${peakTimes.length} sampling times (${peakTimes.map((time) => `${exact(time)} ${timeUnit}`).join(', ')}); every attaining observation is reported and the earliest time is shown as Tmax,obs.`,
    )
  }
  const troughTied = troughTimes.length > 1
  if (troughTied) {
    warnings.push(
      `Cmin,obs is attained at ${troughTimes.length} sampling times (${troughTimes.map((time) => `${exact(time)} ${timeUnit}`).join(', ')}); every attaining observation is reported and the earliest time is shown as Tmin,obs.`,
    )
  }

  const cmaxObs: IntervalExposureMetric = {
    ...definitions.cmax,
    status: peakTied ? 'conditional' : 'available',
    value: peak.value,
    unit: concentrationUnit,
    observations: peak.observations,
    assumptions: observedNotes,
    notes: [
      `Attained by ${peak.observations.length} observation(s) at ${peakTimes.length} sampling time(s).`,
    ],
    ...(peakTied ? { message: `The maximum is attained at ${peakTimes.length} sampling times; all attaining observations are listed.` } : {}),
  }

  const tmaxObs: IntervalExposureMetric = {
    ...definitions.tmax,
    status: peakTied ? 'conditional' : 'available',
    value: Math.min(...peakTimes),
    unit: timeUnit,
    observations: peak.observations,
    assumptions: [
      ...observedNotes,
      'The reported time is the earliest sampled time attaining the observed maximum; it is not an estimate of the true Tmax.',
    ],
    notes: peakTied ? [TIE_NOTE] : [],
    ...(peakTied
      ? {
          message: `The maximum is attained at ${peakTimes.length} sampling times; the earliest (${exact(Math.min(...peakTimes))} ${timeUnit}) is reported and all attaining observations are listed.`,
        }
      : {}),
  }

  const cminObs: IntervalExposureMetric = {
    ...definitions.cmin,
    status: troughTied ? 'conditional' : 'available',
    value: trough.value,
    unit: concentrationUnit,
    observations: trough.observations,
    assumptions: observedNotes,
    notes: [
      `Attained by ${trough.observations.length} observation(s) at ${troughTimes.length} sampling time(s).`,
    ],
    ...(troughTied ? { message: `The minimum is attained at ${troughTimes.length} sampling times; all attaining observations are listed.` } : {}),
  }

  const tminObs: IntervalExposureMetric = {
    ...definitions.tmin,
    status: troughTied ? 'conditional' : 'available',
    value: Math.min(...troughTimes),
    unit: timeUnit,
    observations: trough.observations,
    assumptions: [
      ...observedNotes,
      'The reported time is the earliest sampled time attaining the observed minimum; it is not an estimate of the true Tmin.',
    ],
    notes: troughTied ? [TIE_NOTE] : [],
    ...(troughTied
      ? {
          message: `The minimum is attained at ${troughTimes.length} sampling times; the earliest (${exact(Math.min(...troughTimes))} ${timeUnit}) is reported and all attaining observations are listed.`,
        }
      : {}),
  }

  // --- 4. Cavg,interval ----------------------------------------------------
  const duration = window.duration
  const cavgIntervalValue = aucTau.value / duration
  const expectedAucUnit = `${concentrationUnit}·${timeUnit}`
  let cavgInterval: IntervalExposureMetric
  if (aucTau.unit !== expectedAucUnit) {
    const message = `The interval AUCτ is reported in "${aucTau.unit}" but the dataset units imply "${expectedAucUnit}"; the mean concentration cannot be derived.`
    preconditions.push({ id: 'cavg-interval', status: 'not-met', message })
    cavgInterval = unavailableMetric(definitions.cavgInterval, 'unavailable', 'CONCENTRATION_UNIT_INCOMPATIBLE', message)
  } else if (!Number.isFinite(cavgIntervalValue) || cavgIntervalValue < 0) {
    const message = 'The interval mean concentration is not a finite, non-negative number.'
    preconditions.push({ id: 'cavg-interval', status: 'not-met', message })
    cavgInterval = unavailableMetric(definitions.cavgInterval, 'unavailable', 'NUMERICAL_FAILURE', message)
  } else {
    preconditions.push({
      id: 'cavg-interval',
      status: 'met',
      message: `The interval mean divides AUCτ by the interval duration ${exact(duration)} ${timeUnit}.`,
    })
    cavgInterval = {
      ...definitions.cavgInterval,
      status: 'available',
      value: cavgIntervalValue,
      unit: concentrationUnit,
      substitution: `${auditNumber(aucTau.value)} ${aucTau.unit} ÷ ${exact(duration)} ${timeUnit} = ${auditNumber(cavgIntervalValue)} ${concentrationUnit}`,
      assumptions: [
        'The mean is the trapezoidal area divided by the selected interval duration; it is not an AUCτ-based steady-state average and is never labelled as one.',
        'AUCτ is the observed interval area: no value is extrapolated, so a mean built from sparse sampling inherits that sampling.',
      ],
      notes: [],
    }
  }

  // --- 5. Dosing interval τ (the divisor for Cavg,ss) ---------------------
  const tau = administration?.dosingInterval
  let tauHours: number | null = null
  let tauInDatasetTimeUnit: number | null = null
  if (tau === undefined) {
    preconditions.push({ id: 'dosing-interval', status: 'not-met', message: 'No dosing interval τ is recorded.' })
  } else if (!Number.isFinite(tau.value) || tau.value <= 0) {
    preconditions.push({
      id: 'dosing-interval',
      status: 'not-met',
      message: 'The recorded dosing interval τ is not a positive finite number.',
    })
  } else {
    const tauToH = baseFactor(tau.unit, 'time')
    if (tauToH === null) {
      preconditions.push({
        id: 'dosing-interval',
        status: 'not-met',
        message: `The dosing interval unit "${tau.unit}" is not a time unit.`,
      })
    } else {
      tauHours = tau.value * tauToH
      tauInDatasetTimeUnit = (tau.value * tauToH) / timeToH
      preconditions.push({
        id: 'dosing-interval',
        status: 'met',
        message: `τ = ${exact(tau.value)} ${tau.unit} = ${exact(tauHours)} h = ${auditNumber(tauInDatasetTimeUnit)} ${timeUnit}, the divisor used for Cavg,ss.`,
      })
    }
  }

  // --- 6. Cavg,ss ---------------------------------------------------------
  const cavgSsBase = definitions.cavgSs
  const cavgSsAssumptions = [
    'Steady state is the recorded regimen declaration; it is never inferred from a flat-looking curve or from similar adjacent intervals.',
    'AUCτ covers exactly one dosing interval τ, and the interval was confirmed to start at the analysed dose.',
  ]
  let cavgSs: IntervalExposureMetric
  if (steadyStateVerdict !== null) {
    cavgSs = unavailableMetric(
      cavgSsBase,
      'not-applicable',
      steadyStateVerdict.code,
      steadyStateVerdict.message,
      cavgSsAssumptions,
    )
  } else if (!interval.administrationAligned) {
    const message =
      'Cavg,ss is not reported until the analyst confirms that the selected interval starts at the recorded administration time of the analysed dose; τ alone does not identify which dose a window belongs to.'
    cavgSs = unavailableMetric(cavgSsBase, 'unavailable', 'INTERVAL_NOT_ALIGNED', message, cavgSsAssumptions)
  } else if (tau === undefined) {
    cavgSs = unavailableMetric(
      cavgSsBase,
      'unavailable',
      'DOSING_INTERVAL_MISSING',
      'Cavg,ss requires a recorded dosing interval τ; none is recorded.',
      cavgSsAssumptions,
    )
  } else if (!Number.isFinite(tau.value) || tau.value <= 0) {
    cavgSs = unavailableMetric(
      cavgSsBase,
      'unavailable',
      'DOSING_INTERVAL_NOT_POSITIVE',
      'Cavg,ss requires a positive finite dosing interval τ.',
      cavgSsAssumptions,
    )
  } else if (tauInDatasetTimeUnit === null || tauHours === null) {
    cavgSs = unavailableMetric(
      cavgSsBase,
      'unavailable',
      'DOSING_INTERVAL_UNIT_INCOMPATIBLE',
      `The dosing interval unit "${tau.unit}" is not a time unit, so it cannot be divided out of the AUCτ.`,
      cavgSsAssumptions,
    )
  } else if (aucTau.unit !== expectedAucUnit) {
    cavgSs = unavailableMetric(
      cavgSsBase,
      'unavailable',
      'CONCENTRATION_UNIT_INCOMPATIBLE',
      `The interval AUCτ is reported in "${aucTau.unit}" but the dataset units imply "${expectedAucUnit}".`,
      cavgSsAssumptions,
    )
  } else if (!(tauInDatasetTimeUnit > 0) || !Number.isFinite(tauInDatasetTimeUnit)) {
    cavgSs = unavailableMetric(
      cavgSsBase,
      'unavailable',
      'NUMERICAL_FAILURE',
      `τ converted to the dataset time unit is not a positive finite number (${auditNumber(tauInDatasetTimeUnit ?? Number.NaN)} ${timeUnit}).`,
      cavgSsAssumptions,
    )
  } else {
    const value = aucTau.value / tauInDatasetTimeUnit
    if (!Number.isFinite(value) || value < 0) {
      cavgSs = unavailableMetric(
        cavgSsBase,
        'unavailable',
        'NUMERICAL_FAILURE',
        'The steady-state mean concentration is not a finite, non-negative number.',
        cavgSsAssumptions,
      )
    } else {
      cavgSs = {
        ...cavgSsBase,
        status: 'available',
        value,
        unit: concentrationUnit,
        substitution: `${auditNumber(aucTau.value)} ${aucTau.unit} ÷ ${auditNumber(tauInDatasetTimeUnit)} ${timeUnit} (= τ) = ${auditNumber(value)} ${concentrationUnit}`,
        assumptions: cavgSsAssumptions,
        notes: [
          `τ was converted from ${exact(tau.value)} ${tau.unit} to ${auditNumber(tauInDatasetTimeUnit)} ${timeUnit} with the unit catalog before the division.`,
        ],
      }
    }
  }

  // --- 7. Observed peak-to-trough fluctuation -----------------------------
  const fluctuationAvailable =
    (cmaxObs.status === 'available' || cmaxObs.status === 'conditional') &&
    (cminObs.status === 'available' || cminObs.status === 'conditional') &&
    (cavgSs.status === 'available' || cavgSs.status === 'conditional') &&
    cmaxObs.value !== undefined &&
    cminObs.value !== undefined &&
    cavgSs.value !== undefined

  let fluctuation: IntervalExposureMetric
  if (!fluctuationAvailable) {
    if (cavgSs.status === 'not-applicable') {
      fluctuation = unavailableMetric(
        definitions.fluctuation,
        'not-applicable',
        cavgSs.code ?? 'CAVG_SS_UNAVAILABLE',
        'The fluctuation is a steady-state metric; it is not defined without a declared steady state. The observed peak and trough are still reported above.',
        cavgSs.message === undefined ? [] : [cavgSs.message],
      )
    } else {
      fluctuation = unavailableMetric(
        definitions.fluctuation,
        'unavailable',
        'CAVG_SS_UNAVAILABLE',
        `The fluctuation requires a usable Cavg,ss. ${cavgSs.message ?? ''}`.trim(),
        [],
      )
    }
  } else {
    const numerator = (cmaxObs.value as number) - (cminObs.value as number)
    const denominator = cavgSs.value as number
    if (!(denominator > 0) || !Number.isFinite(denominator)) {
      const message = `Cavg,ss is ${auditNumber(denominator)} ${concentrationUnit}, so the peak-to-trough fluctuation cannot be expressed as a percentage of it. No value is reported.`
      fluctuation = unavailableMetric(definitions.fluctuation, 'unavailable', 'NUMERICAL_FAILURE', message, [])
    } else {
      const value = (100 * numerator) / denominator
      if (!Number.isFinite(value) || value < 0) {
        const message = 'The computed fluctuation is not a finite, non-negative percentage.'
        fluctuation = unavailableMetric(definitions.fluctuation, 'unavailable', 'NUMERICAL_FAILURE', message, [])
      } else {
        const conditional =
          cmaxObs.status === 'conditional' || cminObs.status === 'conditional' || cavgSs.status === 'conditional'
        fluctuation = {
          ...definitions.fluctuation,
          status: conditional ? 'conditional' : 'available',
          value,
          unit: '%',
          substitution: `100 × (${auditNumber(cmaxObs.value as number)} − ${auditNumber(cminObs.value as number)}) ${concentrationUnit} ÷ ${auditNumber(denominator)} ${concentrationUnit} = ${auditNumber(value)} %`,
          assumptions: [
            'Cmax,obs and Cmin,obs are OBSERVED sample extremes, and Cavg,ss is an AUCτ-based ESTIMATE of the interval mean: sparse sampling may miss the actual peak or trough, and the trapezoidal area is itself an estimate.',
            'The percentage is therefore an observed-data-based estimate. Without assumptions about the concentration–time profile between samples and about the integration error, it is not guaranteed to be a lower bound on the true normalized fluctuation.',
            'The denominator is Cavg,ss over exactly one dosing interval τ at the declared steady state.',
          ],
          notes: [],
          ...(conditional
            ? {
                message:
                  'At least one input is conditional (a tied peak/trough), so the fluctuation inherits that caveat.',
              }
            : {}),
        }
      }
    }
  }

  const metrics = [cmaxObs, tmaxObs, cminObs, tminObs, cavgInterval, cavgSs, fluctuation]
  const summary = declaredSteadyState
    ? interval.administrationAligned
      ? 'Observed peak/trough and interval mean over the selected interval, with the steady-state mean and peak-to-trough fluctuation because the dataset declares steady state and the interval was confirmed to start at a dose.'
      : 'Observed peak/trough and interval mean over the selected interval. The steady-state mean and fluctuation stay unavailable until the interval is confirmed to start at a dose.'
    : 'Observed peak/trough and interval mean over the selected interval. The dataset is not declared to be at steady state, so no steady-state mean or fluctuation is derived.'

  return {
    regimen,
    administrationRecorded: interval.administrationRecorded,
    intervalAligned: interval.administrationAligned,
    window,
    cmaxObs,
    tmaxObs,
    cminObs,
    tminObs,
    cavgInterval,
    cavgSs,
    fluctuation,
    metrics,
    aucTauUsed: { value: aucTau.value, unit: aucTau.unit },
    dosingInterval:
      tau === undefined || tauHours === null || tauInDatasetTimeUnit === null
        ? null
        : { recorded: tau, hours: tauHours, inDatasetTimeUnit: tauInDatasetTimeUnit },
    timeUnit,
    concentrationUnit,
    preconditions,
    warnings,
    summary,
  }
}
