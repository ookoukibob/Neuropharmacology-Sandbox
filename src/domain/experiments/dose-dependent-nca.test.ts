import { describe, expect, it } from 'vitest'
import { analyzeDoseDependentNca, type DoseDependentNcaReport } from './dose-dependent-nca'
import type { AdministrationMetadata } from './experimental-dataset'
import { analyzeNca, type NcaAnalysis, type NcaMetricAvailable, type NcaMetricKind } from './nca'

/**
 * Dose-dependent NCA tests. Oracles are hand arithmetic and closed-form
 * one-compartment identities — never the implementation's own output.
 *
 * The synthetic case used throughout: C(t) = 100·e^(−0.5·t) mg/L sampled at
 * t = 0…5 h, dose 100 mg. Then AUC(0→∞) = 100/0.5 = 200 mg/L·h,
 * CL = 100/200 = 0.5 L/h and Vz = 0.5/0.5 = 1 L.
 */

const metric = (
  value: number,
  unit: string,
  kind: NcaMetricKind = 'calculated',
  name?: string,
): NcaMetricAvailable => ({
  status: 'available',
  value,
  unit,
  kind,
  contributingSourceRows: [1, 2, 3],
  ...(name === undefined ? {} : { name }),
})

function nca(overrides: Partial<NcaAnalysis> = {}): NcaAnalysis {
  return {
    ok: true,
    cmax: metric(100, 'mg/L', 'observed'),
    tmax: metric(0, 'h', 'observed'),
    aucLast: metric(180, 'mg/L·h'),
    aucInf: metric(200, 'mg/L·h', 'extrapolated', 'AUC(0→∞)'),
    aucInfInterval: 'zero-to-infinity',
    extrapolatedFraction: metric(0.1, 'fraction'),
    lambdaZ: metric(0.5, 'h⁻¹'),
    halfLife: metric(Math.LN2 / 0.5, 'h'),
    terminalPhase: {
      status: 'available',
      selectedSourceRows: [1, 2, 3],
      selectedTimes: [1, 2, 3],
      eligiblePositiveCount: 3,
      regression: {
        slope: -0.5,
        intercept: Math.log(100),
        lambdaZ: 0.5,
        halfLife: Math.LN2 / 0.5,
        rSquared: 0.99,
        observationCount: 3,
        fittedConcentrations: [60.65, 36.79, 22.31],
      },
    },
    warnings: [],
    ...overrides,
  }
}

const administration = (overrides: Partial<AdministrationMetadata> = {}): AdministrationMetadata => ({
  route: 'iv-bolus',
  regimen: 'single-dose',
  timeReference: 'dose-time',
  dose: { value: 100, unit: 'mg' },
  ...overrides,
})

const run = (
  admin: AdministrationMetadata | undefined,
  analysis: NcaAnalysis = nca(),
  units: { timeUnit?: string; concentrationUnit?: string } = {},
): DoseDependentNcaReport =>
  analyzeDoseDependentNca({
    timeUnit: units.timeUnit ?? 'h',
    concentrationUnit: units.concentrationUnit ?? 'mg/L',
    administration: admin,
    nca: analysis,
  })

