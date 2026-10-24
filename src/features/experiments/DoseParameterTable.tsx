/**
 * Shared table for dose-dependent NCA parameters (phases 50B and 50C).
 *
 * Presentation only: the value, unit, status, formula and message all come from
 * the domain report. Nothing is computed or rounded here beyond the
 * application-wide display formatting.
 */
import { formatNumber } from '@/engine/numeric/decimal'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type {
  DoseDependentParameter,
  DoseDependentStatus,
} from '@/domain/experiments/dose-dependent-nca'

const STATUS_LABEL: Record<DoseDependentStatus, string> = {
  available: 'available',
  conditional: 'conditional',
  unavailable: 'unavailable',
  'not-applicable': 'not applicable',
}

const STATUS_CLASS: Record<DoseDependentStatus, string> = {
  available: 'text-foreground',
  conditional: 'text-amber-700',
  unavailable: 'text-muted-foreground',
  'not-applicable': 'text-muted-foreground',
}

function parameterValue(parameter: DoseDependentParameter): string {
  if (parameter.status === 'available' || parameter.status === 'conditional') {
    return `${formatNumber(parameter.value ?? Number.NaN)} ${parameter.unit ?? ''}`.trim()
  }
  return '—'
}

/** DOM id fragment for a parameter: `CL/F` → `cl-f`. */
function parameterTestId(parameter: DoseDependentParameter): string {
  return parameter.parameter.toLowerCase().replace('/', '-')
}

export function DoseParameterTable({
  parameters,
  testIdPrefix,
  caption,
}: {
  readonly parameters: readonly DoseDependentParameter[]
  /** e.g. `dose-dependent` or `steady-state`; every test id starts with it. */
  readonly testIdPrefix: string
  readonly caption: string
}) {
  return (
    <Table data-testid={`${testIdPrefix}-table`}>
      <TableCaption>{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Parameter</TableHead>
          <TableHead scope="col">Value</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Formula</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {parameters.map((parameter) => (
          <TableRow key={parameter.parameter}>
            <TableHead scope="row" className="text-xs">
              {parameter.label}
              <span className="ml-1 text-muted-foreground">({parameter.basis})</span>
            </TableHead>
            <TableCell
              className="font-mono text-xs"
              data-testid={`${testIdPrefix}-${parameterTestId(parameter)}`}
            >
              {parameterValue(parameter)}
            </TableCell>
            <TableCell
              className={`text-xs ${STATUS_CLASS[parameter.status]}`}
              data-testid={`${testIdPrefix}-${parameterTestId(parameter)}-status`}
            >
              {STATUS_LABEL[parameter.status]}
            </TableCell>
            <TableCell className="font-mono text-xs">{parameter.formula}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
