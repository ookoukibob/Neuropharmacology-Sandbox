import { lazy, Suspense, useCallback, useRef, useState } from 'react'
import { ScientificText } from '@/components/scientific/ScientificText'
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
  unavailableReason,
  OPT_IN_VIEWS,
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
 * Accessible view switcher: a radio group with a roving tabindex.
 *
 * - ArrowLeft / ArrowRight (and Up / Down) move the selection, wrap around and
 *   skip unavailable views, and move DOM focus to the newly selected option;
 * - Tab enters the group at the selected option (the only tabbable one);
 * - unavailable options are disabled, skipped by the arrow keys and never
 *   receive focus.
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
  const groupRef = useRef<HTMLDivElement>(null)
  // Fallback tab stop when the selected view is unavailable: the first
  // enabled option, so Tab always enters the group.
  const fallbackTabStop = CHART_VIEWS.find((item) => chartForView(charts, item.id) !== null)?.id
  const selectedUnavailable = chartForView(charts, active) === null

  const selectAndFocus = (view: ChartViewId) => {
    // Focus synchronously: the button already exists, so it can take focus
    // before React re-renders (which only changes aria-checked/tabIndex).
    groupRef.current
      ?.querySelector<HTMLButtonElement>(`[data-testid="view-tab-${view}"]`)
      ?.focus()
    onSelect(view)
  }

  const move = (direction: 1 | -1) => {
    const enabled = CHART_VIEWS.filter((item) => chartForView(charts, item.id) !== null).map((item) => item.id)
    if (enabled.length === 0) return
    const index = enabled.indexOf(active)
    const next = enabled[(index + direction + enabled.length) % enabled.length]
    if (next !== undefined) selectAndFocus(next)
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Chart view"
      className="flex flex-wrap items-center gap-1 border-b border-border pb-1"
      data-testid="chart-view-tabs"
    >
      {CHART_VIEWS.map((item) => {
        const available = chartForView(charts, item.id) !== null
        // Phase 46 views exist only when the run produced them: a PK-only or
        // failed run offers no effect-site/occupancy tab at all (no fabricated
        // series, no disabled placeholder implying the data exists).
        if (OPT_IN_VIEWS.has(item.id) && !available) return null
        const checked = active === item.id
        // Exactly one tabbable option: the selected view when it is
        // available, otherwise the first available view.
        const tabStop = available && (checked || (selectedUnavailable && item.id === fallbackTabStop))
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!available}
            tabIndex={tabStop ? 0 : -1}
            onClick={() => {
              if (available) onSelect(item.id)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault()
                move(-1)
              } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault()
                move(1)
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                const enabled = CHART_VIEWS.filter((entry) => chartForView(charts, entry.id) !== null)
                const target = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]
                if (target !== undefined) selectAndFocus(target.id)
              }
            }}
            className={`rounded-t-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              checked
                ? 'border-b-2 border-foreground font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            } ${available ? '' : 'cursor-not-allowed opacity-40'}`}
            data-testid={`view-tab-${item.id}`}
            title={available ? item.label : `${item.shortLabel} — ${unavailableReason(item.id)}`}
          >
            {item.shortLabel}
            {available ? null : <span className="sr-only"> (not available)</span>}
          </button>
        )
      })}
      {charts.infusionRate === null ? (
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
            <ScientificText value="Mass balance (A_c + A_p + A_e − A_ref − A_in)" />
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
                <dt className="text-muted-foreground">
                  <ScientificText value={parameter.label} />
                </dt>
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
                  <ScientificText value={warning.message} />
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
              <li key={equation}>
                <ScientificText value={equation} />
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 text-sm">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Structural assumptions
          </h4>
          <ul className="list-disc space-y-1 pl-4" data-testid="model-assumptions">
            {result.assumptions.map((assumption) => (
              <li key={assumption}>
                <ScientificText value={assumption} />
              </li>
            ))}
          </ul>
        </div>
      </div>
      {result.effectSite === undefined ? null : <EffectSiteExplanation result={result} />}
      <p className="rounded-md border p-3 text-xs text-muted-foreground" data-testid="qualification-note">
        A completed numerical run means the integrator finished within its configured tolerances
        and reported a mass balance inside its derived tolerance. It does not mean the model has
        been externally qualified or clinically validated.
      </p>
    </section>
  )
}

