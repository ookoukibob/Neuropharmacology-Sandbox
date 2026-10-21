import {
  buildSimulationCharts,
  effectSiteChart,
  infusionRateChart,
  occupancyChart,
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
  /** Effect-site concentration (phase 46) — null unless the scenario opted in. */
  readonly effectSite: SimulationChart | null
  /** Receptor occupancy as a fraction — null unless the scenario opted in. */
  readonly occupancy: SimulationChart | null
}

/** Derive the charts for a result — the adapter does all the chart work. */
export function chartsForResult(result: SimulationResult): ResultCharts {
  const built = buildSimulationCharts(result)
  if (!built.ok) {
    // A failed run offers NO charts: nothing from a previous run may linger.
    return { concentration: null, amount: null, infusionRate: null, effectSite: null, occupancy: null }
  }
  const find = (id: SimulationChart['id']): SimulationChart | null =>
    built.charts.find((chart) => chart.id === id) ?? null
  return {
    concentration: find('concentration'),
    amount: find('amount'),
    infusionRate: infusionRateChart(result),
    // Presentation-only derivation from the result sidecar; no simulation runs.
    effectSite: effectSiteChart(result),
    occupancy: occupancyChart(result),
  }
}
/** Views offered by the results panel, in display order. */
export type ChartViewId =
  | 'concentration'
  | 'amount'
  | 'infusion-rate'
  | 'effect-site'
  | 'occupancy'

export const CHART_VIEWS: readonly { readonly id: ChartViewId; readonly label: string; readonly shortLabel: string }[] = [
  { id: 'concentration', label: 'Concentration (mg/L)', shortLabel: 'Concentration' },
  { id: 'amount', label: 'Amount (mg)', shortLabel: 'Amount' },
  { id: 'infusion-rate', label: 'Infusion rate (mg/h)', shortLabel: 'Infusion rate' },
  { id: 'effect-site', label: 'Effect-site concentration (mg/L)', shortLabel: 'Effect site' },
  { id: 'occupancy', label: 'Receptor occupancy (fraction)', shortLabel: 'Occupancy' },
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
    case 'effect-site':
      return charts.effectSite
    case 'occupancy':
      return charts.occupancy
  }
}

/**
 * Views that exist ONLY when the run produced their series (phase 46). They
 * are omitted entirely rather than shown disabled, so a PK-only or failed run
 * never implies that effect-site data exists.
 */
export const OPT_IN_VIEWS: ReadonlySet<ChartViewId> = new Set<ChartViewId>(['effect-site', 'occupancy'])

/** Why a view has no chart for this run, in the user's terms. */
export function unavailableReason(view: ChartViewId): string {
  if (view === 'infusion-rate') return 'not applicable: this run has no infusion'
  if (view === 'effect-site' || view === 'occupancy') {
    return 'effect-site analysis was not enabled for this run'
  }
  return 'not available for this run'
}

/** First view that has a chart; concentration is always present on success. */
export function firstAvailableView(charts: ResultCharts): ChartViewId {
  for (const view of CHART_VIEWS) if (chartForView(charts, view.id) !== null) return view.id
  return 'concentration'
}
