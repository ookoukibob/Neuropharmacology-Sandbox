/**
 * Steady-state dose-dependent NCA tests (phase 50C).
 *
 * Fixtures are synthetic and the expectations are hand-checkable:
 * a linear concentration gradient gives an exact trapezoidal AUCτ, so a
 * clearance assertion is arithmetic (84 mg / 840 mg·L⁻¹·h = 0.1 L/h).
 */
import { describe, expect, it } from 'vitest'
import type {
  AdministrationMetadata,
  ExperimentalMeasurement,
} from './experimental-dataset'
import { analyzeIntervalAuc } from './interval-auc'
import { analyzeSteadyStateDoseNca } from './steady-state-dose-nca'

const rows = (pairs: readonly (readonly [number, number])[]): ExperimentalMeasurement[] =>
  pairs.map(([time, concentration], index) => ({
    id: `m${index + 1}`,
    sourceRow: index + 1,
    time,
    concentration,
  }))

/** C = 100 − 5t on [0, 12]: AUC over [0, 12] = (100 + 40)/2 · 12 = 840. */
const linear = rows([
  [0, 100],
  [2, 90],
  [4, 80],
  [6, 70],
  [8, 60],
  [10, 50],
  [12, 40],
])

const base: AdministrationMetadata = {
  route: 'iv-bolus',
  regimen: 'repeated-dose-steady-state',
  timeReference: 'dose-time',
  dose: { value: 84, unit: 'mg' },
  doseBasis: 'per-administration',
  dosingInterval: { value: 12, unit: 'h' },
}

function report(
  administration: AdministrationMetadata | undefined = base,
  overrides: {
    readonly measurements?: readonly ExperimentalMeasurement[]
    readonly timeUnit?: string
    readonly concentrationUnit?: string
    readonly start?: number
    readonly end?: number
    readonly selection?: { startTime: number; endTime: number } | null
    readonly aligned?: boolean
    readonly terminalPointCount?: number
    readonly integrationMethod?: 'linear' | 'linear-up-log-down'
  } = {},
): ReturnType<typeof analyzeSteadyStateDoseNca> {
  const measurements = overrides.measurements ?? linear
  const timeUnit = overrides.timeUnit ?? 'h'
  const concentrationUnit = overrides.concentrationUnit ?? 'mg/L'
  const selection =
    overrides.selection === undefined
      ? { startTime: overrides.start ?? 0, endTime: overrides.end ?? 12 }
      : overrides.selection
  const interval = analyzeIntervalAuc({
    measurements,
    timeUnit,
    concentrationUnit,
    administration,
    integrationMethod: overrides.integrationMethod ?? 'linear',
    terminalPointCount: overrides.terminalPointCount ?? 3,
    selection,
    administrationAligned: overrides.aligned ?? true,
  })
  return analyzeSteadyStateDoseNca({ timeUnit, concentrationUnit, administration, interval })
}

