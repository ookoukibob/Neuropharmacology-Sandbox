/**
 * Residual structure diagnostics for the experimental fits.
 *
 * Two descriptive views per successfully fitted candidate model:
 *
 *   1  residual against measured time (rendered elsewhere; the data here)
 *   2  residual against the fitted concentration
 *
 * plus a conservative screen for a residual spread that changes with the
 * fitted level.
 *
 * WHAT THESE ARE
 * - Descriptions of the residuals the existing fits actually produced. Every
 *   observation keeps its identity, its own row and its own time; duplicates
 *   and replicates are never averaged.
 *
 * WHAT THESE ARE NOT
 * - Not a heteroscedasticity test, not a normality test and not an
 *   independence test. No p-value, no confidence statement and no verdict is
 *   produced.
 * - Not evidence about the true error distribution. A patternless residual
 *   plot is consistent with the assumed error model but does not establish it.
 * - Not a time-series analysis. Observations are not guaranteed to be
 *   independent, regularly spaced or complete, so temporal dependence cannot
 *   be assessed from the available metadata and no lag correlation is computed.
 *
 * Residuals are always `observed − fitted` on the original concentration
 * scale, in the dataset's declared concentration unit.
 *
 * Pure: no React, DOM, Plotly or storage. Measurements are read only — the
 * sorting used to split the fitted range happens on a copy of indices.
 */
import type { MonoExponentialBaselineFitResult } from './mono-exponential-baseline-fit'
import {
  censoredRefusalMessage,
  type ExperimentalMeasurement,
  type QuantifiedMeasurement,
} from './experimental-dataset'
import { diagnoseMonoExponentialFit, type MonoExponentialResidual } from './mono-exponential-fit-diagnostics'
import type { MonoExponentialFitResult } from './mono-exponential-fit'

export type ResidualStructureModelId = 'M0' | 'M1'

/**
 * Minimum observations for the spread screen.
 *
 * Rationale: the screen compares two halves of the fitted range, so each half
 * needs enough points for a mean absolute residual to be worth reading. Six
 * observations give three per half. This is a screening floor, not a
 * statistical requirement.
 */
export const SPREAD_SCREEN_MIN_OBSERVATIONS = 6

/** Minimum observations per half, implied by the floor above. */
export const SPREAD_SCREEN_MIN_PER_HALF = 3

/**
 * Ratio of mean absolute residuals between the two halves that the screen
 * reports as a visible difference.
 *
 * Rationale: it is a deliberately coarse trigger, chosen so that ordinary
 * scatter in a small sample is not flagged. It is NOT derived from a sampling
 * distribution, it carries no probability statement, and no claim is made that
 * a ratio below it means the variances are equal. Both underlying means are
 * always reported so the reader can judge the evidence directly.
 */
export const SPREAD_RATIO_HEURISTIC = 2

export interface SpreadHalf {
  readonly count: number
  /** Mean of |residual| for this half, in the concentration unit. */
  readonly meanAbsoluteResidual: number
}

/** Which half of the fitted range shows the wider absolute residuals. */
export type SpreadDirection = 'wider-at-high-fitted' | 'wider-at-low-fitted' | 'none'

export type SpreadStatus =
  /** The halves differ by at least the heuristic ratio. */
  | 'visible-pattern'
  /** The halves differ by less than the heuristic ratio: no visible pattern. */
  | 'no-visible-pattern'
  /** The screen ran but cannot speak — for example every residual is zero. */
  | 'inconclusive'

export interface ResidualSpreadFinding {
  readonly ok: true
  readonly status: SpreadStatus
  readonly direction: SpreadDirection
  /** Plain-language description of what was and was not found. */
  readonly message: string
  readonly lowerHalf: SpreadHalf
  readonly upperHalf: SpreadHalf
  /** larger mean ÷ smaller mean; null when the smaller mean is exactly zero. */
  readonly ratio: number | null
  readonly heuristicRatio: number
  /** Largest fitted value in the lower half — the lower edge of the cut. */
  readonly splitFittedValue: number
  /** Smallest fitted value in the upper half — the upper edge of the cut. */
  readonly upperFirstFittedValue: number
  /**
   * True when a fitted value straddles the cut: the lower half's largest
   * fitted value equals the upper half's smallest. The two groups then
   * OVERLAP at that value instead of forming two strictly separated ranges.
   */
  readonly boundaryTies: boolean
  /**
   * Plain-language statement of how the split landed, including the overlap
   * when it occurs. Always present, so the grouping is never implicit.
   */
  readonly splitDisclosure: string
}