/**
 * Effect-site model explanation for ONE run (phase 46).
 *
 * Every value shown is the one that run actually used — read from
 * `result.effectSite`, never recomputed here. The assumptions come from the
 * engine's own `EFFECT_SITE_ASSUMPTIONS` list carried on the sidecar, so the
 * UI cannot drift from the engine's stated contract.
 */
function EffectSiteExplanation({ result }: { readonly result: SimulationResult }) {
  const effect = result.effectSite
  if (effect === undefined) return null
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3 text-sm" data-testid="effect-site-explanation">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Effect-site and receptor occupancy
      </h4>
      <ul className="list-disc space-y-1 pl-4 text-xs" data-testid="effect-site-equations">
        <li className="font-mono">
          <ScientificText value="dC_e/dt = k_e0 · (f_u · C_c − C_e)" />
        </li>
        <li className="font-mono">
          <ScientificText value="Occupancy(t) = C_e(t) / (C_e(t) + K_d)" />
        </li>
      </ul>
      <dl
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-xs"
        data-testid="effect-site-parameters"
      >
        <dt className="text-muted-foreground">
          <ScientificText value="Unbound fraction f_u" />
        </dt>
        <dd className="font-mono">{formatNumber(effect.unboundFraction)}</dd>
        <dt className="text-muted-foreground">
          <ScientificText value="Equilibration rate k_e0" />
        </dt>
        <dd className="font-mono">{formatNumber(effect.ke0)} h⁻¹</dd>
        <dt className="text-muted-foreground">
          <ScientificText value="K_d used for occupancy" />
        </dt>
        <dd className="font-mono">
          {formatNumber(effect.kdInPkUnit)} {effect.concentrationUnit}
        </dd>
        <dt className="text-muted-foreground">
          <ScientificText value="K_d unit conversion" />
        </dt>
        <dd className="font-mono">
          {effect.kdConversion === 'same-unit'
            ? 'none (declared in the model unit)'
            : effect.kdConversion === 'unit-conversion'
              ? 'mass-concentration conversion'
              : 'molar → mass via the supplied molecular weight'}
        </dd>
        {effect.molecularWeightUsed === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Molecular weight used</dt>
            <dd className="font-mono">{formatNumber(effect.molecularWeightUsed)} g/mol</dd>
          </>
        )}
      </dl>
      <p className="text-xs text-muted-foreground" data-testid="effect-site-method-note">
        The effect-site series is post-processed from the emitted PK samples, reconstructing the
        unbound concentration as piecewise linear between them. It is exact for that reconstruction
        — not for the true continuous PK trajectory, and not identical to integrating the PK and
        effect-site equations jointly. Convergence with a finer output grid was measured for the
        analytical one-compartment case only; the same bound is not claimed for every
        two-compartment trajectory.
      </p>
      <p className="text-xs text-muted-foreground" data-testid="effect-site-event-note">
        <ScientificText
          value={
            'C_e starts at equilibrium with the pre-event central concentration at the start time ' +
            '(C_e = f_u · C_c, pre-event). An instantaneous bolus changes C_c but not C_e or ' +
            'occupancy; propagation over the following interval starts from the post-event ' +
            'concentration. C_e is a derived concentration variable and is excluded from physical ' +
            'drug-mass accounting.'
          }
        />
      </p>
      <ul className="list-disc space-y-1 pl-4 text-xs" data-testid="effect-site-assumptions">
        {effect.assumptions.map((assumption) => (
          <li key={assumption}>
            <ScientificText value={assumption} />
          </li>
        ))}
      </ul>
    </div>
  )
}