import { Plus, Trash2 } from 'lucide-react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DraftError, EventRow } from '../draft'
import { QuantityField } from './fields'

/**
 * Dosing-event editor: user-facing rows (one bolus, one infusion session) that
 * compile into the engine's `iv-bolus` / `infusion-start` / `infusion-stop`
 * events. Rows are keyed by a stable integer, so editing or removing one row
 * never re-associates another row's state.
 */
export interface EventEditorProps {
  readonly rows: readonly EventRow[]
  readonly errors: readonly DraftError[]
  readonly onChange: (key: number, patch: Partial<Omit<EventRow, 'kind' | 'key'>>) => void
  readonly onRemove: (key: number) => void
  readonly onAddBolus: () => void
  readonly onAddInfusion: () => void
}

const errorFor = (errors: readonly DraftError[], fieldPath: string): string | undefined =>
  errors.find((error) => error.field === fieldPath)?.message

export function EventEditor({ rows, errors, onChange, onRemove, onAddBolus, onAddInfusion }: EventEditorProps) {
  return (
    <section aria-labelledby="events-heading" className="flex flex-col gap-3" data-testid="event-editor">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="events-heading" className="text-base font-medium">
            Dosing events
          </h2>
          <p className="text-xs text-muted-foreground">
            Times in hours. An infusion is one session here and becomes a start and a stop event
            for the engine at the same times.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onAddBolus} data-testid="add-bolus">
            <Plus className="size-4" aria-hidden="true" />
            Add IV bolus
          </Button>
          <Button type="button" variant="outline" onClick={onAddInfusion} data-testid="add-infusion">
            <Plus className="size-4" aria-hidden="true" />
            Add IV infusion
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-events">
          No dosing events. Add an IV bolus or an IV infusion.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row, index) =>
            row.kind === 'bolus' ? (
              <BolusRowView
                key={row.key}
                row={row}
                index={index}
                errors={errors}
                onChange={onChange}
                onRemove={onRemove}
              />
            ) : (
              <InfusionRowView
                key={row.key}
                row={row}
                index={index}
                errors={errors}
                onChange={onChange}
                onRemove={onRemove}
              />
            ),
          )}
        </div>
      )}

      {rows.length === 0 ? null : (
        <Table className="sr-only">
          <TableCaption>Summary of the dosing rows above</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Row</TableHead>
              <TableHead scope="col">Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`summary-${row.key}`}>
                <TableCell>{row.key}</TableCell>
                <TableCell>{row.kind === 'bolus' ? 'IV bolus' : 'IV infusion'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

interface RowViewProps<T extends EventRow> {
  readonly row: T
  readonly index: number
  readonly errors: readonly DraftError[]
  readonly onChange: (key: number, patch: Partial<Omit<EventRow, 'kind' | 'key'>>) => void
  readonly onRemove: (key: number) => void
}

function RowShell({
  title,
  rowIndex,
  kind,
  hasError,
  onRemove,
  testId,
  removeTestId,
  children,
}: {
  readonly title: string
  readonly rowIndex: number
  readonly kind: string
  readonly hasError: boolean
  readonly onRemove: () => void
  readonly testId: string
  readonly removeTestId: string
  readonly children: React.ReactNode
}) {
  return (
    <fieldset
      className={`rounded-md border p-3 ${hasError ? 'border-destructive' : ''}`}
      data-testid={testId}
    >
      <legend className="flex w-full items-center justify-between gap-2 px-1 text-sm font-medium">
        <span>
          {title} · {kind}
        </span>
        {hasError ? (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="size-3" aria-hidden="true" />
            needs attention
          </span>
        ) : null}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
      <div className="mt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          data-testid={removeTestId}
          aria-label={`Remove ${title.toLowerCase()} (row ${rowIndex + 1})`}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Remove
        </Button>
      </div>
    </fieldset>
  )
}

function BolusRowView({ row, index, errors, onChange, onRemove }: RowViewProps<Extract<EventRow, { kind: 'bolus' }>>) {
  const timeField = `events.${row.key}.time`
  const amountField = `events.${row.key}.amount.value`
  const hasError = errorFor(errors, timeField) !== undefined || errorFor(errors, amountField) !== undefined
  return (
    <RowShell
      title={`Event ${index + 1}`}
      rowIndex={index}
      kind="IV bolus"
      hasError={hasError}
      onRemove={() => onRemove(row.key)}
      testId={`event-row-${row.key}`}
      removeTestId={`remove-event-${row.key}`}
    >
      <div className="grid gap-1.5" data-field-path={timeField}>
        <Label htmlFor={`bolus-${row.key}-time`} className="text-sm">
          Time (h)
        </Label>
        <input
          id={`bolus-${row.key}-time`}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={row.time}
          onChange={(event) => onChange(row.key, { time: event.target.value })}
          inputMode="decimal"
          aria-invalid={errorFor(errors, timeField) === undefined ? 'false' : 'true'}
          aria-describedby={errorFor(errors, timeField) === undefined ? undefined : `bolus-${row.key}-time-error`}
          data-testid={`bolus-${row.key}-time`}
        />
        {errorFor(errors, timeField) === undefined ? null : (
          <p id={`bolus-${row.key}-time-error`} className="text-xs text-destructive" role="alert">
            {errorFor(errors, timeField)}
          </p>
        )}
      </div>
      <QuantityField
        id={`bolus-${row.key}-amount`}
        label="Amount"
        value={row.amount.value}
        unit={row.amount.unit}
        dimension="mass"
        error={errorFor(errors, amountField)}
        fieldPath={amountField}
        testId={`bolus-${row.key}-amount`}
        unitTestId={`bolus-${row.key}-amount-unit`}
        onChange={(value) => onChange(row.key, { amount: { value, unit: row.amount.unit } })}
        onUnitChange={(unit) => onChange(row.key, { amount: { value: row.amount.value, unit } })}
      />
    </RowShell>
  )
}

function InfusionRowView({ row, index, errors, onChange, onRemove }: RowViewProps<Extract<EventRow, { kind: 'infusion' }>>) {
  const startField = `events.${row.key}.startTime`
  const stopField = `events.${row.key}.stopTime`
  const rateField = `events.${row.key}.rate.value`
  const hasError =
    errorFor(errors, startField) !== undefined ||
    errorFor(errors, stopField) !== undefined ||
    errorFor(errors, rateField) !== undefined
  return (
    <RowShell
      title={`Event ${index + 1}`}
      rowIndex={index}
      kind="IV infusion"
      hasError={hasError}
      onRemove={() => onRemove(row.key)}
      testId={`event-row-${row.key}`}
      removeTestId={`remove-event-${row.key}`}
    >
      <div className="grid gap-1.5" data-field-path={startField}>
        <Label htmlFor={`infusion-${row.key}-start`} className="text-sm">
          Start time (h)
        </Label>
        <input
          id={`infusion-${row.key}-start`}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={row.startTime}
          onChange={(event) => onChange(row.key, { startTime: event.target.value })}
          inputMode="decimal"
          aria-invalid={errorFor(errors, startField) === undefined ? 'false' : 'true'}
          aria-describedby={errorFor(errors, startField) === undefined ? undefined : `infusion-${row.key}-start-error`}
          data-testid={`infusion-${row.key}-start`}
        />
        {errorFor(errors, startField) === undefined ? null : (
          <p id={`infusion-${row.key}-start-error`} className="text-xs text-destructive" role="alert">
            {errorFor(errors, startField)}
          </p>
        )}
      </div>
      <div className="grid gap-1.5" data-field-path={stopField}>
        <Label htmlFor={`infusion-${row.key}-stop`} className="text-sm">
          Stop time (h)
        </Label>
        <input
          id={`infusion-${row.key}-stop`}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={row.stopTime}
          onChange={(event) => onChange(row.key, { stopTime: event.target.value })}
          inputMode="decimal"
          aria-invalid={errorFor(errors, stopField) === undefined ? 'false' : 'true'}
          aria-describedby={errorFor(errors, stopField) === undefined ? undefined : `infusion-${row.key}-stop-error`}
          data-testid={`infusion-${row.key}-stop`}
        />
        {errorFor(errors, stopField) === undefined ? null : (
          <p id={`infusion-${row.key}-stop-error`} className="text-xs text-destructive" role="alert">
            {errorFor(errors, stopField)}
          </p>
        )}
      </div>
      <QuantityField
        id={`infusion-${row.key}-rate`}
        label="Rate"
        value={row.rate.value}
        unit={row.rate.unit}
        dimension="mass-flow-rate"
        error={errorFor(errors, rateField)}
        fieldPath={rateField}
        testId={`infusion-${row.key}-rate`}
        unitTestId={`infusion-${row.key}-rate-unit`}
        onChange={(value) => onChange(row.key, { rate: { value, unit: row.rate.unit } })}
        onUnitChange={(unit) => onChange(row.key, { rate: { value: row.rate.value, unit } })}
      />
    </RowShell>
  )
}
