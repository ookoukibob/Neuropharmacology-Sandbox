/**
 * Below-quantification-limit (BLQ) support tests (phase 50F).
 *
 * Covers the shared censored-observation helpers and the safety gate every
 * numeric concentration analysis applies: with any BLQ record present the
 * analysis must refuse with `CENSORED_CONCENTRATION_UNSUPPORTED` (naming the
 * source rows) instead of treating a limit as a measured concentration. The
 * time-only sampling diagnostics keep the BLQ record's real sampling time.
 */
import { describe, expect, it } from 'vitest'
import {
  censoredMeasurementsSummary,
  censoredRefusalMessage,
  isCensoredMeasurement,
  isQuantifiedMeasurement,
  type AdministrationMetadata,
  type ExperimentalMeasurement,
} from './experimental-dataset'
import { analyzeNca } from './nca'
import { analyzeIntervalAuc } from './interval-auc'
import { analyzeIntervalExposure } from './interval-exposure-metrics'
import { analyzeSamplingCoverage } from './sampling-coverage'
import { fitMonoExponentialDecay } from './mono-exponential-fit'
import { fitProportionalVarianceDecay } from './proportional-variance-fit'

const quantified = (sourceRow: number, time: number, concentration: number): ExperimentalMeasurement => ({
  id: `q${sourceRow}`,
  sourceRow,
  time,
  concentration,
})

const censored = (
  sourceRow: number,
  time: number,
  limit: number,
  rawText = '<0.1',
): ExperimentalMeasurement => ({
  id: `c${sourceRow}`,
  sourceRow,
  time,
  censored: true,
  censoring: 'below-quantification-limit',
  rawText,
  limit,
})

const NCA_OPTIONS = { integrationMethod: 'linear' as const, terminalPointCount: 3 }

describe('censored observation helpers', () => {
  it('distinguishes quantified records from below-limit records', () => {
    const q = quantified(1, 0, 100)
    const c = censored(2, 1, 0.1)
    expect(isQuantifiedMeasurement(q)).toBe(true)
    expect(isCensoredMeasurement(q)).toBe(false)
    expect(isQuantifiedMeasurement(c)).toBe(false)
    expect(isCensoredMeasurement(c)).toBe(true)
  })

  it('never treats a pre-50F record (no censored field) as censored', () => {
    const legacy = { id: 'm1', sourceRow: 1, time: 0, concentration: 5 }
    expect(isCensoredMeasurement(legacy as ExperimentalMeasurement)).toBe(false)
    expect(isQuantifiedMeasurement(legacy as ExperimentalMeasurement)).toBe(true)
  })

  it('summarises the count and source rows of below-limit records', () => {
    const measurements = [quantified(1, 0, 100), censored(2, 1, 0.1), censored(3, 2, 0.1)]
    expect(censoredMeasurementsSummary(measurements)).toEqual({ count: 2, sourceRows: [2, 3] })
    expect(censoredMeasurementsSummary([quantified(1, 0, 100)])).toBeNull()
    const message = censoredRefusalMessage(measurements)
    expect(message).toMatch(/2 below-quantification-limit record\(s\)/)
    expect(message).toMatch(/source rows 2, 3/)
    expect(message).toMatch(/no limit is substituted/i)
  })
})

describe('numeric analyses refuse censored concentrations', () => {
  const measurements = [quantified(1, 0, 100), quantified(2, 1, 60), censored(3, 2, 0.1)]

  it('NCA refuses', () => {
    const report = analyzeNca(measurements, 'h', 'mg/L', NCA_OPTIONS)
    expect(report.ok).toBe(false)
    if (report.ok) return
    expect(report.code).toBe('CENSORED_CONCENTRATION_UNSUPPORTED')
    expect(report.message).toMatch(/source rows 3/)
  })

  it('interval AUCτ refuses', () => {
    const report = analyzeIntervalAuc({
      measurements,
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      administration: undefined,
      integrationMethod: 'linear',
      terminalPointCount: 3,
      selection: { startTime: 0, endTime: 2 },
      administrationAligned: false,
    })
    expect(report.status).toBe('unavailable')
    expect(report.code).toBe('CENSORED_CONCENTRATION_UNSUPPORTED')
    expect(report.aucTau.status).toBe('unavailable')
  })

  it('interval exposure refuses', () => {
    const interval = analyzeIntervalAuc({
      measurements,
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      administration: undefined,
      integrationMethod: 'linear',
      terminalPointCount: 3,
      selection: { startTime: 0, endTime: 2 },
      administrationAligned: false,
    })
    const report = analyzeIntervalExposure({
      measurements,
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      administration: undefined,
      interval,
    })
    expect(report.cmaxObs.status).toBe('unavailable')
    expect(report.cmaxObs.code).toBe('CENSORED_CONCENTRATION_UNSUPPORTED')
    expect(report.summary).toMatch(/source rows 3/)
  })

  it('mono-exponential fit refuses', () => {
    const fit = fitMonoExponentialDecay(measurements)
    expect(fit.ok).toBe(false)
    if (fit.ok) return
    expect(fit.code).toBe('CENSORED_CONCENTRATION_UNSUPPORTED')
  })

  it('proportional-variance fit refuses', () => {
    const fit = fitProportionalVarianceDecay(measurements)
    expect(fit.ok).toBe(false)
    if (fit.ok) return
    expect(fit.code).toBe('CENSORED_CONCENTRATION_UNSUPPORTED')
  })
})

describe('time-only sampling diagnostics keep the BLQ record time', () => {
  const steady: AdministrationMetadata = {
    route: 'iv-bolus',
    regimen: 'repeated-dose-steady-state',
    timeReference: 'dose-time',
    dose: { value: 84, unit: 'mg' },
    doseBasis: 'per-administration',
    dosingInterval: { value: 4, unit: 'h' },
  }

  it('reports counts and gaps using the censored record time', () => {
    const measurements = [quantified(1, 0, 100), quantified(2, 2, 50), censored(3, 4, 0.1)]
    const interval = analyzeIntervalAuc({
      measurements,
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      administration: steady,
      integrationMethod: 'linear',
      terminalPointCount: 3,
      selection: { startTime: 0, endTime: 4 },
      administrationAligned: true,
    })
    const exposure = analyzeIntervalExposure({
      measurements,
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      administration: steady,
      interval,
    })
    const report = analyzeSamplingCoverage({
      measurements,
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      administration: steady,
      interval,
      exposure,
    })
    // The censored record is a real observation at t = 4 and is counted.
    expect(report.status).toBe('available')
    expect(report.window?.observationCount).toBe(3)
    expect(report.window?.distinctTimeCount).toBe(3)
    expect(report.gaps.status).toBe('available')
    if (report.gaps.status !== 'available') return
    expect(report.gaps.value.gaps.map((gap) => gap.gapDuration)).toEqual([2, 2])
    // Extreme positions cannot be sourced: the exposure report refused BLQ.
    expect(report.extremeLocations.status).toBe('unavailable')
  })
})
