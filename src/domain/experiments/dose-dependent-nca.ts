/**
 * Dose-dependent noncompartmental analysis (phase 50B).
 *
 * Combines the recorded administration metadata (phase 50A) with the existing
 * NCA result to derive clearance and terminal volume — ONLY when the data and
 * metadata actually support them.
 *
 * Scientific contract:
 *
 *   CL/F = Dose / AUC(0→∞)              (apparent clearance)
 *   CL   = F · Dose / AUC(0→∞)          (absolute; F = 1 for an IV route)
 *   Vz/F = (CL/F) / λ_z                 (apparent terminal volume)
 *   Vz   = CL / λ_z                     (absolute)
 *
 * Non-negotiable preconditions:
 * - the dataset must be a SINGLE dose (repeated / steady-state are deferred);
 * - the route must be IV bolus, IV infusion or extravascular (never inferred);
 * - a positive mass dose must be recorded;
 * - the recorded time reference must match the route (dose-time for a bolus or
 *   extravascular dose, infusion-start for an infusion) — time zero is never
 *   assumed to be a dose time;
 * - the AUC must be a COMPLETE AUC(0→∞). A partial `AUC(first→∞)` is never
 *   substituted, even though it is numerically available;
 * - λ_z must be available for the volume parameters (clearance does not need it);
 * - an extravascular dose needs a recorded F for the absolute parameters;
 * - a molar concentration with a mass dose is rejected: converting it would
 *   require a molecular weight that is not recorded, and none is invented.
 *
 * Units are converted through the existing unit catalog's base factors
 * (mass → g, mass-concentration → g/L, time → h), so CL is reported in L/h and
 * Vz in L. No second conversion table is introduced here.
 *
 * Pure domain module: no React, no storage, no I/O.
 */
import { unitCatalog } from '../pharmacology/unit-catalog'
import type {
  AdministrationMetadata,
  AdministrationRegimen,
  AdministrationRoute,
  AdministrationTimeReference,
} from './experimental-dataset'
import type { NcaAnalysis } from './nca'

export type DoseDependentParameterId = 'CL' | 'CL/F' | 'Vz' | 'Vz/F'

/**
 * Four distinct outcomes, so the UI never collapses "cannot be computed" into
 * one generic state:
 * - `available`       — conditions met, no material caveat;
 * - `conditional`     — computed, but a recorded assumption/quality caveat applies;
 * - `unavailable`     — a structured reason explains why it cannot be computed;
 * - `not-applicable`  — the route makes the parameter meaningless (F = 1 for IV).
 */
export type DoseDependentStatus = 'available' | 'conditional' | 'unavailable' | 'not-applicable'

/** Whether the parameter is an absolute quantity or an apparent (F-scaled) one. */
export type DoseDependentBasis = 'absolute' | 'apparent'

export type DoseDependentUnavailableCode =
  | 'ADMINISTRATION_MISSING'
  | 'ROUTE_UNKNOWN'
  | 'ROUTE_OTHER'
  | 'REGIMEN_UNKNOWN'
  | 'REGIMEN_NOT_SINGLE_DOSE'
  | 'DOSE_MISSING'
  | 'DOSE_NOT_POSITIVE'
  | 'DOSE_UNIT_INCOMPATIBLE'
  | 'CONCENTRATION_UNIT_INCOMPATIBLE'
  | 'TIME_UNIT_INCOMPATIBLE'
  | 'TIME_REFERENCE_MISMATCH'
  | 'INFUSION_METADATA_INCONSISTENT'
  | 'AUC_NOT_COMPLETE'
  | 'AUC_UNAVAILABLE'
  | 'LAMBDA_Z_UNAVAILABLE'
  | 'BIOAVAILABILITY_MISSING'
  | 'NUMERICAL_FAILURE'

/** The exact inputs a parameter used, for audit. */
export interface DoseDependentInputs {
  readonly dose?: { readonly value: number; readonly unit: string }
  readonly auc?: { readonly value: number; readonly unit: string; readonly name: string }
  readonly lambdaZ?: { readonly value: number; readonly unit: string }
  readonly bioavailability?: number
}

