/**
 * SimulationChart — Plotly rendering of one simulation chart (phase 42).
 *
 * Receives an already-adapted `SimulationChart` (engine samples copied into
 * traces) and performs no computation of any kind: no pharmacology, no
 * smoothing, no reordering. The x/y arrays are passed to Plotly exactly as the
 * adapter produced them, so a pre-event/post-event pair at the same time
 * renders as the vertical jump of an instantaneous dose.
 *
 * Lazy-loaded by the page (React.lazy) so Plotly's bundle is not part of the
 * initial application payload, matching the calculator's chart strategy.
 */
import Plot from 'react-plotly.js'
import {
  infusionRateTraceToPlotly,
  simulationChartLayout,
  simulationEventShapes,
  simulationTraceToPlotly,
  type SimulationChart,
  type SimulationEventMarker,
  type SimulationPlotlyTrace,
} from './simulationAdapter'

interface SimulationChartProps {
  readonly chart: SimulationChart
  /**
   * The applied events, used only as the alternative text of the chart's
   * event lines; the visible event list lives on the page.
   */
  readonly events: readonly SimulationEventMarker[]
  /** Plotly graph div id, unique per chart on the page. */
  readonly graphId: string
  /** Optional per-point hover text (infusion-rate chart, from `infusionRates`). */
  readonly hoverTexts?: readonly string[]
}

export function SimulationChart({ chart, events, graphId, hoverTexts }: SimulationChartProps) {
  const traces: SimulationPlotlyTrace[] = chart.traces.map((trace) =>
    hoverTexts !== undefined && chart.id === 'infusion-rate'
      ? infusionRateTraceToPlotly(trace, hoverTexts)
      : simulationTraceToPlotly(trace, chart.yLabel, chart.yUnit),
  )
  const layout = {
    ...simulationChartLayout(chart),
    shapes: simulationEventShapes(events),
    // Per-point side/group/value text: repeated timestamps stay
    // distinguishable on hover (unified hover would merge them).
    hovermode: 'closest' as const,
  }
  const config = {
    displayModeBar: true,
    displaylogo: false,
    responsive: true,
    // The value is also printed by the event list and hover text, so the
    // chart never depends on colour alone.
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'resetScale2d'],
  }

  return (
    <div
      className="w-full"
      style={{ height: 360 }}
      data-testid={`simulation-chart-${chart.id}`}
    >
      <Plot
        divId={graphId}
        data={traces}
        layout={layout}
        config={config}
        aria-label={`${chart.title}: ${chart.yLabel} (${chart.yUnit}) against ${chart.xLabel} (${chart.xUnit})`}
      />
    </div>
  )
}