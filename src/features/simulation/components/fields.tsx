import { ScientificText } from '@/components/scientific/ScientificText'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { EditorUnitDimension } from '../draft'
import { editorUnitOptions } from './editorUnits'

/**
 * Editor field primitives. Every control is labelled, every unit select is
 * populated from the engine's own catalog (never a hand-kept list), and the
 * error text is wired to the control with `aria-describedby` so a screen
 * reader announces it with the field.
 */

export interface FieldProps {
  readonly id: string
  readonly label: string
  readonly symbol?: string
  readonly help?: string
  readonly value: string
  /** `undefined` means "no error"; required so callers must decide explicitly. */
  readonly error: string | undefined
  readonly testId: string
  readonly fieldPath: string
  readonly onChange: (value: string) => void
}

/** A labelled numeric text field. Blank stays blank; nothing is coerced. */
export function NumberField({
  id,
  label,
  symbol,
  help,
  value,
  error,
  testId,
  fieldPath,
  onChange,
}: FieldProps) {
  const errorId = `${id}-error`
  return (
    <div className="grid gap-1.5" data-field-path={fieldPath}>
      <Label htmlFor={id} className="text-sm">
        {symbol === undefined ? null : (
          <ScientificText value={symbol} className="font-mono" />
        )}{' '}
        {label}
      </Label>
      {help === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          <ScientificText value={help} />
        </p>
      )}
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        aria-invalid={error === undefined ? 'false' : 'true'}
        aria-describedby={error === undefined ? undefined : errorId}
        data-testid={testId}
      />
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export interface QuantityFieldProps extends Omit<FieldProps, 'label' | 'help'> {
  readonly label: string
  readonly unit: string
  readonly dimension: EditorUnitDimension
  readonly onUnitChange: (unit: string) => void
  readonly unitTestId: string
}

/** A number + unit pair, unit choices from the catalog for one dimension. */
export function QuantityField({
  id,
  label,
  symbol,
  value,
  unit,
  error,
  dimension,
  testId,
  unitTestId,
  fieldPath,
  onChange,
  onUnitChange,
}: QuantityFieldProps) {
  const errorId = `${id}-error`
  const unitId = `${id}-unit`
  const options = editorUnitOptions(dimension)
  return (
    <div className="grid gap-1.5" data-field-path={fieldPath}>
      <Label htmlFor={id} className="text-sm">
        {symbol === undefined ? null : (
          <ScientificText value={symbol} className="font-mono" />
        )}{' '}
        {label}
      </Label>
      <div className="flex flex-wrap items-start gap-2">
        <Input
          id={id}
          className="min-w-28 flex-1"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="decimal"
          aria-invalid={error === undefined ? 'false' : 'true'}
          aria-describedby={error === undefined ? undefined : errorId}
          data-testid={testId}
        />
        <div className="grid gap-1">
          <Label htmlFor={unitId} className="sr-only">
            {label} unit
          </Label>
          <select
            id={unitId}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={unit}
            onChange={(event) => onUnitChange(event.target.value)}
            data-testid={unitTestId}
          >
            {options.map((symbolOption) => (
              <option key={symbolOption} value={symbolOption}>
                {symbolOption}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

