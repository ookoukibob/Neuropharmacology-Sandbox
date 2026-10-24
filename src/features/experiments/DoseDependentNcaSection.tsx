/**
 * Dose-dependent NCA display (phase 50B).
 *
 * Presentation only: every number, formula, status and unavailable reason comes
 * from `analyzeDoseDependentNca`. This component never performs a
 * pharmacological calculation, and it never fills a missing input with a guess.
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
  DoseDependentNcaReport,
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

export function DoseDependentNcaSection({ report }: { readonly report: DoseDependentNcaReport }) {
  const parameters = [report.parameters.cl, report.parameters.clF, report.parameters.vz, report.parameters.vzF]
  const unavailable = parameters.filter((parameter) => parameter.status === 'unavailable')
  const conditional = parameters.filter((parameter) => parameter.status === 'conditional')

  return (
    <section aria-labelledby="dose-dependent-heading" className="space-y-3" data-testid="dose-dependent-nca">
      <div className="space-y-1">
        <h4 id="dose-dependent-heading" className="text-sm font-medium">
          Dose-dependent parameters
        </h4>
        <p className="text-xs text-muted-foreground" data-testid="dose-dependent-summary">
          {report.summary}
        </p>
      </div>

      <Table data-testid="dose-dependent-table">
        <TableCaption>
          Clearance and terminal volume derived from recorded administration metadata and the NCA result
          above. Conditional values include explicit caveats; unavailable parameters show why they were refused.
        </TableCaption>
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
                data-testid={`dose-dependent-${parameter.parameter.toLowerCase().replace('/', '-')}`}
              >
                {parameterValue(parameter)}
              </TableCell>
              <TableCell
                className={`text-xs ${STATUS_CLASS[parameter.status]}`}
                data-testid={`dose-dependent-${parameter.parameter.toLowerCase().replace('/', '-')}-status`}
              >
                {STATUS_LABEL[parameter.status]}
              </TableCell>
              <TableCell className="font-mono text-xs">{parameter.formula}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {unavailable.length > 0 ? (
        <div
          className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground"
          role="note"
          data-testid="dose-dependent-unavailable"
        >
          <h5 className="font-medium text-foreground">Why a dose-dependent parameter is unavailable</h5>
          <ul className="list-disc space-y-1 pl-4">
            {unavailable.map((parameter) => (
              <li key={parameter.parameter}>
                <span className="font-medium text-foreground">{parameter.parameter}</span>{' '}
                <span className="font-mono text-[0.7rem]">{parameter.code}</span>: {parameter.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {conditional.length > 0 ? (
        <div
          className="space-y-1 rounded-md border border-amber-500/40 p-3 text-xs text-amber-700"
          role="status"
          data-testid="dose-dependent-conditional"
        >
          <h5 className="font-medium">Conditional results</h5>
          <ul className="list-disc space-y-1 pl-4">
            {conditional.map((parameter) => (
              <li key={parameter.parameter}>
                <span className="font-medium">{parameter.parameter}</span>: {parameter.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1 rounded-md border p-3 text-xs" data-testid="dose-dependent-inputs">
        <h5 className="font-medium">Inputs and substitutions</h5>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <InputRow label="Dose" value={doseText(report)} />
          <InputRow label="AUC used" value={aucText(report)} />
          <InputRow label="λ_z used" value={lambdaText(report)} />
          <InputRow label="Bioavailability F" value={fText(report)} />
        </dl>
        <ul className="mt-2 space-y-1 font-mono text-[0.7rem] text-muted-foreground">
          {parameters
            .filter((parameter) => parameter.substitution !== undefined)
            .map((parameter) => (
              <li key={`${parameter.parameter}-substitution`}>
                {parameter.parameter}: {parameter.substitution}
              </li>
            ))}
        </ul>
      </div>

      <div className="rounded-md border p-3 text-xs" data-testid="dose-dependent-preconditions">
        <h5 className="mb-1 font-medium">Preconditions checked</h5>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          {report.preconditions.map((precondition) => (
            <li key={precondition.id}>
              <span className="font-mono text-[0.7rem]">{precondition.id}</span>{' '}
              <span className="font-medium text-foreground">{precondition.status}</span>: {precondition.message}
            </li>
          ))}
        </ul>
      </div>

      {report.warnings.length > 0 ? (
        <div
          className="space-y-1 rounded-md border border-amber-500/40 p-3 text-xs text-amber-700"
          role="status"
          data-testid="dose-dependent-warnings"
        >
          <h5 className="font-medium">Notes</h5>
          <ul className="list-disc space-y-1 pl-4">
            {report.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid="dose-dependent-scope">
        Dose-dependent NCA is limited to single-dose datasets in this phase. Repeated-dose and steady-state
        datasets are not converted into a single-dose curve, and τ is never treated as the analysis interval.
        These are exploratory pharmacokinetic summaries, not clinical dose recommendations.
      </p>
    </section>
  )
}

function InputRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  )
}

function doseText(report: DoseDependentNcaReport): string {
  const dose = report.parameters.cl.inputs.dose ?? report.parameters.clF.inputs.dose
  return dose === undefined ? 'not recorded' : `${formatNumber(dose.value)} ${dose.unit}`
}

function aucText(report: DoseDependentNcaReport): string {
  const auc = report.parameters.cl.inputs.auc ?? report.parameters.clF.inputs.auc
  return auc === undefined ? 'unavailable' : `${auc.name} = ${formatNumber(auc.value)} ${auc.unit}`
}

function lambdaText(report: DoseDependentNcaReport): string {
  const lambdaZ = report.parameters.cl.inputs.lambdaZ
  return lambdaZ === undefined
    ? 'unavailable (volume parameters only)'
    : `${formatNumber(lambdaZ.value)} ${lambdaZ.unit}`
}

function fText(report: DoseDependentNcaReport): string {
  const f = report.parameters.cl.inputs.bioavailability
  if (f !== undefined) return formatNumber(f)
  return report.route === 'iv-bolus' || report.route === 'iv-infusion'
    ? '1 by the IV route definition'
    : 'not recorded'
}
