import { describe, expect, it } from 'vitest'
import { simulate } from '@/engine/simulation/simulate'
import type { SimulationResult, SimulationScenario } from '@/engine/simulation/types'
import {
  amountChart,
  buildSimulationCharts,
  concentrationChart,
  describeSimulationEvent,
  discontinuityIndices,
  formatNumber,
  simulationChartFailure,
  simulationChartLayout,
  simulationEventMarkers,
  simulationEventShapes,
  simulationHoverTexts,
  simulationTraceToPlotly,
  type SimulationTrace,
} from './simulationAdapter'

/**
 * Adapter tests. Every expectation is derived from the engine contract:
 * the adapter must copy `SimulationSample` values verbatim, in emission
 * order, and must never compute, smooth or reorder anything.
 */

const SOLVER = {
  absoluteTolerance: 1e-10,
  relativeTolerance: 1e-10,
  initialStep: 0.01,
  minStep: 1e-12,
  maxStep: 0.25,
  maxSteps: 200000,
}

/** Q = 0 keeps the peripheral compartment empty and the arithmetic obvious. */
const scenario = (overrides: Partial<SimulationScenario> = {}): SimulationScenario => ({
  startTime: 0,
  endTime: 12,
  outputTimes: [0, 1, 2, 3, 4, 6, 8, 12],
  initialState: { centralAmount: 0, peripheralAmount: 0 },
  parameters: {
    centralVolume: { value: 10, unit: 'L' },
    peripheralVolume: { value: 20, unit: 'L' },
    clearance: { value: 2, unit: 'L/h' },
    intercompartmentalClearance: { value: 0, unit: 'L/h' },
  },
  events: [],
  solver: SOLVER,
  ...overrides,
})

const run = (overrides: Partial<SimulationScenario> = {}): SimulationResult => {
  const report = simulate(scenario(overrides))
  if (!report.ok) throw new Error(JSON.stringify(report.errors))
  return report.result
}

const traceById = (traces: readonly SimulationTrace[], id: string): SimulationTrace => {
  const trace = traces.find((t) => t.id === id)
  if (trace === undefined) throw new Error(`missing trace ${id}`)
  return trace
}

describe('buildSimulationCharts — failure handling', () => {
  it('refuses a missing result', () => {
    expect(buildSimulationCharts(null)).toEqual({
      ok: false,
      reason: 'No simulation result to display.',
    })
    expect(buildSimulationCharts(undefined).ok).toBe(false)
  })

  it('refuses a result with no samples', () => {
    const result = { ...run(), samples: [] }
    const charts = buildSimulationCharts(result)
    expect(charts.ok).toBe(false)
    if (!charts.ok) expect(charts.reason).toContain('no samples')
  })

  it('refuses a result containing a non-finite sample value', () => {
    const base = run()
    const broken: SimulationResult = {
      ...base,
      samples: base.samples.map((s, i) => (i === 2 ? { ...s, centralConcentration: Number.NaN } : s)),
    }
    const charts = buildSimulationCharts(broken)
    expect(charts.ok).toBe(false)
    if (!charts.ok) expect(charts.reason).toContain('centralConcentration')
  })

  it('refuses a result whose mass balance failed', () => {
    const base = run()
    const charts = buildSimulationCharts({ ...base, massBalance: { ...base.massBalance, ok: false } })
    expect(charts.ok).toBe(false)
    if (!charts.ok) expect(charts.reason).toContain('mass-balance')
  })

  it('simulationChartFailure returns null for a healthy result', () => {
    expect(simulationChartFailure(run())).toBeNull()
  })
})

