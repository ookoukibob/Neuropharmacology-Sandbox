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