describe('dose-dependent NCA — IV bolus and infusion', () => {
  it('derives CL and Vz for an IV bolus from Dose/AUC and CL/λz', () => {
    const report = run(administration())
    expect(report.status).toBe('available')
    expect(report.parameters.cl.status).toBe('available')
    expect(report.parameters.cl.value).toBeCloseTo(0.5, 12)
    expect(report.parameters.cl.unit).toBe('L/h')
    expect(report.parameters.cl.basis).toBe('absolute')
    expect(report.parameters.cl.formula).toBe('CL = Dose / AUC(0→∞)')
    expect(report.parameters.vz.status).toBe('available')
    expect(report.parameters.vz.value).toBeCloseTo(1, 12)
    expect(report.parameters.vz.unit).toBe('L')
    // F = 1 by the IV route definition: the apparent twins are not reported.
    expect(report.parameters.clF.status).toBe('not-applicable')
    expect(report.parameters.vzF.status).toBe('not-applicable')
    // The audit block carries the exact inputs.
    expect(report.parameters.cl.inputs.dose).toEqual({ value: 100, unit: 'mg' })
    expect(report.parameters.cl.inputs.auc).toEqual({
      value: 200,
      unit: 'mg/L·h',
      name: 'AUC(0→∞)',
    })
  })

  it('derives CL for an IV infusion from the total dose and complete AUC', () => {
    const report = run(
      administration({
        route: 'iv-infusion',
        timeReference: 'infusion-start',
        infusion: { duration: { value: 2, unit: 'h' } },
      }),
    )
    expect(report.parameters.cl.status).toBe('available')
    expect(report.parameters.cl.value).toBeCloseTo(0.5, 12)
    expect(report.parameters.vz.value).toBeCloseTo(1, 12)
  })

  it('warns but still computes when an IV infusion has no duration/rate recorded', () => {
    const report = run(administration({ route: 'iv-infusion', timeReference: 'infusion-start' }))
    expect(report.parameters.cl.status).toBe('available')
    expect(report.warnings.some((warning) => /does not depend on the input rate/i.test(warning))).toBe(true)
  })

  it('does not claim an empty infusion record contains duration or rate', () => {
    const report = run(
      administration({
        route: 'iv-infusion',
        timeReference: 'infusion-start',
        infusion: {},
      }),
    )
    expect(report.parameters.cl.status).toBe('available')
    expect(
      report.preconditions.find((condition) => condition.id === 'infusion')?.message,
    ).toMatch(/no infusion duration or rate is recorded/i)
    expect(report.parameters.vz.status).toBe('conditional')
  })

  it('requires every terminal-regression observation to be after the infusion end', () => {
    const baseTerminal = nca().terminalPhase
    if (baseTerminal.status !== 'available') throw new Error('fixture')
    const postInfusionNca = nca({
      terminalPhase: {
        ...baseTerminal,
        selectedSourceRows: [4, 5, 6],
        selectedTimes: [3, 4, 5],
      },
    })
    const infusion = administration({
      route: 'iv-infusion',
      timeReference: 'infusion-start',
      infusion: { duration: { value: 2, unit: 'h' } },
    })
    const afterEnd = run(infusion, postInfusionNca)
    expect(afterEnd.parameters.vz.status).toBe('available')

    // The last selected point is after 2 h, but earlier regression points
    // still overlap the infusion. Such a mixed-phase regression is conditional.
    const straddling = run(infusion, nca())
    expect(straddling.parameters.vz.status).toBe('conditional')
    expect(straddling.parameters.vz.message).toMatch(/end of the infusion/i)

    const beforeEnd = run(
      administration({
        route: 'iv-infusion',
        timeReference: 'infusion-start',
        infusion: { duration: { value: 6, unit: 'h' } },
      }),
    )
    expect(beforeEnd.parameters.vz.status).toBe('conditional')

    const noDuration = run(administration({ route: 'iv-infusion', timeReference: 'infusion-start' }))
    expect(noDuration.parameters.vz.status).toBe('conditional')
  })
  it('normalises terminal sampling times before comparing them with infusion duration', () => {
    // Dataset times are minutes, but the recorded infusion duration is hours.
    // The terminal observations end at 90 min (1.5 h), before a 2 h infusion
    // finishes. Raw 90 <= 2 is false, so comparing unconverted values would
    // incorrectly mark Vz as available.
    const minuteAnalysis = nca({
      aucInf: metric(200, 'mg/L·min', 'extrapolated', 'AUC(0→∞)'),
      lambdaZ: metric(0.5, 'min⁻¹'),
      terminalPhase: {
        status: 'available',
        selectedSourceRows: [4, 5, 6],
        selectedTimes: [30, 60, 90],
        eligiblePositiveCount: 6,
        regression: {
          slope: -0.5,
          intercept: Math.log(100),
          lambdaZ: 0.5,
          halfLife: Math.LN2 / 0.5,
          rSquared: 0.99,
          observationCount: 3,
          fittedConcentrations: [60.65, 36.79, 22.31],
        },
      },
    })
    const report = run(
      administration({
        route: 'iv-infusion',
        timeReference: 'infusion-start',
        infusion: { duration: { value: 2, unit: 'h' } },
      }),
      minuteAnalysis,
      { timeUnit: 'min' },
    )
    expect(report.parameters.cl.status).toBe('available')
    expect(report.parameters.vz.status).toBe('conditional')
    expect(report.parameters.vz.message).toMatch(/end of the infusion/i)
  })

})

