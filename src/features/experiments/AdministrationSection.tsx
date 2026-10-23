/**
 * Administration-metadata display and editor (phase 50A).
 *
 * The metadata is OPTIONAL and every value is explicitly known or unknown.
 * Nothing here is inferred from the measurements, and editing metadata never
 * touches the measurement rows, their provenance, or the stored units.
 *
 * Dose-dependent parameters (CL, CL/F, Vz, Vz/F) are NOT computed here.
 */
import { useState } from 'react'
import { Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatNumber } from '@/engine/numeric/decimal'
import { unitCatalog } from '@/domain/pharmacology/unit-catalog'
import {
  ADMINISTRATION_REGIMENS,
  ADMINISTRATION_ROUTES,
  ADMINISTRATION_TIME_REFERENCES,
  validateAdministration,
  type AdministrationMetadata,
  type AdministrationQuantity,
  type AdministrationRegimen,
  type AdministrationRoute,
  type AdministrationTimeReference,
} from '@/domain/experiments/experimental-dataset'

const ROUTE_LABEL: Record<AdministrationRoute, string> = {
  'iv-bolus': 'IV bolus',
  'iv-infusion': 'IV infusion',
  extravascular: 'Extravascular',
  other: 'Other',
  unknown: 'Unknown',
}

const REGIMEN_LABEL: Record<AdministrationRegimen, string> = {
  'single-dose': 'Single dose',
  'repeated-dose': 'Repeated dosing (not at steady state)',
  'repeated-dose-steady-state': 'Repeated dosing (steady state)',
  unknown: 'Unknown',
}

const TIME_REFERENCE_LABEL: Record<AdministrationTimeReference, string> = {
  'dose-time': 'Dose administration time',
  'infusion-start': 'Infusion start',
  'first-observation': 'First observation',
  other: 'Other reference',
  unknown: 'Unknown',
}

const MASS_UNITS = unitCatalog.unitsOfDimension('mass').map((unit) => unit.symbol)
const TIME_UNITS = unitCatalog.unitsOfDimension('time').map((unit) => unit.symbol)
const FLOW_UNITS = unitCatalog.unitsOfDimension('mass-flow-rate').map((unit) => unit.symbol)

// Sensible editor defaults: the most common units, falling back to the first
// catalog unit. A default unit is a technical editor choice, not a scientific
// value — the recorded metadata always stores the unit the user actually sees.
const DEFAULT_MASS_UNIT = MASS_UNITS.includes('mg') ? 'mg' : (MASS_UNITS[0] ?? 'mg')
const DEFAULT_TIME_UNIT = TIME_UNITS.includes('h') ? 'h' : (TIME_UNITS[0] ?? 'h')
const DEFAULT_FLOW_UNIT = FLOW_UNITS.includes('mg/h') ? 'mg/h' : (FLOW_UNITS[0] ?? 'mg/h')

interface AdministrationSectionProps {
  readonly administration: AdministrationMetadata | undefined
  readonly busy: boolean
  readonly onSave: (administration: AdministrationMetadata | undefined) => Promise<boolean>
}

function quantityText(quantity: AdministrationQuantity | undefined): string {
  return quantity === undefined ? 'Unknown' : `${formatNumber(quantity.value)} ${quantity.unit}`
}

function infusionText(administration: AdministrationMetadata): string {
  const infusion = administration.infusion
  if (infusion === undefined) return 'Unknown'
  if (infusion.duration !== undefined) return `${quantityText(infusion.duration)} (duration)`
  if (infusion.rate !== undefined) return `${quantityText(infusion.rate)} (rate)`
  return 'Unknown'
}

export function AdministrationSection({ administration, busy, onSave }: AdministrationSectionProps) {
  const [editing, setEditing] = useState(false)
  return (
    <section aria-labelledby="administration-heading" className="space-y-3" data-testid="administration-section">
      <div className="flex items-center justify-between gap-2">
        <h3 id="administration-heading" className="text-sm font-medium">
          Administration
        </h3>
        {editing ? (
          <span className="text-xs text-muted-foreground">Editing</span>
        ) : (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(true)}
              data-testid="administration-edit"
            >
              <Pencil className="size-4" aria-hidden="true" />
              {administration === undefined ? 'Add' : 'Edit'}
            </Button>
            {administration !== undefined && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void onSave(undefined)}
                data-testid="administration-clear"
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Clear
              </Button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <AdministrationEditor
          administration={administration}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (next) => {
            const saved = await onSave(next)
            if (saved) setEditing(false)
          }}
        />
      ) : (
        <AdministrationDisplay administration={administration} />
      )}
    </section>
  )
}

