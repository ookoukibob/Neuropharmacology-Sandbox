import type { SimulationScenario } from '@/engine/simulation/types'

/**
 * The phase-42 demonstration scenario: one explicit, deterministic synthetic
 * case that exercises a bolus, an infusion with a stop, and a second bolus.
 *
 * EVERY number below is a SYNTHETIC TEST PARAMETER. They are not real compound
 * parameters, not clinical estimates, not recommendations and not evidence of
 * clinical validity. Nothing here is loaded from a database or the network,
 * and no value is hidden in a default: moments, units, output grid, initial
 * state and solver settings are all spelled out.
 */
export const DEMO_SCENARIO: SimulationScenario = {
  startTime: 0,
  endTime: 24,
  // 0.25 h grid, generated explicitly (start and end included).
  outputTimes: Array.from({ length: 97 }, (_, index) => index * 0.25),
  initialState: { centralAmount: 0, peripheralAmount: 0 },
  parameters: {
    centralVolume: { value: 10, unit: 'L' },
    peripheralVolume: { value: 20, unit: 'L' },
    clearance: { value: 2, unit: 'L/h' },
    intercompartmentalClearance: { value: 3, unit: 'L/h' },
  },
  events: [
    { type: 'iv-bolus', eventId: 'demo-bolus-1', time: 0, amount: { value: 100, unit: 'mg' } },
    {
      type: 'infusion-start',
      eventId: 'demo-infusion-start-1',
      infusionId: 'demo-infusion-1',
      time: 2,
      rate: { value: 10, unit: 'mg/h' },
    },
    { type: 'infusion-stop', eventId: 'demo-infusion-stop-1', infusionId: 'demo-infusion-1', time: 6 },
    { type: 'iv-bolus', eventId: 'demo-bolus-2', time: 8, amount: { value: 30, unit: 'mg' } },
  ],
  solver: {
    absoluteTolerance: 1e-10,
    relativeTolerance: 1e-10,
    initialStep: 0.01,
    minStep: 1e-12,
    maxStep: 0.25,
    maxSteps: 200000,
  },
}

/** Human-readable scenario rows shown before (and after) a run. */
export interface DemoScenarioRow {
  readonly group: 'Parameters' | 'Initial state' | 'Horizon' | 'Dosing events' | 'Solver'
  readonly label: string
  readonly value: string
}

export const DEMO_SCENARIO_ROWS: readonly DemoScenarioRow[] = [
  { group: 'Parameters', label: 'V_c — central volume', value: '10 L' },
  { group: 'Parameters', label: 'V_p — peripheral volume', value: '20 L' },
  { group: 'Parameters', label: 'CL — systemic clearance', value: '2 L/h' },
  { group: 'Parameters', label: 'Q — intercompartmental clearance', value: '3 L/h' },
  { group: 'Initial state', label: 'A_c(0) — central amount', value: '0 mg' },
  { group: 'Initial state', label: 'A_p(0) — peripheral amount', value: '0 mg' },
  { group: 'Horizon', label: 'Time horizon', value: '0–24 h' },
  { group: 'Horizon', label: 'Output interval', value: '0.25 h (97 requested times)' },
  { group: 'Dosing events', label: 'IV bolus', value: '100 mg at t = 0 h' },
  { group: 'Dosing events', label: 'IV infusion', value: '10 mg/h from t = 2 h to t = 6 h' },
  { group: 'Dosing events', label: 'IV bolus', value: '30 mg at t = 8 h' },
  { group: 'Solver', label: 'Method', value: 'Adaptive Dormand–Prince 5(4)' },
  { group: 'Solver', label: 'Tolerances', value: 'absolute 1e-10, relative 1e-10' },
  { group: 'Solver', label: 'Step bounds', value: 'initial 0.01 h, min 1e-12 h, max 0.25 h' },
  { group: 'Solver', label: 'Step budget', value: '200 000 attempts' },
]