describe('dose-dependent NCA — extravascular and bioavailability', () => {
  const extravascular = administration({ route: 'extravascular' })

  it('reports only CL/F and Vz/F when F is not recorded', () => {
    const report = run(extravascular)
    expect(report.parameters.clF.status).toBe('available')
    expect(report.parameters.clF.value).toBeCloseTo(0.5, 12)
    expect(report.parameters.clF.basis).toBe('apparent')
    expect(report.parameters.cl.status).toBe('unavailable')
    expect(report.parameters.cl.code).toBe('BIOAVAILABILITY_MISSING')
    expect(report.parameters.vz.status).toBe('unavailable')
    expect(report.parameters.vz.code).toBe('BIOAVAILABILITY_MISSING')
    // The terminal volume is computable but conditional (flip-flop risk).
    expect(report.parameters.vzF.status).toBe('conditional')
    expect(report.parameters.vzF.value).toBeCloseTo(1, 12)
    expect(report.parameters.vzF.message).toMatch(/flip-flop/i)
  })

  it('computes absolute CL and Vz when F is recorded', () => {
    const report = run(administration({ route: 'extravascular', bioavailability: 0.5 }))
    expect(report.parameters.cl.status).toBe('available')
    expect(report.parameters.cl.value).toBeCloseTo(0.25, 12)
    expect(report.parameters.cl.formula).toBe('CL = F × Dose / AUC(0→∞)')
    expect(report.parameters.vz.status).toBe('conditional')
    expect(report.parameters.vz.value).toBeCloseTo(0.5, 12)
    // The apparent parameters remain available alongside the absolute ones.
    expect(report.parameters.clF.value).toBeCloseTo(0.5, 12)
    expect(report.parameters.vzF.value).toBeCloseTo(1, 12)
  })
})

describe('dose-dependent NCA — λz and AUC preconditions', () => {
  it('keeps CL available while Vz/Vz/F are unavailable without λz', () => {
    const noLambda = nca({
      lambdaZ: { status: 'unavailable', code: 'NON_POSITIVE_TERMINAL_SLOPE', message: 'no decay' },
      terminalPhase: {
        status: 'unavailable',
        selectedSourceRows: [1, 2, 3],
        selectedTimes: [1, 2, 3],
        eligiblePositiveCount: 3,
        regression: null,
        code: 'NON_POSITIVE_TERMINAL_SLOPE',
        message: 'no decay',
      },
    })
    const iv = run(administration(), noLambda)
    expect(iv.parameters.cl.status).toBe('available')
    expect(iv.parameters.vz.status).toBe('unavailable')
    expect(iv.parameters.vz.code).toBe('LAMBDA_Z_UNAVAILABLE')

    const ev = run(administration({ route: 'extravascular' }), noLambda)
    expect(ev.parameters.clF.status).toBe('available')
    expect(ev.parameters.vzF.status).toBe('unavailable')
    expect(ev.parameters.vzF.code).toBe('LAMBDA_Z_UNAVAILABLE')
  })

  it('refuses AUC(first→∞) instead of substituting it for a complete AUC', () => {
    const partial = nca({
      aucInf: metric(200, 'mg/L·h', 'extrapolated', 'AUC(first→∞)'),
      aucInfInterval: 'first-to-infinity',
    })
    const report = run(administration(), partial)
    expect(report.status).toBe('unavailable')
    expect(report.parameters.cl.code).toBe('AUC_NOT_COMPLETE')
    expect(report.parameters.cl.message).toMatch(/never substituted/i)
  })

  it('reports AUC_UNAVAILABLE when no extrapolated AUC exists', () => {
    const missing = nca({
      aucInf: { status: 'unavailable', code: 'NON_POSITIVE_TERMINAL_SLOPE', message: 'no decay' },
      aucInfInterval: null,
    })
    const report = run(administration(), missing)
    expect(report.parameters.cl.code).toBe('AUC_UNAVAILABLE')
    expect(report.parameters.cl.message).toMatch(/no decay/)
  })

  it('marks CL conditional when more than 20% of AUC is extrapolated', () => {
    const report = run(administration(), nca({ extrapolatedFraction: metric(0.35, 'fraction') }))
    expect(report.parameters.cl.status).toBe('conditional')
    expect(report.parameters.cl.warnings.some((warning) => /20%/.test(warning))).toBe(true)
  })

  it('marks Vz conditional when the terminal regression is weak', () => {
    const weak = nca()
    const terminal = weak.terminalPhase
    if (terminal.status !== 'available' || terminal.regression === null) throw new Error('fixture')
    const report = run(
      administration(),
      nca({ terminalPhase: { ...terminal, regression: { ...terminal.regression, rSquared: 0.4 } } }),
    )
    expect(report.parameters.cl.status).toBe('available')
    expect(report.parameters.vz.status).toBe('conditional')
    expect(report.parameters.vz.message).toMatch(/R²/)
  })
})

