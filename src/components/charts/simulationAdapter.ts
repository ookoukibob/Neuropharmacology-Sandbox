/**
 * Simulation chart adapter (phase 42).
 *
 * Pure presentation mapping from the engine's `SimulationResult` to
 * chart-ready Plotly traces and layout metadata. It performs NO pharmacology:
 *
 * - it never computes a concentration, derivative, or integral;
 * - it never re-integrates, resamples, smooths, deduplicates or sorts;
 * - it never calls `simulate()` and imports no solver.
 *
 * Every number in a trace is copied from a `SimulationSample` (or from the
 * report's parameters/units) exactly as the engine emitted it, in emission
 * order.
 *
 * Why order matters (ADR-26). At a dosing event the engine emits two samples
 * with the SAME time — `pre-event` and `post-event`. They are a
 * discontinuity, not a duplicate: a bolus makes A_c jump by D (and the
 * central concentration by D/V_c) within zero simulated time. A line trace
 * that keeps both points in that order renders the jump as a vertical
 * segment at the exact event time. Any grouping, `Set`, sort, or
 * interpolation would erase the dose from the picture, so this module
 * preserves the array as given.
 *
 * Concentrations and amounts are never placed on one y-axis: they are
 * different physical dimensions (mg/L vs mg). The result therefore contains
 * two separate charts.
 */
import type {
  EventTraceEntry,
  SimulationResult,
  SimulationSample,
} from '@/engine/simulation/types'

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type SimulationChartId = 'concentration' | 'amount'

/** One chart-ready series: parallel x/y arrays plus the full source samples. */
export interface SimulationTrace {
  /** Stable id, e.g. `simulation.concentration.central`. */
  readonly id: string
  readonly name: string
  readonly x: readonly number[]
  readonly y: readonly number[]
  /**
   * The samples the series was built from, in emission order. Chart code and
   * tests read side/event metadata from here; interactive hover text is
   * derived per point by `simulationHoverTexts`.
   */
  readonly samples: readonly SimulationSample[]
  /** Marks a pre/post-event pair so it can be drawn without hiding it. */
  readonly isEventSeries: boolean
}

export interface SimulationChart {
  readonly id: SimulationChartId
  readonly title: string
  readonly xLabel: string
  readonly xUnit: string
  readonly yLabel: string
  readonly yUnit: string
  /** Linear only in this phase; no log-axis configuration is offered. */
  readonly xType: 'linear'
  readonly yType: 'linear'
  readonly traces: readonly SimulationTrace[]
}

/** A dosing event prepared for display (never inferred from the curve). */
export interface SimulationEventMarker {
  readonly eventId: string
  readonly type: EventTraceEntry['type']
  readonly time: number
  readonly groupIndex: number
  readonly orderInGroup: number
  readonly infusionId?: string
  /** Declared quantity exactly as the caller supplied it (bolus/rate). */
  readonly declaredValue?: { readonly value: number; readonly unit: string }
  readonly canonicalValue?: number
  readonly canonicalUnit?: string
}

export type SimulationChartsResult =
  | {
      readonly ok: true
      readonly charts: readonly SimulationChart[]
      readonly events: readonly SimulationEventMarker[]
    }
  | {
      readonly ok: false
      readonly reason: string
    }

const CONCENTRATION_UNIT = 'mg/L'
const AMOUNT_UNIT = 'mg'
const TIME_UNIT = 'h'

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NUMERIC_FIELDS = [
  'centralAmount',
  'peripheralAmount',
  'cumulativeEliminated',
  'cumulativeInput',
  'centralConcentration',
  'peripheralConcentration',
] as const satisfies readonly (keyof SimulationSample)[]

/**
 * Why a result cannot be charted. A report that is not a successful
 * simulation, has no samples, or carries a non-finite value must never be
 * turned into a plausible-looking curve.
 */