describe('steady-state dose-dependent NCA', () => {
  it('computes absolute CL from the per-administration dose and AUCτ', () => {
    const result = report()

    expect(result.status).toBe('available')
    expect(result.regimen).toBe('repeated-dose-steady-state')
    expect(result.doseBasis).toBe('per-administration')
    expect(result.intervalAligned).toBe(true)

    expect(result.parameters.cl.status).toBe('available')
    expect(result.parameters.cl.value).toBeCloseTo(84 / 840, 12)
    expect(result.parameters.cl.unit).toBe('L/h')
    expect(result.parameters.cl.formula).toBe('CL = Dose_τ / AUCτ')
    expect(result.parameters.cl.substitution).toContain('g·h/L')

    // F = 1 by the IV route definition: the apparent twin is not applicable.
    expect(result.parameters.clF.status).toBe('not-applicable')
    expect(result.parameters.vzF.status).toBe('not-applicable')

    // Volume uses the interval's own λ_z.
    expect(result.parameters.vz.status).toBe('available')
    expect(result.parameters.vz.unit).toBe('L')
    const lambdaZ = result.interval.lambdaZ
    if (lambdaZ?.status !== 'available') throw new Error('setup')
    expect(result.parameters.vz.value).toBeCloseTo((84 / 840) / lambdaZ.value, 10)
  })

  it('records the AUCτ, the dose and the interval it used', () => {
    const result = report()
    const inputs = result.parameters.cl.inputs
    expect(inputs.dose).toEqual({ value: 84, unit: 'mg' })
    expect(inputs.doseBasis).toBe('per-administration')
    expect(inputs.auc).toMatchObject({ name: 'AUCτ', unit: 'mg/L·h' })
    expect(inputs.auc?.value).toBeCloseTo(840, 10)
    expect(inputs.interval).toEqual({ startTime: 0, endTime: 12, timeUnit: 'h' })
    expect(result.parameters.cl.assumptions.join(' ')).toMatch(/OBSERVED interval area/i)
    expect(result.parameters.cl.assumptions.join(' ')).toMatch(/RECORDED declaration/i)
  })

  it('uses the interval λ_z, never the whole-dataset one', () => {
    // Two windows: [0, 8] (fast, 4 h apart) and [4, 12]. Selecting [0, 8] with
    // τ = 8 h must regress only its own rows.
    const decay = rows([
      [0, 100],
      [2, 67.032],
      [4, 44.933],
      [6, 30.119],
      [8, 20.19],
      [10, 13.534],
      [12, 9.0718],
    ])
    const result = report(
      { ...base, dosingInterval: { value: 8, unit: 'h' } },
      { measurements: decay, start: 0, end: 8 },
    )
    expect(result.parameters.cl.status).toBe('available')
    // The interval's 5 observations (t = 0…8) contribute their last 3 rows.
    expect(result.interval.terminalPhase?.selectedSourceRows).toEqual([3, 4, 5])
    expect(result.parameters.vz.status).toBe('available')
  })

  it('computes CL/F and CL separately for an extravascular dose with F', () => {
    const extravascular: AdministrationMetadata = {
      ...base,
      route: 'extravascular',
      bioavailability: 0.8,
    }
    const result = report(extravascular)
    expect(result.parameters.clF.status).toBe('available')
    expect(result.parameters.clF.value).toBeCloseTo(84 / 840, 12)
    expect(result.parameters.cl.status).toBe('available')
    expect(result.parameters.cl.value).toBeCloseTo(0.8 * (84 / 840), 12)
    expect(result.parameters.cl.formula).toBe('CL = F × Dose_τ / AUCτ')
    // Absorption may limit the terminal phase: the volume carries the caveat.
    expect(result.parameters.vz.status).toBe('conditional')
    expect(result.parameters.vz.message).toMatch(/flip-flop/i)
  })

  it('reports apparent parameters but not absolute ones when F is unknown', () => {
    const extravascular: AdministrationMetadata = { ...base, route: 'extravascular' }
    const result = report(extravascular)
    expect(result.parameters.clF.status).toBe('available')
    expect(result.parameters.clF.value).toBeCloseTo(84 / 840, 12)
    expect(result.parameters.cl.status).toBe('unavailable')
    expect(result.parameters.cl.code).toBe('BIOAVAILABILITY_MISSING')
    expect(result.parameters.vzF.status).toBe('conditional')
    expect(result.parameters.vz.status).toBe('unavailable')
    expect(result.parameters.vz.code).toBe('BIOAVAILABILITY_MISSING')
    // The apparent label is never presented as the absolute one.
    expect(result.parameters.clF.label).toMatch(/apparent/i)
    expect(result.parameters.cl.label).toMatch(/total clearance/i)
  })

  it('reports AUCτ but no dose-dependent parameter for repeated dosing off steady state', () => {
    const notSteady: AdministrationMetadata = { ...base, regimen: 'repeated-dose' }
    const result = report(notSteady)
    expect(result.status).toBe('unavailable')
    expect(result.parameters.cl.code).toBe('REGIMEN_NOT_STEADY_STATE')
    expect(result.parameters.cl.message).toMatch(/not a clearance/i)
    expect(result.parameters.clF.code).toBe('REGIMEN_NOT_STEADY_STATE')
    expect(result.parameters.vz.code).toBe('REGIMEN_NOT_STEADY_STATE')
    // The interval itself is still available — it is simply not a clearance input.
    expect(result.interval.aucTau.status).toBe('available')
  })

  it('never infers steady state from similar adjacent interval areas', () => {
    // Two adjacent 12 h windows with almost identical areas and a flat curve:
    // the regimen still says "not at steady state", so no CL is produced.
    const flat = rows([
      [0, 50],
      [2, 50.1],
      [4, 49.9],
      [6, 50],
      [8, 50.1],
      [10, 49.9],
      [12, 50],
    ])
    const first = report({ ...base, regimen: 'repeated-dose' }, { measurements: flat, start: 0, end: 12 })
    expect(first.parameters.cl.code).toBe('REGIMEN_NOT_STEADY_STATE')
    expect(first.parameters.cl.value).toBeUndefined()
    // Even the declared-steady-state version requires the analyst's confirmation.
    const unconfirmed = report(base, { measurements: flat, start: 0, end: 12, aligned: false })
    expect(unconfirmed.parameters.cl.code).toBe('INTERVAL_NOT_ALIGNED')
  })

  it('refuses an unknown regimen and a single dose', () => {
    expect(report({ ...base, regimen: 'unknown' }).parameters.cl.code).toBe('REGIMEN_UNKNOWN')
    expect(report({ ...base, regimen: 'single-dose' }).parameters.cl.code).toBe(
      'REGIMEN_NOT_STEADY_STATE',
    )
    expect(report({ ...base, regimen: 'single-dose' }).parameters.cl.message).toMatch(
      /phase 50B|AUC\(0→∞\)/i,
    )
  })

  it('requires an explicitly recorded per-administration dose basis', () => {
    const { doseBasis: _omitted, ...withoutBasis } = base
    expect(report(withoutBasis).parameters.cl.code).toBe('DOSE_BASIS_UNKNOWN')
    expect(report({ ...base, doseBasis: 'unknown' }).parameters.cl.code).toBe('DOSE_BASIS_UNKNOWN')
    const total = report({ ...base, doseBasis: 'total-regimen' })
    expect(total.parameters.cl.code).toBe('DOSE_BASIS_NOT_PER_ADMINISTRATION')
    expect(total.parameters.cl.message).toMatch(/TOTAL amount of the whole regimen/i)
    // The recorded amount is still shown in the audit trail of the refusal.
    expect(total.parameters.cl.inputs.dose).toEqual({ value: 84, unit: 'mg' })
    expect(total.parameters.cl.inputs.doseBasis).toBe('total-regimen')
  })

  it('requires the analyst to confirm the interval starts at a dose', () => {
    const result = report(base, { aligned: false })
    expect(result.status).toBe('unavailable')
    expect(result.parameters.cl.code).toBe('INTERVAL_NOT_ALIGNED')
    expect(result.parameters.cl.message).toMatch(/τ alone does not identify/i)
    expect(result.intervalAligned).toBe(false)
  })

  it('refuses when no interval is selected or the interval has no AUCτ', () => {
    expect(report(base, { selection: null }).parameters.cl.code).toBe('INTERVAL_NOT_SELECTED')
    // A boundary that is not observed makes the interval unusable.
    const missingBoundary = report(base, { start: 1, end: 13 })
    expect(missingBoundary.parameters.cl.code).toBe('INTERVAL_AUC_UNAVAILABLE')
    expect(missingBoundary.parameters.cl.message).toMatch(/no observation exists/i)
  })

  it('keeps CL available when the interval cannot yield a λ_z', () => {
    const twoPoints = rows([
      [0, 100],
      [12, 40],
    ])
    const result = report(base, { measurements: twoPoints })
    expect(result.parameters.cl.status).toBe('available')
    expect(result.parameters.cl.value).toBeCloseTo(84 / 840, 12)
    expect(result.parameters.vz.status).toBe('unavailable')
    expect(result.parameters.vz.code).toBe('LAMBDA_Z_UNAVAILABLE')
    expect(result.parameters.vz.message).toMatch(/CL is unaffected/i)
  })

  it('rejects a missing, non-positive or dimensionally wrong dose', () => {
    const { dose: _omitted, ...withoutDose } = base
    expect(report(withoutDose).parameters.cl.code).toBe('DOSE_MISSING')
    expect(report({ ...base, dose: { value: 0, unit: 'mg' } }).parameters.cl.code).toBe(
      'DOSE_NOT_POSITIVE',
    )
    expect(report({ ...base, dose: { value: 84, unit: 'mg/L' } }).parameters.cl.code).toBe(
      'DOSE_UNIT_INCOMPATIBLE',
    )
  })

  it('refuses a molar concentration with a mass dose instead of inventing a molecular weight', () => {
    const result = report(base, { concentrationUnit: 'µM' })
    expect(result.parameters.cl.code).toBe('CONCENTRATION_UNIT_INCOMPATIBLE')
    expect(result.parameters.cl.message).toMatch(/molecular weight/i)
  })

  it('converts mass, concentration and time units to L/h', () => {
    // µg dose, µg/mL concentration, minutes: 100 000 µg = 0.1 g,
    // AUC = 70 µg/mL · 60 min = 4200 µg·min/mL = 0.07 g·h/L.
    const micro = rows([
      [0, 100],
      [30, 70],
      [60, 40],
    ])
    const result = report(
      { ...base, dose: { value: 100_000, unit: 'µg' }, dosingInterval: { value: 1, unit: 'h' } },
      { measurements: micro, timeUnit: 'min', concentrationUnit: 'µg/mL', end: 60 },
    )
    expect(result.parameters.cl.status).toBe('available')
    expect(result.parameters.cl.value).toBeCloseTo(0.1 / 0.07, 10)
    expect(result.parameters.cl.unit).toBe('L/h')
    expect(result.parameters.cl.substitution).toContain('0.1 g')
    expect(result.parameters.cl.substitution).toContain('0.07 g·h/L')
  })

  it('rejects a time reference that does not anchor the axis to administration', () => {
    const result = report({ ...base, timeReference: 'first-observation' })
    expect(result.parameters.cl.code).toBe('TIME_REFERENCE_MISMATCH')
    expect(result.parameters.cl.message).toMatch(/Time zero|relative to/i)
  })

  it('rejects infusion metadata on a non-infusion route', () => {
    const result = report({ ...base, infusion: { duration: { value: 1, unit: 'h' } } })
    expect(result.parameters.cl.code).toBe('INFUSION_METADATA_INCONSISTENT')
  })

  it('makes an IV-infusion volume conditional when the interval terminal phase is not post-infusion', () => {
    const infusion: AdministrationMetadata = {
      ...base,
      route: 'iv-infusion',
      timeReference: 'infusion-start',
      infusion: { duration: { value: 4, unit: 'h' } },
    }
    const result = report(infusion)
    // Clearance does not depend on the input rate.
    expect(result.parameters.cl.status).toBe('available')
    // The terminal points at 8, 10, 12 h are 8–12 h after the interval start,
    // i.e. after the 4 h infusion: the volume is usable here.
    expect(result.parameters.vz.status).toBe('available')

    const early = report(infusion, { end: 12, terminalPointCount: 6 })
    expect(early.parameters.cl.status).toBe('available')
    expect(early.parameters.vz.status).toBe('conditional')
    expect(early.parameters.vz.message).toMatch(/input phase|infusion end/i)
  })

  it('makes the volume conditional when the infusion end is unrecorded', () => {
    const infusion: AdministrationMetadata = {
      ...base,
      route: 'iv-infusion',
      timeReference: 'infusion-start',
    }
    const result = report(infusion)
    expect(result.parameters.cl.status).toBe('available')
    expect(result.parameters.vz.status).toBe('conditional')
    expect(result.parameters.vz.message).toMatch(/infusion end|input phase/i)
    expect(result.warnings.some((warning) => /no infusion duration or rate is recorded/i.test(warning))).toBe(true)
  })

  it('reports a numerical failure instead of an infinite clearance', () => {
    const tiny = rows([
      [0, 1e-300],
      [12, 1e-300],
    ])
    const result = report({ ...base, dose: { value: 1e300, unit: 'mg' } }, { measurements: tiny })
    expect(result.parameters.cl.status).toBe('unavailable')
    expect(result.parameters.cl.code).toBe('NUMERICAL_FAILURE')
  })

  it('does not mutate the measurements it analyses', () => {
    const snapshot = JSON.stringify(linear)
    report()
    expect(JSON.stringify(linear)).toBe(snapshot)
  })
})
