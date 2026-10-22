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
export function buildExperimentalDatasetChart(dataset: ExperimentalDataset): ExperimentalDatasetChart {
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
      showlegend: false,
      hovermode: 'closest',
    },
    ariaLabel: `Observed concentration–time measurements from ${dataset.name}: ${dataset.measurements.length} points. Time in ${dataset.timeUnit}, concentration in ${dataset.concentrationUnit}. No fitted curve or interpolation is shown; the measurement table contains the same values.`,
  }
}
