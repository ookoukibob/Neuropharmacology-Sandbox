/**
 * SimulationView — the phase-42 demonstration workflow.
 *
 *   DEMO_SCENARIO (explicit synthetic parameters)
 *      ↓ user presses "Run demonstration"
 *   simulate()  ← the real Phase 41 engine; the ONLY source of every number
 *      ↓ SimulationReport
 *   simulationAdapter (pure) → SimulationChart (Plotly, lazy)
 *      ↓
 *   charts + event table + diagnostics
 *
 * No formula, parameter default or integral lives in this file: it renders
 * what the engine returned.
 */
import { AlertCircle, Info, Play } from 'lucide-react'
import { Suspense, lazy, useMemo, useRef } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  buildSimulationCharts,
  describeSimulationEvent,
  formatNumber,
  type SimulationEventMarker,
} from '@/components/charts/simulationAdapter'
import type { SimulationResult } from '@/engine/simulation/types'
import { DEMO_SCENARIO, DEMO_SCENARIO_ROWS } from './demoScenario'
import { useSimulationRunner } from './useSimulationRunner'

const LazySimulationChart = lazy(() =>
  import('@/components/charts/SimulationChart').then((mod) => ({ default: mod.SimulationChart })),
)

const SYNTHETIC_DISCLAIMER =
  'Synthetic demonstration parameters. These numbers are invented for testing the simulation engine: they are not real compound parameters, not clinical estimates, not recommendations, and not evidence of clinical validity.'

export function SimulationView() {
  const { state, run } = useSimulationRunner()
  const resultsRef = useRef<HTMLDivElement>(null)

  const charts = useMemo(
    () => (state.status === 'success' ? buildSimulationCharts(state.result) : null),
    [state],
  )

  return (
    <div className="flex flex-col gap-6">
      <Alert data-testid="synthetic-scenario-notice">
        <Info className="size-4" aria-hidden="true" />
        <AlertTitle>Synthetic demonstration scenario</AlertTitle>
        <AlertDescription>
          <p>{SYNTHETIC_DISCLAIMER}</p>
          <p className="mt-1">
            Model output is mathematics on those supplied parameters; it is not a clinical
            prediction and never observed data.
          </p>
        </AlertDescription>
      </Alert>

      <section aria-labelledby="scenario-heading" className="rounded-lg border p-4">
        <h2 id="scenario-heading" className="text-base font-medium">
          Demonstration scenario
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Open, linear two-compartment IV model. Doses are applied at their exact times; the
          engine integrates to every event time, so a bolus is an instantaneous jump.
        </p>
        <ScenarioTable />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => run(DEMO_SCENARIO)} data-testid="run-demonstration">
            <Play className="size-4" aria-hidden="true" />
            Run demonstration
          </Button>
          <p className="text-xs text-muted-foreground">
            Runs the deterministic demo scenario through the simulation engine. Nothing is saved.
          </p>
        </div>
      </section>

      <div ref={resultsRef} tabIndex={-1} className="flex flex-col gap-6 focus:outline-none">
        {state.status === 'failure' && <FailureReport errors={state.errors} runNumber={state.runNumber} />}
        {state.status === 'success' && charts !== null && (
          charts.ok ? (
            <SuccessReport
              result={state.result}
              events={charts.events}
              charts={charts.charts}
              runNumber={state.runNumber}
            />
          ) : (
            <Alert variant="destructive" data-testid="chart-failure">
              <AlertCircle className="size-4" aria-hidden="true" />
              <AlertTitle>Result cannot be charted</AlertTitle>
              <AlertDescription>{charts.reason}</AlertDescription>
            </Alert>
          )
        )}
        {state.status === 'idle' && (
          <p className="text-sm text-muted-foreground" data-testid="simulation-idle">
            No simulation has been run yet. Press “Run demonstration” to compute the scenario.
          </p>
        )}
      </div>
    </div>
  )
}