describe('concentration chart', () => {
  it('copies the engine concentration values verbatim, in emission order', () => {
    const result = run({ events: [] })
    const chart = concentrationChart(result)
    const central = traceById(chart.traces, 'simulation.concentration.central')
    const peripheral = traceById(chart.traces, 'simulation.concentration.peripheral')

    expect(central.x).toEqual(result.samples.map((s) => s.time))
    expect(central.y).toEqual(result.samples.map((s) => s.centralConcentration))
    expect(peripheral.y).toEqual(result.samples.map((s) => s.peripheralConcentration))
    // Q = 0: nothing ever reaches the periphery, and the series is still a
    // real series of zeros rather than being dropped.
    expect(peripheral.y.every((v) => v === 0)).toBe(true)
    expect(peripheral.y).toHaveLength(result.samples.length)
  })

  it('declares the concentration unit, the time unit and linear axes', () => {
    const chart = concentrationChart(run())
    expect(chart).toMatchObject({
      id: 'concentration',
      xLabel: 'Time',
      xUnit: 'h',
      yLabel: 'Concentration',
      yUnit: 'mg/L',
      xType: 'linear',
      yType: 'linear',
    })
    const layout = simulationChartLayout(chart) as {
      xaxis: { title: string; type: string }
      yaxis: { title: string; type: string }
    }
    expect(layout.xaxis.title).toBe('Time (h)')
    expect(layout.yaxis.title).toBe('Concentration (mg/L)')
    expect([layout.xaxis.type, layout.yaxis.type]).toEqual(['linear', 'linear'])
  })

  it('starts from a 100 mg bolus: C(0) = D/V_c after the event, 0 before it', () => {
    const result = run({ events: [{ type: 'iv-bolus', eventId: 'd1', time: 0, amount: { value: 100, unit: 'mg' } }] })
    const central = traceById(concentrationChart(result).traces, 'simulation.concentration.central')
    // pre-event / post-event at t = 0, both preserved.
    expect(central.x.slice(0, 2)).toEqual([0, 0])
    expect(central.y.slice(0, 2)).toEqual([0, 10])
    // 100 mg / 10 L = 10 mg/L; 1 h later with CL = 2 L/h the amount 100·e^(-0.2) ≈ 81.87 mg → 8.19 mg/L.
    expect(central.y[2]).toBeCloseTo(10 * Math.exp(-0.2 / 1) * Math.exp(-0), 0)
    expect(central.y[2]).toBeCloseTo(8.1873075308, 6)
  })
})

describe('amount chart', () => {
  it('puts the compartment amounts on a mg axis, separate from concentrations', () => {
    const result = run({ events: [{ type: 'iv-bolus', eventId: 'd1', time: 2, amount: { value: 50, unit: 'mg' } }] })
    const chart = amountChart(result)
    expect(chart).toMatchObject({ id: 'amount', yLabel: 'Amount', yUnit: 'mg' })
    const central = traceById(chart.traces, 'simulation.amount.central')
    expect(central.y).toEqual(result.samples.map((s) => s.centralAmount))
    const eliminated = traceById(chart.traces, 'simulation.amount.eliminated')
    expect(eliminated.y).toEqual(result.samples.map((s) => s.cumulativeEliminated))
    const input = traceById(chart.traces, 'simulation.amount.input')
    expect(input.y).toEqual(result.samples.map((s) => s.cumulativeInput))
    // The chart never mixes dimensions: every trace is in mg.
    expect(chart.yUnit).toBe('mg')
    expect(chart.id).not.toBe('concentration')
  })
})

