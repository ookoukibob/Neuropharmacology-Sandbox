/**
 * Chart adapter (phase 4): pure functions converting engine CurveData to
 * Plotly traces/layout. No pharmacology calculations here — the engine has
 * already done all the math.
 *
 * The adapter respects the CurveData's scale hints (xScale, yScale) and the
 * Phase 2 log-y safety policy: if the curve carries a
 * LOG_Y_AXIS_NOT_REPRESENTABLE warning, the adapter forces linear y-axis for
 * rendering and returns a flag so the UI can explain the fallback.
 */
import type { CurveData, CurveSeries } from '@/engine/types'

export interface AxisResolution {
  readonly xType: 'linear' | 'log'
  readonly yType: 'linear' | 'log'
  readonly logYBlocked: boolean
}

/**
 * Resolve the actual axis types to use for rendering.
 * - x-axis: respects CurveData.xScale (validated by engine; log x requires min>0)
 * - y-axis: if CurveData carries LOG_Y_AXIS_NOT_REPRESENTABLE, force linear
 *   and return logYBlocked=true so the UI can show the structured warning.
 */
export function resolveAxisTypes(curve: CurveData): AxisResolution {
  const logYBlocked = curve.warnings?.some(
    (w) => w.code === 'LOG_Y_AXIS_NOT_REPRESENTABLE',
  ) ?? false

  return {
    xType: curve.xScale,
    yType: logYBlocked ? 'linear' : curve.yScale,
    logYBlocked,
  }
}

/** Convert a CurveSeries to a Plotly trace. */
function seriesToTrace(series: CurveSeries, _index: number) {
  const isModel = series.seriesType === 'model'
  return {
    x: series.points.map((p) => p.x),
    y: series.points.map((p) => p.y),
    name: series.name,
    mode: isModel ? 'lines' : 'markers',
    type: 'scatter',
    line: isModel ? { width: 2 } : undefined,
    marker: isModel ? undefined : { size: 6 },
    hovertemplate:
      `${series.xUnit ? `${series.xUnit}: ` : ''}%{x}` +
      (series.yUnit ? `<br>${series.yUnit}: %{y}` : '') +
      '<extra></extra>',
    // Only show legend if there are multiple series
    showlegend: undefined, // decided by parent
  }
}

/** Convert CurveData to an array of Plotly traces. */
export function curveToTraces(curve: CurveData) {
  return curve.series.map((series, i) => seriesToTrace(series, i))
}

/** Build a Plotly layout from CurveData and resolved axis types. */
export function curveLayout(
  curve: CurveData,
  axes: AxisResolution,
): Record<string, unknown> {
  return {
    xaxis: {
      title: curve.xUnit ? `${curve.xLabel} (${curve.xUnit})` : curve.xLabel,
      type: axes.xType,
      showgrid: true,
      zeroline: false,
    },
    yaxis: {
      title: curve.yUnit ? `${curve.yLabel} (${curve.yUnit})` : curve.yLabel,
      type: axes.yType,
      showgrid: true,
      zeroline: false,
    },
    margin: { l: 60, r: 20, t: 10, b: 50 },
    showlegend: curve.series.length > 1,
    hovermode: 'x unified' as const,
  }
}