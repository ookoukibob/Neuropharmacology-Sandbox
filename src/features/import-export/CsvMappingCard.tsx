/**
 * CSV column-mapping card — the explicit step between "file selected" and
 * "preview".
 *
 * Every source column is shown with a sample value and a destination
 * select; the default is always "Ignore (not imported)". No column is
 * ever inferred from its name — a `Kd/Ki`, `affinity` or `potency` header
 * stays unmapped until the user assigns it. Parameter value columns
 * without a unit column must declare a visibly chosen fixed unit before
 * the preview can run.
 */
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { unitCatalog } from '@/domain/pharmacology/unit-catalog'
import { CSV_PARAMS, type ParamKey } from './csv/params'
import {
  CSV_DESTINATIONS,
  mappingWarnings,
  type CsvMappingState,
  type DestinationOption,
} from './csv/csvImport'

const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background px-2 text-sm'

/** Destination options grouped in declaration order (one pass, no resort). */
const DESTINATION_GROUPS: readonly { name: string; options: DestinationOption[] }[] = (() => {
  const groups: { name: string; options: DestinationOption[] }[] = []
  for (const option of CSV_DESTINATIONS) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.name === option.group) last.options.push(option)
    else groups.push({ name: option.group, options: [option] })
  }
  return groups
})()

interface Props {
  readonly state: CsvMappingState
  readonly errors: readonly string[]
  readonly disabled: boolean
  readonly onChange: (next: CsvMappingState) => void
  readonly onPreview: () => void
  readonly onDiscard: () => void
}

export function CsvMappingCard({ state, errors, disabled, onChange, onPreview, onDiscard }: Props) {
  const warnings = mappingWarnings(state)
  const mappedValueParams = CSV_PARAMS.filter((p) =>
    state.destinations.includes(`${p.key}.value`),
  )
  const fixedUnitParams = mappedValueParams.filter(
    (p) => !state.destinations.includes(`${p.key}.unit`),
  )

  function setDestination(index: number, value: string): void {
    const next = state.destinations.map((dest, i) =>
      i === index ? (value === '' ? null : value) : dest,
    )
    onChange({ ...state, destinations: next })
  }

  function setFixedUnit(key: ParamKey, value: string): void {
    onChange({ ...state, fixedUnits: { ...state.fixedUnits, [key]: value } })
  }

  return (
    <Card data-testid="csv-mapping">
      <CardHeader>
        <CardTitle headingLevel={2}>Map CSV columns</CardTitle>
        <p className="text-sm text-muted-foreground">
          File: {state.fileName} — {state.headers.length} column
          {state.headers.length === 1 ? '' : 's'}, {state.rows.length} data row
          {state.rows.length === 1 ? '' : 's'}. Columns left unmapped are not imported and are
          listed again in the preview. Drug name is required; scientific columns are never
          inferred from their names.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Column</TableHead>
              <TableHead>First value</TableHead>
              <TableHead>Maps to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.headers.map((header, index) => {
              const sample = state.rows[0]?.[index] ?? ''
              const displayName = header === '' ? `column ${index + 1} (unnamed)` : header
              return (
                <TableRow key={`${displayName}-${index}`}>
                  <TableCell className="font-medium">{displayName}</TableCell>
                  <TableCell
                    className="max-w-56 truncate text-muted-foreground"
                    title={sample}
                  >
                    {sample === '' ? '—' : sample}
                  </TableCell>
                  <TableCell>
                    <select
                      aria-label={`Map column ${displayName}`}
                      data-testid={`map-${index}`}
                      className={SELECT_CLASS}
                      value={state.destinations[index] ?? ''}
                      disabled={disabled}
                      onChange={(e) => setDestination(index, e.target.value)}
                    >
                      <option value="">Ignore (not imported)</option>
                      {DESTINATION_GROUPS.map((group) => (
                        <optgroup key={group.name} label={group.name}>
                          {group.options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>

        {fixedUnitParams.length > 0 && (
          <div className="space-y-2" data-testid="fixed-units">
            <p className="text-sm font-medium">Fixed units</p>
            <p className="text-xs text-muted-foreground">
              These value columns have no unit column, so one fixed unit applies to every row.
              Units are stored exactly as declared — never converted or guessed.
            </p>
            {fixedUnitParams.map((param) => {
              const unitId = `fixed-unit-${param.key}`
              return (
                <div key={param.key} className="flex flex-wrap items-center gap-2">
                  <Label htmlFor={unitId} className="w-48 shrink-0">
                    {param.label}
                  </Label>
                  {param.dimensions.length > 0 ? (
                    <select
                      id={unitId}
                      data-testid={unitId}
                      className={SELECT_CLASS}
                      value={state.fixedUnits[param.key] ?? ''}
                      disabled={disabled}
                      onChange={(e) => setFixedUnit(param.key, e.target.value)}
                    >
                      <option value="">Select unit…</option>
                      {param.dimensions.map((dimension) => (
                        <optgroup key={dimension} label={dimension}>
                          {unitCatalog.unitsOfDimension(dimension).map((unit) => (
                            <option key={unit.symbol} value={unit.symbol}>
                              {unit.symbol}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={unitId}
                      data-testid={unitId}
                      placeholder="declared unit (e.g. mL/min)"
                      value={state.fixedUnits[param.key] ?? ''}
                      disabled={disabled}
                      onChange={(e) => setFixedUnit(param.key, e.target.value)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {warnings.length > 0 && (
          <Alert data-testid="mapping-warnings">
            <AlertTitle>Check these mappings</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {errors.length > 0 && (
          <Alert variant="destructive" data-testid="mapping-errors">
            <AlertTitle>Mapping needs attention</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" data-testid="csv-preview-btn" disabled={disabled} onClick={onPreview}>
            Preview import
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="csv-cancel-btn"
            disabled={disabled}
            onClick={onDiscard}
          >
            Discard file
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