export function simulationChartFailure(
  result: SimulationResult | null | undefined,
): string | null {
  if (result === null || result === undefined) return 'No simulation result to display.'
  if (!Array.isArray(result.samples) || result.samples.length === 0) {
    return 'The simulation result contains no samples.'
  }
  for (const [index, sample] of result.samples.entries()) {
    if (sample === null || typeof sample !== 'object') {
      return `Sample ${index} is malformed.`
    }
    if (typeof sample.time !== 'number' || !Number.isFinite(sample.time)) {
      return `Sample ${index} has a non-finite time.`
    }
    for (const field of NUMERIC_FIELDS) {
      const value = sample[field]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `Sample ${index} (${sample.side} at t = ${sample.time} h) has a non-finite ${field}.`
      }
    }
  }
  if (!result.massBalance || result.massBalance.ok !== true) {
    return 'The simulation did not pass its mass-balance check; no chart is drawn.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Series construction
// ---------------------------------------------------------------------------

const isEventSample = (sample: SimulationSample): boolean =>
  sample.side === 'pre-event' || sample.side === 'post-event'

function buildTrace(
  id: string,
  name: string,
  samples: readonly SimulationSample[],
  field: keyof SimulationSample,
): SimulationTrace {
  const x: number[] = []
  const y: number[] = []
  let isEventSeries = false
  // Straight copy in emission order — no filtering, grouping or sorting.
  for (const sample of samples) {
    const value = sample[field]
    if (typeof value !== 'number') continue
    x.push(sample.time)
    y.push(value)
    if (isEventSample(sample)) isEventSeries = true
  }
  return { id, name, x, y, samples, isEventSeries }
}

/** Hover text for every point of a trace: time, side, group, value+unit. */
export function simulationHoverTexts(
  trace: SimulationTrace,
  valueLabel: string,
  valueUnit: string,
): readonly string[] {
  return trace.x.map((time, index) => {
    const sample = trace.samples[index]
    const value = trace.y[index]
    const parts = [`t = ${formatNumber(time)} ${TIME_UNIT}`]
    if (sample !== undefined) {
      parts.push(`${sideLabel(sample.side)}`)
      if (sample.eventGroup !== undefined) parts.push(`group ${sample.eventGroup}`)
    }
    if (value !== undefined) parts.push(`${valueLabel}: ${formatNumber(value)} ${valueUnit}`)
    return parts.join(' · ')
  })
}

function sideLabel(side: SimulationSample['side']): string {
  switch (side) {
    case 'initial':
      return 'start of simulation'
    case 'interval':
      return 'between events'
    case 'pre-event':
      return 'just before the event'
    case 'post-event':
      return 'just after the event'
  }
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 1e-3 && abs < 1e6) return String(Number(value.toPrecision(6)))
  return value.toExponential(3)
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Display records for the applied dosing events, taken from the report's
 * `eventTrace` — never inferred from apparent curve changes. Every event is
 * kept, including several at one time, in engine order.
 */
export function simulationEventMarkers(
  result: SimulationResult,
): readonly SimulationEventMarker[] {
  return result.eventTrace.map((entry) => ({
    eventId: entry.eventId,
    type: entry.type,
    time: entry.time,
    groupIndex: entry.groupIndex,
    orderInGroup: entry.orderInGroup,
    ...(entry.infusionId === undefined ? {} : { infusionId: entry.infusionId }),
    ...(entry.declaredValue === undefined
      ? {}
      : { declaredValue: { value: entry.declaredValue.value, unit: entry.declaredValue.unit } }),
    ...(entry.canonicalValue === undefined ? {} : { canonicalValue: entry.canonicalValue }),
    ...(entry.canonicalUnit === undefined ? {} : { canonicalUnit: entry.canonicalUnit }),
  }))
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/** Central + peripheral concentration over time (mg/L). */
export function concentrationChart(result: SimulationResult): SimulationChart {
  return {
    id: 'concentration',
    title: 'Compartment concentration over time',
    xLabel: 'Time',
    xUnit: TIME_UNIT,
    yLabel: 'Concentration',
    yUnit: CONCENTRATION_UNIT,
    xType: 'linear',
    yType: 'linear',
    traces: [
      buildTrace('simulation.concentration.central', 'Central compartment', result.samples, 'centralConcentration'),
      buildTrace(
        'simulation.concentration.peripheral',
        'Peripheral compartment',
        result.samples,
        'peripheralConcentration',
      ),
    ],
  }
}

/**
 * Compartment amounts over time (mg).
 *
 * The two physical compartments are the primary series; cumulative input and
 * cumulative elimination are accounting states (they include the initial
 * condition's elimination history), so they are included with names that say
 * so rather than being presented as a third compartment.
 */
export function amountChart(result: SimulationResult): SimulationChart {
  return {
    id: 'amount',
    title: 'Compartment amounts over time',
    xLabel: 'Time',
    xUnit: TIME_UNIT,
    yLabel: 'Amount',
    yUnit: AMOUNT_UNIT,
    xType: 'linear',
    yType: 'linear',
    traces: [
      buildTrace('simulation.amount.central', 'Central amount', result.samples, 'centralAmount'),
      buildTrace('simulation.amount.peripheral', 'Peripheral amount', result.samples, 'peripheralAmount'),
      buildTrace('simulation.amount.input', 'Cumulative input (accounting)', result.samples, 'cumulativeInput'),
      buildTrace(
        'simulation.amount.eliminated',
        'Cumulative eliminated (accounting)',
        result.samples,
        'cumulativeEliminated',
      ),
    ],
  }
}

/**
 * Build every chart for a successful result, or a typed failure.
 * `result` must come from `simulate()` (`report.ok === true ? report.result : null`).
 */
export function buildSimulationCharts(
  result: SimulationResult | null | undefined,
): SimulationChartsResult {
  const failure = simulationChartFailure(result)
  if (failure !== null || result === null || result === undefined) {
    return { ok: false, reason: failure ?? 'No simulation result to display.' }
  }
  return {
    ok: true,
    charts: [concentrationChart(result), amountChart(result)],
    events: simulationEventMarkers(result),
  }
}

// ---------------------------------------------------------------------------
// Indices of discontinuities (for annotation / testing, not for rendering math)
// ---------------------------------------------------------------------------

/**
 * Positions in a trace where two consecutive points share a time and a
 * different `side` — the vertical jump a bolus draws. Returned as the index
 * of the PRE point (so the segment pre→post is (i, i+1)).
 */
export function discontinuityIndices(trace: SimulationTrace): readonly number[] {
  const indices: number[] = []
  for (let i = 1; i < trace.x.length; i += 1) {
    const previous = trace.samples[i - 1]
    const current = trace.samples[i]
    if (previous === undefined || current === undefined) continue
    if (trace.x[i] === trace.x[i - 1] && previous.side !== current.side) indices.push(i - 1)
  }
  return indices
}

// ---------------------------------------------------------------------------
// Plotly mapping (still pure: no Plotly import, no DOM)
// ---------------------------------------------------------------------------

/** A Plotly-compatible scatter trace, all keys defined. */
export interface SimulationPlotlyTrace {
  readonly x: readonly number[]
  readonly y: readonly number[]
  readonly name: string
  readonly type: 'scatter'
  readonly mode: 'lines'
  readonly line: { readonly width: number; readonly dash: 'solid' | 'dot' }
  readonly hovertemplate: string
  readonly customdata: readonly string[]
}

/**
 * Map one `SimulationTrace` to a Plotly line trace.
 *
 * The x/y arrays are the engine's sample values in emission order, so a
 * pre/post pair at one time becomes a vertical segment: Plotly draws every
 * consecutive pair, including two points with equal x. The per-point
 * `customdata` strings are the hover texts, which keeps the event side and
 * event group visible even when two points share a time.
 *
 * The trace carries no own property whose value is `undefined` (the phase 27
 * regression guard applies to every chart in this project).
 */
export function simulationTraceToPlotly(
  trace: SimulationTrace,
  valueLabel: string,
  valueUnit: string,
): SimulationPlotlyTrace {
  return {
    // Copies: Plotly may rewrite arrays in place, and the adapter's values
    // must stay exactly as the engine reported them.
    x: trace.x.slice(),
    y: trace.y.slice(),
    name: trace.name,
    type: 'scatter',
    mode: 'lines',
    // Solid line for every series: the jump is the segment between a
    // pre-event and a post-event point at equal x. No smoothing, no
    // interpolation, and no separate event styling that could imply the
    // change happened gradually.
    line: { width: 2, dash: 'solid' as const },
    hovertemplate: '%{customdata}<extra>' + trace.name + '</extra>',
    customdata: simulationHoverTexts(trace, valueLabel, valueUnit),
  }
}

/**
 * Plotly layout for one simulation chart. Linear axes only (this phase);
 * the y-axis title carries the unit so a screen-reader user reading the
 * chart's accessible table or caption sees it.
 */
export function simulationChartLayout(chart: SimulationChart): Record<string, unknown> {
  return {
    xaxis: {
      title: `${chart.xLabel} (${chart.xUnit})`,
      type: chart.xType,
      showgrid: true,
      zeroline: false,
    },
    yaxis: {
      title: `${chart.yLabel} (${chart.yUnit})`,
      type: chart.yType,
      showgrid: true,
      zeroline: false,
    },
    margin: { l: 64, r: 16, t: 24, b: 48 },
    showlegend: chart.traces.length > 1,
    hovermode: 'closest' as const,
  }
}

/**
 * Vertical event lines for a chart's layout. Each dosing event becomes a thin
 * line at its time (no marker on the curve itself, so data is never
 * obscured). Stops use a dotted pattern and starts a dashed one, so event
 * kinds differ by shape as well as by position — never by colour alone.
 */
export function simulationEventShapes(
  events: readonly SimulationEventMarker[],
): readonly Record<string, unknown>[] {
  return events.map((event) => ({
    type: 'line',
    xref: 'x',
    yref: 'paper',
    x0: event.time,
    x1: event.time,
    y0: 0,
    y1: 1,
    line: {
      width: 1,
      dash: event.type === 'infusion-stop' ? 'dot' : 'longdash',
      // Muted grey so the coloured series stay dominant; the event table and
      // hover text carry the meaning, not the colour.
      color: '#8a8a8a',
    },
    name: describeSimulationEvent(event),
  }))
}

/** Human-readable one-line description of an event (used by the event table). */
export function describeSimulationEvent(event: SimulationEventMarker): string {
  switch (event.type) {
    case 'iv-bolus': {
      const amount =
        event.declaredValue === undefined
          ? ''
          : `${formatNumber(event.declaredValue.value)} ${event.declaredValue.unit}`
      return `IV bolus ${amount}`.trim()
    }
    case 'infusion-start': {
      const rate =
        event.declaredValue === undefined
          ? ''
          : `${formatNumber(event.declaredValue.value)} ${event.declaredValue.unit}`
      return `Infusion ${event.infusionId ?? ''} starts at ${rate}`.trim()
    }
    case 'infusion-stop':
      return `Infusion ${event.infusionId ?? ''} stops (no amount administered at this time)`
  }
}
