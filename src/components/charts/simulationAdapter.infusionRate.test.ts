import { describe, expect, it } from 'vitest'
import { simulate } from '@/engine/simulation/simulate'
import type { SimulationResult, SimulationScenario } from '@/engine/simulation/types'
import {
  infusionRateChart,
  infusionRateHoverTexts,
  infusionRateTraceToPlotly,
} from './simulationAdapter'

/**
 * Infusion-rate chart (phase 43): every plotted value must come from
 * `result.infusionRates` — the engine's own pre/post-event rate snapshots.
 * Expected values below are derived from the scenario by hand, never from the
 * adapter.
 */

const SOLVER = {
  absoluteTolerance: 1e-10,
  relativeTolerance: 1e-10,
  initialStep: 0.01,
  minStep: 1e-12,
  maxStep: 0.25,
  maxSteps: 200000,
}

const scenario = (events: SimulationScenario['events'], endTime = 12): SimulationScenario => ({
  startTime: 0,
  endTime,
  outputTimes: Array.from({ length: endTime + 1 }, (_, index) => index),
  initialState: { centralAmount: 0, peripheralAmount: 0 },
  parameters: {
    centralVolume: { value: 10, unit: 'L' },
    peripheralVolume: { value: 20, unit: 'L' },
    clearance: { value: 2, unit: 'L/h' },
    intercompartmentalClearance: { value: 1, unit: 'L/h' },
  },
  events,
  solver: SOLVER,
})

const result = (events: SimulationScenario['events'], endTime = 12): SimulationResult => {
  const report = simulate(scenario(events, endTime))
  if (!report.ok) throw new Error(JSON.stringify(report.errors))
  return report.result
}

describe('infusionRateChart', () => {
  it('copies rates and times from the engine with h and mg/h units', () => {
    const r = result([
      { type: 'infusion-start', eventId: 's1', infusionId: 'I1', time: 2, rate: { value: 10, unit: 'mg/h' } },
      { type: 'infusion-stop', eventId: 't1', infusionId: 'I1', time: 6 },
    ])
    const chart = infusionRateChart(r)
    expect(chart).not.toBeNull()
    if (chart === null) return
    expect(chart.xUnit).toBe('h')
    expect(chart.yUnit).toBe('mg/h')
    expect(chart.id).toBe('infusion-rate')
    const trace = chart.traces[0]
    expect(trace).toBeDefined()
    if (trace === undefined) return
    expect(trace.x).toEqual(r.infusionRates.map((point) => point.time))
    expect(trace.y).toEqual(r.infusionRates.map((point) => point.totalRate))
    // Hand check: off before 2 h, 10 mg/h between 2 and 6 h, off afterwards.
    const at = (t: number, side: 'pre-event' | 'post-event'): number => {
      const index = trace.x.findIndex((x, i) => x === t && (r.infusionRates[i]?.side ?? '') === side)
      return trace.y[index] ?? Number.NaN
    }
    expect(at(2, 'pre-event')).toBe(0)
    expect(at(2, 'post-event')).toBe(10)
    expect(at(6, 'pre-event')).toBe(10)
    expect(at(6, 'post-event')).toBe(0)
  })

  it('preserves the pre/post change at one identical timestamp', () => {
    const r = result([
      { type: 'infusion-start', eventId: 's1', infusionId: 'I1', time: 3, rate: { value: 4, unit: 'mg/h' } },
      { type: 'infusion-stop', eventId: 't1', infusionId: 'I1', time: 5 },
    ])
    const chart = infusionRateChart(r)
    const trace = chart?.traces[0]
    expect(trace).toBeDefined()
    if (trace === undefined) return
    const indices = trace.x.flatMap((x, i) => (x === 3 ? [i] : []))
    expect(indices).toHaveLength(2)
    const [pre, post] = indices as [number, number]
    expect(trace.y[pre]).toBe(0)
    expect(trace.y[post]).toBe(4)
    expect(r.infusionRates[pre]?.side).toBe('pre-event')
    expect(r.infusionRates[post]?.side).toBe('post-event')
  })

  it('uses the engine-reported summed rate for overlapping infusions', () => {
    const r = result([
      { type: 'infusion-start', eventId: 's1', infusionId: 'A', time: 1, rate: { value: 2, unit: 'mg/h' } },
      { type: 'infusion-start', eventId: 's2', infusionId: 'B', time: 3, rate: { value: 3, unit: 'mg/h' } },
      { type: 'infusion-stop', eventId: 't1', infusionId: 'A', time: 5 },
      { type: 'infusion-stop', eventId: 't2', infusionId: 'B', time: 7 },
    ])
    const trace = infusionRateChart(r)?.traces[0]
    expect(trace).toBeDefined()
    if (trace === undefined) return
    // 2 mg/h alone, then 5 mg/h while both run, then 3 mg/h.
    expect(Math.max(...trace.y)).toBe(5)
    const at5 = r.infusionRates.find((point) => point.time === 5 && point.side === 'post-event')
    expect(at5?.totalRate).toBe(3)
    expect(at5?.activeInfusionIds).toEqual(['B'])
  })

  it('keeps active infusion ids available for inspection', () => {
    const r = result([
      { type: 'infusion-start', eventId: 's1', infusionId: 'A', time: 1, rate: { value: 1, unit: 'mg/h' } },
      { type: 'infusion-stop', eventId: 't1', infusionId: 'A', time: 2 },
    ])
    const hover = infusionRateHoverTexts(r)
    expect(hover[0]).toContain('active: none')
    expect(hover.join(' ')).toContain('active: A')
    expect(hover.every((text) => text.includes('mg/h'))).toBe(true)
  })

  it('does not present a stop as an administered amount', () => {
    const r = result([
      { type: 'infusion-start', eventId: 's1', infusionId: 'A', time: 1, rate: { value: 1, unit: 'mg/h' } },
      { type: 'infusion-stop', eventId: 't1', infusionId: 'A', time: 2 },
    ])
    // The rate series only ever carries rates (mg/h); no dose series exists.
    const chart = infusionRateChart(r)
    expect(chart?.yUnit).toBe('mg/h')
    expect(chart?.traces).toHaveLength(1)
  })

  it('returns null when the scenario has no infusion at all', () => {
    const r = result([{ type: 'iv-bolus', eventId: 'd1', time: 1, amount: { value: 5, unit: 'mg' } }])
    expect(infusionRateChart(r)).toBeNull()
  })

  it('never fabricates a zero-rate infusion for a bolus-only result', () => {
    const r = result([])
    expect(infusionRateChart(r)).toBeNull()
  })

  it('copies arrays so a Plotly mutation cannot alter the report', () => {
    const r = result([
      { type: 'infusion-start', eventId: 's1', infusionId: 'A', time: 1, rate: { value: 1, unit: 'mg/h' } },
      { type: 'infusion-stop', eventId: 't1', infusionId: 'A', time: 2 },
    ])
    const trace = infusionRateChart(r)?.traces[0]
    expect(trace).toBeDefined()
    if (trace === undefined) return
    const plotly = infusionRateTraceToPlotly(trace, infusionRateHoverTexts(r))
    expect(plotly.x).not.toBe(trace.x)
    expect(plotly.y).not.toBe(trace.y)
    expect(Object.values(plotly)).not.toContain(undefined)
  })
})