export type ResidualSpreadUnavailableCode =
  | 'INSUFFICIENT_OBSERVATIONS'
  | 'DEGENERATE_FIT'
  | 'INVALID_INPUT'

export interface ResidualSpreadUnavailable {
  readonly ok: false
  readonly code: ResidualSpreadUnavailableCode
  readonly message: string
}

export type ResidualSpreadScreen = ResidualSpreadFinding | ResidualSpreadUnavailable

/**
 * How the observations are ordered for display, and what cannot be inferred
 * from that order.
 */
export interface ResidualTimeOrder {
  /** Points are placed at their measured time; no connecting line is drawn. */
  readonly chartOrder: 'measured-time'
  readonly distinctTimeCount: number
  /** Rows sharing their timestamp with at least one other row. */
  readonly duplicateTimeRowCount: number
  /** Whether the stored source order is non-decreasing in time. */
  readonly sourceOrderFollowsTime: boolean
  readonly notes: readonly string[]
}

export interface ResidualStructureModel {
  readonly ok: true
  readonly modelId: ResidualStructureModelId
  readonly label: string
  /** One entry per stored measurement, in source order. */
  readonly residuals: readonly MonoExponentialResidual[]
  readonly measurementCount: number
  readonly rmse: number
  readonly spread: ResidualSpreadScreen
  readonly timeOrder: ResidualTimeOrder
  readonly notes: readonly string[]
}

export type ResidualStructureFailureCode =
  | 'MEASUREMENT_MISMATCH'
  | 'INVALID_MEASUREMENT'
  | 'NON_FINITE_PARAMETER'
  /** The candidate has no successful fit to derive residuals from. */
  | 'FIT_UNAVAILABLE'
  | 'CENSORED_CONCENTRATION_UNSUPPORTED'

export interface ResidualStructureFailure {
  readonly ok: false
  readonly modelId: ResidualStructureModelId
  readonly label: string
  readonly code: ResidualStructureFailureCode
  readonly message: string
}

export type ResidualStructureModelResult = ResidualStructureModel | ResidualStructureFailure

const MODEL_LABELS: Record<ResidualStructureModelId, string> = {
  M0: 'Decay model',
  M1: 'Decay with additive baseline',
}

/** Standing notes: what a residual pattern can and cannot tell you. */
function standingNotes(): readonly string[] {
  return [
    'Residuals are observed concentration minus fitted concentration, in the declared concentration unit. The zero line is a perfect prediction, not a target.',
    'A visible pattern suggests the model misses structure in these data: curvature, a level shift, or residuals that grow with the fitted value. It does not identify the cause, and it does not establish that the error variance changes with the fitted value.',
    'A patternless plot is consistent with the declared error model but does not establish it. These are descriptions of one dataset, not tests of normality, independence or constant variance.',
    'No autocorrelation, independence test or effective-sample-size adjustment is computed. Observations are not guaranteed to be independent, equally spaced or complete, so temporal dependence cannot be assessed from the available metadata.',
  ]
}

function describeTimeOrder(residuals: readonly MonoExponentialResidual[]): ResidualTimeOrder {
  const counts = new Map<number, number>()
  for (const point of residuals) counts.set(point.time, (counts.get(point.time) ?? 0) + 1)
  let duplicateTimeRowCount = 0
  for (const point of residuals) {
    const count = counts.get(point.time) ?? 0
    if (count > 1) duplicateTimeRowCount += 1
  }
  let sourceOrderFollowsTime = true
  for (let index = 1; index < residuals.length; index += 1) {
    const previous = residuals[index - 1]
    const current = residuals[index]
    if (previous === undefined || current === undefined) continue
    if (current.time < previous.time) {
      sourceOrderFollowsTime = false
      break
    }
  }
  const notes: string[] = [
    'Points are placed at their measured time. No line is drawn between them, so the chart does not suggest a continuous time course.',
  ]
  if (duplicateTimeRowCount > 0) {
    notes.push(
      'Observations sharing a timestamp: ' +
        String(duplicateTimeRowCount) +
        ' of ' +
        String(residuals.length) +
        ' rows. Each is plotted and counted separately; none is averaged or dropped.',
    )
  }
  if (!sourceOrderFollowsTime) {
    notes.push(
      'The stored rows are not in increasing time order. Each point is placed at its measured time, and its source row stays available on hover.',
    )
  }
  return {
    chartOrder: 'measured-time',
    distinctTimeCount: counts.size,
    duplicateTimeRowCount,
    sourceOrderFollowsTime,
    notes,
  }
}

