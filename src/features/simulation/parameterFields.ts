/**
 * Single source of truth for the simulation editor's scientific parameters.
 *
 * The identifier a control and a validation error share is `id`; the strings a
 * human reads are `symbol` (notation source, rendered by <ScientificText>) and
 * `label` (prose only, never containing notation). Splitting them is what stops
 * the defect class this module exists for: a form field and its error summary
 * used to carry two hand-written copies of "Central volume V_c", one rendered
 * through the notation renderer and one printed raw.
 *
 * Rules for maintainers:
 *  - `label` must never contain an underscore symbol or a caret exponent; the
 *    notation belongs in `symbol` and only there.
 *  - `id` is machine-readable and stable: validation errors, `data-field-path`
 *    and focus management all key off it. Do not rename one without the others.
 */
export type SimulationFieldId =
  | 'centralVolume'
  | 'peripheralVolume'
  | 'clearance'
  | 'intercompartmentalClearance'
  | 'initialCentralAmount'
  | 'initialPeripheralAmount'
  | 'startTime'
  | 'endTime'
  | 'outputInterval'
  | 'solver.absoluteTolerance'
  | 'solver.relativeTolerance'
  | 'solver.initialStep'
  | 'solver.minStep'
  | 'solver.maxStep'
  | 'solver.maxSteps'
  | 'effectSite.unboundFraction'
  | 'effectSite.ke0'
  | 'effectSite.kd'
  | 'effectSite.molecularWeight'
  | 'effectSite.molecularWeightProvenance'

export interface SimulationFieldDefinition {
  /** Stable machine identifier: error `field`, `data-field-path`, focus target. */
  readonly id: SimulationFieldId
  /** Prose name shown after the symbol. Never contains notation. */
  readonly label: string
  /** Notation source (`V_c`, `A_c(0)`), rendered as real sub/sup elements. */
  readonly symbol?: string
}

export const SIMULATION_FIELDS: Readonly<Record<SimulationFieldId, SimulationFieldDefinition>> = {
  centralVolume: { id: 'centralVolume', symbol: 'V_c', label: 'Central volume' },
  peripheralVolume: { id: 'peripheralVolume', symbol: 'V_p', label: 'Peripheral volume' },
  clearance: { id: 'clearance', symbol: 'CL', label: 'Systemic clearance' },
  intercompartmentalClearance: {
    id: 'intercompartmentalClearance',
    symbol: 'Q',
    label: 'Intercompartmental clearance',
  },
  initialCentralAmount: {
    id: 'initialCentralAmount',
    symbol: 'A_c(0)',
    label: 'Initial central amount (mg — fixed canonical unit)',
  },
  initialPeripheralAmount: {
    id: 'initialPeripheralAmount',
    symbol: 'A_p(0)',
    label: 'Initial peripheral amount (mg — fixed canonical unit)',
  },
  startTime: { id: 'startTime', label: 'Start time (h)' },
  endTime: { id: 'endTime', label: 'End time (h)' },
  outputInterval: { id: 'outputInterval', label: 'Output interval (h)' },
  'solver.absoluteTolerance': { id: 'solver.absoluteTolerance', label: 'Absolute tolerance' },
  'solver.relativeTolerance': { id: 'solver.relativeTolerance', label: 'Relative tolerance' },
  'solver.initialStep': { id: 'solver.initialStep', label: 'Initial step (h)' },
  'solver.minStep': { id: 'solver.minStep', label: 'Minimum step (h)' },
  'solver.maxStep': { id: 'solver.maxStep', label: 'Maximum step (h)' },
  'solver.maxSteps': { id: 'solver.maxSteps', label: 'Maximum step attempts' },
  'effectSite.unboundFraction': {
    id: 'effectSite.unboundFraction',
    symbol: 'f_u',
    label: 'Unbound fraction',
  },
  'effectSite.ke0': { id: 'effectSite.ke0', symbol: 'k_e0', label: 'Equilibration rate' },
  'effectSite.kd': {
    id: 'effectSite.kd',
    symbol: 'K_d',
    label: 'Equilibrium dissociation constant',
  },
  'effectSite.molecularWeight': { id: 'effectSite.molecularWeight', label: 'Molecular weight' },
  'effectSite.molecularWeightProvenance': {
    id: 'effectSite.molecularWeightProvenance',
    label: 'Molecular-weight provenance',
  },
}

/** Look up one definition by its typed identifier. */
export function simulationField(id: SimulationFieldId): SimulationFieldDefinition {
  return SIMULATION_FIELDS[id]
}

/**
 * Engine parameter symbols (`ValidatedParameter.symbol`) mapped onto the
 * shared definitions, so the results table shows the same notation as the
 * editor instead of the engine's own display string.
 */
const ENGINE_SYMBOL_FIELDS: Readonly<Record<string, SimulationFieldId>> = {
  Vc: 'centralVolume',
  Vp: 'peripheralVolume',
  CL: 'clearance',
  Q: 'intercompartmentalClearance',
}

export function simulationFieldForEngineSymbol(
  symbol: string,
): SimulationFieldDefinition | undefined {
  const id = ENGINE_SYMBOL_FIELDS[symbol]
  return id === undefined ? undefined : SIMULATION_FIELDS[id]
}

/**
 * A validation error identifies a field by path; the presentation layer turns
 * that path into readable text here, so validation code never builds labels.
 *
 * Dosing rows are dynamic (`events.<key>.stopTime`), so they get a generated
 * prose subject. Those subjects contain no notation, so they need no renderer.
 */
export interface FieldSubject {
  readonly definition?: SimulationFieldDefinition
  readonly label: string
  readonly symbol?: string
}

const EVENT_PARTS: Readonly<Record<string, string>> = {
  time: 'time',
  'amount.value': 'amount',
  startTime: 'start time',
  stopTime: 'stop time',
  'rate.value': 'rate',
}

export function fieldSubject(fieldPath: string): FieldSubject {
  const definition = (SIMULATION_FIELDS as Record<string, SimulationFieldDefinition>)[fieldPath]
  if (definition !== undefined) {
    return {
      definition,
      label: definition.label,
      ...(definition.symbol === undefined ? {} : { symbol: definition.symbol }),
    }
  }

  const event = /^events\.(\d+)\.(.+)$/.exec(fieldPath)
  if (event !== null) {
    const [, row, part] = event
    const prose = part === undefined ? undefined : EVENT_PARTS[part]
    return { label: prose === undefined ? `Dosing row ${row}` : `Dosing row ${row}: ${prose}` }
  }

  // Unknown paths stay visible rather than silently disappearing from the
  // summary; the raw path is the only honest description available.
  return { label: fieldPath }
}
