/**
 * Interval exposure summary (phase 50D).
 *
 * Presentation only: every number, status, formula, substitution and refusal
 * reason comes from `analyzeIntervalExposure`. This component never computes a
 * peak, a mean or a fluctuation, never decides steady state and never converts
 * a unit.
 */
import { formatNumber } from '@/engine/numeric/decimal'
import { ScientificText } from '@/components/scientific/ScientificText'
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
  IntervalExposureMetric,
  IntervalExposureObservation,
  IntervalExposureReport,
  IntervalExposureStatus,
} from '@/domain/experiments/interval-exposure-metrics'

const STATUS_LABEL: Record<IntervalExposureStatus, string> = {
  available: 'available',
  conditional: 'conditional',
  unavailable: 'unavailable',
  'not-applicable': 'not applicable',
}

const STATUS_CLASS: Record<IntervalExposureStatus, string> = {
  available: 'text-foreground',
  conditional: 'text-amber-700',
  unavailable: 'text-muted-foreground',
  'not-applicable': 'text-muted-foreground',
}

const KIND_LABEL: Record<IntervalExposureMetric['kind'], string> = {
  observed: 'observed',
  calculated: 'calculated',
}

function metricValue(metric: IntervalExposureMetric): string {
  if (metric.status === 'available' || metric.status === 'conditional') {
    return `${formatNumber(metric.value ?? Number.NaN)} ${metric.unit ?? ''}`.trim()
  }
  return '—'
}

