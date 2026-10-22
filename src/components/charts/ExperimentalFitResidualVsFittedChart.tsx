/**
 * Residual-vs-fitted visualization for the experimental fits.
 *
 * Plotting residuals against the fitted concentration makes changing spread
 * and curvature easier to see than against time, because both axes then share
 * one scale. Markers are raw residuals (observed minus fitted) in the dataset's
 * declared concentration unit, one marker per stored measurement, never
 * connected.
 *
 * A widening or narrowing cloud is a description of this sample. It is not a
 * heteroscedasticity test, and a level cloud does not establish constant
 * variance.
 */
import type { ComponentProps } from 'react'
import Plot from 'react-plotly.js'
import type { MonoExponentialResidual } from '@/domain/experiments/mono-exponential-fit-diagnostics'

export interface ExperimentalFitResidualVsFittedChartProps {
  readonly residuals: readonly MonoExponentialResidual[]
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly datasetName: string
  /** Distinguishes the candidate model when more than one is on screen. */
  readonly modelLabel?: string
  readonly testId?: string
}

export function ExperimentalFitResidualVsFittedChart({
  residuals,
  timeUnit,
  concentrationUnit,
  datasetName,
  modelLabel,
  testId = 'fit-residual-fitted-chart',
}: ExperimentalFitResidualVsFittedChartProps) {
  const modelSuffix = modelLabel === undefined ? '' : ' · ' + modelLabel
  const data = [
    {
      type: 'scatter',
      mode: 'markers',
      name: 'Raw residuals',
      x: residuals.map((point) => point.fitted),
      y: residuals.map((point) => point.residual),
      marker: { size: 8 },
      text: residuals.map(
        (point) =>
          'Source row: ' +
          String(point.sourceRow) +
          '<br>Fitted: ' +
          String(point.fitted) +
          ' ' +
          concentrationUnit +
          '<br>Residual (observed − fitted): ' +
          String(point.residual) +
          ' ' +
          concentrationUnit +
          '<br>Measured at: ' +
          String(point.time) +
          ' ' +
          timeUnit,
      ),
      hovertemplate: '%{text}<extra></extra>',
    },
  ] as NonNullable<ComponentProps<typeof Plot>['data']>

  const layout: Record<string, unknown> = {
    autosize: true,
    height: 260,
    margin: { l: 72, r: 20, t: 12, b: 58 },
    showlegend: false,
    hovermode: 'closest',
    xaxis: {
      title: { text: 'Fitted concentration (' + concentrationUnit + ')' },
      showgrid: true,
      zeroline: false,
    },
    yaxis: {
      title: { text: 'Residual (observed − fitted; ' + concentrationUnit + ')' },
      showgrid: true,
      zeroline: true,
      zerolinewidth: 2,
    },
    title: {
      text: 'Residuals against fitted value · ' + datasetName + modelSuffix,
      x: 0.02,
      xanchor: 'left',
    },
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
    <div className="w-full min-w-0 overflow-hidden" style={{ height: 260 }} data-testid={testId}>
      <Plot
        data={data}
        layout={layout}
        config={config}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
        aria-label={
          'Residual plot against fitted concentration for ' +
          datasetName +
          modelSuffix +
          '. Each marker is one stored observation: the horizontal axis is the fitted concentration in ' +
          concentrationUnit +
          ', the vertical axis is observed minus fitted concentration in the same unit, and the horizontal zero line is a perfect prediction. A widening or narrowing cloud describes this sample only; it is not a test of constant variance. Source row, measurement time and values are available on hover.'
        }
      />
    </div>
  )
}

export default ExperimentalFitResidualVsFittedChart
