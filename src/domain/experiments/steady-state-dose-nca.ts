/**
 * Steady-state repeated-dose NCA (phase 50C).
 *
 * Combines an explicitly selected dosing-interval AUCτ (see `interval-auc.ts`)
 * with the recorded administration metadata to derive clearance and terminal
 * volume for a dataset that is DECLARED to be at steady state:
 *
 *   CL/F = Dose_τ / AUCτ             (apparent clearance)
 *   CL   = F · Dose_τ / AUCτ         (absolute; F = 1 for an IV route)
 *   Vz/F = (CL/F) / λ_z              (apparent terminal volume)
 *   Vz   = CL / λ_z                  (absolute)
 *
 * `Dose_τ` is the amount given at EACH administration. It must be explicitly
 * recorded as `doseBasis: 'per-administration'`; a total-regimen amount, an
 * unrecorded basis or `unknown` is never divided by one interval's AUCτ.
 *
 * Non-negotiable preconditions (each refuses with its own code):
 * - the regimen must be DECLARED `repeated-dose-steady-state`. A plain
 *   `repeated-dose` dataset yields an AUCτ but no dose-dependent parameters:
 *   `Dose/AUCτ` from a non-steady-state interval is not a clearance. Steady
 *   state is never inferred from a flat-looking curve or from similar adjacent
 *   interval areas;
 * - the analyst must select the interval explicitly and confirm that it starts
 *   at the recorded administration time of the dose it describes. That
 *   confirmation is an analysis input, echoed in the report, never persisted;
 * - the interval must be one τ wide with observed boundaries and a usable AUCτ;
 * - the route must be IV bolus, IV infusion or extravascular (never inferred);
 * - the recorded time reference must match the route;
 * - λ_z must come from the SAME interval (never from another window) and is
 *   required only for the volume parameters;
 * - an extravascular dose needs a recorded F for the absolute parameters.
 *
 * Units, statuses and audit strings reuse the phase-50B helpers from
 * `dose-dependent-nca.ts`; there is no second unit table or formatter.
 *
 * Pure domain module: no React, no storage, no I/O.
 */
import type {
  AdministrationDoseBasis,
  AdministrationMetadata,
  AdministrationRegimen,
  AdministrationRoute,
} from './experimental-dataset'
import { unitCatalog } from '../pharmacology/unit-catalog'
import {
  auditNumber,
  baseFactor,
  computedParameter,
  exact,
  notApplicableParameter,
  ROUTE_LABEL,
  routeRule,
  TIME_REFERENCE_LABEL,
  unavailableParameter,
  type DoseDependentInputs,
  type DoseDependentParameter,
  type DoseDependentPrecondition,
  type DoseDependentUnavailableCode,
} from './dose-dependent-nca'
import type { IntervalAucReport } from './interval-auc'

export interface SteadyStateDoseNcaInput {
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly administration: AdministrationMetadata | undefined
  /** The selected-interval analysis; it owns the AUCτ and the interval λ_z. */
  readonly interval: IntervalAucReport
}

export interface SteadyStateDoseNcaReport {
  readonly status: 'available' | 'conditional' | 'unavailable'
  readonly route: AdministrationRoute | 'not-recorded'
  readonly regimen: AdministrationRegimen | 'not-recorded'
  readonly doseBasis: AdministrationDoseBasis | 'not-recorded'
  readonly administrationRecorded: boolean
  /** The interval analysis this report consumed, for the audit trail. */
  readonly interval: IntervalAucReport
  readonly intervalAligned: boolean
  readonly parameters: {
    readonly cl: DoseDependentParameter
    readonly clF: DoseDependentParameter
    readonly vz: DoseDependentParameter
    readonly vzF: DoseDependentParameter
  }
  readonly preconditions: readonly DoseDependentPrecondition[]
  readonly summary: string
  readonly warnings: readonly string[]
}