function ScenarioTable() {
  const groups = useMemo(() => {
    const order = ['Parameters', 'Initial state', 'Horizon', 'Dosing events', 'Solver'] as const
    return order.map((group) => ({
      group,
      rows: DEMO_SCENARIO_ROWS.filter((row) => row.group === group),
    }))
  }, [])

  return (
    <div className="mt-3 grid gap-4 md:grid-cols-2" data-testid="scenario-parameters">
      {groups.map(({ group, rows }) => (
        <section key={group} aria-label={group} className="text-sm">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group}
          </h3>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
            {rows.map((row) => (
              <div key={`${row.group}-${row.label}`} className="contents">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="text-right font-mono text-xs">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

function FailureReport({
  errors,
  runNumber,
}: {
  readonly errors: readonly { readonly code: string; readonly stage: string; readonly field?: string; readonly eventId?: string; readonly message: string }[]
  readonly runNumber: number
}) {
  void runNumber
  return (
    <Alert variant="destructive" data-testid="simulation-errors">
      <AlertCircle className="size-4" aria-hidden="true" />
      <AlertTitle>Simulation failed — no results are shown</AlertTitle>
      <AlertDescription>
        <p className="mb-2">
          The engine rejected the scenario or could not complete the integration. No partial
          curve is displayed.
        </p>
        <ul className="list-disc space-y-1 pl-4">
          {errors.map((error, index) => (
            <li key={`${error.code}-${index}`} className="text-sm">
              <span className="mr-1 font-mono text-xs">{error.code}</span>
              {error.message}
              {error.field === undefined ? '' : ` (field: ${error.field})`}
              {error.eventId === undefined ? '' : ` (event: ${error.eventId})`}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

function SuccessReport({
  result,
  events,
  charts,
  runNumber,
}: {
  readonly result: SimulationResult
  readonly events: readonly SimulationEventMarker[]
  readonly charts: NonNullable<ReturnType<typeof buildSimulationCharts> & { ok: true }>['charts']
  readonly runNumber: number
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-testid="simulation-summary">
        <Badge variant="secondary">
          {result.model.label} · v{result.model.version}
        </Badge>
        <Badge variant="outline">Run {runNumber}</Badge>
        <span className="text-sm text-muted-foreground">
          {result.samples.length} reported samples over {formatNumber(result.startTime)}–
          {formatNumber(result.endTime)} h
        </span>
      </div>

      <section aria-labelledby="events-heading">
        <h2 id="events-heading" className="text-base font-medium">
          Dosing events
        </h2>
        <EventTable events={events} />
      </section>

      <section aria-labelledby="charts-heading" className="flex flex-col gap-6">
        <h2 id="charts-heading" className="text-base font-medium">
          Results
        </h2>
        {charts.map((chart) => (
          <figure key={chart.id} className="flex flex-col gap-2">
            <figcaption className="text-sm">
              <span className="font-medium">{chart.title}</span>
              <span className="ml-2 text-muted-foreground">
                {chart.yLabel} in {chart.yUnit} against {chart.xLabel.toLowerCase()} in{' '}
                {chart.xUnit}.
              </span>
            </figcaption>
            <Suspense fallback={<p className="text-sm text-muted-foreground">Loading chart…</p>}>
              <LazySimulationChart chart={chart} events={events} graphId={`simulation-chart-${chart.id}`} />
            </Suspense>
            <p className="text-xs text-muted-foreground" id={`simulation-caption-${chart.id}`}>
              Each curve is the engine’s reported samples in order. At a dosing event two
              samples share one timestamp (“just before” and “just after”), so the jump is drawn
              vertically at the event time. The same values are listed in the diagnostics below.
            </p>
          </figure>
        ))}
      </section>

      <Diagnostics result={result} />
    </>
  )
}

function EventTable({ events }: { readonly events: readonly SimulationEventMarker[] }) {
  return (
    <Table data-testid="event-table">
      <TableCaption>
        Every applied dosing event, in the order the engine applied it. Events sharing a time
        are kept separate.
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
            <TableCell>{eventLabel(event.type)}</TableCell>
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

function eventLabel(type: SimulationEventMarker['type']): string {
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
      <h2 id="diagnostics-heading" className="text-base font-medium">
        Diagnostics
      </h2>

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
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Parameters (canonical units)
          </h3>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
            {result.parameters.map((parameter) => (
              <div key={parameter.symbol} className="contents">
                <dt className="text-muted-foreground">{parameter.label}</dt>
                <dd className="text-right font-mono text-xs">
                  {formatNumber(parameter.canonicalValue)} {parameter.canonicalUnit}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="text-sm">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Warnings
          </h3>
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
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Model equations
          </h3>
          <ul className="space-y-1 font-mono text-xs" data-testid="model-equations">
            {result.model.equations.map((equation) => (
              <li key={equation}>{equation}</li>
            ))}
          </ul>
        </div>
        <div className="text-sm">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Structural assumptions
          </h3>
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
