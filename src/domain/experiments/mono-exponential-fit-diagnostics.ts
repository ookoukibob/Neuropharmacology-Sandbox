/**
 * Descriptive diagnostics for a successful mono-exponential fit (phase 47C).
 * Residuals stay in the original concentration unit and source-row order.
 * This module does not standardize residuals, infer an error distribution,
 * estimate uncertainty, or compare models. Notes are screening aids only.
 */
import type { ExperimentalMeasurement } from './experimental-dataset'
import type { MonoExponentialFitResult } from './mono-exponential-fit'

export interface MonoExponentialResidual {
  readonly measurementId: string
  readonly sourceRow: number
  readonly time: number
  readonly observed: number
  readonly fitted: number
  /** Raw residual: observed minus fitted, in the dataset concentration unit. */
  readonly residual: number
}

export interface MonoExponentialFitDiagnostics {
  readonly ok: true
  readonly measurementCount: number
  readonly estimatedParameterCount: 2
  /** n - p for the fitted amplitude and decay rate. May be zero. */
  readonly residualDegreesOfFreedom: number
  readonly distinctTimeCount: number
  /** sqrt(mean(raw residual squared)), in the original concentration unit. */
  readonly rmse: number
  readonly residuals: readonly MonoExponentialResidual[]
  /** Boundary and minimum-information notes, not formal identifiability results. */
  readonly dataSupportNotes: readonly string[]
}

export interface MonoExponentialFitDiagnosticsFailure {
  readonly ok: false
  readonly message: string
}

export type MonoExponentialFitDiagnosticsResult =
  | MonoExponentialFitDiagnostics
  | MonoExponentialFitDiagnosticsFailure

type SuccessfulFit = Extract<MonoExponentialFitResult, { ok: true }>

/**
 * Compute one residual for every row used by the fit. Replicates and duplicate
 * times remain separate. RMSE uses scaled squares to avoid needless overflow.
 */
export function diagnoseMonoExponentialFit(
  measurements: readonly ExperimentalMeasurement[],
  fit: SuccessfulFit,
): MonoExponentialFitDiagnosticsResult {
  if (measurements.length === 0 || measurements.length !== fit.measurementCount) {
    return { ok: false, message: 'The diagnostic rows do not match the observations used by this fit.' }
  }
  if (!Number.isFinite(fit.tRef) || !Number.isFinite(fit.cRef) || !Number.isFinite(fit.k)) {
    return { ok: false, message: 'The fit contains a non-finite parameter; diagnostics are unavailable.' }
  }

  const residuals: MonoExponentialResidual[] = []
  const distinctTimes = new Set<number>()
  let maxAbsResidual = 0

  for (const measurement of measurements) {
    if (
      measurement === null ||
      typeof measurement !== 'object' ||
      typeof measurement.time !== 'number' ||
      typeof measurement.concentration !== 'number' ||
      !Number.isFinite(measurement.time) ||
      !Number.isFinite(measurement.concentration)
    ) {
      return { ok: false, message: 'A measurement is invalid; residual diagnostics are unavailable.' }
    }
    const fitted = fit.cRef * Math.exp(-fit.k * (measurement.time - fit.tRef))
    const residual = measurement.concentration - fitted
    if (!Number.isFinite(fitted) || !Number.isFinite(residual)) {
      return { ok: false, message: 'A fitted value or residual is not finite; diagnostics are unavailable.' }
    }
    distinctTimes.add(measurement.time)
    maxAbsResidual = Math.max(maxAbsResidual, Math.abs(residual))
    residuals.push({
      measurementId: measurement.id,
      sourceRow: measurement.sourceRow,
      time: measurement.time,
      observed: measurement.concentration,
      fitted,
      residual,
    })
  }

  let scaledSumSquares = 0
  if (maxAbsResidual > 0) {
    for (const point of residuals) {
      const scaled = point.residual / maxAbsResidual
      scaledSumSquares += scaled * scaled
    }
  }
  const rmse = maxAbsResidual === 0
    ? 0
    : maxAbsResidual * Math.sqrt(scaledSumSquares / residuals.length)
  if (!Number.isFinite(rmse)) {
    return { ok: false, message: 'RMSE is not finite; diagnostics are unavailable.' }
  }

  const measurementCount = measurements.length
  const residualDegreesOfFreedom = measurementCount - 2
  const distinctTimeCount = distinctTimes.size
  const dataSupportNotes: string[] = []

  if (fit.zeroRate) {
    dataSupportNotes.push(
      'The estimated decay rate is at the k = 0 boundary. The data do not establish a positive decay rate or a finite half-life.',
    )
  }
  if (fit.warnings.some((warning) => warning.code === 'RATE_AT_UPPER_BOUND')) {
    dataSupportNotes.push(
      'The estimated rate reached the optimizer numerical upper bound. The rate is unresolved beyond that bound.',
    )
  }
  if (distinctTimeCount < 3) {
    dataSupportNotes.push(
      'Only ' + String(distinctTimeCount) + ' distinct time points are available. With two fitted parameters, residual patterns and parameter precision cannot be assessed reliably from so few distinct times.',
    )
  }
  if (residualDegreesOfFreedom === 0) {
    dataSupportNotes.push(
      'There are no residual degrees of freedom (n equals the two fitted parameters). RMSE is descriptive only; no residual-variance estimate is available.',
    )
  }
  if (dataSupportNotes.length === 0) {
    dataSupportNotes.push(
      'No rate-boundary or fewer-than-three-distinct-times flag was detected. This preliminary screen is not a formal structural or practical identifiability test and does not quantify parameter uncertainty.',
    )
  }

  return {
    ok: true,
    measurementCount,
    estimatedParameterCount: 2,
    residualDegreesOfFreedom,
    distinctTimeCount,
    rmse,
    residuals,
    dataSupportNotes,
  }
}