describe('dose-dependent NCA — administration preconditions', () => {
  it('returns an explicit reason when no administration record exists', () => {
    const report = run(undefined)
    expect(report.status).toBe('unavailable')
    expect(report.administrationRecorded).toBe(false)
    expect(report.parameters.cl.code).toBe('ADMINISTRATION_MISSING')
    expect(report.parameters.vzF.code).toBe('ADMINISTRATION_MISSING')
  })

  it('rejects unknown and other routes', () => {
    expect(run(administration({ route: 'unknown' })).parameters.cl.code).toBe('ROUTE_UNKNOWN')
    expect(run(administration({ route: 'other' })).parameters.cl.code).toBe('ROUTE_OTHER')
  })

  it('rejects repeated dosing and unknown regimens without inventing a steady-state AUC', () => {
    const repeated = run(administration({ regimen: 'repeated-dose', dosingInterval: { value: 12, unit: 'h' } }))
    expect(repeated.parameters.cl.code).toBe('REGIMEN_NOT_SINGLE_DOSE')
    expect(repeated.parameters.cl.message).toMatch(/AUCτ/)
    expect(run(administration({ regimen: 'repeated-dose-steady-state' })).parameters.cl.code).toBe(
      'REGIMEN_NOT_SINGLE_DOSE',
    )
    expect(run(administration({ regimen: 'unknown' })).parameters.cl.code).toBe('REGIMEN_UNKNOWN')
  })

  it('rejects a missing or non-positive dose', () => {
    const noDose: AdministrationMetadata = {
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
    }
    expect(run(noDose).parameters.cl.code).toBe('DOSE_MISSING')
    expect(run(administration({ dose: { value: 0, unit: 'mg' } })).parameters.cl.code).toBe(
      'DOSE_NOT_POSITIVE',
    )
  })

  it('rejects a time reference that does not anchor time zero to administration', () => {
    expect(run(administration({ timeReference: 'first-observation' })).parameters.cl.code).toBe(
      'TIME_REFERENCE_MISMATCH',
    )
    expect(
      run(administration({ route: 'iv-infusion', timeReference: 'dose-time' })).parameters.cl.code,
    ).toBe('TIME_REFERENCE_MISMATCH')
    expect(
      run(administration({ route: 'extravascular', timeReference: 'infusion-start' })).parameters.cl
        .code,
    ).toBe('TIME_REFERENCE_MISMATCH')
  })

  it('rejects infusion parameters recorded on a non-infusion route', () => {
    const report = run(administration({ infusion: { rate: { value: 10, unit: 'mg/h' } } }))
    expect(report.parameters.cl.code).toBe('INFUSION_METADATA_INCONSISTENT')
  })
})

