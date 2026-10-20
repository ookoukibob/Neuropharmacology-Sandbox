/**
 * SimulationChart — interactive Plotly view of one simulation chart (phase 44).
 *
 * Layout contract (why the previous version overlapped):
 * The wrapper used to be `height: 360` with `responsive: true` and no
 * explicit Plotly `layout.height`. Plotly then applied its own default
 * `height: 450`, so the graph div was 450 px tall inside a 360 px fixed-height
 * box. `overflow: visible` let the extra 90 px spill over the note, table and
 * diagnostics below, and the graph kept its initial width after a resize.
 *
 * Here the height and width are explicit and owned by this component:
 * - `layout.autosize: false` with measured width/height (no Plotly default);
 * - a ResizeObserver re-measures the container and relays out on change;
 * - the container is a grid cell with `min-width: 0` so it can shrink;
 * - `overflow: hidden` is the safety net, never the fix.
 *
 * The component performs no science: traces and event shapes come from the
 * adapter, which copies engine samples verbatim (ADR-26).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Plot from 'react-plotly.js'
import {
  infusionRateTraceToPlotly,
  simulationChartLayout,
  simulationEventShapes,
  simulationTraceToPlotly,
  type SimulationChart as SimulationChartData,
  type SimulationEventMarker,
  type SimulationPlotlyTrace,
} from './simulationAdapter'

/** Deliberate plotting area (px): wide enough for analysis, no dead space. */
export const CHART_HEIGHT_PX = 320
/** Compact height for narrow viewports. */
export const CHART_HEIGHT_COMPACT_PX = 260
/** Below this container width the compact height is used. */
export const CHART_COMPACT_WIDTH_PX = 640

interface SimulationChartProps {
  readonly chart: SimulationChartData
  /** Applied events, drawn as vertical reference lines (adapter-provided). */
  readonly events: readonly SimulationEventMarker[]
  /** Plotly graph div id, unique per chart on the page. */
  readonly graphId: string
  /** Optional per-point hover text (infusion-rate chart, from `infusionRates`). */
  readonly hoverTexts?: readonly string[]
  /** Accessible name for the chart region. */
  readonly ariaLabel: string
  /** Called after the user resets zoom to the full range. */
  readonly onReset?: () => void
}

interface Size {
  readonly width: number
  readonly height: number
}

export function SimulationChart({
  chart,
  events,
  graphId,
  hoverTexts,
  ariaLabel,
  onReset,
}: SimulationChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size | null>(null)

  const measure = useCallback(() => {
    const element = containerRef.current
    if (element === null) return
    const width = element.clientWidth
    if (width <= 0) return
    const height = width < CHART_COMPACT_WIDTH_PX ? CHART_HEIGHT_COMPACT_PX : CHART_HEIGHT_PX
    setSize((current) =>
      current !== null && Math.abs(current.width - width) < 2 && current.height === height
        ? current
        : { width, height },
    )
  }, [])

  // Measure before paint (first render) and whenever the container changes.
  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const element = containerRef.current
    if (element === null || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(() => measure())
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure])

  const traces: SimulationPlotlyTrace[] = useMemo(
    () =>
      chart.traces.map((trace) =>
        hoverTexts !== undefined && chart.id === 'infusion-rate'
          ? infusionRateTraceToPlotly(trace, hoverTexts)
          : simulationTraceToPlotly(trace, chart.yLabel, chart.yUnit),
      ),
    [chart, hoverTexts],
  )

  // Plotly accepts a plain object layout; typing it as Record keeps the
  // optional-property rules of the app out of Plotly's API.
  const layout = useMemo<Record<string, unknown>>(() => {
    const base = simulationChartLayout(chart) as Record<string, unknown>
    const height = size?.height ?? CHART_HEIGHT_PX
    const shapes = simulationEventShapes(events)
    const compact = size !== null && size.width < CHART_COMPACT_WIDTH_PX
    return {
      ...base,
      // Explicit size: never let Plotly fall back to its own default height.
      autosize: false,
      ...(size === null ? {} : { width: size.width }),
      height,
      shapes: shapes.length === 0 ? [] : shapes,
      // Per-point text keeps equal timestamps distinguishable on hover.
      hovermode: 'closest',
      // Legend inside the plot area on wide screens, above it when narrow so
      // it can never sit on top of the traces.
      legend:
        compact
          ? // Narrow: the legend sits on its own row *inside* the plot area,
            // below the modebar band reserved by the top margin.
            { orientation: 'h', yanchor: 'top', y: 1, xanchor: 'left', x: 0 }
          : { orientation: 'v', yanchor: 'top', y: 1, xanchor: 'left', x: 1.02 },
      margin: compact
        ? { l: 56, r: 8, t: 12, b: 44 }
        : { l: 64, r: 16, t: 24, b: 48 },
      modebar: { orientation: 'h', bgcolor: 'rgba(0,0,0,0)', color: '#8a8a8a', activecolor: '#3b82f6' },
    }
  }, [chart, events, size])

  const config = useMemo<Record<string, unknown>>(
    () => ({
      displayModeBar: true,
      displaylogo: false,
      responsive: false, // sizing is owned here, not by Plotly's window listener
      scrollZoom: true,
      doubleClick: 'reset',
      modeBarButtonsToRemove: ['lasso2d', 'select2d', 'sendDataToCloud'],
      toImageButtonOptions: { filename: `simulation-${chart.id}` },
    }),
    [chart.id],
  )

  return (
    <div
      ref={containerRef}
      className="simulation-chart w-full min-w-0 overflow-hidden"
      // Reserve the plotting height before Plotly measures, avoiding a
      // layout jump when the lazy chart bundle finishes loading.
      style={{ height: size?.height ?? CHART_HEIGHT_PX }}
      data-testid={`simulation-chart-${chart.id}`}
      data-chart-width={size?.width ?? ''}
    >
      {size === null ? (
        <p className="text-sm text-muted-foreground">Loading chart…</p>
      ) : (
        <Plot
          divId={graphId}
          data={traces}
          layout={layout}
          config={config}
          style={{ width: '100%', height: '100%' }}
          useResizeHandler={false}
          onRelayout={(event) => {
            // A double-click / modebar "reset" returns the full axis range.
            const data = event as Record<string, unknown>
            if (data['xaxis.autorange'] === true || data['yaxis.autorange'] === true) onReset?.()
          }}
          aria-label={ariaLabel}
        />
      )}
    </div>
  )
}