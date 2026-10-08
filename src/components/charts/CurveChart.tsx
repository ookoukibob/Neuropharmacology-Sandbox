/**
 * CurveChart — Plotly chart component (lazy-loaded).
 *
 * Receives engine CurveData and renders it via react-plotly.js. The
 * chart layer never computes pharmacology — it only maps CurveData to
 * Plotly traces and layout via the adapter.
 *
 * This component is dynamically imported (React.lazy) so Plotly's large
 * bundle doesn't block first paint on pages that don't use charts.
 */
import Plot from 'react-plotly.js'
import type { CurveData } from '@/engine/types'
import { resolveAxisTypes, curveToTraces, curveLayout } from './curveAdapter'

interface CurveChartProps {
  readonly curve: CurveData
}

export function CurveChart({ curve }: CurveChartProps) {
  const axes = resolveAxisTypes(curve)
  const traces = curveToTraces(curve)
  const layout = curveLayout(curve, axes)

  const config = {
    displayModeBar: true,
    displaylogo: false,
    responsive: true,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'resetScale2d'],
  }

  return (
    <div className="w-full" style={{ height: 400 }} data-testid="curve-chart">
      <Plot data={traces} layout={layout} config={config} />
    </div>
  )
}