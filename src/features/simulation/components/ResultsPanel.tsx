import { lazy, Suspense, useCallback, useState } from 'react'
import {
  describeSimulationEvent,
  formatNumber,
  infusionRateHoverTexts,
  type SimulationChart as SimulationChartData,
  type SimulationEventMarker,
} from '@/components/charts/simulationAdapter'
import {
  CHART_VIEWS,
  chartForView,
  firstAvailableView,
  type ChartViewId,
  type ResultCharts,
} from './resultCharts'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { SimulationResult } from '@/engine/simulation/types'

const LazySimulationChart = lazy(() =>
  import('@/components/charts/SimulationChart').then((mod) => ({ default: mod.SimulationChart })),
)

/**
 * Results area (phase 44): one large analysis chart with a view switcher,
 * followed by the event table and diagnostics.
 *
 * Switching views is presentation only: the adapter output for every view is
 * already computed, the engine is never called, and the scenario is untouched.
 */
export function ResultsPanel({
  result,
  events,
  charts,
}: {
  readonly result: SimulationResult
  readonly events: readonly SimulationEventMarker[]
  readonly charts: ResultCharts
}) {
  const [view, setView] = useState<ChartViewId>(() => firstAvailableView(charts))
  const [resetKey, setResetKey] = useState(0)
  const active = chartForView(charts, view)
  const rateHover = active?.id === 'infusion-rate' ? infusionRateHoverTexts(result) : undefined

  const selectView = useCallback((next: ChartViewId) => {
    setView(next)
    setResetKey((key) => key + 1)
  }, [])

  return (
    <section aria-labelledby="results-heading" className="flex min-w-0 flex-col gap-4">
      <h2 id="results-heading" className="text-base font-medium">
        Results
      </h2>

      <ChartViewTabs charts={charts} active={view} onSelect={selectView} />

      {active === null ? (
        <p className="text-sm text-muted-foreground" data-testid="chart-view-unavailable">
          This view is not available for the current result.
        </p>
      ) : (
        <ChartFigure
          key={`${active.id}-${resetKey}`}
          chart={active}
          events={events}
          hoverTexts={rateHover}
        />
      )}

      <EventTable events={events} />
      <Diagnostics result={result} />
    </section>
  )
}

/**
 * Accessible view switcher: a radio group (arrow keys move between views,
 * unavailable views are skipped), styled as compact tabs.
 */
function ChartViewTabs({
  charts,
  active,
  onSelect,
}: {
  readonly charts: ResultCharts
  readonly active: ChartViewId
  readonly onSelect: (view: ChartViewId) => void
}) {
  const enabled = CHART_VIEWS.filter((item) => chartForView(charts, item.id) !== null)
  return (
    <div
      role="radiogroup"
      aria-label="Chart view"
      className="flex flex-wrap items-center gap-1 border-b border-border pb-1"
      data-testid="chart-view-tabs"
    >
      {CHART_VIEWS.map((item) => {
        const available = chartForView(charts, item.id) !== null
        const checked = active === item.id
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!available}
            tabIndex={checked || (!available && enabled[0]?.id === item.id) ? 0 : available ? -1 : -1}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              const index = enabled.findIndex((entry) => entry.id === (checked ? item.id : active))
              const step = event.key === 'ArrowRight' ? 1 : -1
              const next = enabled[(index + step + enabled.length) % enabled.length]
              if (next !== undefined) onSelect(next.id)
            }}
            className={`rounded-t-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              checked
                ? 'border-b-2 border-foreground font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            } ${available ? '' : 'cursor-not-allowed opacity-40'}`}
            data-testid={`view-tab-${item.id}`}
            title={available ? item.label : `${item.shortLabel} — not applicable: this run has no infusion`}
          >
            {item.shortLabel}
            {available ? null : <span className="sr-only"> (not available)</span>}
          </button>
        )
      })}
      {enabled.length < CHART_VIEWS.length ? (
        <span className="ml-2 text-xs text-muted-foreground" data-testid="view-availability-note">
          Infusion rate unavailable: this run has no infusion.
        </span>
      ) : null}
    </div>
  )
}

function ChartFigure({
  chart,
  events,
  hoverTexts,
}: {
  readonly chart: SimulationChartData
  readonly events: readonly SimulationEventMarker[]
  readonly hoverTexts: readonly string[] | undefined
}) {
  const captionId = `chart-caption-${chart.id}`
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2" data-testid="chart-figure">
      <figcaption id={captionId} className="text-sm">
        <span className="font-medium">{chart.title}</span>
        <span className="ml-2 text-muted-foreground">
          {chart.yLabel} ({chart.yUnit}) against {chart.xLabel.toLowerCase()} ({chart.xUnit}). Drag to
          zoom, double-click or press reset to return to the full range.
        </span>
      </figcaption>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading chart…</p>}>
        <LazySimulationChart
          chart={chart}
          events={events}
          graphId={`simulation-chart-${chart.id}`}
          ariaLabel={`${chart.title}: ${chart.yLabel} in ${chart.yUnit} against ${chart.xLabel} in ${chart.xUnit}`}
          {...(hoverTexts === undefined ? {} : { hoverTexts })}
        />
      </Suspense>
      <p className="text-xs text-muted-foreground">
        {chart.id === 'infusion-rate'
          ? 'The engine reports the total rate just before and just after every event, so a start or a stop is a vertical step. Values come from the simulation result; nothing is reconstructed here.'
          : 'Each curve is the engine’s reported samples in order. At a dosing event two samples share one timestamp (“just before” and “just after”), so the jump is drawn vertically at the event time. Dotted lines mark dosing events.'}
      </p>
    </figure>
  )
}

