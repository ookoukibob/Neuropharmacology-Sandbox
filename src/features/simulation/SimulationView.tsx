/**
 * SimulationView — the phase-43 general scenario editor.
 *
 *   SimulationDraft (strings)  ──compileScenario()──▶  SimulationScenario
 *        ▲                                                   │ (or draft errors)
 *        │ user edits                      "Run simulation"  ▼
 *        └───────────────────────────────  simulate()  ◀── snapshot (once per action)
 *                                                │
 *                                                ▼  SimulationReport
 *                              simulationAdapter → charts / events / diagnostics
 *
 * `simulate()` is the only source of every scientific number on this page.
 * Nothing runs during render, typing or in an effect: a result exists only
 * after an explicit run, and it is cleared as soon as the draft changes.
 */
import { AlertCircle, Info, Play, RotateCcw } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { buildSimulationCharts } from '@/components/charts/simulationAdapter'
import {
  compileScenario,
  demoDraft,
  newBolusRow,
  newInfusionRow,
  type CompileResult,
  type EventRow,
  type SimulationDraft,
} from './draft'
import { EventEditor } from './components/EventEditor'
import {
  HorizonSection,
  ParameterSection,
  ScenarioErrorSummary,
  SolverSection,
} from './components/ScenarioSections'
import { ResultsPanel } from './components/ResultsPanel'
import { chartsForResult } from './components/resultCharts'
import { useSimulationRunner } from './useSimulationRunner'

const SYNTHETIC_DISCLAIMER =
  'The example is a synthetic demonstration: V_c 10 L, V_p 20 L, CL 2 L/h, Q 3 L/h, a 100 mg bolus at 0 h, a 10 mg/h infusion from 2 h to 6 h and a 30 mg bolus at 8 h. These values are invented for testing the simulation engine — they are not real compound parameters, not clinical estimates and not evidence of clinical validity. Values you edit are your own inputs; the application does not verify their provenance.'

