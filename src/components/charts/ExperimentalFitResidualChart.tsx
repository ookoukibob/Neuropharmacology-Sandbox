/**
 * Residual-vs-time visualization for phase 47C.
 * Points are raw residuals (observed minus fitted), not standardized residuals.
 */
import type { ComponentProps } from 'react'
import Plot from 'react-plotly.js'
import type { MonoExponentialResidual } from '@/domain/experiments/mono-exponential-fit-diagnostics'

export interface ExperimentalFitResidualChartProps {
  readonly residuals: readonly MonoExponentialResidual[]
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly datasetName: string
}

export function ExperimentalFitResidualChart({
  residuals,
  timeUnit,
  concentrationUnit,
  datasetName,
}: ExperimentalFitResidualChartProps) {
  const data = [
    {
      type: 'scatter',
      mode: 'markers',
      name: 'Raw residuals',
      x: residuals.map((point) => point.time),
      y: residuals.map((point) => point.residual),
      customdata: residuals.map((point) => point.sourceRow),
      marker: { size: 8 },
      hovertemplate:
        'Time: %{x} ' + timeUnit + '<br>Residual (observed − fitted): %{y} ' +
        concentrationUnit + '<br>Source row: %{customdata}<extra></extra>',
    },
  ] as NonNullable<ComponentProps<typeof Plot>['data']>

  const layout: Record<string, unknown> = {
    autosize: true,
    height: 260,
    margin: { l: 72, r: 20, t: 12, b: 58 },
    showlegend: false,
    hovermode: 'closest',
    xaxis: { title: { text: 'Time (' + timeUnit + ')' }, showgrid: true, zeroline: false },
    yaxis: {
      title: { text: 'Residual (observed − fitted; ' + concentrationUnit + ')' },
      showgrid: true,
      zeroline: true,
      zerolinewidth: 2,
    },
    title: { text: 'Residuals for ' + datasetName, x: 0.02, xanchor: 'left' },
  }
  const config: Record<string, unknown> = {
    displayModeBar: true,
    displaylogo: false,
    responsive: true,
    scrollZoom: true,
    doubleClick: 'reset',
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'sendDataToCloud'],
  }

  return (
    <div className="w-full min-w-0 overflow-hidden" style={{ height: 260 }} data-testid="fit-residual-chart">
      <Plot
        data={data}
        layout={layout}
        config={config}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
        aria-label={'Residual plot for ' + datasetName + '. Each marker is observed concentration minus fitted concentration, in ' + concentrationUnit + '; the horizontal zero line represents zero residual. The source row remains available on hover.'}
      />
    </div>
  )
}

export default ExperimentalFitResidualChart