export function IntervalExposureSummary({ report }: { readonly report: IntervalExposureReport }) {
  const unavailable = report.metrics.filter(
    (metric) => metric.status === 'unavailable' || metric.status === 'not-applicable',
  )
  const conditional = report.metrics.filter((metric) => metric.status === 'conditional')
  const substitutions = report.metrics.filter((metric) => metric.substitution !== undefined)

  return (
    <section
      aria-labelledby="exposure-heading"
      className="space-y-3 border-t pt-4"
      data-testid="exposure-summary"
    >
      <div className="space-y-1">
        <h5 id="exposure-heading" className="text-sm font-medium">
          Interval exposure summary
        </h5>
        <p className="text-xs text-muted-foreground" data-testid="exposure-summary-text">
          {report.summary}
        </p>
      </div>

      <Table data-testid="exposure-table">
        <TableCaption>
          Observed peak and trough, the mean over the selected interval and — only for a declared steady
          state — the steady-state mean and the observed peak-to-trough fluctuation. Every value is
          derived from observations inside the interval; nothing is interpolated or fitted.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Metric</TableHead>
            <TableHead scope="col">Value</TableHead>
            <TableHead scope="col">Kind</TableHead>
            <TableHead scope="col">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.metrics.map((metric) => (
            <TableRow key={metric.id}>
              <TableHead scope="row" className="text-xs">
                {metric.label}
              </TableHead>
              <TableCell className="font-mono text-xs" data-testid={`exposure-${metric.id}`}>
                {metricValue(metric)}
              </TableCell>
              <TableCell className="text-xs">{KIND_LABEL[metric.kind]}</TableCell>
              <TableCell
                className={`text-xs ${STATUS_CLASS[metric.status]}`}
                data-testid={`exposure-${metric.id}-status`}
              >
                {STATUS_LABEL[metric.status]}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ExtremeDetail
        heading="Observation(s) attaining the observed maximum"
        metric={report.cmaxObs}
        timeUnit={report.timeUnit}
        concentrationUnit={report.concentrationUnit}
        testId="exposure-peak-observations"
      />
      <ExtremeDetail
        heading="Observation(s) attaining the observed minimum"
        metric={report.cminObs}
        timeUnit={report.timeUnit}
        concentrationUnit={report.concentrationUnit}
        testId="exposure-trough-observations"
      />

      <div className="space-y-1 rounded-md border p-3 text-xs" data-testid="exposure-inputs">
        <h6 className="font-medium">Interval and inputs</h6>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <Detail
            label="Selected interval"
            value={
              report.window === null
                ? 'not selected'
                : `${formatNumber(report.window.startTime)} → ${formatNumber(report.window.endTime)} ${report.window.timeUnit}`
            }
          />
          <Detail
            label="Interval duration"
            value={
              report.window === null
                ? '—'
                : `${formatNumber(report.window.duration)} ${report.window.timeUnit}`
            }
          />
          <Detail
            label="Observed points in the interval"
            value={report.window === null ? '—' : String(report.window.observationCount)}
          />
          <Detail
            label="AUCτ used"
            value={
              report.aucTauUsed === null
                ? 'unavailable'
                : `${formatNumber(report.aucTauUsed.value)} ${report.aucTauUsed.unit}`
            }
          />
          <Detail
            label="τ used"
            value={
              report.dosingInterval === null
                ? 'not recorded'
                : `${formatNumber(report.dosingInterval.recorded.value)} ${report.dosingInterval.recorded.unit} = ${formatNumber(report.dosingInterval.inDatasetTimeUnit)} ${report.timeUnit}`
            }
          />
          <Detail
            label="Steady state"
            value={
              report.regimen === 'repeated-dose-steady-state'
                ? report.intervalAligned
                  ? 'declared, interval confirmed aligned to a dose'
                  : 'declared, interval alignment not confirmed'
                : `not applicable (regimen: ${report.regimen})`
            }
          />
        </dl>
        <ul className="mt-2 space-y-1 font-mono text-[0.7rem] text-muted-foreground">
          {substitutions.map((metric) => (
            <li key={`${metric.id}-substitution`}>
              {metric.id}: {metric.substitution}
            </li>
          ))}
        </ul>
        <ul className="mt-1 space-y-1 text-muted-foreground">
          {report.metrics
            .filter((metric) => metric.status === 'available' || metric.status === 'conditional')
            .flatMap((metric) =>
              metric.assumptions.map((assumption) => (
                <li key={`${metric.id}-${assumption}`}>
                  <span className="font-mono text-[0.7rem]">{metric.id}</span>: {assumption}
                </li>
              )),
            )}
        </ul>
      </div>

      {conditional.length > 0 ? (
        <div
          className="space-y-1 rounded-md border border-amber-500/40 p-3 text-xs text-amber-700"
          role="status"
          data-testid="exposure-conditional"
        >
          <h6 className="font-medium">Conditional metrics</h6>
          <ul className="list-disc space-y-1 pl-4">
            {conditional.map((metric) => (
              <li key={metric.id}>
                <span className="font-medium">{metric.id}</span>: {metric.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unavailable.length > 0 ? (
        <div
          className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground"
          role="note"
          data-testid="exposure-unavailable"
        >
          <h6 className="font-medium text-foreground">Why a metric is unavailable</h6>
          <ul className="list-disc space-y-1 pl-4">
            {unavailable.map((metric) => (
              <li key={metric.id}>
                <span className="font-medium text-foreground">{metric.id}</span>{' '}
                <span className="font-mono text-[0.7rem]">{metric.code}</span>{' '}
                ({STATUS_LABEL[metric.status]}): {metric.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-md border p-3 text-xs" data-testid="exposure-preconditions">
        <h6 className="mb-1 font-medium">Preconditions checked</h6>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          {report.preconditions.map((precondition) => (
            <li key={precondition.id}>
              <span className="font-mono text-[0.7rem]">{precondition.id}</span>{' '}
              <span className="font-medium text-foreground">{precondition.status}</span>:{' '}
              {precondition.message}
            </li>
          ))}
        </ul>
      </div>

      {report.warnings.length > 0 ? (
        <div
          className="space-y-1 rounded-md border border-amber-500/40 p-3 text-xs text-amber-700"
          role="status"
          data-testid="exposure-warnings"
        >
          <h6 className="font-medium">Notes</h6>
          <ul className="list-disc space-y-1 pl-4">
            {report.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1 rounded-md border p-3 text-xs" data-testid="exposure-formulas">
        <h6 className="font-medium">Formulas</h6>
        <ul className="space-y-1 font-mono text-[0.7rem]">
          {report.metrics.map((metric) => (
            <li key={`${metric.id}-formula`}>
              <ScientificText value={metric.formula} />
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="exposure-scope">
        The peak and trough are the largest and smallest concentrations actually sampled inside the
        interval — not the true extremes between samples. They are never averaged, interpolated, smoothed
        or fitted. The steady-state mean and the fluctuation exist only for a dataset declared to be at
        steady state with an interval confirmed to start at a dose, and they are never inferred from the
        curve. These are exploratory pharmacokinetic summaries, not clinical dose recommendations.
      </p>
    </section>
  )
}

/**
 * The full list of observations attaining an extreme. Ties are shown, not
 * collapsed: the domain reports every attaining row and this block renders all
 * of them.
 */
function ExtremeDetail({
  heading,
  metric,
  timeUnit,
  concentrationUnit,
  testId,
}: {
  readonly heading: string
  readonly metric: IntervalExposureMetric
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly testId: string
}) {
  const observations = metric.observations ?? []
  if (metric.status !== 'available' && metric.status !== 'conditional') return null
  if (observations.length === 0) return null
  return (
    <div className="space-y-1 rounded-md border p-3 text-xs" data-testid={testId}>
      <h6 className="font-medium">
        {heading} ({observations.length})
      </h6>
      <ul className="space-y-1">
        {observations.map((observation: IntervalExposureObservation) => (
          <li
            key={`${observation.sourceRow}-${observation.time}`}
            className="font-mono"
            data-testid={`${testId}-item`}
          >
            {formatNumber(observation.concentration)} {concentrationUnit} at{' '}
            {formatNumber(observation.time)} {timeUnit} · source row {observation.sourceRow}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        {observations.length === 1
          ? 'A single sampling time attains this extreme.'
          : 'More than one sampling time attains this extreme; all of them are listed and no single time is treated as unique.'}
      </p>
    </div>
  )
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  )
}
