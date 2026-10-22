import { AlertCircle } from 'lucide-react'
import { ParameterLabel } from '@/components/scientific/ParameterLabel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import type { SimulationError } from '@/engine/simulation/types'
import type { DraftError, SimulationDraft } from '../draft'
import { engineErrorFieldPath } from '../draft'
import { fieldSubject, SIMULATION_FIELDS } from '../parameterFields'
import { NumberField, QuantityField } from './fields'
import { errorMessages } from './scenarioErrors'

/**
 * Scenario sections: model parameters, time horizon, advanced solver
 * settings, and the two error channels.
 *
 * Two error channels are kept visibly distinct:
 *   draft errors   — the text could not be parsed (blank, "abc", bad grid)
 *   engine errors  — `simulate()` rejected a well-formed scenario
 *                    (positivity, units, event sequence, solver rules)
 * Draft errors are never allowed to stand in for an engine rule, and engine
 * errors are never reduced to a generic "invalid input".
 */

export function ScenarioErrorSummary({
  draftErrors,
  engineErrors,
  onFocusField,
}: {
  readonly draftErrors: readonly DraftError[]
  readonly engineErrors: readonly SimulationError[]
  readonly onFocusField: (field: string) => void
}) {
  if (draftErrors.length === 0 && engineErrors.length === 0) return null
  return (
    <Alert variant="destructive" id="scenario-error-summary" data-testid="form-errors">
      <AlertCircle className="size-4" aria-hidden="true" />
      <AlertTitle>Fix these problems before a result can be shown</AlertTitle>
      <AlertDescription>
        {draftErrors.length > 0 ? (
          <>
            <p className="mt-1 font-medium">Form input</p>
            <ul className="list-disc pl-4" data-testid="draft-errors">
              {draftErrors.map((error) => {
                // The label comes from the shared field metadata — the same
                // definition the control's own <Label> renders — so a summary
                // entry and the field it points at can never disagree about
                // either the notation or the wording.
                const subject = fieldSubject(error.field)
                return (
                  <li key={error.field}>
                    <button
                      type="button"
                      className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onFocusField(error.field)}
                    >
                      <ParameterLabel label={subject.label} symbol={subject.symbol} />
                    </button>
                    : {error.message}
                  </li>
                )
              })}
            </ul>
          </>
        ) : null}
        {engineErrors.length > 0 ? (
          <>
            <p className="mt-2 font-medium">Simulation engine</p>
            <ul className="list-disc pl-4" data-testid="engine-errors">
              {engineErrors.map((error, index) => (
                <li key={`${error.code}-${index}`}>
                  <span className="mr-1 font-mono text-xs">{error.code}</span>
                  <span className="mr-1 font-mono text-xs">[{error.stage}]</span>
                  {error.message}
                  {error.field === undefined ? '' : ` (field: ${error.field})`}
                  {error.eventId === undefined ? '' : ` (event: ${error.eventId})`}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function ParameterSection({
  draft,
  draftErrors,
  engineErrors,
  onChange,
  onChangeQuantity,
}: {
  readonly draft: SimulationDraft
  readonly draftErrors: readonly DraftError[]
  readonly engineErrors: readonly SimulationError[]
  readonly onChange: (field: 'initialCentralAmount' | 'initialPeripheralAmount', value: string) => void
  readonly onChangeQuantity: (
    field: 'centralVolume' | 'peripheralVolume' | 'clearance' | 'intercompartmentalClearance',
    patch: { readonly value?: string; readonly unit?: string },
  ) => void
}) {
  const messages = errorMessages(draftErrors)
  const engineMessage = (field: string): string | undefined =>
    engineErrors.find((error) => engineErrorFieldPath(error) === field)?.message

  const errorOf = (field: string): string | undefined => messages.get(field) ?? engineMessage(field)

  return (
    <section aria-labelledby="parameters-heading" className="flex flex-col gap-3" data-testid="scenario-parameters">
      <div>
        <h2 id="parameters-heading" className="text-base font-medium">
          Model parameters
        </h2>
        <p className="text-xs text-muted-foreground">
          Two-compartment IV model. Values you type are your own inputs: the application does not
          verify where they came from.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <QuantityField
          id="scenario-central-volume"
          label={SIMULATION_FIELDS.centralVolume.label}
          symbol={SIMULATION_FIELDS.centralVolume.symbol}
          value={draft.centralVolume.value}
          unit={draft.centralVolume.unit}
          dimension="volume"
          error={errorOf('centralVolume')}
          fieldPath="centralVolume"
          testId="central-volume-value"
          unitTestId="central-volume-unit"
          onChange={(value) => onChangeQuantity('centralVolume', { value })}
          onUnitChange={(unit) => onChangeQuantity('centralVolume', { unit })}
        />
        <QuantityField
          id="scenario-peripheral-volume"
          label={SIMULATION_FIELDS.peripheralVolume.label}
          symbol={SIMULATION_FIELDS.peripheralVolume.symbol}
          value={draft.peripheralVolume.value}
          unit={draft.peripheralVolume.unit}
          dimension="volume"
          error={errorOf('peripheralVolume')}
          fieldPath="peripheralVolume"
          testId="peripheral-volume-value"
          unitTestId="peripheral-volume-unit"
          onChange={(value) => onChangeQuantity('peripheralVolume', { value })}
          onUnitChange={(unit) => onChangeQuantity('peripheralVolume', { unit })}
        />
        <QuantityField
          id="scenario-clearance"
          label={SIMULATION_FIELDS.clearance.label}
          symbol={SIMULATION_FIELDS.clearance.symbol}
          value={draft.clearance.value}
          unit={draft.clearance.unit}
          dimension="clearance"
          error={errorOf('clearance')}
          fieldPath="clearance"
          testId="clearance-value"
          unitTestId="clearance-unit"
          onChange={(value) => onChangeQuantity('clearance', { value })}
          onUnitChange={(unit) => onChangeQuantity('clearance', { unit })}
        />
        <QuantityField
          id="scenario-q"
          label={SIMULATION_FIELDS.intercompartmentalClearance.label}
          symbol={SIMULATION_FIELDS.intercompartmentalClearance.symbol}
          value={draft.intercompartmentalClearance.value}
          unit={draft.intercompartmentalClearance.unit}
          dimension="clearance"
          error={errorOf('intercompartmentalClearance')}
          fieldPath="intercompartmentalClearance"
          testId="q-value"
          unitTestId="q-unit"
          onChange={(value) => onChangeQuantity('intercompartmentalClearance', { value })}
          onUnitChange={(unit) => onChangeQuantity('intercompartmentalClearance', { unit })}
        />
        <NumberField
          id="scenario-initial-central"
          label={SIMULATION_FIELDS.initialCentralAmount.label}
          symbol={SIMULATION_FIELDS.initialCentralAmount.symbol}
          value={draft.initialCentralAmount}
          error={errorOf('initialCentralAmount')}
          fieldPath="initialCentralAmount"
          testId="initial-central-value"
          onChange={(value) => onChange('initialCentralAmount', value)}
        />
        <NumberField
          id="scenario-initial-peripheral"
          label={SIMULATION_FIELDS.initialPeripheralAmount.label}
          symbol={SIMULATION_FIELDS.initialPeripheralAmount.symbol}
          value={draft.initialPeripheralAmount}
          error={errorOf('initialPeripheralAmount')}
          fieldPath="initialPeripheralAmount"
          testId="initial-peripheral-value"
          onChange={(value) => onChange('initialPeripheralAmount', value)}
        />
      </div>
    </section>
  )
}

export function HorizonSection({
  draft,
  draftErrors,
  onChange,
}: {
  readonly draft: SimulationDraft
  readonly draftErrors: readonly DraftError[]
  readonly onChange: (field: 'startTime' | 'endTime' | 'outputInterval', value: string) => void
}) {
  const messages = errorMessages(draftErrors)
  return (
    <section aria-labelledby="horizon-heading" className="flex flex-col gap-3" data-testid="horizon-section">
      <div>
        <h2 id="horizon-heading" className="text-base font-medium">
          Time horizon and output sampling
        </h2>
        <p className="text-xs text-muted-foreground">
          All times in hours. These are observation times: they do not change the solver’s step
          sizes, and dosing events are always integrated to exactly.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField
          id="scenario-start-time"
          label={SIMULATION_FIELDS.startTime.label}
          value={draft.startTime}
          error={messages.get('startTime')}
          fieldPath="startTime"
          testId="start-time-value"
          onChange={(value) => onChange('startTime', value)}
        />
        <NumberField
          id="scenario-end-time"
          label={SIMULATION_FIELDS.endTime.label}
          value={draft.endTime}
          error={messages.get('endTime')}
          fieldPath="endTime"
          testId="end-time-value"
          onChange={(value) => onChange('endTime', value)}
        />
        <NumberField
          id="scenario-output-interval"
          label={SIMULATION_FIELDS.outputInterval.label}
          value={draft.outputInterval}
          error={messages.get('outputInterval')}
          fieldPath="outputInterval"
          testId="output-interval-value"
          onChange={(value) => onChange('outputInterval', value)}
        />
      </div>
    </section>
  )
}

export function SolverSection({
  draft,
  draftErrors,
  onChange,
}: {
  readonly draft: SimulationDraft
  readonly draftErrors: readonly DraftError[]
  readonly onChange: (field: keyof SimulationDraft['solver'], value: string) => void
}) {
  const messages = errorMessages(draftErrors)
  const field = (key: keyof SimulationDraft['solver'], testId: string) => (
    <NumberField
      id={`solver-${key}`}
      label={SIMULATION_FIELDS[`solver.${key}`].label}
      value={draft.solver[key]}
      error={messages.get(`solver.${key}`)}
      fieldPath={`solver.${key}`}
      testId={testId}
      onChange={(value) => onChange(key, value)}
    />
  )
  return (
    <details className="rounded-lg border p-4" data-testid="solver-section">
      <summary className="cursor-pointer text-base font-medium">Advanced solver settings</summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Adaptive Dormand–Prince 5(4). Tolerances control accuracy; steps are in hours. The engine
        validates these settings and reports its own errors.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {field('absoluteTolerance', 'solver-absolute-tolerance')}
        {field('relativeTolerance', 'solver-relative-tolerance')}
        {field('initialStep', 'solver-initial-step')}
        {field('minStep', 'solver-min-step')}
        {field('maxStep', 'solver-max-step')}
        {field('maxSteps', 'solver-max-steps')}
      </div>
    </details>
  )
}

export function FieldLabelHelp({ children }: { readonly children: React.ReactNode }) {
  return <Label className="text-xs text-muted-foreground">{children}</Label>
}
