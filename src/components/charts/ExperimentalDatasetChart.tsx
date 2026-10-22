/**
 * Plotly view of observed concentration–time measurements (phase 47A).
 *
 * The chart is presentation only: the adapter maps the stored measurements to
 * marker traces, and this component owns sizing. The accessible measurement
 * table is always rendered by the parent and is the source of the values.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import Plot from 'react-plotly.js'
import type { ExperimentalDataset } from '@/domain/experiments/experimental-dataset'
import {
  buildExperimentalDatasetChart,
  type ExperimentalDatasetFitOverlay,
} from './experimentalDatasetAdapter'

export const DATASET_CHART_HEIGHT_PX = 320
export const DATASET_CHART_COMPACT_HEIGHT_PX = 260
const DATASET_CHART_COMPACT_WIDTH_PX = 640

interface ExperimentalDatasetChartProps {
  readonly dataset: ExperimentalDataset
  readonly graphId: string
  /** Optional fitted curve to draw as a separate line trace (phase 47B). */
  readonly fitOverlay?: ExperimentalDatasetFitOverlay
}

interface Size {
  readonly width: number
  readonly height: number
}

export function ExperimentalDatasetChart({
  dataset,
  graphId,
  fitOverlay,
}: ExperimentalDatasetChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size | null>(null)
  const chart = useMemo(
    () => buildExperimentalDatasetChart(dataset, fitOverlay),
    [dataset, fitOverlay],
  )

  const measure = useCallback(() => {
    const element = containerRef.current
    if (element === null) return
    const width = element.clientWidth
    if (width <= 0) return
    const height =
      width < DATASET_CHART_COMPACT_WIDTH_PX
        ? DATASET_CHART_COMPACT_HEIGHT_PX
        : DATASET_CHART_HEIGHT_PX
    setSize((current) =>
      current !== null && Math.abs(current.width - width) < 2 && current.height === height
        ? current
        : { width, height },
    )
  }, [])

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

  const layout = useMemo<Record<string, unknown>>(() => {
    const height = size?.height ?? DATASET_CHART_HEIGHT_PX
    return {
      ...chart.layout,
      autosize: false,
      ...(size === null ? {} : { width: size.width }),
      height,
    }
  }, [chart.layout, size])

  const config = useMemo<Record<string, unknown>>(
    () => ({
      displayModeBar: true,
      displaylogo: false,
      responsive: false,
      scrollZoom: true,
      doubleClick: 'reset',
      modeBarButtonsToRemove: ['lasso2d', 'select2d', 'sendDataToCloud'],
      toImageButtonOptions: { filename: `experimental-dataset-${graphId}` },
    }),
    [graphId],
  )

  return (
    <div
      ref={containerRef}
      className="w-full min-w-0 overflow-hidden"
      style={{ height: size?.height ?? DATASET_CHART_HEIGHT_PX }}
      data-testid="experimental-dataset-chart"
    >
      {size === null ? (
        <p className="text-sm text-muted-foreground">Loading chart…</p>
      ) : (
        <Plot
          divId={graphId}
          data={chart.traces as NonNullable<ComponentProps<typeof Plot>['data']>}
          layout={layout}
          config={config}
          style={{ width: '100%', height: '100%' }}
          useResizeHandler={false}
          aria-label={chart.ariaLabel}
        />
      )}
    </div>
  )
}

export default ExperimentalDatasetChart
