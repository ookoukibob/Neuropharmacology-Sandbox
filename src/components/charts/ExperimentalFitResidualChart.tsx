/**
 * Residual-vs-time visualization for the experimental fits.
 * Points are raw residuals (observed minus fitted), not standardized residuals.
 *
 * Markers are never connected: the observations are not a continuous time
 * course and are not guaranteed to be independent or evenly spaced.
 */
import type { ComponentProps } from 'react'
import Plot from 'react-plotly.js'
import type { MonoExponentialResidual } from '@/domain/experiments/mono-exponential-fit-diagnostics'

const PLOT_CONFIG: Record<string, unknown> = {
  displayModeBar: true,
  displaylogo: false,
  responsive: true,
  scrollZoom: true,
  doubleClick: 'reset',
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'sendDataToCloud'],
}

function hoverText(
  point: MonoExponentialResidual,
  timeUnit: string,
  concentrationUnit: string,
): string {
  return (
    'Source row: ' +
    String(point.sourceRow) +
    '<br>Time: ' +
    String(point.time) +
    ' ' +
    timeUnit +
    '<br>Observed: ' +
    String(point.observed) +
    ' ' +
    concentrationUnit +
    '<br>Fitted: ' +
    String(point.fitted) +
    ' ' +
    concentrationUnit +
    '<br>Residual (observed − fitted): ' +
    String(point.residual) +
    ' ' +
    concentrationUnit
  )
}

export interface ExperimentalFitResidualChartProps {
  readonly residuals: readonly MonoExponentialResidual[]
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly datasetName: string
  /** Distinguishes the candidate model when more than one is on screen. */
  readonly modelLabel?: string
  readonly testId?: string
}

export function ExperimentalFitResidualChart({
  residuals,
  timeUnit,
  concentrationUnit,
  datasetName,
  modelLabel,
  testId = 'fit-residual-chart',
}: ExperimentalFitResidualChartProps) {
  const modelSuffix = modelLabel === undefined ? '' : ' · ' + modelLabel
  const data = [
    {
      type: 'scatter',
      mode: 'markers',
      name: 'Raw residuals',
      x: residuals.map((point) => point.time),
      y: residuals.map((point) => point.residual),
      marker: { size: 8 },
      text: residuals.map((point) => hoverText(point, timeUnit, concentrationUnit)),
      hovertemplate: '%{text}<extra></extra>',
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
    title: {
      text: 'Residuals against time · ' + datasetName + modelSuffix,
      x: 0.02,
      xanchor: 'left',
    },
  }

  return (
    <div className="w-full min-w-0 overflow-hidden" style={{ height: 260 }} data-testid={testId}>
      <Plot
        data={data}
        layout={layout}
        config={PLOT_CONFIG}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
        aria-label={
          'Residual plot against measured time for ' +
          datasetName +
          modelSuffix +
          '. Each marker is one stored observation, placed at its measured time in ' +
          timeUnit +
          '; the vertical axis is observed minus fitted concentration in ' +
          concentrationUnit +
          '. The horizontal zero line is a perfect prediction. Points sharing a time are drawn separately and no line connects the markers. Source row, observed and fitted values are available on hover.'
        }
      />
    </div>
  )
}

export default ExperimentalFitResidualChart