function AdministrationDisplay({ administration }: { readonly administration: AdministrationMetadata | undefined }) {
  if (administration === undefined) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="administration-unknown">
        No administration information is recorded. Route, dose, regimen and time origin are unknown.
      </p>
    )
  }
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid="administration-summary">
      <Field label="Route" value={ROUTE_LABEL[administration.route]} />
      <Field label="Regimen" value={REGIMEN_LABEL[administration.regimen]} />
      <Field label="Dose" value={quantityText(administration.dose)} />
      <Field label="Infusion" value={infusionText(administration)} />
      <Field label="Dosing interval τ" value={quantityText(administration.dosingInterval)} />
      <Field label="Time reference" value={TIME_REFERENCE_LABEL[administration.timeReference]} />
      <Field
        label="Bioavailability F"
        value={
          administration.bioavailability === undefined
            ? 'Unknown'
            : formatNumber(administration.bioavailability)
        }
      />
    </dl>
  )
}

function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

interface EditorState {
  route: AdministrationRoute
  regimen: AdministrationRegimen
  timeReference: AdministrationTimeReference
  doseValue: string
  doseUnit: string
  infusionMode: 'none' | 'duration' | 'rate'
  infusionDurationValue: string
  infusionDurationUnit: string
  infusionRateValue: string
  infusionRateUnit: string
  intervalValue: string
  intervalUnit: string
  bioavailability: string
}

function initialEditorState(administration: AdministrationMetadata | undefined): EditorState {
  const infusion = administration?.infusion
  const infusionMode: EditorState['infusionMode'] =
    infusion?.duration !== undefined ? 'duration' : infusion?.rate !== undefined ? 'rate' : 'none'
  return {
    route: administration?.route ?? 'unknown',
    regimen: administration?.regimen ?? 'unknown',
    timeReference: administration?.timeReference ?? 'unknown',
    doseValue: administration?.dose === undefined ? '' : String(administration.dose.value),
    doseUnit: administration?.dose?.unit ?? DEFAULT_MASS_UNIT,
    infusionMode,
    infusionDurationValue:
      infusion?.duration === undefined ? '' : String(infusion.duration.value),
    infusionDurationUnit: infusion?.duration?.unit ?? DEFAULT_TIME_UNIT,
    infusionRateValue: infusion?.rate === undefined ? '' : String(infusion.rate.value),
    infusionRateUnit: infusion?.rate?.unit ?? DEFAULT_FLOW_UNIT,
    intervalValue:
      administration?.dosingInterval === undefined ? '' : String(administration.dosingInterval.value),
    intervalUnit: administration?.dosingInterval?.unit ?? DEFAULT_TIME_UNIT,
    bioavailability:
      administration?.bioavailability === undefined ? '' : String(administration.bioavailability),
  }
}