export interface DoseDependentParameter {
  readonly parameter: DoseDependentParameterId
  readonly label: string
  readonly status: DoseDependentStatus
  readonly basis: DoseDependentBasis
  readonly value?: number
  readonly unit?: string
  /** Symbolic formula, e.g. "CL = F × Dose / AUC(0→∞)". */
  readonly formula: string
  /** Declared values substituted into the formula, plus the result. */
  readonly substitution?: string
  readonly inputs: DoseDependentInputs
  readonly assumptions: readonly string[]
  readonly warnings: readonly string[]
  readonly code?: DoseDependentUnavailableCode
  readonly message?: string
}

export interface DoseDependentPrecondition {
  readonly id: string
  readonly status: 'met' | 'not-met' | 'not-applicable'
  readonly message: string
}

export interface DoseDependentNcaReport {
  readonly status: 'available' | 'conditional' | 'unavailable'
  readonly route: AdministrationRoute | 'not-recorded'
  readonly regimen: AdministrationRegimen | 'not-recorded'
  readonly parameters: {
    readonly cl: DoseDependentParameter
    readonly clF: DoseDependentParameter
    readonly vz: DoseDependentParameter
    readonly vzF: DoseDependentParameter
  }
  readonly preconditions: readonly DoseDependentPrecondition[]
  readonly summary: string
  readonly warnings: readonly string[]
  /** True when the analysis actually consumed a recorded administration record. */
  readonly administrationRecorded: boolean
}

export interface DoseDependentNcaInput {
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly administration: AdministrationMetadata | undefined
  /** The SAME NCA analysis shown to the user; never recomputed here. */
  readonly nca: NcaAnalysis
}

const ROUTE_LABEL: Readonly<Record<AdministrationRoute, string>> = {
  'iv-bolus': 'IV bolus',
  'iv-infusion': 'IV infusion',
  extravascular: 'extravascular',
  other: 'other',
  unknown: 'unknown',
}

const TIME_REFERENCE_LABEL: Readonly<Record<AdministrationTimeReference, string>> = {
  'dose-time': 'dose-time',
  'infusion-start': 'infusion-start',
  'first-observation': 'first-observation',
  other: 'other',
  unknown: 'unknown',
}

/** Route-specific preconditions, declared once. */
interface RouteRule {
  /** The time reference that actually anchors time zero to administration. */
  readonly requiredTimeReference: AdministrationTimeReference
  /** True when the route's systemic bioavailability is 1 by definition (IV). */
  readonly absoluteByRoute: boolean
  /** True when the route permits infusion details. */
  readonly allowsInfusion: boolean
}

function routeRule(route: AdministrationRoute): RouteRule | null {
  switch (route) {
    case 'iv-bolus':
      return { requiredTimeReference: 'dose-time', absoluteByRoute: true, allowsInfusion: false }
    case 'iv-infusion':
      return { requiredTimeReference: 'infusion-start', absoluteByRoute: true, allowsInfusion: true }
    case 'extravascular':
      return { requiredTimeReference: 'dose-time', absoluteByRoute: false, allowsInfusion: false }
    case 'other':
    case 'unknown':
      return null
  }
}

/** Exact shortest round-trip rendering; never rounds a scientific value. */
const exact = (value: number): string => String(value)

function unavailableParameter(
  parameter: DoseDependentParameterId,
  label: string,
  basis: DoseDependentBasis,
  formula: string,
  code: DoseDependentUnavailableCode,
  message: string,
  inputs: DoseDependentInputs,
  assumptions: readonly string[],
): DoseDependentParameter {
  return {
    parameter,
    label,
    status: 'unavailable',
    basis,
    formula,
    inputs,
    assumptions,
    warnings: [],
    code,
    message,
  }
}