/**
 * Descriptive screen for residual spread that changes with the fitted level.
 *
 * The observations are split into two halves of the fitted range (a
 * deterministic count-based split on a copy of the indices — the stored rows
 * are never reordered) and the mean absolute residual of each half is
 * compared. Rows with identical fitted values may fall on both sides of the
 * cut; that is stated rather than hidden.
 */
export function screenResidualSpread(
  residuals: readonly MonoExponentialResidual[],
): ResidualSpreadScreen {
  if (residuals.length < SPREAD_SCREEN_MIN_OBSERVATIONS) {
    return {
      ok: false,
      code: 'INSUFFICIENT_OBSERVATIONS',
      message:
        'Residual spread needs at least ' +
        String(SPREAD_SCREEN_MIN_OBSERVATIONS) +
        ' observations to compare two halves of the fitted range; this fit has ' +
        String(residuals.length) +
        '.',
    }
  }

  let allZero = true
  let fittedMin = Number.POSITIVE_INFINITY
  let fittedMax = Number.NEGATIVE_INFINITY
  for (const point of residuals) {
    if (!Number.isFinite(point.fitted) || !Number.isFinite(point.residual)) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'A fitted value or residual is not finite, so the spread screen is unavailable.',
      }
    }
    if (point.residual !== 0) allZero = false
    if (point.fitted < fittedMin) fittedMin = point.fitted
    if (point.fitted > fittedMax) fittedMax = point.fitted
  }

  if (fittedMax === fittedMin) {
    return {
      ok: false,
      code: 'DEGENERATE_FIT',
      message:
        'Every fitted value is identical, so residuals cannot be grouped by fitted level and no spread comparison is possible.',
    }
  }

  if (allZero) {
    return {
      ok: true,
      status: 'inconclusive',
      direction: 'none',
      message:
        'Every residual is zero, so there is no spread to compare. An exact fit of this kind says nothing about how residuals would behave under other conditions.',
      lowerHalf: { count: 0, meanAbsoluteResidual: 0 },
      upperHalf: { count: 0, meanAbsoluteResidual: 0 },
      ratio: null,
      heuristicRatio: SPREAD_RATIO_HEURISTIC,
      splitFittedValue: fittedMin,
      upperFirstFittedValue: fittedMax,
      boundaryTies: false,
      splitDisclosure:
        'No split was formed: every residual is zero, so there are no groups to compare.',
    }
  }

  // Count-based split on a copy of the indices: the caller's array is never
  // reordered, and ties in the fitted value are resolved by source order.
  const order = residuals.map((_, index) => index)
  order.sort((left, right) => {
    const a = residuals[left]
    const b = residuals[right]
    if (a === undefined || b === undefined) return 0
    if (a.fitted !== b.fitted) return a.fitted - b.fitted
    return a.sourceRow - b.sourceRow
  })

  const half = Math.floor(residuals.length / 2)
  const lowerIndices = order.slice(0, half)
  const upperIndices = order.slice(half)
  if (lowerIndices.length < SPREAD_SCREEN_MIN_PER_HALF || upperIndices.length < SPREAD_SCREEN_MIN_PER_HALF) {
    return {
      ok: false,
      code: 'INSUFFICIENT_OBSERVATIONS',
      message:
        'Each half of the fitted range needs at least ' +
        String(SPREAD_SCREEN_MIN_PER_HALF) +
        ' observations; this fit does not provide them.',
    }
  }

  const meanAbsolute = (indices: readonly number[]): number => {
    let total = 0
    for (const index of indices) {
      const point = residuals[index]
      if (point === undefined) continue
      total += Math.abs(point.residual)
    }
    return total / indices.length
  }

  const lowerMean = meanAbsolute(lowerIndices)
  const upperMean = meanAbsolute(upperIndices)
  const splitPoint = residuals[lowerIndices[lowerIndices.length - 1] ?? 0]
  const splitFittedValue = splitPoint === undefined ? fittedMin : splitPoint.fitted
  const upperPoint = residuals[upperIndices[0] ?? 0]
  const upperFirstFittedValue = upperPoint === undefined ? fittedMax : upperPoint.fitted
  // A count-based cut can land inside a group of identical fitted values, so
  // the same fitted value can appear on both sides. Say so rather than imply
  // two separated ranges.
  const boundaryTies = splitFittedValue === upperFirstFittedValue
  const splitDisclosure = boundaryTies
    ? 'The two groups overlap at the split: both contain observations fitted at the same value. The cut is count-based, so this is not two strictly separated fitted-value ranges.'
    : 'The two groups are separated: the lower half ends below the upper half\'s first fitted value. The cut is still count-based rather than a natural boundary in the data.'

  let ratio: number | null
  let direction: SpreadDirection
  if (lowerMean === 0 && upperMean === 0) {
    ratio = null
    direction = 'none'
  } else if (lowerMean === 0) {
    ratio = null
    direction = 'wider-at-high-fitted'
  } else if (upperMean === 0) {
    ratio = null
    direction = 'wider-at-low-fitted'
  } else if (upperMean >= lowerMean) {
    ratio = upperMean / lowerMean
    direction = 'wider-at-high-fitted'
  } else {
    ratio = lowerMean / upperMean
    direction = 'wider-at-low-fitted'
  }

  const visible = ratio === null ? direction !== 'none' : ratio >= SPREAD_RATIO_HEURISTIC
  const status: SpreadStatus = visible ? 'visible-pattern' : 'no-visible-pattern'
  const halfDescription =
    direction === 'wider-at-low-fitted' ? 'the lower half of the fitted range' : 'the higher half of the fitted range'
  const message = visible
    ? 'The observed mean absolute residual is larger in ' +
      halfDescription +
      ' than in the other' +
      (ratio === null
        ? ', where it is exactly zero'
        : ', by a factor of about ' + ratio.toFixed(2)) +
      '. That describes these two groups in this sample; it is not a test result and does not identify why they differ.'
    : 'The two halves of the fitted range differ in observed mean absolute residual by less than the screening ratio. That is not evidence that the spread is constant.'

  return {
    ok: true,
    status,
    direction,
    message,
    lowerHalf: { count: lowerIndices.length, meanAbsoluteResidual: lowerMean },
    upperHalf: { count: upperIndices.length, meanAbsoluteResidual: upperMean },
    ratio,
    heuristicRatio: SPREAD_RATIO_HEURISTIC,
    splitFittedValue,
    upperFirstFittedValue,
    boundaryTies,
    splitDisclosure,
  }
}

