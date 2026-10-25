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
import {
  isCensoredMeasurement,
  isQuantifiedMeasurement,
  type ExperimentalDataset,
} from '@/domain/experiments/experimental-dataset'

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
  const quantified = dataset.measurements.filter(isQuantifiedMeasurement)
  const censored = dataset.measurements.filter(isCensoredMeasurement)

  const x = quantified.map((measurement) => measurement.time)
  const y = quantified.map((measurement) => measurement.concentration)
  const customdata = quantified.map((measurement) => {
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

  // Below-limit records are drawn with a distinct marker at the LLOQ position
  // and are NEVER plotted as a measured concentration or as zero. Their y value
  // is the limit, clearly labelled as such.
  const censoredX = censored.map((measurement) => measurement.time)
  const censoredY = censored.map((measurement) => measurement.limit)
  const censoredData = censored.map((measurement) => {
    const rows = [
      `Source row ${measurement.sourceRow}`,
      'Below the limit of quantification (not a measured concentration)',
      `Original text: ${escapeHover(measurement.rawText)}`,
      `LLOQ: ${measurement.limit} ${concentrationUnit}`,
    ]
    if (measurement.sampleId !== undefined) {
      rows.push(`Sample: ${escapeHover(measurement.sampleId)}`)
    }
    return rows.join('<br>')
  })

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

  const quantifiedTrace = {
    type: 'scatter',
    mode: 'markers',
    name: 'Observed measurements',
    x,
    y,
    customdata,
    marker: { size: 7, opacity: 0.9 },
    hovertemplate:
      `Time: %{x} ${timeUnit}<br>Concentration: %{y} ${concentrationUnit}<br>%{customdata}<extra></extra>`,
  }

  const censoredTrace =
    censored.length === 0
      ? null
      : {
          type: 'scatter',
          mode: 'markers',
          name: 'Below limit of quantification (LLOQ position)',
          x: censoredX,
          y: censoredY,
          customdata: censoredData,
          marker: { size: 8, opacity: 0.9, symbol: 'x', color: '#888888' },
          hovertemplate:
            `Time: %{x} ${timeUnit}<br>Below the limit of quantification<br>%{customdata}<extra></extra>`,
        }

  const needsLegend = fitTrace !== null || censoredTrace !== null

  const ariaCount =
    censored.length === 0
      ? `${quantified.length} points`
      : `${quantified.length} quantified points and ${censored.length} below-limit records (shown at the LLOQ position, not as measured concentrations)`

  return {
    traces: [
      quantifiedTrace,
      ...(censoredTrace === null ? [] : [censoredTrace]),
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
      // A legend is needed only when the fitted curve or censored markers are
      // present, so the two series stay distinguishable.
      showlegend: needsLegend,
      hovermode: 'closest',
    },
    ariaLabel:
      fitTrace === null
        ? `Observed concentration–time measurements from ${dataset.name}: ${ariaCount}. Time in ${dataset.timeUnit}, concentration in ${dataset.concentrationUnit}. No fitted curve or interpolation is shown; the measurement table contains the same values.`
        : `Observed concentration–time measurements from ${dataset.name}: ${ariaCount}, plus the fitted mono-exponential curve. Time in ${dataset.timeUnit}, concentration in ${dataset.concentrationUnit}. The curve is a model visualization, not additional measurements; the measurement table contains the observed values.`,
  }
}