function notApplicableParameter(
  parameter: DoseDependentParameterId,
  label: string,
  basis: DoseDependentBasis,
  formula: string,
  message: string,
  inputs: DoseDependentInputs,
): DoseDependentParameter {
  return {
    parameter,
    label,
    status: 'not-applicable',
    basis,
    formula,
    inputs,
    assumptions: [],
    warnings: [],
    message,
  }
}

interface ComputedParameterInput {
  readonly parameter: DoseDependentParameterId
  readonly label: string
  readonly basis: DoseDependentBasis
  readonly value: number
  readonly unit: string
  readonly formula: string
  readonly substitution: string
  readonly inputs: DoseDependentInputs
  readonly assumptions: readonly string[]
  readonly warnings: readonly string[]
  readonly conditionalReasons: readonly string[]
}

function computedParameter(input: ComputedParameterInput): DoseDependentParameter {
  if (!Number.isFinite(input.value)) {
    return unavailableParameter(
      input.parameter,
      input.label,
      input.basis,
      input.formula,
      'NUMERICAL_FAILURE',
      'The computed value is not finite; the inputs may be outside the representable range.',
      input.inputs,
      input.assumptions,
    )
  }
  const conditional = input.conditionalReasons.length > 0
  return {
    parameter: input.parameter,
    label: input.label,
    status: conditional ? 'conditional' : 'available',
    basis: input.basis,
    value: input.value,
    unit: input.unit,
    formula: input.formula,
    substitution: input.substitution,
    inputs: input.inputs,
    assumptions: input.assumptions,
    warnings: input.warnings,
    ...(conditional ? { message: input.conditionalReasons.join(' ') } : {}),
  }
}

function baseFactor(unit: string, dimension: 'mass' | 'mass-concentration' | 'time'): number | null {
  const def = unitCatalog.get(unit)
  if (def === undefined || def.dimension !== dimension) return null
  return def.toBase
}

/**
 * Analyse dose-dependent NCA parameters from a recorded administration record
 * and an existing NCA result.
 *
 * The NCA result is consumed, never recomputed: `CL`/`Vz` reuse the same
 * `aucInf` and `lambdaZ` the analyst sees, so the two cards cannot disagree.
 */
