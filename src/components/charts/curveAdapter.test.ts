/**
 * Unit tests for the chart adapter's public trace-contract (phase 27 follow-up).
 *
 * Regression contract: a trace object must never carry a top-level own
 * property whose value is `undefined`. The phase 27 production defect came
 * from explicit `undefined` keys (e.g. `marker: undefined`) satisfying
 * plotly's presence guard in cleanData ('marker' in trace), which then
 * threw on the undefined value — and react-plotly.js swallows that
 * rejection (no onError prop), leaving the calculator curve chart blank
 * with no visible error. These tests inspect the actual objects (never
 * JSON, which silently drops `undefined` properties) so reintroducing
 * `marker: undefined`, `line: undefined` or `showlegend: undefined`
 * fails here first.
 */
import { describe, expect, it } from 'vitest'
import { curveLayout, curveToTraces, resolveAxisTypes } from './curveAdapter'
import type { CurveData, CurveSeries } from '@/engine/types'

// Narrow a single-element array by throwing instead of casting, so indexed
// access stays type-safe under noUncheckedIndexedAccess (store test style).
function firstTrace(traces: ReturnType<typeof curveToTraces>): object {
  const first = traces[0]
  if (first === undefined) {
    throw new Error(`expected at least one trace, received ${traces.length}`)
  }
  return first
}

/** Top-level own keys whose value is explicitly `undefined`. */
function keysWithUndefinedValue(trace: object): string[] {
  return Object.entries(trace)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key)
}

function seriesOf(seriesType: CurveSeries['seriesType']): CurveSeries {
  return {
    id: seriesType === 'model' ? 'pk.concentration' : 'pk.observed',
    name: seriesType === 'model' ? 'Model C(t)' : 'Observed C(t)',
    seriesType,
    points: [
      { x: 0, y: 100 },
      { x: 1, y: 50 },
      { x: 10, y: 0.09765625 },
    ],
    xUnit: 'h',
    yUnit: 'µM',
  }
}

function curveWith(...series: CurveSeries[]): CurveData {
  return {
    model: 'pk.first-order-one-compartment',
    xLabel: 't',
    yLabel: 'C(t)',
    xUnit: 'h',
    yUnit: 'µM',
    xScale: 'linear',
    yScale: 'linear',
    series,
  }
}

describe('curveToTraces', () => {
  it('maps a model series to a line trace with line style and no undefined-valued keys', () => {
    const trace = firstTrace(curveToTraces(curveWith(seriesOf('model'))))

    // Points map to x/y in order; identity fields are preserved.
    expect(trace).toMatchObject({
      x: [0, 1, 10],
      y: [100, 50, 0.09765625],
      name: 'Model C(t)',
      mode: 'lines',
      type: 'scatter',
    })
    // Intended model style is present.
    expect(trace).toMatchObject({ line: { width: 2 } })
    // The opposite style key, and the parent-owned legend key, are absent
    // as own properties — not merely undefined-valued.
    expect(Object.hasOwn(trace, 'marker')).toBe(false)
    expect(Object.hasOwn(trace, 'showlegend')).toBe(false)
    // The phase 27 regression guard: no own property may be undefined.
    expect(keysWithUndefinedValue(trace)).toEqual([])
  })

  it('maps an observed series to a marker trace with marker style and no undefined-valued keys', () => {
    const trace = firstTrace(curveToTraces(curveWith(seriesOf('observed'))))

    expect(trace).toMatchObject({
      x: [0, 1, 10],
      y: [100, 50, 0.09765625],
      name: 'Observed C(t)',
      mode: 'markers',
      type: 'scatter',
    })
    expect(trace).toMatchObject({ marker: { size: 6 } })
    expect(Object.hasOwn(trace, 'line')).toBe(false)
    expect(Object.hasOwn(trace, 'showlegend')).toBe(false)
    expect(keysWithUndefinedValue(trace)).toEqual([])
  })

  it('emits one trace per series when a curve mixes both series types', () => {
    const traces = curveToTraces(curveWith(seriesOf('model'), seriesOf('observed')))
    expect(traces).toHaveLength(2)
    for (const trace of traces) {
      expect(keysWithUndefinedValue(trace)).toEqual([])
    }
  })
})

describe('resolveAxisTypes', () => {
  it('respects the curve scale hints when no log-y warning is present', () => {
    const axes = resolveAxisTypes({
      ...curveWith(seriesOf('model')),
      xScale: 'log',
      yScale: 'log',
    })
    expect(axes).toEqual({ xType: 'log', yType: 'log', logYBlocked: false })
  })

  it('forces a linear y-axis when the curve carries LOG_Y_AXIS_NOT_REPRESENTABLE', () => {
    const axes = resolveAxisTypes({
      ...curveWith(seriesOf('model')),
      xScale: 'log',
      yScale: 'log',
      warnings: [
        {
          code: 'LOG_Y_AXIS_NOT_REPRESENTABLE',
          severity: 'info',
          message: 'Synthetic fixture: sampled values reach zero on a log y-axis.',
        },
      ],
    })
    expect(axes).toEqual({ xType: 'log', yType: 'linear', logYBlocked: true })
  })
})

describe('curveLayout', () => {
  it('shows the legend only for multi-series curves and fixes the hover mode', () => {
    const axes = resolveAxisTypes(curveWith(seriesOf('model')))
    expect(curveLayout(curveWith(seriesOf('model')), axes)).toMatchObject({
      showlegend: false,
      hovermode: 'x unified',
    })
    expect(
      curveLayout(curveWith(seriesOf('model'), seriesOf('observed')), axes),
    ).toMatchObject({ showlegend: true })
  })
})