describe('dose-dependent NCA — units', () => {
  it('converts a mass unit before dividing (µg dose, mg/L·h AUC)', () => {
    const report = run(administration({ dose: { value: 100_000, unit: 'µg' } }))
    expect(report.parameters.cl.value).toBeCloseTo(0.5, 12)
    expect(report.parameters.cl.substitution).toBe('0.1 g ÷ 0.2 g·h/L = 0.5 L/h')
  })

  it('converts a mass-concentration unit (µg/mL) and a time unit (min)', () => {
    // 200 µg/mL·min = 200 mg/L·min = 3.3333 mg/L·h; λz 0.5 min⁻¹ = 30 h⁻¹.
    const analysis = nca({
      aucInf: metric(200, 'µg/mL·min', 'extrapolated', 'AUC(0→∞)'),
      lambdaZ: metric(0.5, 'min⁻¹'),
    })
    const report = run(administration(), analysis, {
      timeUnit: 'min',
      concentrationUnit: 'µg/mL',
    })
    expect(report.parameters.cl.value).toBeCloseTo(30, 10)
    expect(report.parameters.vz.value).toBeCloseTo(1, 10)
    expect(report.parameters.cl.substitution).toContain('g ÷')
    expect(report.parameters.cl.substitution).toContain('g·h/L =')
    expect(report.parameters.vz.substitution).toContain('h⁻¹ =')
  })

  it('refuses a molar concentration with a mass dose (no molecular weight is invented)', () => {
    const report = run(administration(), nca(), { concentrationUnit: 'µM' })
    expect(report.parameters.cl.code).toBe('CONCENTRATION_UNIT_INCOMPATIBLE')
    expect(report.parameters.cl.message).toMatch(/molecular weight/i)
  })

  it('refuses a dose unit that is not a mass', () => {
    const report = run(administration({ dose: { value: 100, unit: 'mg/L' } }))
    expect(report.parameters.cl.code).toBe('DOSE_UNIT_INCOMPATIBLE')
  })

  it('rejects a dose that underflows to zero during base-unit conversion', () => {
    const report = run(administration({ dose: { value: Number.MIN_VALUE, unit: 'µg' } }))
    expect(report.parameters.cl.status).toBe('unavailable')
    expect(report.parameters.cl.code).toBe('NUMERICAL_FAILURE')
  })

  it('rejects an AUC conversion overflow instead of publishing zero clearance', () => {
    const report = run(
      administration(),
      nca({ aucInf: metric(Number.MAX_VALUE, 'g/L·d', 'extrapolated', 'AUC(0→∞)') }),
      { timeUnit: 'd', concentrationUnit: 'g/L' },
    )
    expect(report.parameters.cl.status).toBe('unavailable')
    expect(report.parameters.cl.code).toBe('NUMERICAL_FAILURE')
    expect(report.parameters.cl.message).toMatch(/positive finite number/i)
  })

  it('refuses a non-finite result instead of publishing an infinity', () => {
    const report = run(administration(), nca({ aucInf: metric(Number.MIN_VALUE, 'mg/L·h', 'extrapolated', 'AUC(0→∞)') }))
    expect(report.parameters.cl.status).toBe('unavailable')
    expect(report.parameters.cl.code).toBe('NUMERICAL_FAILURE')
  })
})

describe('dose-dependent NCA — integration with the real NCA engine', () => {
  it('recovers the analytic CL and Vz of an exact exponential bolus curve', () => {
    // C(t) = 100·e^(−0.5t) at t = 0…5, dose 100 mg. With linear-up/log-down
    // integration the trapezoids are exact for an exponential, so
    // AUC(0→∞) = 100/0.5 = 200 exactly and λz = 0.5 exactly.
    const concentration = (time: number): number => 100 * Math.exp(-0.5 * time)
    const measurements = [0, 1, 2, 3, 4, 5].map((time, index) => ({
      id: `m${index}`,
      sourceRow: index + 1,
      time,
      concentration: concentration(time),
    }))
    const analysis = analyzeNca(measurements, 'h', 'mg/L', {
      integrationMethod: 'linear-up-log-down',
      terminalPointCount: 3,
    })
    if (!analysis.ok) throw new Error('NCA failed')

    const report = run(administration(), analysis)
    expect(analysis.aucInfInterval).toBe('zero-to-infinity')
    expect(report.parameters.cl.value).toBeCloseTo(0.5, 8)
    expect(report.parameters.vz.value).toBeCloseTo(1, 8)
  })
})
