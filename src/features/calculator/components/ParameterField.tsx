/**
 * ParameterField — a single calculator input row with value, unit, and
 * optional library-source selector.
 *
 * - Value is a controlled text input (validated on submit, never mutated).
 * - Unit is a select populated from the catalog (or free text for effect
 *   units, or fixed display for dimensionless n).
 * - If the field has library candidates, a "From library" select lets the
 *   user explicitly load a value+unit+provenance.
 * - Provenance/source is displayed under the field: either "From library:
 *   <label> · <ProvenanceBadge>" or "User-entered — no source claim" for
 *   typed values, or nothing for empty untouched fields.
 * - Engine/Zod errors are shown inline.
 */
import { AlertCircle } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import type { CalculatorFieldSpec, LibraryCandidate } from '../modelAdapters'
import type { ParameterDraft } from '../schemas'
import { ProvenanceBadge } from './ProvenanceBadge'
import { unitGroupsFor } from '../modelAdapters'

interface ParameterFieldProps {
  readonly spec: CalculatorFieldSpec
  readonly field: ParameterDraft | undefined
  readonly error: string | undefined
  readonly candidates: readonly LibraryCandidate[]
  readonly onValueChange: (value: string) => void
  readonly onUnitChange: (unit: string) => void
  readonly onLoad: (candidate: LibraryCandidate) => void
  readonly idPrefix: string
}

export function ParameterField({
  spec,
  field,
  error,
  candidates,
  onValueChange,
  onUnitChange,
  onLoad,
  idPrefix,
}: ParameterFieldProps) {
  const valueId = `${idPrefix}-${spec.key}-value`
  const unitId = `${idPrefix}-${spec.key}-unit`
  const loadId = `${idPrefix}-${spec.key}-load`
  const errorId = `${idPrefix}-${spec.key}-error`
  const sourceId = `${idPrefix}-${spec.key}-source`

  // Default empty values when field is undefined
  const value = field?.value ?? ''
  const unit = field?.unit ?? ''

  // Unit options grouped by dimension
  const groups = unitGroupsFor(spec)

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid={`field-${spec.key}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={valueId} className="mb-0">
          <span className="font-mono">{spec.symbol}</span>{' '}
          <span className="text-muted-foreground font-normal">{spec.label}</span>
        </Label>
        {spec.unit.kind === 'fixed' && (
          <span className="text-xs text-muted-foreground">
            dimensionless (unit "{spec.unit.symbol}")
          </span>
        )}
      </div>

      {spec.help && <p className="text-xs text-muted-foreground">{spec.help}</p>}

      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5 min-w-32 flex-1">
          <Label className="text-xs text-muted-foreground" htmlFor={valueId}>
            Value
          </Label>
          <Input
            id={valueId}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            inputMode="decimal"
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? 'true' : 'false'}
            data-testid={`input-${spec.key}-value`}
          />
        </div>

        {/* Unit control */}
        {spec.unit.kind === 'catalog' && groups.length > 0 && (
          <div className="grid gap-1.5 min-w-28">
            <Label className="text-xs text-muted-foreground" htmlFor={unitId}>
              Unit
            </Label>
            <select
              id={unitId}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={unit}
              onChange={(e) => onUnitChange(e.target.value)}
              data-testid={`input-${spec.key}-unit`}
            >
              <option value="">Select unit…</option>
              {groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.symbols.map((symbol) => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}

        {spec.unit.kind === 'rate' && groups.length > 0 && (
          <div className="grid gap-1.5 min-w-28">
            <Label className="text-xs text-muted-foreground" htmlFor={unitId}>
              Unit
            </Label>
            <select
              id={unitId}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={unit}
              onChange={(e) => onUnitChange(e.target.value)}
              data-testid={`input-${spec.key}-unit`}
            >
              <option value="">Select unit…</option>
              {groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.symbols.map((symbol) => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}

        {spec.unit.kind === 'effect' && (
          <div className="grid gap-1.5 min-w-28">
            <Label className="text-xs text-muted-foreground" htmlFor={unitId}>
              Unit
            </Label>
            <Input
              id={unitId}
              placeholder="e.g. %, pmol/min"
              value={unit}
              onChange={(e) => onUnitChange(e.target.value)}
              data-testid={`input-${spec.key}-unit`}
            />
          </div>
        )}

        {spec.unit.kind === 'fixed' && (
          <div className="grid gap-1.5 min-w-20">
            <span className="text-xs text-muted-foreground">Unit</span>
            <div className="h-9 rounded-md border border-input bg-muted px-2 text-sm flex items-center">
              {spec.unit.symbol}
            </div>
          </div>
        )}

        {/* Load from library */}
        {candidates.length > 0 && (
          <div className="grid gap-1.5 min-w-36">
            <Label className="text-xs text-muted-foreground" htmlFor={loadId}>
              From library
            </Label>
            <select
              id={loadId}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value=""
              onChange={(e) => {
                const candidate = candidates.find((c) => c.key === e.target.value)
                if (candidate) onLoad(candidate)
              }}
              data-testid={`input-${spec.key}-load`}
            >
              <option value="">Select…</option>
              {candidates.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label} — {c.value} {c.unit}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Source line / provenance */}
      {field?.source !== undefined ? (
        <p className="text-xs text-muted-foreground" id={sourceId} data-testid={`source-${spec.key}`}>
          From library: {field.source.originLabel}{' '}
          <ProvenanceBadge provenance={field.source.provenance} />
        </p>
      ) : value.trim() !== '' ? (
        <p className="text-xs text-muted-foreground" data-testid={`source-${spec.key}`}>
          User-entered — no source claim
        </p>
      ) : null}

      {/* Inline error */}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1 text-sm text-destructive"
          data-testid={`error-${spec.key}`}
        >
          <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
}