export function analyzeDoseDependentNca(input: DoseDependentNcaInput): DoseDependentNcaReport {
  const { timeUnit, concentrationUnit, administration, nca } = input
  const preconditions: DoseDependentPrecondition[] = []
  const reportWarnings: string[] = []

  const formulas = {
    cl: 'CL = Dose / AUC(0→∞)',
    clWithF: 'CL = F × Dose / AUC(0→∞)',
    clF: 'CL/F = Dose / AUC(0→∞)',
    vz: 'Vz = CL / λ_z',
    vzF: 'Vz/F = (CL/F) / λ_z',
  } as const

  const allUnavailable = (
    code: DoseDependentUnavailableCode,
    message: string,
    inputs: DoseDependentInputs = {},
  ): DoseDependentNcaReport => {
    return {
      status: 'unavailable',
      route: administration?.route ?? 'not-recorded',
      regimen: administration?.regimen ?? 'not-recorded',
      parameters: {
        cl: unavailableParameter('CL', 'CL (total clearance)', 'absolute', formulas.cl, code, message, inputs, []),
        clF: unavailableParameter('CL/F', 'CL/F (apparent clearance)', 'apparent', formulas.clF, code, message, inputs, []),
        vz: unavailableParameter('Vz', 'Vz (terminal volume of distribution)', 'absolute', formulas.vz, code, message, inputs, []),
        vzF: unavailableParameter('Vz/F', 'Vz/F (apparent terminal volume)', 'apparent', formulas.vzF, code, message, inputs, []),
      },
      preconditions,
      summary: message,
      warnings: [],
      administrationRecorded: administration !== undefined,
    }
  }

  // --- 1. Administration record -------------------------------------------
  if (administration === undefined) {
    preconditions.push({
      id: 'administration',
      status: 'not-met',
      message: 'No administration metadata is recorded.',
    })
    return allUnavailable(
      'ADMINISTRATION_MISSING',
      'No administration metadata is recorded, so route, dose and time origin are unknown. Dose-dependent parameters are not computed.',
    )
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
        ? 'The administration route is recorded as "other"; this phase supports only IV bolus, IV infusion and extravascular routes.'
        : 'The administration route is recorded as unknown; a route is never inferred from the curve.'
    preconditions.push({ id: 'route', status: 'not-met', message })
    return allUnavailable(code, message)
  }
  preconditions.push({
    id: 'route',
    status: 'met',
    message: `Route is ${ROUTE_LABEL[administration.route]}.`,
  })

  // --- 3. Regimen ----------------------------------------------------------
  if (administration.regimen === 'unknown') {
    const message =
      'The dosing regimen is recorded as unknown; a single dose cannot be assumed, so dose-dependent parameters are not computed.'
    preconditions.push({ id: 'regimen', status: 'not-met', message })
    return allUnavailable('REGIMEN_UNKNOWN', message)
  }
  if (administration.regimen !== 'single-dose') {
    const message =
      'This phase supports single-dose datasets only. A repeated-dose or steady-state dataset needs an explicit dosing interval and the corresponding AUCτ; that is deferred to a later phase (candidate Phase 50C).'
    preconditions.push({ id: 'regimen', status: 'not-met', message })
    return allUnavailable('REGIMEN_NOT_SINGLE_DOSE', message)
  }
  preconditions.push({
    id: 'regimen',
    status: 'met',
    message: 'Regimen is a single dose.',
  })

  // --- 4. Dose -------------------------------------------------------------
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
    const message = `The dose unit "${dose.unit}" is not a mass unit, so it cannot be divided by a concentration–time AUC.`
    preconditions.push({ id: 'dose-unit', status: 'not-met', message })
    return allUnavailable('DOSE_UNIT_INCOMPATIBLE', message)
  }
  preconditions.push({
    id: 'dose',
    status: 'met',
    message: `Dose is ${exact(dose.value)} ${dose.unit}.`,
  })
  // The dose is known from here on, so later refusals still show it.
  const doseInput = { value: dose.value, unit: dose.unit } as const

  // --- 5. Units ------------------------------------------------------------
  const concToBase = baseFactor(concentrationUnit, 'mass-concentration')
  if (concToBase === null) {
    const molar = unitCatalog.get(concentrationUnit)?.dimension === 'molar-concentration'
    const message = molar
      ? `The concentration unit "${concentrationUnit}" is molar, while the dose is a mass. Converting between them requires a molecular weight, which is not recorded; none is assumed in this phase.`
      : `The concentration unit "${concentrationUnit}" is not a mass concentration, so a mass dose cannot be divided by the AUC.`
    preconditions.push({ id: 'concentration-unit', status: 'not-met', message })
    return allUnavailable('CONCENTRATION_UNIT_INCOMPATIBLE', message, { dose: doseInput })
  }
  const timeToH = baseFactor(timeUnit, 'time')
  if (timeToH === null) {
    const message = `The time unit "${timeUnit}" is not a time unit, so the AUC interval cannot be normalised.`
    preconditions.push({ id: 'time-unit', status: 'not-met', message })
    return allUnavailable('TIME_UNIT_INCOMPATIBLE', message, { dose: doseInput })
  }
  preconditions.push({
    id: 'units',
    status: 'met',
    message: 'Dose, concentration and time units are dimensionally compatible with a clearance.',
  })

  // --- 6. Time reference ---------------------------------------------------
  if (administration.timeReference !== rule.requiredTimeReference) {
    const message = `A ${ROUTE_LABEL[administration.route]} dataset requires the recorded times to be relative to ${TIME_REFERENCE_LABEL[rule.requiredTimeReference]} (timeReference = ${rule.requiredTimeReference}); recorded: ${TIME_REFERENCE_LABEL[administration.timeReference]}. Time zero is not assumed to be the dose time.`
    preconditions.push({ id: 'time-reference', status: 'not-met', message })
    return allUnavailable('TIME_REFERENCE_MISMATCH', message, { dose: doseInput })
  }
  preconditions.push({
    id: 'time-reference',
    status: 'met',
    message: `Recorded times are relative to ${TIME_REFERENCE_LABEL[rule.requiredTimeReference]}.`,
  })

  // --- 7. Infusion consistency --------------------------------------------
  if (!rule.allowsInfusion && administration.infusion !== undefined) {
    const message = `The route is ${ROUTE_LABEL[administration.route]} but infusion parameters are recorded; the administration metadata contradicts itself.`
    preconditions.push({ id: 'infusion', status: 'not-met', message })
    return allUnavailable('INFUSION_METADATA_INCONSISTENT', message, { dose: doseInput })
  }
  if (rule.allowsInfusion && administration.infusion === undefined) {
    const note =
      'The route is IV infusion but no infusion duration or rate is recorded; the clearance uses the stated total dose, which does not depend on the input rate.'
    reportWarnings.push(note)
    preconditions.push({ id: 'infusion', status: 'met', message: note })
  } else {
    preconditions.push({
      id: 'infusion',
      status: rule.allowsInfusion ? 'met' : 'not-applicable',
      message: rule.allowsInfusion
        ? 'Infusion details are recorded.'
        : 'Infusion details do not apply to this route.',
    })
  }

  // --- 8. Complete AUC(0→∞) ----------------------------------------------
  if (nca.aucInfInterval === 'first-to-infinity') {
    const message =
      'A complete AUC(0→∞) is required. This dataset only supports AUC(first→∞) because the first observation is after time zero; the partial interval is never substituted for a complete AUC.'
    preconditions.push({ id: 'auc', status: 'not-met', message })
    return allUnavailable('AUC_NOT_COMPLETE', message, { dose: doseInput })
  }
  if (nca.aucInfInterval !== 'zero-to-infinity' || nca.aucInf.status !== 'available') {
    const reason =
      nca.aucInf.status === 'unavailable' ? ` ${nca.aucInf.message}` : ''
    const message = `A complete AUC(0→∞) is not available.${reason}`.trim()
    preconditions.push({ id: 'auc', status: 'not-met', message })
    return allUnavailable('AUC_UNAVAILABLE', message, { dose: doseInput })
  }
  const aucValue = nca.aucInf.value
  if (!Number.isFinite(aucValue) || aucValue <= 0) {
    const message = 'AUC(0→∞) is not a positive finite number, so clearance cannot be derived from it.'
    preconditions.push({ id: 'auc', status: 'not-met', message })
    return allUnavailable('AUC_UNAVAILABLE', message, { dose: doseInput })
  }
  const aucName = nca.aucInf.name ?? 'AUC(0→∞)'
  const aucUnit = nca.aucInf.unit
  preconditions.push({
    id: 'auc',
    status: 'met',
    message: `A complete ${aucName} is available (${exact(aucValue)} ${aucUnit}).`,
  })

  // --- 9. Terminal rate (for Vz only) -------------------------------------
  const lambdaZ = nca.lambdaZ.status === 'available' ? nca.lambdaZ : null
  const lambdaZAvailable = lambdaZ !== null && Number.isFinite(lambdaZ.value) && lambdaZ.value > 0
  if (lambdaZAvailable) {
    preconditions.push({
      id: 'lambda-z',
      status: 'met',
      message: `λ_z is available (${exact(lambdaZ.value)} ${lambdaZ.unit}).`,
    })
  } else {
    preconditions.push({
      id: 'lambda-z',
      status: 'not-met',
      message:
        'The terminal elimination rate λ_z is not available, so the volume parameters cannot be computed (clearance is unaffected).',
    })
  }

  // --- 10. Bioavailability ------------------------------------------------
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

  // --- 10b. IV infusion: does the terminal phase follow the infusion end? --
  // While an infusion is running, the log-linear slope reflects the approach
  // to steady state, not elimination. The volume parameters require a
  // post-infusion terminal phase; if that cannot be demonstrated, they are
  // conditional rather than presented as a confirmed physiological volume.
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
    const lastTerminalTime =
      nca.terminalPhase.status === 'available' && nca.terminalPhase.selectedTimes.length > 0
        ? Math.max(...nca.terminalPhase.selectedTimes)
        : null
    if (durationHours === null) {
      infusionTerminalConfirmed = false
      preconditions.push({
        id: 'infusion-terminal-phase',
        status: 'not-met',
        message:
          'The infusion end time is not recorded, so it cannot be confirmed that the terminal phase follows the end of the infusion.',
      })
    } else if (lastTerminalTime === null || lastTerminalTime <= durationHours) {
      infusionTerminalConfirmed = false
      preconditions.push({
        id: 'infusion-terminal-phase',
        status: 'not-met',
        message: `The last terminal observation (${exact(lastTerminalTime ?? 0)} h) does not extend beyond the infusion end (${exact(durationHours)} h), so the slope may reflect the input rather than elimination.`,
      })
    } else {
      preconditions.push({
        id: 'infusion-terminal-phase',
        status: 'met',
        message: `The terminal observations extend beyond the infusion end (${exact(durationHours)} h).`,
      })
    }
  }

  // --- Conversion to the catalog's base units ------------------------------
  const doseInG = dose.value * doseToG
  const aucBase = aucValue * concToBase * timeToH // g·h/L
  const doseBaseText = `${exact(dose.value)} ${dose.unit} → ${exact(doseInG)} g`
  const aucBaseText = `${exact(aucValue)} ${aucUnit} → ${exact(aucBase)} g·h/L`
  const conversionNote = `Unit normalisation: ${doseBaseText}; ${aucBaseText}.`

  const inputs: DoseDependentInputs = {
    dose: { value: dose.value, unit: dose.unit },
    auc: { value: aucValue, unit: aucUnit, name: aucName },
    ...(lambdaZAvailable && lambdaZ !== null
      ? { lambdaZ: { value: lambdaZ.value, unit: lambdaZ.unit } }
      : {}),
    // Only a non-IV F is an input; the IV route's F = 1 is a route property,
    // not a recorded value, so it is never presented as one.
    ...(fRecorded && !rule.absoluteByRoute ? { bioavailability: f as number } : {}),
  }

  const unitAssumptions: readonly string[] = [
    conversionNote,
    'Clearance is reported in L/h and volume in L after converting mass to g, mass concentration to g/L and time to h with the unit catalog.',
  ]

  // --- 11. CL/F (always defined when the base preconditions are met) ------
  const clFValue = doseInG / aucBase // L/h
  const extrapolatedFraction =
    nca.extrapolatedFraction.status === 'available' ? nca.extrapolatedFraction.value : undefined
  const aucQualityReasons: string[] = []
  if (extrapolatedFraction !== undefined && extrapolatedFraction > 0.2) {
    aucQualityReasons.push(
      `More than 20% of AUC(0→∞) is extrapolated (${exact(extrapolatedFraction)}), so the exposure estimate carries extra uncertainty.`,
    )
  }

  const clFParameter =
    rule.absoluteByRoute
      ? notApplicableParameter(
          'CL/F',
          'CL/F (apparent clearance)',
          'apparent',
          formulas.clF,
          'F is 1 by the IV route definition, so CL/F equals CL; the absolute CL is reported instead.',
          inputs,
        )
      : computedParameter({
          parameter: 'CL/F',
          label: 'CL/F (apparent clearance)',
          basis: 'apparent',
          value: clFValue,
          unit: 'L/h',
          formula: formulas.clF,
          substitution: `${exact(dose.value)} ${dose.unit} ÷ ${exact(aucValue)} ${aucUnit} = ${exact(clFValue)} L/h`,
          inputs,
          assumptions: [
            ...unitAssumptions,
            'F need not be known for CL/F: it is the apparent clearance at the recorded extravascular dose.',
          ],
          warnings: [...aucQualityReasons],
          conditionalReasons: [...aucQualityReasons],
        })

  // --- 12. CL (absolute) ---------------------------------------------------
  let clParameter: DoseDependentParameter
  let clValue: number | null = null
  if (rule.absoluteByRoute) {
    clValue = clFValue
    clParameter = computedParameter({
      parameter: 'CL',
      label: 'CL (total clearance)',
      basis: 'absolute',
      value: clValue,
      unit: 'L/h',
      formula: formulas.cl,
      substitution: `${exact(dose.value)} ${dose.unit} ÷ ${exact(aucValue)} ${aucUnit} = ${exact(clValue)} L/h`,
      inputs,
      assumptions: [
        ...unitAssumptions,
        'Systemic bioavailability is 1 by the IV route definition; this is a property of the route, not a recorded F value.',
      ],
      warnings: [...aucQualityReasons],
      conditionalReasons: [...aucQualityReasons],
    })
  } else if (fRecorded) {
    clValue = (f as number) * clFValue
    clParameter = computedParameter({
      parameter: 'CL',
      label: 'CL (total clearance)',
      basis: 'absolute',
      value: clValue,
      unit: 'L/h',
      formula: formulas.clWithF,
      substitution: `${exact(f as number)} × ${exact(dose.value)} ${dose.unit} ÷ ${exact(aucValue)} ${aucUnit} = ${exact(clValue)} L/h`,
      inputs,
      assumptions: [
        ...unitAssumptions,
        `The recorded bioavailability F = ${exact(f as number)} is assumed to apply to this dose and dataset.`,
      ],
      warnings: [...aucQualityReasons],
      conditionalReasons: [...aucQualityReasons],
    })
  } else {
    clParameter = unavailableParameter(
      'CL',
      'CL (total clearance)',
      'absolute',
      formulas.clWithF,
      'BIOAVAILABILITY_MISSING',
      'F is not recorded, so absolute CL cannot be computed for an extravascular dose; only the apparent CL/F is reported.',
      inputs,
      unitAssumptions,
    )
  }

  // --- 13. Vz/F and Vz -----------------------------------------------------
  const lambdaZBase = lambdaZAvailable && lambdaZ !== null ? lambdaZ.value / timeToH : null
  const terminalQualityReasons: string[] = [...aucQualityReasons]
  if (!infusionTerminalConfirmed) {
    terminalQualityReasons.push(
      'The sampling does not demonstrably extend beyond the end of the infusion, so the terminal slope may reflect the infusion input rather than elimination; the volume is a conditional estimate.',
    )
  }
  if (
    nca.terminalPhase.status === 'available' &&
    nca.terminalPhase.regression !== null &&
    nca.terminalPhase.regression.rSquared < 0.8
  ) {
    terminalQualityReasons.push(
      `The terminal log-linear regression explains less than 80% of the log-concentration variance (R² = ${exact(nca.terminalPhase.regression.rSquared)}), so λ_z and the derived volume are less well determined.`,
    )
  }
  const extravascularCaveat =
    administration.route === 'extravascular'
      ? 'For an extravascular dose the observed terminal slope may reflect absorption rather than elimination (flip-flop); the volume is a conditional terminal estimate, not a confirmed physiological volume.'
      : null
  if (extravascularCaveat !== null) terminalQualityReasons.push(extravascularCaveat)

  let vzFParameter: DoseDependentParameter
  if (rule.absoluteByRoute) {
    vzFParameter = notApplicableParameter(
      'Vz/F',
      'Vz/F (apparent terminal volume)',
      'apparent',
      formulas.vzF,
      'F is 1 by the IV route definition, so Vz/F equals Vz; the absolute Vz is reported instead.',
      inputs,
    )
  } else if (!lambdaZAvailable || lambdaZBase === null) {
    vzFParameter = unavailableParameter(
      'Vz/F',
      'Vz/F (apparent terminal volume)',
      'apparent',
      formulas.vzF,
      'LAMBDA_Z_UNAVAILABLE',
      'The terminal elimination rate λ_z is not available, so Vz/F cannot be computed; CL/F is unaffected.',
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
      formula: formulas.vzF,
      substitution: `${exact(clFValue)} L/h ÷ ${exact(lambdaZ.value)} ${lambdaZ.unit} = ${exact(value)} L`,
      inputs,
      assumptions: [
        ...unitAssumptions,
        'λ_z is taken from the same terminal log-linear regression shown in the NCA table.',
        ...(extravascularCaveat === null
          ? []
          : ['The terminal phase is assumed to represent elimination, which is not guaranteed for an extravascular dose.']),
      ],
      warnings: [...terminalQualityReasons],
      conditionalReasons: [...terminalQualityReasons],
    })
  }

  let vzParameter: DoseDependentParameter
  if (rule.absoluteByRoute) {
    if (!lambdaZAvailable || lambdaZBase === null) {
      vzParameter = unavailableParameter(
        'Vz',
        'Vz (terminal volume of distribution)',
        'absolute',
        formulas.vz,
        'LAMBDA_Z_UNAVAILABLE',
        'The terminal elimination rate λ_z is not available, so Vz cannot be computed; CL is unaffected.',
        inputs,
        unitAssumptions,
      )
    } else {
      const value = clFValue / lambdaZBase
      vzParameter = computedParameter({
        parameter: 'Vz',
        label: 'Vz (terminal volume of distribution)',
        basis: 'absolute',
        value,
        unit: 'L',
        formula: formulas.vz,
        substitution: `${exact(clFValue)} L/h ÷ ${exact(lambdaZ.value)} ${lambdaZ.unit} = ${exact(value)} L`,
        inputs,
        assumptions: [
          ...unitAssumptions,
          'λ_z is taken from the same terminal log-linear regression shown in the NCA table.',
        ],
        warnings: [...terminalQualityReasons],
        conditionalReasons: [...terminalQualityReasons],
      })
    }
  } else if (!fRecorded || clValue === null) {
    vzParameter = unavailableParameter(
      'Vz',
      'Vz (terminal volume of distribution)',
      'absolute',
      formulas.vz,
      'BIOAVAILABILITY_MISSING',
      'F is not recorded, so absolute Vz cannot be computed for an extravascular dose; only the apparent Vz/F is reported.',
      inputs,
      unitAssumptions,
    )
  } else if (!lambdaZAvailable || lambdaZBase === null) {
    vzParameter = unavailableParameter(
      'Vz',
      'Vz (terminal volume of distribution)',
      'absolute',
      formulas.vz,
      'LAMBDA_Z_UNAVAILABLE',
      'The terminal elimination rate λ_z is not available, so Vz cannot be computed; CL is unaffected.',
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
      formula: formulas.vz,
      substitution: `${exact(clValue)} L/h ÷ ${exact(lambdaZ.value)} ${lambdaZ.unit} = ${exact(value)} L`,
      inputs,
      assumptions: [
        ...unitAssumptions,
        `The recorded bioavailability F = ${exact(f as number)} is assumed to apply to this dose and dataset.`,
        'λ_z is taken from the same terminal log-linear regression shown in the NCA table.',
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
  const status: DoseDependentNcaReport['status'] = statuses.includes('conditional')
    ? 'conditional'
    : statuses.includes('available')
      ? 'available'
      : 'unavailable'

  const summary =
    administration.route === 'extravascular'
      ? fRecorded
        ? 'Single-dose extravascular dataset with a recorded F: absolute CL/Vz and apparent CL/F/Vz/F are reported; the terminal volume remains conditional because absorption may limit the terminal phase.'
        : 'Single-dose extravascular dataset without a recorded F: only the apparent CL/F and Vz/F are reported.'
      : `Single-dose ${ROUTE_LABEL[administration.route]} dataset: CL and Vz are derived from the recorded dose and the complete AUC(0→∞).`

  return {
    status,
    route: administration.route,
    regimen: administration.regimen,
    parameters,
    preconditions,
    summary,
    warnings: reportWarnings,
    administrationRecorded: true,
  }
}
