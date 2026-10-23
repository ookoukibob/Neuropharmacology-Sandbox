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
import { AlertCircle, Play, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { buildSimulationCharts } from '@/components/charts/simulationAdapter'
import {
  compileScenario,
  emptyDraft,
  emptyEffectSiteDraft,
  newBolusRow,
  newInfusionRow,
  type CompileResult,
  type EventRow,
  type SimulationDraft,
} from './draft'
import { EffectSiteSection } from './components/EffectSiteSection'
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
import { useScenarioLibrary } from './useScenarioLibrary'
import { SavedScenariosPanel } from './components/SavedScenariosPanel'
import type { ScenarioRepository } from '@/data/repositories/scenarioRepository'

export function SimulationView({ scenarioRepository }: { readonly scenarioRepository: ScenarioRepository }) {
  const [draft, setDraft] = useState<SimulationDraft>(() => emptyDraft())
  const { state, run, clear } = useSimulationRunner()
  const library = useScenarioLibrary(scenarioRepository)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Dirty tracking compares the live draft with the loaded/saved snapshot.
  // A read-only comparison: it never simulates and never writes.
  useEffect(() => {
    library.syncDirty(draft)
  }, [draft, library])

  /** A loaded saved draft replaces the editor draft and invalidates results. */
  const replaceDraft = useCallback(
    (next: SimulationDraft) => {
      setDraft(next)
      clear()
    },
    [clear],
  )

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
      const submitter = document.activeElement
      requestAnimationFrame(() => {
        if (document.activeElement === submitter) document.getElementById('scenario-error-summary')?.focus()
      })
      return
    }
    run(compilation.scenario)
    // Announce the result to keyboard users by moving focus to the results
    // region — but only when the user is still on the Run button. A deferred
    // focus must never steal focus from a control the user has moved to in
    // the meantime (it silently swallowed the next keystroke).
    const submitter = document.activeElement
    requestAnimationFrame(() => {
      if (document.activeElement === submitter) resultsRef.current?.focus()
    })
  }

  function clearScenario(): void {
    setDraft(emptyDraft())
    clear()
  }

  const charts = state.status === 'success' ? chartsForResult(state.result) : null
  const chartResult = state.status === 'success' ? buildSimulationCharts(state.result) : null

  return (
    <div className="flex flex-col gap-6">
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

        <EffectSiteSection
          draft={draft.effectSite ?? emptyEffectSiteDraft()}
          errors={draftErrors ?? []}
          onChange={(next) => edit((current) => ({ ...current, effectSite: next }))}
        />

        <SavedScenariosPanel library={library} draft={draft} onDraftReplaced={replaceDraft} />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" data-testid="run-simulation">
            <Play className="size-4" aria-hidden="true" />
            Run simulation
          </Button>
          <Button type="button" variant="outline" onClick={clearScenario} data-testid="clear-scenario">
            <RotateCcw className="size-4" aria-hidden="true" />
            Clear scenario
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
  const bolus = /^bolus-(\d+)(?:-(\d+))?$/.exec(eventId)
  if (bolus !== null) {
    const dose = bolus[2] === undefined ? '' : `, dose ${bolus[2]}`
    return `${eventId} (IV bolus row ${bolus[1]}${dose} of the editor)`
  }
  const infusion = /^infusion-(\d+)(?:-(\d+))?-(start|stop)$/.exec(eventId)
  if (infusion !== null) {
    const dose = infusion[2] === undefined ? '' : `, dose ${infusion[2]}`
    return `${eventId} (infusion ${infusion[3]} for editor row ${infusion[1]}${dose})`
  }
  return eventId
}