describe('instantaneous events — the discontinuity contract', () => {
  const bolusScenario = (time: number, amount: number): Partial<SimulationScenario> => ({
    events: [{ type: 'iv-bolus', eventId: 'd1', time, amount: { value: amount, unit: 'mg' } }],
    outputTimes: [0, 1, 2, 4, 6, 8, 12].filter((t) => t !== time).concat(time).sort((a, b) => a - b) as number[],
  })

  it('keeps the pre-event and post-event points at the same time, in that order', () => {
    const result = run(bolusScenario(4, 60))
    const central = traceById(amountChart(result).traces, 'simulation.amount.central')
    const indices = central.x.flatMap((t, i) => (t === 4 ? [i] : []))
    expect(indices).toHaveLength(2)
    const [preIndex, postIndex] = indices as [number, number]
    expect(postIndex).toBe(preIndex + 1)
    expect(central.samples[preIndex]!.side).toBe('pre-event')
    expect(central.samples[postIndex]!.side).toBe('post-event')
    expect(central.samples[preIndex]!.eventGroup).toBe(central.samples[postIndex]!.eventGroup)
  })

  it('draws the bolus as a vertical segment: same x, y increases by exactly D', () => {
    const result = run(bolusScenario(4, 60))
    const central = traceById(amountChart(result).traces, 'simulation.amount.central')
    const [preIndex] = discontinuityIndices(central)
    expect(preIndex).toBeDefined()
    if (preIndex === undefined) return
    expect(central.x[preIndex]).toBe(central.x[preIndex + 1])
    expect(central.y[preIndex + 1]! - central.y[preIndex]!).toBeCloseTo(60, 9)
  })

  it('jumps the concentration by D/V_c, not gradually', () => {
    // D = 60 mg, V_c = 10 L → 6 mg/L step at t = 4.
    const result = run(bolusScenario(4, 60))
    const central = traceById(concentrationChart(result).traces, 'simulation.concentration.central')
    const index = discontinuityIndices(central)[0]
    expect(index).toBeDefined()
    if (index === undefined) return
    expect(central.y[index + 1]! - central.y[index]!).toBeCloseTo(6, 9)
    // No intermediate point was invented between the two sides.
    expect(central.x.filter((t) => t === 4)).toHaveLength(2)
  })

  it('does not move the jump to a neighbouring time or spread it over an interval', () => {
    const result = run(bolusScenario(4, 60))
    const central = traceById(amountChart(result).traces, 'simulation.amount.central')
    const jumpTimes = discontinuityIndices(central).map((i) => central.x[i])
    expect(jumpTimes).toEqual([4])
  })

  it('the Plotly trace preserves that order and carries side metadata per point', () => {
    const result = run(bolusScenario(4, 60))
    const central = traceById(amountChart(result).traces, 'simulation.amount.central')
    const plotly = simulationTraceToPlotly(central, 'Central amount', 'mg')
    expect(plotly.x).toEqual(central.x)
    expect(plotly.y).toEqual(central.y)
    const index = discontinuityIndices(central)[0]!
    expect(plotly.customdata[index]).toContain('just before the event')
    expect(plotly.customdata[index + 1]).toContain('just after the event')
    expect(plotly.customdata[index]).toContain('t = 4 h')
    expect(plotly.customdata[index + 1]).toContain('mg')
  })
})

