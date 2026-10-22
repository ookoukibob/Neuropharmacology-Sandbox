/**
 * Profile of the least-squares objective over the decay rate (phase 47C).
 *
 * The plotted quantity is a RESIDUAL SUM OF SQUARES for the same model and the
 * same amplitude projection the fit uses — not a likelihood, not a profile
 * likelihood, and not a confidence region. The amplitude is concentrated out
 * of the plotted objective rather than held fixed, which is why the label says
 * "profile objective" and never "profile likelihood".
 *
 * Presentation only: every value comes from the domain layer, and candidates
 * that could not be evaluated are omitted rather than interpolated across.
 */
import type { ComponentProps } from 'react'
import Plot from 'react-plotly.js'
import type { MonoExponentialProfilePoint } from '@/domain/experiments/mono-exponential-profile'

export interface ExperimentalFitProfileChartProps {
  readonly points: readonly MonoExponentialProfilePoint[]
  readonly fittedRate: number
  readonly fittedSse: number
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly datasetName: string
}

export function ExperimentalFitProfileChart({
  points,
  fittedRate,
  fittedSse,
  timeUnit,
  concentrationUnit,
  datasetName,
}: ExperimentalFitProfileChartProps) {
  // Failed candidates are dropped from the drawing (never interpolated); the
  // count of what is missing is reported by the domain result, not hidden here.
  const evaluated: { readonly k: number; readonly sse: number }[] = []
  for (const point of points) {
    if (point.ok) evaluated.push({ k: point.k, sse: point.sse })
  }
  const rateAxis = 'Decay rate k (' + timeUnit + '⁻¹)'
  const objectiveAxis = 'Residual sum of squares ((' + concentrationUnit + ')²)'

  if (evaluated.length === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-testid="fit-profile-chart">
        No candidate decay rate could be evaluated, so the objective profile cannot be drawn.
      </p>
    )
  }

  const data = [
    {
      type: 'scatter',
      mode: evaluated.length > 1 ? 'lines+markers' : 'markers',
      name: 'Residual sum of squares',
      x: evaluated.map((point) => point.k),
      y: evaluated.map((point) => point.sse),
      marker: { size: 5 },
      hovertemplate:
        'Rate: %{x} ' + timeUnit + '⁻¹<br>Residual sum of squares: %{y}<extra></extra>',
    },
    {
      type: 'scatter',
      mode: 'markers',
      name: 'Fitted estimate',
      x: [fittedRate],
      y: [fittedSse],
      marker: { size: 11, symbol: 'diamond' },
      hovertemplate:
        'Fitted rate: %{x} ' + timeUnit + '⁻¹<br>Fitted residual sum of squares: %{y}<extra></extra>',
    },
  ] as NonNullable<ComponentProps<typeof Plot>['data']>

  const layout: Record<string, unknown> = {
    autosize: true,
    height: 260,
    margin: { l: 78, r: 20, t: 12, b: 62 },
    showlegend: true,
    legend: { orientation: 'h', y: -0.28 },
    hovermode: 'closest',
    xaxis: { title: { text: rateAxis }, showgrid: true, zeroline: false },
    yaxis: { title: { text: objectiveAxis }, showgrid: true, zeroline: false },
    title: { text: 'Objective profile for ' + datasetName, x: 0.02, xanchor: 'left' },
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
    <div className="w-full min-w-0 overflow-hidden" style={{ height: 260 }} data-testid="fit-profile-chart">
      <Plot
        data={data}
        layout={layout}
        config={config}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
        aria-label={
          'Profile of the residual sum of squares against the decay rate k for ' +
          datasetName +
          '. The horizontal axis is the decay rate k in reciprocal ' +
          timeUnit +
          '; the vertical axis is the unweighted residual sum of squares in (' +
          concentrationUnit +
          ') squared, with the amplitude re-solved at each candidate rate. A diamond marks the fitted estimate. This is a least-squares objective profile, not a likelihood or profile likelihood, and it is not a confidence interval.'
        }
      />
    </div>
  )
}

export default ExperimentalFitProfileChart
