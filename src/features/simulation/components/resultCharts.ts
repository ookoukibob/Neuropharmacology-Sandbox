import {
  buildSimulationCharts,
  infusionRateChart,
  type SimulationChart,
} from '@/components/charts/simulationAdapter'
import type { SimulationResult } from '@/engine/simulation/types'

/** Which charts the viewer chose to display (session only, never persisted). */
export interface ChartVisibility {
  readonly concentration: boolean
  readonly amount: boolean
  readonly infusionRate: boolean
}

export const DEFAULT_CHART_VISIBILITY: ChartVisibility = {
  concentration: true,
  amount: true,
  infusionRate: true,
}

/** Charts available for one result, in display order. */
export interface ResultCharts {
  readonly concentration: SimulationChart | null
  readonly amount: SimulationChart | null
  readonly infusionRate: SimulationChart | null
}

/** Derive the charts for a result — the adapter does all the chart work. */
export function chartsForResult(result: SimulationResult): ResultCharts {
  const built = buildSimulationCharts(result)
  if (!built.ok) return { concentration: null, amount: null, infusionRate: null }
  const find = (id: SimulationChart['id']): SimulationChart | null =>
    built.charts.find((chart) => chart.id === id) ?? null
  return {
    concentration: find('concentration'),
    amount: find('amount'),
    infusionRate: infusionRateChart(result),
  }
}
/** Views offered by the results panel, in display order. */
export type ChartViewId = 'concentration' | 'amount' | 'infusion-rate'

export const CHART_VIEWS: readonly { readonly id: ChartViewId; readonly label: string; readonly shortLabel: string }[] = [
  { id: 'concentration', label: 'Concentration (mg/L)', shortLabel: 'Concentration' },
  { id: 'amount', label: 'Amount (mg)', shortLabel: 'Amount' },
  { id: 'infusion-rate', label: 'Infusion rate (mg/h)', shortLabel: 'Infusion rate' },
]

/** The chart for one view, or null when that view is unavailable. */
export function chartForView(charts: ResultCharts, view: ChartViewId): SimulationChart | null {
  switch (view) {
    case 'concentration':
      return charts.concentration
    case 'amount':
      return charts.amount
    case 'infusion-rate':
      return charts.infusionRate
  }
}

/** First view that has a chart; concentration is always present on success. */
export function firstAvailableView(charts: ResultCharts): ChartViewId {
  for (const view of CHART_VIEWS) if (chartForView(charts, view.id) !== null) return view.id
  return 'concentration'
}