/**
 * Residual structure for the mono-exponential (M0) fit.
 *
 * Reuses the existing residual diagnostics — the same rows, the same
 * residuals, the same RMSE — and adds the spread screen and ordering
 * disclosure. The fit is never re-run.
 */
export function analyzeMonoExponentialResiduals(
  measurements: readonly ExperimentalMeasurement[],
  fit: Extract<MonoExponentialFitResult, { ok: true }>,
): ResidualStructureModelResult {
  const diagnostics = diagnoseMonoExponentialFit(measurements, fit)
  if (!diagnostics.ok) {
    return {
      ok: false,
      modelId: 'M0',
      label: MODEL_LABELS.M0,
      code: diagnostics.code,
      message: diagnostics.message,
    }
  }
  return {
    ok: true,
    modelId: 'M0',
    label: MODEL_LABELS.M0,
    residuals: diagnostics.residuals,
    measurementCount: diagnostics.measurementCount,
    rmse: diagnostics.rmse,
    spread: screenResidualSpread(diagnostics.residuals),
    timeOrder: describeTimeOrder(diagnostics.residuals),
    notes: standingNotes(),
  }
}

/**
 * Build one residual per stored row for the baseline model, from the fit's own
 * parameters. No refitting: the fitted value at each measured time is the
 * model equation evaluated with the published estimates.
 */