function EventTable({ events }: { readonly events: readonly SimulationEventMarker[] }) {
  return (
    <Table data-testid="event-table">
      <TableCaption>
        Every applied dosing event, in the order the engine applied it. Events sharing a time are
        kept separate.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">#</TableHead>
          <TableHead scope="col">Time (h)</TableHead>
          <TableHead scope="col">Type</TableHead>
          <TableHead scope="col">Details</TableHead>
          <TableHead scope="col">Infusion</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event, index) => (
          <TableRow key={event.eventId} data-testid={`event-row-${event.eventId}`}>
            <TableCell>{index + 1}</TableCell>
            <TableCell className="font-mono">{formatNumber(event.time)}</TableCell>
            <TableCell>{labelOf(event.type)}</TableCell>
            <TableCell>
              {describeSimulationEvent(event)}
              {event.canonicalValue === undefined || event.declaredValue === undefined ? null : (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({formatNumber(event.canonicalValue)} {event.canonicalUnit})
                </span>
              )}
            </TableCell>
            <TableCell className="font-mono text-xs">{event.infusionId ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function labelOf(type: SimulationEventMarker['type']): string {
  switch (type) {
    case 'iv-bolus':
      return 'IV bolus'
    case 'infusion-start':
      return 'Infusion start'
    case 'infusion-stop':
      return 'Infusion stop'
  }
}

function Diagnostics({ result }: { readonly result: SimulationResult }) {
  const { solver, massBalance, warnings } = result
  return (
    <section aria-labelledby="diagnostics-heading" className="flex min-w-0 flex-col gap-4">
      <h3 id="diagnostics-heading" className="text-base font-medium">
        Diagnostics
      </h3>
      <div className="grid gap-4 md:grid-cols-2">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm" data-testid="solver-diagnostics">
          <dt className="col-span-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Numerical integration
          </dt>
          <dt className="text-muted-foreground">Method</dt>
          <dd className="font-mono text-xs">{solver.method}</dd>
          <dt className="text-muted-foreground">Absolute / relative tolerance</dt>
          <dd className="font-mono text-xs">
            {formatNumber(solver.settings.absoluteTolerance)} / {formatNumber(solver.settings.relativeTolerance)}
          </dd>
          <dt className="text-muted-foreground">Step bounds (initial / min / max, h)</dt>
          <dd className="font-mono text-xs">
            {formatNumber(solver.settings.initialStep)} / {formatNumber(solver.settings.minStep)} /{' '}
            {formatNumber(solver.settings.maxStep)}
          </dd>
          <dt className="text-muted-foreground">Accepted steps</dt>
          <dd className="font-mono text-xs">{solver.acceptedSteps}</dd>
          <dt className="text-muted-foreground">Rejected steps</dt>
          <dd className="font-mono text-xs">{solver.rejectedSteps}</dd>
          <dt className="text-muted-foreground">Derivative evaluations</dt>
          <dd className="font-mono text-xs">{solver.functionEvaluations}</dd>
        </dl>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm" data-testid="mass-balance-diagnostics">
          <dt className="col-span-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Mass balance (A_c + A_p + A_e − A_ref − A_in)
          </dt>
          <dt className="text-muted-foreground">Largest |residual|</dt>
          <dd className="font-mono text-xs">{formatNumber(massBalance.maxAbsResidual)} mg</dd>
          <dt className="text-muted-foreground">Acceptance tolerance</dt>
          <dd className="font-mono text-xs">{formatNumber(massBalance.tolerance)} mg</dd>
          <dt className="text-muted-foreground">Check</dt>
          <dd className="text-xs">{massBalance.ok ? 'within tolerance' : 'failed'}</dd>
        </dl>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 text-sm">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Parameters as the engine received them (canonical units)
          </h4>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
            {result.parameters.map((parameter) => (
              <div key={parameter.symbol} className="contents">
                <dt className="text-muted-foreground">{parameter.label}</dt>
                <dd className="text-right font-mono text-xs">
                  {formatNumber(parameter.canonicalValue)} {parameter.canonicalUnit}
                  {parameter.conversionFactor === undefined ? null : (
                    <span className="ml-1 text-muted-foreground">
                      (from {formatNumber(parameter.declaredValue)} {parameter.declaredUnit})
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="min-w-0 text-sm">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Warnings</h4>
          {warnings.length === 0 ? (
            <p className="text-muted-foreground">None reported.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-4" data-testid="simulation-warnings">
              {warnings.map((warning) => (
                <li key={warning.code + warning.message}>
                  <span className="mr-1 font-mono text-xs">{warning.code}</span>
                  {warning.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 text-sm">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Model equations</h4>
          <ul className="space-y-1 font-mono text-xs" data-testid="model-equations">
            {result.model.equations.map((equation) => (
              <li key={equation}>{equation}</li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 text-sm">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Structural assumptions
          </h4>
          <ul className="list-disc space-y-1 pl-4" data-testid="model-assumptions">
            {result.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="rounded-md border p-3 text-xs text-muted-foreground" data-testid="qualification-note">
        A completed numerical run means the integrator finished within its configured tolerances
        and reported a mass balance inside its derived tolerance. It does not mean the model has
        been externally qualified or clinically validated.
      </p>
    </section>
  )
}