export function SimulationView() {
  const [draft, setDraft] = useState<SimulationDraft>(() => demoDraft())
  const { state, run, clear } = useSimulationRunner()
  const resultsRef = useRef<HTMLDivElement>(null)

  // Compile for error display only. This is a pure function of the draft; it
  // never calls the engine and never runs during typing into the simulation.
  const compilation: CompileResult = useMemo(() => compileScenario(draft), [draft])

  /** Every edit invalidates the previous outcome. */
  const edit = useCallback(
    (update: (current: SimulationDraft) => SimulationDraft) => {
      setDraft(update)
      clear()
    },
    [clear],
  )

  const engineErrors = state.status === 'failure' ? state.errors : []
  const draftErrors = compilation.ok ? null : compilation.errors

  function focusField(field: string): void {
    const element = document.querySelector<HTMLElement>(`[data-field-path="${field}"] input, [data-field-path="${field}"] select`)
    element?.focus()
  }

  function runSimulation(): void {
    if (!compilation.ok) {
      // No scenario to give the engine: keep the typed draft errors visible
      // and move focus to the summary so the problem is announced.
      clear()
      requestAnimationFrame(() => document.getElementById('scenario-error-summary')?.focus())
      return
    }
    run(compilation.scenario)
    requestAnimationFrame(() => resultsRef.current?.focus())
  }

  function resetToExample(): void {
    setDraft(demoDraft())
    clear()
  }

  const charts = state.status === 'success' ? chartsForResult(state.result) : null
  const chartResult = state.status === 'success' ? buildSimulationCharts(state.result) : null

  return (
    <div className="flex flex-col gap-6">
      <Alert data-testid="synthetic-scenario-notice">
        <Info className="size-4" aria-hidden="true" />
        <AlertTitle>Synthetic example scenario — editable</AlertTitle>
        <AlertDescription>
          <p>{SYNTHETIC_DISCLAIMER}</p>
          <p className="mt-1">
            Model output is mathematics on the parameters below; it is not a clinical prediction and
            never observed data.
          </p>
        </AlertDescription>
      </Alert>

      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          runSimulation()
        }}
        aria-describedby="scenario-form-description"
      >
        <p id="scenario-form-description" className="text-sm text-muted-foreground">
          Open, linear two-compartment IV model. Edit the parameters, dosing events, time horizon
          and, under Advanced, the solver settings — then run the simulation. Nothing is saved.
        </p>

        <ScenarioErrorSummary draftErrors={draftErrors ?? []} engineErrors={engineErrors} onFocusField={focusField} />

        <ParameterSection
          draft={draft}
          draftErrors={draftErrors ?? []}
          engineErrors={engineErrors}
          onChange={(field, value) => edit((current) => ({ ...current, [field]: value }))}
          onChangeQuantity={(field, patch) =>
            edit((current) => ({ ...current, [field]: { ...current[field], ...patch } }))
          }
        />

        <HorizonSection
          draft={draft}
          draftErrors={draftErrors ?? []}
          onChange={(field, value) => edit((current) => ({ ...current, [field]: value }))}
        />

        <EventEditor
          rows={draft.events}
          errors={draftErrors ?? []}
          onChange={(key, patch) =>
            edit((current) => ({
              ...current,
              events: current.events.map((row): EventRow =>
                row.key === key ? ({ ...row, ...patch } as EventRow) : row,
              ),
            }))
          }
          onRemove={(key) =>
            edit((current) => ({ ...current, events: current.events.filter((row) => row.key !== key) }))
          }
          onAddBolus={() => edit((current) => ({ ...current, events: [...current.events, newBolusRow(current.events)] }))}
          onAddInfusion={() =>
            edit((current) => ({ ...current, events: [...current.events, newInfusionRow(current.events)] }))
          }
        />

        <SolverSection
          draft={draft}
          draftErrors={draftErrors ?? []}
          onChange={(field, value) =>
            edit((current) => ({ ...current, solver: { ...current.solver, [field]: value } }))
          }
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" data-testid="run-simulation">
            <Play className="size-4" aria-hidden="true" />
            Run simulation
          </Button>
          <Button type="button" variant="outline" onClick={resetToExample} data-testid="reset-demo">
            <RotateCcw className="size-4" aria-hidden="true" />
            Reset to synthetic example
          </Button>
        </div>
      </form>

      <div ref={resultsRef} tabIndex={-1} className="flex flex-col gap-6 focus:outline-none">
        {state.status === 'idle' && (
          <p className="text-sm text-muted-foreground" data-testid="simulation-idle">
            No current simulation result. Edit the scenario and press “Run simulation”.
          </p>
        )}
        {state.status === 'failure' && (
          <Alert variant="destructive" data-testid="simulation-errors">
            <AlertCircle className="size-4" aria-hidden="true" />
            <AlertTitle>Simulation failed — no results are shown</AlertTitle>
            <AlertDescription>
              <p className="mb-2">
                The engine rejected this scenario or could not complete the integration. No partial
                curve is displayed.
              </p>
              <ul className="list-disc space-y-1 pl-4">
                {state.errors.map((error, index) => (
                  <li key={`${error.code}-${index}`} className="text-sm">
                    <span className="mr-1 font-mono text-xs">{error.code}</span>
                    <span className="mr-1 font-mono text-xs">[{error.stage}]</span>
                    {error.message}
                    {error.field === undefined ? '' : ` (field: ${error.field})`}
                    {error.eventId === undefined ? '' : ` (event: ${eventIdLabel(error.eventId)})`}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {state.status === 'success' && charts !== null && (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="simulation-summary">
              <Badge variant="secondary">
                {state.result.model.label} · v{state.result.model.version}
              </Badge>
              <Badge variant="outline">Run {state.runNumber}</Badge>
              <span className="text-sm text-muted-foreground">
                {state.result.samples.length} reported samples over {state.result.startTime}–
                {state.result.endTime} h
              </span>
            </div>
            {chartResult !== null && !chartResult.ok ? (
              <Alert variant="destructive" data-testid="chart-failure">
                <AlertCircle className="size-4" aria-hidden="true" />
                <AlertTitle>Result cannot be charted</AlertTitle>
                <AlertDescription>{chartResult.reason}</AlertDescription>
              </Alert>
            ) : null}
            <ResultsPanel
              result={state.result}
              events={chartResult !== null && chartResult.ok ? chartResult.events : []}
              charts={charts}
            />
          </>
        )}
      </div>
    </div>
  )
}

/** Readable description of an engine event id (stable editor ids). */
function eventIdLabel(eventId: string): string {
  const bolus = /^bolus-(\d+)$/.exec(eventId)
  if (bolus !== null) return `${eventId} (IV bolus row ${bolus[1]} of the editor)`
  const infusion = /^infusion-(\d+)-(start|stop)$/.exec(eventId)
  if (infusion !== null) return `${eventId} (infusion ${infusion[2]} for editor row ${infusion[1]})`
  return eventId
}

/** Kept for the page-level focus/announcement behaviour. */
export { SYNTHETIC_DISCLAIMER }