function baselineResiduals(
  measurements: readonly ExperimentalMeasurement[],
  fit: Extract<MonoExponentialBaselineFitResult, { ok: true }>,
):
  | { ok: true; residuals: MonoExponentialResidual[]; rmse: number }
  | { ok: false; code: ResidualStructureFailureCode; message: string } {
  if (measurements.length === 0 || measurements.length !== fit.measurementCount) {
    return {
      ok: false,
      code: 'MEASUREMENT_MISMATCH',
      message: 'The rows do not match the observations used by this fit.',
    }
  }
  const censoredRefusal = censoredRefusalMessage(measurements)
  if (censoredRefusal !== null) {
    return { ok: false, code: 'CENSORED_CONCENTRATION_UNSUPPORTED', message: censoredRefusal }
  }
  if (
    !Number.isFinite(fit.tRef) ||
    !Number.isFinite(fit.amplitude) ||
    !Number.isFinite(fit.baseline) ||
    !Number.isFinite(fit.k)
  ) {
    return {
      ok: false,
      code: 'NON_FINITE_PARAMETER',
      message: 'The fit contains a non-finite parameter; residuals are unavailable.',
    }
  }

  const residuals: MonoExponentialResidual[] = []
  let scaled = 0
  let maxAbsResidual = 0
  for (const measurement of measurements) {
    if (measurement === null || typeof measurement !== 'object') {
      return {
        ok: false,
        code: 'INVALID_MEASUREMENT',
        message: 'A measurement is invalid; residuals are unavailable.',
      }
    }
    const concentration = (measurement as QuantifiedMeasurement).concentration
    if (
      typeof measurement.time !== 'number' ||
      typeof concentration !== 'number' ||
      !Number.isFinite(measurement.time) ||
      !Number.isFinite(concentration)
    ) {
      return {
        ok: false,
        code: 'INVALID_MEASUREMENT',
        message: 'A measurement is invalid; residuals are unavailable.',
      }
    }
    const fitted = fit.baseline + fit.amplitude * Math.exp(-fit.k * (measurement.time - fit.tRef))
    const residual = concentration - fitted
    if (!Number.isFinite(fitted) || !Number.isFinite(residual)) {
      return {
        ok: false,
        code: 'NON_FINITE_PARAMETER',
        message: 'A fitted value or residual is not finite; residuals are unavailable.',
      }
    }
    maxAbsResidual = Math.max(maxAbsResidual, Math.abs(residual))
    residuals.push({
      measurementId: measurement.id,
      sourceRow: measurement.sourceRow,
      time: measurement.time,
      observed: concentration,
      fitted,
      residual,
    })
  }

  if (maxAbsResidual > 0) {
    for (const point of residuals) {
      const scaledResidual = point.residual / maxAbsResidual
      scaled += scaledResidual * scaledResidual
    }
  }
  const rmse =
    maxAbsResidual === 0
      ? 0
      : maxAbsResidual * Math.sqrt(scaled / residuals.length)
  if (!Number.isFinite(rmse)) {
    return {
      ok: false,
      code: 'NON_FINITE_PARAMETER',
      message: 'RMSE is not finite; residuals are unavailable.',
    }
  }

  return { ok: true, residuals, rmse }
}

/**
 * Residual structure for the baseline model (M1).
 *
 * Takes the fit the comparison already produced; the model is not fitted again.
 */
export function analyzeBaselineResiduals(
  measurements: readonly ExperimentalMeasurement[],
  fit: MonoExponentialBaselineFitResult,
): ResidualStructureModelResult {
  if (!fit.ok) {
    return {
      ok: false,
      modelId: 'M1',
      label: MODEL_LABELS.M1,
      code: 'FIT_UNAVAILABLE',
      message: fit.message,
    }
  }
  const built = baselineResiduals(measurements, fit)
  if (!built.ok) {
    return {
      ok: false,
      modelId: 'M1',
      label: MODEL_LABELS.M1,
      code: built.code,
      message: built.message,
    }
  }
  return {
    ok: true,
    modelId: 'M1',
    label: MODEL_LABELS.M1,
    residuals: built.residuals,
    measurementCount: built.residuals.length,
    rmse: built.rmse,
    spread: screenResidualSpread(built.residuals),
    timeOrder: describeTimeOrder(built.residuals),
    notes: standingNotes(),
  }
}
