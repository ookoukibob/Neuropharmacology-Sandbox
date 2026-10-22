import type { SimulationScenario } from '@/engine/simulation/types'

/**
 * Test-only synthetic scenario covering a bolus, a stopped infusion and a
 * second bolus. This fixture is never imported by product code; its numbers
 * exist solely to make engine and editor regression tests deterministic.
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
