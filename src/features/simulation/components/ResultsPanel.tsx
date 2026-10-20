import { lazy, Suspense } from 'react'
import {
  describeSimulationEvent,
  formatNumber,
  infusionRateHoverTexts,
  type SimulationChart,
  type SimulationEventMarker,
} from '@/components/charts/simulationAdapter'
import type { ChartVisibility, ResultCharts } from './resultCharts'
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

export function ChartToggles({
  charts,
  visibility,
  onChange,
}: {
  readonly charts: ResultCharts
  readonly visibility: ChartVisibility
  readonly onChange: (patch: Partial<ChartVisibility>) => void
}) {
  const rows = [
    { key: 'concentration' as const, label: 'Concentration chart', available: charts.concentration !== null },
    { key: 'amount' as const, label: 'Amount chart', available: charts.amount !== null },
    { key: 'infusionRate' as const, label: 'Infusion-rate chart', available: charts.infusionRate !== null },
  ]
  return (
    <fieldset className="flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="chart-toggles">
      <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Show charts
      </legend>
      {rows.map((row) => (
        <label key={row.key} className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={row.available && visibility[row.key]}
            disabled={!row.available}
            onChange={(event) => onChange({ [row.key]: event.target.checked } as Partial<ChartVisibility>)}
            data-testid={`toggle-${row.key}`}
          />
          {row.label}
          {row.available ? null : (
            <span className="text-xs text-muted-foreground">(not applicable: no infusion in this run)</span>
          )}
        </label>
      ))}
    </fieldset>
  )
}

export function ResultsPanel({
  result,
  events,
  charts,
  visibility,
}: {
  readonly result: SimulationResult
  readonly events: readonly SimulationEventMarker[]
  readonly charts: ResultCharts
  readonly visibility: ChartVisibility
}) {
  const shown = [
    visibility.concentration ? charts.concentration : null,
    visibility.amount ? charts.amount : null,
    visibility.infusionRate ? charts.infusionRate : null,
  ].filter((chart): chart is SimulationChart => chart !== null)
  const rateHover = charts.infusionRate === null ? undefined : infusionRateHoverTexts(result)

  return (
    <section aria-labelledby="results-heading" className="flex flex-col gap-4">
      <h2 id="results-heading" className="text-base font-medium">
        Results
      </h2>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-charts-shown">
          All charts are hidden. The result and its diagnostics remain available below.
        </p>
      ) : null}
      {shown.map((chart) => (
        <figure key={chart.id} className="flex flex-col gap-2">
          <figcaption className="text-sm">
            <span className="font-medium">{chart.title}</span>
            <span className="ml-2 text-muted-foreground">
              {chart.yLabel} in {chart.yUnit} against {chart.xLabel.toLowerCase()} in {chart.xUnit}.
            </span>
          </figcaption>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading chart…</p>}>
            <LazySimulationChart
              chart={chart}
              events={events}
              graphId={`simulation-chart-${chart.id}`}
              {...(rateHover === undefined ? {} : { hoverTexts: rateHover })}
            />
          </Suspense>
          <p className="text-xs text-muted-foreground">
            {chart.id === 'infusion-rate'
              ? 'The engine reports the total rate just before and just after every event, so a start or a stop is a vertical step. Values come from the simulation result; nothing is reconstructed here.'
              : 'Each curve is the engine’s reported samples in order. At a dosing event two samples share one timestamp (“just before” and “just after”), so the jump is drawn vertically at the event time.'}
          </p>
        </figure>
      ))}
      <EventTable events={events} />
      <Diagnostics result={result} />
    </section>
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
    <section aria-labelledby="diagnostics-heading" className="flex flex-col gap-4">
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
        <div className="text-sm">
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
        <div className="text-sm">
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
        <div className="text-sm">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Model equations</h4>
          <ul className="space-y-1 font-mono text-xs" data-testid="model-equations">
            {result.model.equations.map((equation) => (
              <li key={equation}>{equation}</li>
            ))}
          </ul>
        </div>
        <div className="text-sm">
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