describe('events', () => {
  it('maps the real event trace to display markers, including several at one time', () => {
    const result = run({
      endTime: 12,
      outputTimes: [0, 2, 4, 6, 8, 12],
      events: [
        { type: 'iv-bolus', eventId: 'd1', time: 0, amount: { value: 100, unit: 'mg' } },
        { type: 'infusion-start', eventId: 's1', infusionId: 'I1', time: 2, rate: { value: 10, unit: 'mg/h' } },
        { type: 'iv-bolus', eventId: 'd2', time: 2, amount: { value: 5, unit: 'mg' } },
        { type: 'infusion-stop', eventId: 't1', infusionId: 'I1', time: 6 },
      ],
    })
    const markers = simulationEventMarkers(result)
    expect(markers.map((m) => m.eventId)).toEqual(['d1', 'd2', 's1', 't1'])
    // Same timestamp, two distinct events: none is collapsed.
    expect(markers.filter((m) => m.time === 2).map((m) => m.eventId)).toEqual(['d2', 's1'])
    expect(markers.find((m) => m.eventId === 'd1')?.declaredValue).toEqual({ value: 100, unit: 'mg' })
    expect(markers.find((m) => m.eventId === 's1')?.declaredValue).toEqual({ value: 10, unit: 'mg/h' })
    expect(markers.find((m) => m.eventId === 's1')?.infusionId).toBe('I1')
    // A stop must not look like an administered amount.
    const stop = markers.find((m) => m.eventId === 't1')!
    expect(stop.type).toBe('infusion-stop')
    expect(stop.declaredValue).toBeUndefined()
    expect(describeSimulationEvent(stop)).toContain('no amount administered')
  })

  it('renders one shape per event, each labelled with its own description', () => {
    const result = run({
      outputTimes: [0, 2, 6, 12],
      events: [
        { type: 'infusion-start', eventId: 's1', infusionId: 'I1', time: 2, rate: { value: 10, unit: 'mg/h' } },
        { type: 'infusion-stop', eventId: 't1', infusionId: 'I1', time: 6 },
      ],
    })
    const shapes = simulationEventShapes(simulationEventMarkers(result))
    expect(shapes).toHaveLength(2)
    expect(shapes[0]).toMatchObject({ type: 'line', x0: 2, x1: 2 })
    expect(shapes[1]).toMatchObject({ type: 'line', x0: 6, x1: 6 })
    // Kinds are distinguished by their accessible name, not by colour: the
    // stop says it administers no amount.
    const names = shapes.map((shape) => String((shape as { name?: string }).name ?? ''))
    expect(names[0]).toContain('starts at 10 mg/h')
    expect(names[1]).toContain('no amount administered')
    // All event lines share one restrained style so the data stays dominant.
    expect((shapes[0]!.line as { dash: string }).dash).toBe((shapes[1]!.line as { dash: string }).dash)
    for (const shape of shapes) expect(Object.values(shape)).not.toContain(undefined)
  })
})

describe('degenerate and zero-valued data', () => {
  it('charts a scenario whose whole curve is zero', () => {
    const result = run({ initialState: { centralAmount: 0, peripheralAmount: 0 }, events: [] })
    const charts = buildSimulationCharts(result)
    expect(charts.ok).toBe(true)
    if (!charts.ok) return
    const concentration = charts.charts[0]!
    const central = traceById(concentration.traces, 'simulation.concentration.central')
    expect(central.y.every((v) => v === 0)).toBe(true)
    expect(central.y.length).toBeGreaterThan(1)
  })

  it('keeps an exact numeric zero as 0 (never substitutes a small positive value)', () => {
    const result = run({ events: [{ type: 'iv-bolus', eventId: 'd1', time: 0, amount: { value: 100, unit: 'mg' } }] })
    const central = traceById(amountChart(result).traces, 'simulation.amount.central')
    expect(central.y[0]).toBe(0)
    expect(Object.is(central.y[0], 0)).toBe(true)
  })

  it('formats numbers for hover without inventing digits', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(10)).toBe('10')
    expect(formatNumber(81.8730753079)).toBe('81.8731')
    expect(formatNumber(0.0000123)).toBe('1.230e-5')
  })

  it('produces per-point hover text for every point', () => {
    const result = run({ events: [{ type: 'iv-bolus', eventId: 'd1', time: 2, amount: { value: 5, unit: 'mg' } }] })
    const trace = traceById(amountChart(result).traces, 'simulation.amount.central')
    const texts = simulationHoverTexts(trace, 'Central amount', 'mg')
    expect(texts).toHaveLength(trace.x.length)
    expect(texts[0]).toContain('start of simulation')
    expect(texts.some((t) => t.includes('group'))).toBe(true)
  })
})

describe('Plotly trace contract', () => {
  it('never carries an own property whose value is undefined', () => {
    const result = run({ events: [{ type: 'iv-bolus', eventId: 'd1', time: 2, amount: { value: 5, unit: 'mg' } }] })
    for (const chart of [concentrationChart(result), amountChart(result)]) {
      for (const trace of chart.traces) {
        const plotly = simulationTraceToPlotly(trace, chart.yLabel, chart.yUnit)
        expect(Object.entries(plotly).filter(([, v]) => v === undefined)).toEqual([])
      }
    }
  })
})