function AdministrationEditor({
  administration,
  busy,
  onSave,
  onCancel,
}: {
  readonly administration: AdministrationMetadata | undefined
  readonly busy: boolean
  readonly onSave: (administration: AdministrationMetadata | undefined) => Promise<void>
  readonly onCancel: () => void
}) {
  const [state, setState] = useState<EditorState>(() => initialEditorState(administration))
  const [issues, setIssues] = useState<readonly string[]>([])

  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]): void =>
    setState((current) => ({ ...current, [key]: value }))

  function parseOptional(
    text: string,
    unit: string,
  ):
    | { readonly ok: true; readonly quantity: AdministrationQuantity | undefined }
    | { readonly ok: false; readonly message: string } {
    const trimmed = text.trim()
    if (trimmed === '') return { ok: true, quantity: undefined }
    const value = Number(trimmed)
    if (!Number.isFinite(value)) return { ok: false, message: `must be a finite number (got "${text}")` }
    return { ok: true, quantity: { value, unit } }
  }

  function submit(): void {
    const dose = parseOptional(state.doseValue, state.doseUnit)
    const duration = parseOptional(state.infusionDurationValue, state.infusionDurationUnit)
    const rate = parseOptional(state.infusionRateValue, state.infusionRateUnit)
    const interval = parseOptional(state.intervalValue, state.intervalUnit)
    if (!dose.ok || !duration.ok || !rate.ok || !interval.ok) {
      setIssues([dose, duration, rate, interval].filter((r) => !r.ok).map((r) => (r.ok ? '' : r.message)))
      return
    }

    const bioavailabilityText = state.bioavailability.trim()
    let bioavailability: number | undefined
    if (bioavailabilityText !== '') {
      const value = Number(bioavailabilityText)
      if (!Number.isFinite(value)) {
        setIssues([`bioavailability must be a finite number (got "${state.bioavailability}")`])
        return
      }
      bioavailability = value
    }

    const administration: AdministrationMetadata = {
      route: state.route,
      regimen: state.regimen,
      timeReference: state.timeReference,
      ...(dose.quantity === undefined ? {} : { dose: dose.quantity }),
      ...(state.infusionMode === 'none'
        ? {}
        : {
            infusion:
              state.infusionMode === 'duration'
                ? duration.quantity === undefined
                  ? {}
                  : { duration: duration.quantity }
                : rate.quantity === undefined
                  ? {}
                  : { rate: rate.quantity },
          }),
      ...(interval.quantity === undefined ? {} : { dosingInterval: interval.quantity }),
      ...(bioavailability === undefined ? {} : { bioavailability }),
    }

    const problems = validateAdministration(administration)
    if (problems.length > 0) {
      setIssues(problems.map((issue) => `${issue.field}: ${issue.message}`))
      return
    }
    setIssues([])
    void onSave(administration)
  }

  return (
    <form
      className="space-y-3 rounded-md border p-3"
      data-testid="administration-editor"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <EnumSelect
          id="administration-route"
          label="Route"
          value={state.route}
          options={ADMINISTRATION_ROUTES}
          labels={ROUTE_LABEL}
          testId="administration-route"
          onChange={(value) => set('route', value)}
        />
        <EnumSelect
          id="administration-regimen"
          label="Regimen"
          value={state.regimen}
          options={ADMINISTRATION_REGIMENS}
          labels={REGIMEN_LABEL}
          testId="administration-regimen"
          onChange={(value) => set('regimen', value)}
        />
        <EnumSelect
          id="administration-time-reference"
          label="Time reference"
          value={state.timeReference}
          options={ADMINISTRATION_TIME_REFERENCES}
          labels={TIME_REFERENCE_LABEL}
          testId="administration-time-reference"
          onChange={(value) => set('timeReference', value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <QuantityInput
          id="administration-dose"
          label="Dose amount (leave blank if unknown)"
          value={state.doseValue}
          unit={state.doseUnit}
          units={MASS_UNITS}
          testId="administration-dose"
          unitTestId="administration-dose-unit"
          onChange={(value) => set('doseValue', value)}
          onUnitChange={(unit) => set('doseUnit', unit)}
        />
        <QuantityInput
          id="administration-interval"
          label="Dosing interval τ (leave blank if unknown)"
          value={state.intervalValue}
          unit={state.intervalUnit}
          units={TIME_UNITS}
          testId="administration-interval"
          unitTestId="administration-interval-unit"
          onChange={(value) => set('intervalValue', value)}
          onUnitChange={(unit) => set('intervalUnit', unit)}
        />
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Infusion (for IV infusion)</legend>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="administration-infusion-mode">Infusion detail</Label>
          <select
            id="administration-infusion-mode"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={state.infusionMode}
            data-testid="administration-infusion-mode"
            onChange={(event) => set('infusionMode', event.target.value as EditorState['infusionMode'])}
          >
            <option value="none">None / unknown</option>
            <option value="duration">Duration</option>
            <option value="rate">Rate</option>
          </select>
        </div>
        {state.infusionMode === 'duration' ? (
          <QuantityInput
            id="administration-infusion-duration"
            label="Infusion duration"
            value={state.infusionDurationValue}
            unit={state.infusionDurationUnit}
            units={TIME_UNITS}
            testId="administration-infusion-duration"
            unitTestId="administration-infusion-duration-unit"
            onChange={(value) => set('infusionDurationValue', value)}
            onUnitChange={(unit) => set('infusionDurationUnit', unit)}
          />
        ) : state.infusionMode === 'rate' ? (
          <QuantityInput
            id="administration-infusion-rate"
            label="Infusion rate"
            value={state.infusionRateValue}
            unit={state.infusionRateUnit}
            units={FLOW_UNITS}
            testId="administration-infusion-rate"
            unitTestId="administration-infusion-rate-unit"
            onChange={(value) => set('infusionRateValue', value)}
            onUnitChange={(unit) => set('infusionRateUnit', unit)}
          />
        ) : null}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="administration-bioavailability">Bioavailability F (0–1, blank if unknown)</Label>
          <Input
            id="administration-bioavailability"
            value={state.bioavailability}
            inputMode="decimal"
            placeholder="—"
            disabled={busy}
            data-testid="administration-bioavailability"
            onChange={(event) => set('bioavailability', event.target.value)}
          />
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-destructive" role="alert" data-testid="administration-errors">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy} data-testid="administration-save">
          Save administration
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          <X className="size-4" aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </form>
  )
}

function EnumSelect<const T extends string>({
  id,
  label,
  value,
  options,
  labels,
  testId,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly value: T
  readonly options: readonly T[]
  readonly labels: Record<T, string>
  readonly testId: string
  readonly onChange: (value: T) => void
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </div>
  )
}

function QuantityInput({
  id,
  label,
  value,
  unit,
  units,
  testId,
  unitTestId,
  onChange,
  onUnitChange,
}: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly unit: string
  readonly units: readonly string[]
  readonly testId: string
  readonly unitTestId: string
  readonly onChange: (value: string) => void
  readonly onUnitChange: (unit: string) => void
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          inputMode="decimal"
          placeholder="—"
          className="flex-1"
          data-testid={testId}
          onChange={(event) => onChange(event.target.value)}
        />
        <select
          aria-label={`${label} unit`}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={unit}
          data-testid={unitTestId}
          onChange={(event) => onUnitChange(event.target.value)}
        >
          {units.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