/** The formulas are stated once, exactly as they are audited in the UI. */
const FORMULAS = {
  clF: 'CL/F = Dose_τ / AUCτ',
  cl: 'CL = Dose_τ / AUCτ',
  clWithF: 'CL = F × Dose_τ / AUCτ',
  vz: 'Vz = CL / λ_z',
  vzF: 'Vz/F = (CL/F) / λ_z',
} as const

export function analyzeSteadyStateDoseNca(
  input: SteadyStateDoseNcaInput,
): SteadyStateDoseNcaReport {
  const { timeUnit, concentrationUnit, administration, interval } = input
  const preconditions: DoseDependentPrecondition[] = []
  const reportWarnings: string[] = []

  const allUnavailable = (
    code: DoseDependentUnavailableCode,
    message: string,
    inputs: DoseDependentInputs = {},
  ): SteadyStateDoseNcaReport => ({
    status: 'unavailable',
    route: administration?.route ?? 'not-recorded',
    regimen: administration?.regimen ?? 'not-recorded',
    doseBasis: administration?.doseBasis ?? 'not-recorded',
    administrationRecorded: administration !== undefined,
    interval,
    intervalAligned: interval.administrationAligned,
    parameters: {
      cl: unavailableParameter('CL', 'CL (total clearance)', 'absolute', FORMULAS.cl, code, message, inputs, []),
      clF: unavailableParameter('CL/F', 'CL/F (apparent clearance)', 'apparent', FORMULAS.clF, code, message, inputs, []),
      vz: unavailableParameter('Vz', 'Vz (terminal volume of distribution)', 'absolute', FORMULAS.vz, code, message, inputs, []),
      vzF: unavailableParameter('Vz/F', 'Vz/F (apparent terminal volume)', 'apparent', FORMULAS.vzF, code, message, inputs, []),
    },
    preconditions,
    summary: message,
    warnings: [],
  })

  // --- 1. Administration record -------------------------------------------
  if (administration === undefined) {
    const message =
      'No administration metadata is recorded, so route, dose and time origin are unknown. Steady-state dose-dependent parameters are not computed.'
    preconditions.push({ id: 'administration', status: 'not-met', message })
    return allUnavailable('ADMINISTRATION_MISSING', message)
  }
  preconditions.push({
    id: 'administration',
    status: 'met',
    message: 'An administration record is present.',
  })

  // --- 2. Route ------------------------------------------------------------
  const rule = routeRule(administration.route)
  if (rule === null) {
    const code: DoseDependentUnavailableCode =
      administration.route === 'other' ? 'ROUTE_OTHER' : 'ROUTE_UNKNOWN'
    const message =
      administration.route === 'other'
        ? 'The administration route is recorded as "other"; only IV bolus, IV infusion and extravascular routes are supported.'
        : 'The administration route is recorded as unknown; a route is never inferred from the curve.'
    preconditions.push({ id: 'route', status: 'not-met', message })
    return allUnavailable(code, message)
  }
  preconditions.push({
    id: 'route',
    status: 'met',
    message: `Route is ${ROUTE_LABEL[administration.route]}.`,
  })

  // --- 3. Declared steady state -------------------------------------------
  if (administration.regimen === 'unknown') {
    const message =
      'The dosing regimen is recorded as unknown. Steady state is never inferred, so no steady-state dose-dependent parameter is computed.'
    preconditions.push({ id: 'regimen', status: 'not-met', message })
    return allUnavailable('REGIMEN_UNKNOWN', message)
  }
  if (administration.regimen !== 'repeated-dose-steady-state') {
    const message =
      administration.regimen === 'single-dose'
        ? 'The regimen is recorded as a single dose. Single-dose dose-dependent parameters use the complete AUC(0→∞) (phase 50B); Dose_τ/AUCτ is not applied to a single-dose dataset.'
        : 'The dataset is declared as repeated dosing NOT at steady state. Its interval AUCτ is reported, but Dose_τ/AUCτ is not a clearance and no dose-dependent parameter is derived. A steady-state declaration is required; it is never inferred from the curve or from similar adjacent interval areas.'
    preconditions.push({ id: 'regimen', status: 'not-met', message })
    return allUnavailable('REGIMEN_NOT_STEADY_STATE', message)
  }
  preconditions.push({
    id: 'regimen',
    status: 'met',
    message:
      'The dataset declares repeated dosing at steady state. This is a recorded declaration, not an inference from the curve.',
  })

  // --- 4. The selected interval -------------------------------------------
  if (interval.selection === null) {
    const message =
      'No dosing interval has been selected. Steady-state parameters require an explicitly selected interval of length τ with observed boundaries.'
    preconditions.push({ id: 'interval', status: 'not-met', message })
    return allUnavailable('INTERVAL_NOT_SELECTED', message)
  }
  if (interval.status !== 'available' || interval.aucTau.status !== 'available') {
    const reason = interval.aucTau.status === 'unavailable' ? interval.aucTau.message : interval.summary
    const message = `The selected interval does not produce a usable AUCτ. ${reason}`.trim()
    preconditions.push({ id: 'interval', status: 'not-met', message })
    return allUnavailable('INTERVAL_AUC_UNAVAILABLE', message)
  }
  preconditions.push({
    id: 'interval',
    status: 'met',
    message: `AUCτ = ${exact(interval.aucTau.value)} ${interval.aucTau.unit} over source rows ${interval.aucTau.contributingSourceRows.join(', ')}.`,
  })

  if (!interval.administrationAligned) {
    const message =
      'The analyst has not confirmed that the selected interval starts at the recorded administration time of the dose it describes. τ alone does not identify which dose a window belongs to, so a dosing interval is never assumed.'
    preconditions.push({ id: 'interval-alignment', status: 'not-met', message })
    return allUnavailable('INTERVAL_NOT_ALIGNED', message)
  }
  preconditions.push({
    id: 'interval-alignment',
    status: 'met',
    message:
      'The analyst confirmed that the selected interval starts at the recorded administration time of the analysed dose (an analysis input, not stored metadata).',
  })

  // --- 5. Dose and its basis ----------------------------------------------
  const dose = administration.dose
  if (dose === undefined) {
    const message = 'No dose amount is recorded; dose-dependent parameters require an explicit dose.'
    preconditions.push({ id: 'dose', status: 'not-met', message })
    return allUnavailable('DOSE_MISSING', message)
  }
  if (!Number.isFinite(dose.value) || dose.value <= 0) {
    const message = 'The recorded dose must be a finite number greater than zero.'
    preconditions.push({ id: 'dose', status: 'not-met', message })
    return allUnavailable('DOSE_NOT_POSITIVE', message)
  }
  const doseToG = baseFactor(dose.unit, 'mass')
  if (doseToG === null) {
    const message = `The dose unit "${dose.unit}" is not a mass unit, so it cannot be divided by a concentration–time AUCτ.`
    preconditions.push({ id: 'dose-unit', status: 'not-met', message })
    return allUnavailable('DOSE_UNIT_INCOMPATIBLE', message)
  }
  const doseInput = { value: dose.value, unit: dose.unit } as const
  const doseBasis: AdministrationDoseBasis | 'not-recorded' = administration.doseBasis ?? 'not-recorded'
  if (doseBasis === 'total-regimen') {
    const message = `The recorded ${exact(dose.value)} ${dose.unit} is the TOTAL amount of the whole regimen (doseBasis = total-regimen). Dividing a cumulative amount by one interval's AUCτ would inflate clearance, so no dose-dependent parameter is computed. Record the per-administration amount instead.`
    preconditions.push({ id: 'dose-basis', status: 'not-met', message })
    return allUnavailable('DOSE_BASIS_NOT_PER_ADMINISTRATION', message, { dose: doseInput, doseBasis })
  }
  if (doseBasis !== 'per-administration') {
    const message =
      'The recorded dose has no recorded basis (per-administration vs total regimen), or the basis is explicitly unknown. One dosing interval corresponds to ONE administration, so an unstated amount is never used as Dose_τ.'
    preconditions.push({ id: 'dose-basis', status: 'not-met', message })
    return allUnavailable('DOSE_BASIS_UNKNOWN', message, { dose: doseInput, doseBasis })
  }
  preconditions.push({
    id: 'dose',
    status: 'met',
    message: `Dose_τ = ${exact(dose.value)} ${dose.unit}, recorded as the amount of each administration.`,
  })

  // --- 6. Units ------------------------------------------------------------
  const concToBase = baseFactor(concentrationUnit, 'mass-concentration')
  if (concToBase === null) {
    const molar = unitCatalogDimension(concentrationUnit) === 'molar-concentration'
    const message = molar
      ? `The concentration unit "${concentrationUnit}" is molar, while the dose is a mass. Converting between them requires a molecular weight, which is not recorded; none is assumed.`
      : `The concentration unit "${concentrationUnit}" is not a mass concentration, so a mass dose cannot be divided by the AUCτ.`
    preconditions.push({ id: 'concentration-unit', status: 'not-met', message })
    return allUnavailable('CONCENTRATION_UNIT_INCOMPATIBLE', message, { dose: doseInput })
  }
  const timeToH = baseFactor(timeUnit, 'time')
  if (timeToH === null) {
    const message = `The time unit "${timeUnit}" is not a time unit, so the interval AUCτ cannot be normalised.`
    preconditions.push({ id: 'time-unit', status: 'not-met', message })
    return allUnavailable('TIME_UNIT_INCOMPATIBLE', message, { dose: doseInput })
  }
  preconditions.push({
    id: 'units',
    status: 'met',
    message: 'Dose, concentration and time units are dimensionally compatible with a clearance.',
  })

  // --- 7. Time reference and infusion consistency -------------------------
  if (administration.timeReference !== rule.requiredTimeReference) {
    const message = `A ${ROUTE_LABEL[administration.route]} dataset requires the recorded times to be relative to ${TIME_REFERENCE_LABEL[rule.requiredTimeReference]} (timeReference = ${rule.requiredTimeReference}); recorded: ${TIME_REFERENCE_LABEL[administration.timeReference]}. The interval's position on the time axis must be anchored to administration.`
    preconditions.push({ id: 'time-reference', status: 'not-met', message })
    return allUnavailable('TIME_REFERENCE_MISMATCH', message, { dose: doseInput })
  }
  preconditions.push({
    id: 'time-reference',
    status: 'met',
    message: `Recorded times are relative to ${TIME_REFERENCE_LABEL[rule.requiredTimeReference]}.`,
  })

  if (!rule.allowsInfusion && administration.infusion !== undefined) {
    const message = `The route is ${ROUTE_LABEL[administration.route]} but infusion parameters are recorded; the administration metadata contradicts itself.`
    preconditions.push({ id: 'infusion', status: 'not-met', message })
    return allUnavailable('INFUSION_METADATA_INCONSISTENT', message, { dose: doseInput })
  }
  const infusionDetailsRecorded =
    administration.infusion?.duration !== undefined || administration.infusion?.rate !== undefined
  if (rule.allowsInfusion && infusionDetailsRecorded) {
    preconditions.push({
      id: 'infusion',
      status: 'met',
      message: 'Infusion duration or rate is recorded.',
    })
  } else if (rule.allowsInfusion) {
    const note =
      'The route is IV infusion but no infusion duration or rate is recorded; clearance uses the stated per-administration dose, which does not depend on the input rate, while the volume check cannot confirm the infusion end.'
    reportWarnings.push(note)
    preconditions.push({ id: 'infusion', status: 'met', message: note })
  } else {
    preconditions.push({
      id: 'infusion',
      status: 'not-applicable',
      message: 'Infusion details do not apply to this route.',
    })
  }

  // --- 8. λ_z from the selected interval only -----------------------------
  const lambdaZ = interval.lambdaZ !== null && interval.lambdaZ.status === 'available' ? interval.lambdaZ : null
  const lambdaZAvailable = lambdaZ !== null && Number.isFinite(lambdaZ.value) && lambdaZ.value > 0
  if (lambdaZAvailable) {
    preconditions.push({
      id: 'lambda-z',
      status: 'met',
      message: `λ_z comes from the selected interval only (${exact(lambdaZ.value)} ${lambdaZ.unit} over source rows ${interval.terminalPhase?.selectedSourceRows.join(', ') ?? ''}). The whole-dataset λ_z is never substituted.`,
    })
  } else {
    preconditions.push({
      id: 'lambda-z',
      status: 'not-met',
      message:
        'The selected interval has no usable terminal λ_z, so the volume parameters cannot be computed (clearance is unaffected).',
    })
  }

  // --- 9. Bioavailability --------------------------------------------------
  const f = administration.bioavailability
  const fRecorded = typeof f === 'number' && Number.isFinite(f) && f > 0 && f <= 1
  if (rule.absoluteByRoute) {
    preconditions.push({
      id: 'bioavailability',
      status: 'not-applicable',
      message: 'F is 1 by the IV route definition; the absolute parameters are computed directly.',
    })
  } else if (fRecorded) {
    preconditions.push({
      id: 'bioavailability',
      status: 'met',
      message: `A recorded bioavailability F = ${exact(f as number)} is used for the absolute parameters.`,
    })
  } else {
    preconditions.push({
      id: 'bioavailability',
      status: 'not-met',
      message:
        'Bioavailability F is not recorded, so absolute CL/Vz cannot be computed for an extravascular dose; only the apparent CL/F and Vz/F are reported.',
    })
  }

  // --- 10. IV infusion: is the interval's terminal phase post-infusion? ---
  // Within a dosing interval the curve rises during the infusion; a slope fitted
  // across that input phase describes the approach to steady state, not
  // elimination. Volume parameters require every terminal observation to fall
  // after the infusion end, measured from the interval start.
  let infusionTerminalConfirmed = true
  if (administration.route === 'iv-infusion') {
    const duration = administration.infusion?.duration
    const durationHours =
      duration === undefined
        ? null
        : (() => {
            const factor = baseFactor(duration.unit, 'time')
            return factor === null ? null : duration.value * factor
          })()
    const startTime = interval.selection?.startTime ?? 0
    const firstTerminalTimeHours =
      interval.terminalPhase !== null &&
      interval.terminalPhase.status === 'available' &&
      interval.terminalPhase.selectedTimes.length > 0
        ? (Math.min(...interval.terminalPhase.selectedTimes) - startTime) * timeToH
        : null
    if (durationHours === null) {
      infusionTerminalConfirmed = false
      preconditions.push({
        id: 'infusion-terminal-phase',
        status: 'not-met',
        message:
          'The infusion end time is not recorded, so it cannot be confirmed that the interval terminal phase follows the end of the infusion.',
      })
    } else if (firstTerminalTimeHours === null || firstTerminalTimeHours <= durationHours) {
      infusionTerminalConfirmed = false
      preconditions.push({
        id: 'infusion-terminal-phase',
        status: 'not-met',
        message: `The earliest terminal observation of the interval is ${exact(firstTerminalTimeHours ?? 0)} h after the interval start, which is not after the infusion end (${exact(durationHours)} h), so the fitted slope may include the infusion input phase.`,
      })
    } else {
      preconditions.push({
        id: 'infusion-terminal-phase',
        status: 'met',
        message: `All terminal regression observations of the interval occur after the infusion end (${exact(durationHours)} h from the interval start).`,
      })
    }
  }

  // --- Base-unit conversion ------------------------------------------------
  const doseInG = dose.value * doseToG
  const aucBase = interval.aucTau.status === 'available' ? interval.aucTau.value * concToBase * timeToH : Number.NaN
  if (!Number.isFinite(aucBase) || aucBase <= 0) {
    const message = 'The interval AUCτ is not a positive finite number after unit normalisation, so clearance cannot be derived from it.'
    preconditions.push({ id: 'interval-area', status: 'not-met', message })
    return allUnavailable('NUMERICAL_FAILURE', message, { dose: doseInput })
  }

  const aucUnit = interval.aucTau.status === 'available' ? interval.aucTau.unit : `${concentrationUnit}·${timeUnit}`
  const inputs: DoseDependentInputs = {
    dose: { value: dose.value, unit: dose.unit },
    doseBasis,
    auc: { value: interval.aucTau.status === 'available' ? interval.aucTau.value : Number.NaN, unit: aucUnit, name: 'AUCτ' },
    ...(interval.selection === null
      ? {}
      : {
          interval: {
            startTime: interval.selection.startTime,
            endTime: interval.selection.endTime,
            timeUnit,
          },
        }),
    ...(lambdaZAvailable && lambdaZ !== null
      ? { lambdaZ: { value: lambdaZ.value, unit: lambdaZ.unit } }
      : {}),
    ...(fRecorded && !rule.absoluteByRoute ? { bioavailability: f as number } : {}),
  }

  const unitAssumptions: readonly string[] = [
    `Unit normalisation: ${exact(dose.value)} ${dose.unit} → ${auditNumber(doseInG)} g; ${exact(interval.aucTau.status === 'available' ? interval.aucTau.value : Number.NaN)} ${aucUnit} → ${auditNumber(aucBase)} g·h/L.`,
    'Clearance is reported in L/h and volume in L after converting mass to g, mass concentration to g/L and time to h with the unit catalog.',
    'AUCτ is the OBSERVED interval area; it is not extrapolated, so the single-dose ≤20% extrapolation criterion does not apply and is not used as a condition.',
  ]

  const intervalAssumption = `The selected interval is one dosing interval τ at steady state (${exact(interval.interval?.declaredIntervalHours ?? Number.NaN)} h), anchored to the administration time of the analysed dose.`
  const steadyStateAssumption =
    'Steady state is a RECORDED declaration (regimen = repeated-dose-steady-state), not an inference from the curve shape or from similar adjacent interval areas.'

  // --- 11. CL/F ------------------------------------------------------------
  const clFValue = doseInG / aucBase // L/h
  const clFParameter = rule.absoluteByRoute
    ? notApplicableParameter(
        'CL/F',
        'CL/F (apparent clearance)',
        'apparent',
        FORMULAS.clF,
        'F is 1 by the IV route definition, so CL/F equals CL; the absolute CL is reported instead.',
        inputs,
      )
    : computedParameter({
        parameter: 'CL/F',
        label: 'CL/F (apparent clearance)',
        basis: 'apparent',
        value: clFValue,
        unit: 'L/h',
        formula: FORMULAS.clF,
        substitution: `${auditNumber(doseInG)} g ÷ ${auditNumber(aucBase)} g·h/L = ${auditNumber(clFValue)} L/h`,
        inputs,
        assumptions: [
          ...unitAssumptions,
          intervalAssumption,
          steadyStateAssumption,
          'F need not be known for CL/F: it is the apparent clearance at the recorded extravascular per-administration dose.',
        ],
        warnings: [],
        conditionalReasons: [],
      })

  // --- 12. CL --------------------------------------------------------------
  let clParameter: DoseDependentParameter
  let clValue: number | null = null
  const clAssumptions = [...unitAssumptions, intervalAssumption, steadyStateAssumption]
  if (rule.absoluteByRoute) {
    clValue = clFValue
    clParameter = computedParameter({
      parameter: 'CL',
      label: 'CL (total clearance)',
      basis: 'absolute',
      value: clValue,
      unit: 'L/h',
      formula: FORMULAS.cl,
      substitution: `${auditNumber(doseInG)} g ÷ ${auditNumber(aucBase)} g·h/L = ${auditNumber(clValue)} L/h`,
      inputs,
      assumptions: [
        ...clAssumptions,
        'Systemic bioavailability is 1 by the IV route definition; this is a property of the route, not a recorded F value.',
      ],
      warnings: [],
      conditionalReasons: [],
    })
  } else if (fRecorded) {
    clValue = (f as number) * clFValue
    clParameter = computedParameter({
      parameter: 'CL',
      label: 'CL (total clearance)',
      basis: 'absolute',
      value: clValue,
      unit: 'L/h',
      formula: FORMULAS.clWithF,
      substitution: `${auditNumber(f as number)} × ${auditNumber(doseInG)} g ÷ ${auditNumber(aucBase)} g·h/L = ${auditNumber(clValue)} L/h`,
      inputs,
      assumptions: [
        ...clAssumptions,
        `The recorded bioavailability F = ${exact(f as number)} is assumed to apply at steady state for this dataset.`,
      ],
      warnings: [],
      conditionalReasons: [],
    })
  } else {
    clParameter = unavailableParameter(
      'CL',
      'CL (total clearance)',
      'absolute',
      FORMULAS.clWithF,
      'BIOAVAILABILITY_MISSING',
      'F is not recorded, so absolute CL cannot be computed for an extravascular dose; only the apparent CL/F is reported.',
      inputs,
      clAssumptions,
    )
  }

  // --- 13. Vz/F and Vz -----------------------------------------------------
  const lambdaZBase = lambdaZAvailable && lambdaZ !== null ? lambdaZ.value / timeToH : null
  const terminalQualityReasons: string[] = []
  if (!infusionTerminalConfirmed) {
    terminalQualityReasons.push(
      'The interval sampling does not demonstrably extend beyond the end of the infusion, so the terminal slope may reflect the input phase rather than elimination; the volume is a conditional estimate.',
    )
  }
  if (
    interval.terminalPhase !== null &&
    interval.terminalPhase.status === 'available' &&
    interval.terminalPhase.regression !== null &&
    interval.terminalPhase.regression.rSquared < 0.8
  ) {
    terminalQualityReasons.push(
      `The interval's terminal log-linear regression explains less than 80% of the log-concentration variance (R² = ${exact(interval.terminalPhase.regression.rSquared)}), so λ_z and the derived volume are less well determined.`,
    )
  }
  const extravascularCaveat =
    administration.route === 'extravascular'
      ? 'For an extravascular dose the observed terminal slope may reflect absorption rather than elimination (flip-flop); the volume is a conditional terminal estimate, not a confirmed physiological volume.'
      : null
  if (extravascularCaveat !== null) terminalQualityReasons.push(extravascularCaveat)

  const lambdaAssumption =
    'λ_z is taken from the terminal log-linear regression of the SAME selected interval, never from another window of the dataset.'

  let vzFParameter: DoseDependentParameter
  if (rule.absoluteByRoute) {
    vzFParameter = notApplicableParameter(
      'Vz/F',
      'Vz/F (apparent terminal volume)',
      'apparent',
      FORMULAS.vzF,
      'F is 1 by the IV route definition, so Vz/F equals Vz; the absolute Vz is reported instead.',
      inputs,
    )
  } else if (!lambdaZAvailable || lambdaZBase === null) {
    vzFParameter = unavailableParameter(
      'Vz/F',
      'Vz/F (apparent terminal volume)',
      'apparent',
      FORMULAS.vzF,
      'LAMBDA_Z_UNAVAILABLE',
      'The selected interval has no usable terminal λ_z, so Vz/F cannot be computed; CL/F is unaffected.',
      inputs,
      unitAssumptions,
    )
  } else {
    const value = clFValue / lambdaZBase
    vzFParameter = computedParameter({
      parameter: 'Vz/F',
      label: 'Vz/F (apparent terminal volume)',
      basis: 'apparent',
      value,
      unit: 'L',
      formula: FORMULAS.vzF,
      substitution: `${auditNumber(clFValue)} L/h ÷ ${auditNumber(lambdaZBase)} h⁻¹ = ${auditNumber(value)} L`,
      inputs,
      assumptions: [
        ...unitAssumptions,
        intervalAssumption,
        steadyStateAssumption,
        lambdaAssumption,
        ...(extravascularCaveat === null
          ? []
          : ['The terminal phase is assumed to represent elimination, which is not guaranteed for an extravascular dose.']),
      ],
      warnings: [...terminalQualityReasons],
      conditionalReasons: [...terminalQualityReasons],
    })
  }

  let vzParameter: DoseDependentParameter
  if (!lambdaZAvailable || lambdaZBase === null) {
    vzParameter = unavailableParameter(
      'Vz',
      'Vz (terminal volume of distribution)',
      'absolute',
      FORMULAS.vz,
      'LAMBDA_Z_UNAVAILABLE',
      'The selected interval has no usable terminal λ_z, so Vz cannot be computed; CL is unaffected.',
      inputs,
      unitAssumptions,
    )
  } else if (rule.absoluteByRoute) {
    const value = clFValue / lambdaZBase
    vzParameter = computedParameter({
      parameter: 'Vz',
      label: 'Vz (terminal volume of distribution)',
      basis: 'absolute',
      value,
      unit: 'L',
      formula: FORMULAS.vz,
      substitution: `${auditNumber(clFValue)} L/h ÷ ${auditNumber(lambdaZBase)} h⁻¹ = ${auditNumber(value)} L`,
      inputs,
      assumptions: [...clAssumptions, lambdaAssumption],
      warnings: [...terminalQualityReasons],
      conditionalReasons: [...terminalQualityReasons],
    })
  } else if (!fRecorded || clValue === null) {
    vzParameter = unavailableParameter(
      'Vz',
      'Vz (terminal volume of distribution)',
      'absolute',
      FORMULAS.vz,
      'BIOAVAILABILITY_MISSING',
      'F is not recorded, so absolute Vz cannot be computed for an extravascular dose; only the apparent Vz/F is reported.',
      inputs,
      unitAssumptions,
    )
  } else {
    const value = clValue / lambdaZBase
    vzParameter = computedParameter({
      parameter: 'Vz',
      label: 'Vz (terminal volume of distribution)',
      basis: 'absolute',
      value,
      unit: 'L',
      formula: FORMULAS.vz,
      substitution: `${auditNumber(clValue)} L/h ÷ ${auditNumber(lambdaZBase)} h⁻¹ = ${auditNumber(value)} L`,
      inputs,
      assumptions: [
        ...clAssumptions,
        lambdaAssumption,
        ...(extravascularCaveat === null
          ? []
          : ['The terminal phase is assumed to represent elimination, which is not guaranteed for an extravascular dose.']),
      ],
      warnings: [...terminalQualityReasons],
      conditionalReasons: [...terminalQualityReasons],
    })
  }

  const parameters = { cl: clParameter, clF: clFParameter, vz: vzParameter, vzF: vzFParameter }
  const statuses = [clParameter.status, clFParameter.status, vzParameter.status, vzFParameter.status]
  const status: SteadyStateDoseNcaReport['status'] = statuses.includes('conditional')
    ? 'conditional'
    : statuses.includes('available')
      ? 'available'
      : 'unavailable'

  const summary =
    administration.route === 'extravascular'
      ? fRecorded
        ? 'Steady-state extravascular dataset with a recorded per-administration dose and F. Absolute and apparent parameters are assessed independently; terminal volumes may be conditional because absorption can limit the terminal phase.'
        : 'Steady-state extravascular dataset. Apparent parameters may be available; absolute CL and Vz require a recorded F. Each parameter has its own status.'
      : `Steady-state ${ROUTE_LABEL[administration.route]} dataset. CL and CL/F use the per-administration dose divided by the selected interval's AUCτ; terminal volumes additionally require the interval's λ_z.`

  return {
    status,
    route: administration.route,
    regimen: administration.regimen,
    doseBasis,
    administrationRecorded: true,
    interval,
    intervalAligned: interval.administrationAligned,
    parameters,
    preconditions,
    summary,
    warnings: reportWarnings,
  }
}

/**
 * Unit dimension lookup for the molar-vs-mass message. The unit catalog stays
 * the single source of unit truth; nothing is converted here.
 */
function unitCatalogDimension(unit: string): string | undefined {
  return unitCatalog.get(unit)?.dimension
}
