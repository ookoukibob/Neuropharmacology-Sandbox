/**
 * Presentation-only Plotly mapping for measured concentration–time datasets
 * (phase 47A).
 *
 * The adapter copies declared values into marker traces. It performs no
 * fitting, smoothing, interpolation, unit conversion or any other scientific
 * calculation, and it never draws a line through observations. Axis titles
 * use the dataset's declared units. The viewport dimensions are added by the
 * chart component, not here, so this module stays deterministic and easy to
 * test.
 */
import type { ExperimentalDataset } from '@/domain/experiments/experimental-dataset'

export interface ExperimentalDatasetChart {
  readonly traces: readonly Record<string, unknown>[]
  readonly layout: Record<string, unknown>
  readonly ariaLabel: string
}

function escapeHover(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Observed points only — exactly one marker per stored measurement, in source
 * order. Duplicate timestamps remain duplicate points.
 */
/** A fitted model curve to overlay, already computed by the fit module. */
export interface ExperimentalDatasetFitOverlay {
  readonly points: readonly { readonly time: number; readonly concentration: number }[]
  readonly label: string
}

export function buildExperimentalDatasetChart(
  dataset: ExperimentalDataset,
  fitOverlay?: ExperimentalDatasetFitOverlay,
): ExperimentalDatasetChart {
  const x = dataset.measurements.map((measurement) => measurement.time)
  const y = dataset.measurements.map((measurement) => measurement.concentration)
  const customdata = dataset.measurements.map((measurement) => {
    const rows = [`Source row ${measurement.sourceRow}`]
    if (measurement.sampleId !== undefined) {
      rows.push(`Sample: ${escapeHover(measurement.sampleId)}`)
    }
    if (measurement.note !== undefined) {
      rows.push(`Note: ${escapeHover(measurement.note)}`)
    }
    return rows.join('<br>')
  })
  const timeUnit = escapeHover(dataset.timeUnit)
  const concentrationUnit = escapeHover(dataset.concentrationUnit)

  // The fitted curve is a SEPARATE line trace drawn after the observed markers:
  // it visualizes the fitted equation and never replaces or interpolates the
  // measured rows. Absent when no fit was requested or the fit failed.
  const fitTrace =
    fitOverlay === undefined || fitOverlay.points.length === 0
      ? null
      : {
          type: 'scatter',
          mode: 'lines',
          name: fitOverlay.label,
          x: fitOverlay.points.map((point) => point.time),
          y: fitOverlay.points.map((point) => point.concentration),
          line: { width: 2, dash: 'solid' },
          hovertemplate: `Fitted curve — time: %{x} ${timeUnit}<br>Concentration: %{y} ${concentrationUnit}<extra></extra>`,
        }

  return {
    traces: [
      {
        type: 'scatter',
        mode: 'markers',
        name: 'Observed measurements',
        x,
        y,
        customdata,
        marker: { size: 7, opacity: 0.9 },
        hovertemplate:
          `Time: %{x} ${timeUnit}<br>Concentration: %{y} ${concentrationUnit}<br>%{customdata}<extra></extra>`,
      },
      ...(fitTrace === null ? [] : [fitTrace]),
    ],
    layout: {
      xaxis: {
        title: { text: `Time (${dataset.timeUnit})` },
        showgrid: true,
        zeroline: false,
      },
      yaxis: {
        title: { text: `Measured concentration (${dataset.concentrationUnit})` },
        showgrid: true,
        zeroline: false,
      },
      margin: { l: 64, r: 16, t: 16, b: 52 },
      // A legend is needed only when the fitted curve is present, so the two
      // series stay distinguishable.
      showlegend: fitTrace !== null,
      hovermode: 'closest',
    },
    ariaLabel:
      fitTrace === null
        ? `Observed concentration–time measurements from ${dataset.name}: ${dataset.measurements.length} points. Time in ${dataset.timeUnit}, concentration in ${dataset.concentrationUnit}. No fitted curve or interpolation is shown; the measurement table contains the same values.`
        : `Observed concentration–time measurements from ${dataset.name}: ${dataset.measurements.length} points, plus the fitted mono-exponential curve. Time in ${dataset.timeUnit}, concentration in ${dataset.concentrationUnit}. The curve is a model visualization, not additional measurements; the measurement table contains the observed values.`,
  }
}
