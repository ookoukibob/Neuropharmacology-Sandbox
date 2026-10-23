import { useMemo, useState } from 'react'
import type { ExperimentalMeasurement } from '@/domain/experiments/experimental-dataset'
import {
  analyzeNca,
  DEFAULT_TERMINAL_POINT_COUNT,
  type NcaAnalysis,
  type NcaIntegrationMethod,
  type NcaMetric,
} from '@/domain/experiments/nca'
import { formatNumber } from '@/engine/numeric/decimal'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const KIND_LABEL: Record<'observed' | 'calculated' | 'extrapolated', string> = {
  observed: 'observed',
  calculated: 'calculated',
  extrapolated: 'extrapolated',
}

/** The terminal point-count choices offered to the analyst. */
const TERMINAL_POINT_CHOICES = [2, 3, 4, 5, 6]

function metricValue(metric: NcaMetric): string {
  return metric.status === 'available' ? `${formatNumber(metric.value)} ${metric.unit}` : 'unavailable'
}

function metricKind(metric: NcaMetric): string {
  return metric.status === 'available' ? KIND_LABEL[metric.kind] : '—'
}

function metricMethod(metric: NcaMetric): string {
  return metric.status === 'available' && metric.method !== undefined ? metric.method : '—'
}

interface NcaCardProps {
  readonly measurements: readonly ExperimentalMeasurement[]
  readonly timeUnit: string
  readonly concentrationUnit: string
}

/**
 * Noncompartmental analysis of the selected concentration–time dataset.
 *
 * The integration method and terminal point count are explicit, user-reviewable
 * settings; every value below is derived and ephemeral, never persisted. A
 * metric the data cannot support is shown as unavailable with its reason, never
 * as a fabricated number.
 */
export function NcaCard({ measurements, timeUnit, concentrationUnit }: NcaCardProps) {
  const [integrationMethod, setIntegrationMethod] = useState<NcaIntegrationMethod>('linear')
  const [terminalPointCount, setTerminalPointCount] = useState(DEFAULT_TERMINAL_POINT_COUNT)

  const analysis = useMemo(
    () => analyzeNca(measurements, timeUnit, concentrationUnit, { integrationMethod, terminalPointCount }),
    [measurements, timeUnit, concentrationUnit, integrationMethod, terminalPointCount],
  )

  return (
    <Card data-testid="nca-card">
      <CardHeader>
        <CardTitle headingLevel={3}>Noncompartmental analysis</CardTitle>
        <p className="text-xs text-muted-foreground">
          Observed and derived parameters computed from the stored concentration–time rows. Values are
          never averaged, filled in or back-extrapolated to time zero. This is an exploratory
          pharmacokinetic summary, not a clinical recommendation.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Integration method</span>
            <select
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={integrationMethod}
              data-testid="nca-integration-method"
              onChange={(event) => setIntegrationMethod(event.target.value as NcaIntegrationMethod)}
            >
              <option value="linear">Linear trapezoidal</option>
              <option value="linear-up-log-down">Linear-up / log-down</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Terminal points</span>
            <select
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={String(terminalPointCount)}
              data-testid="nca-terminal-points"
              onChange={(event) => setTerminalPointCount(Number(event.target.value))}
            >
              {TERMINAL_POINT_CHOICES.map((count) => (
                <option key={count} value={String(count)}>
                  Last {count} positive observations
                </option>
              ))}
            </select>
          </label>
        </div>

        {!analysis.ok ? (
          <p role="alert" className="text-sm text-destructive" data-testid="nca-error">
            {analysis.message}
          </p>
        ) : (
          <NcaResults
            analysis={analysis}
            measurementCount={measurements.length}
            timeUnit={timeUnit}
            concentrationUnit={concentrationUnit}
          />
        )}
      </CardContent>
    </Card>
  )
}

function NcaResults({
  analysis,
  measurementCount,
  timeUnit,
  concentrationUnit,
}: {
  analysis: NcaAnalysis
  measurementCount: number
  timeUnit: string
  concentrationUnit: string
}) {
  const rows: readonly { label: string; metric: NcaMetric; testId: string }[] = [
    { label: 'Cmax (maximum observed concentration)', metric: analysis.cmax, testId: 'nca-cmax' },
    { label: 'Tmax (time of maximum)', metric: analysis.tmax, testId: 'nca-tmax' },
    {
      label: analysis.aucLast.status === 'available' && analysis.aucLast.name ? analysis.aucLast.name : 'AUC (last)',
      metric: analysis.aucLast,
      testId: 'nca-auc-last',
    },
    { label: 'AUC extrapolated to infinity', metric: analysis.aucInf, testId: 'nca-auc-inf' },
    { label: 'Extrapolated fraction', metric: analysis.extrapolatedFraction, testId: 'nca-extrapolated-fraction' },
    { label: 'Terminal elimination rate λ_z', metric: analysis.lambdaZ, testId: 'nca-lambda-z' },
    { label: 'Terminal half-life t½', metric: analysis.halfLife, testId: 'nca-half-life' },
  ]

  const unavailableRows = rows.filter((row) => row.metric.status === 'unavailable')

  return (
    <>
      <Table data-testid="nca-table">
        <TableCaption>
          Noncompartmental parameters for {measurementCount} observations in {timeUnit} /{' '}
          {concentrationUnit}.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Parameter</TableHead>
            <TableHead scope="col">Value</TableHead>
            <TableHead scope="col">Kind</TableHead>
            <TableHead scope="col">Method</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableHead scope="row" className="text-xs">{row.label}</TableHead>
              <TableCell className="font-mono text-xs" data-testid={row.testId}>
                {metricValue(row.metric)}
              </TableCell>
              <TableCell className="text-xs">{metricKind(row.metric)}</TableCell>
              <TableCell className="text-xs">{metricMethod(row.metric)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {analysis.terminalPhase.status === 'available' && analysis.terminalPhase.regression !== null ? (
        <div className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground" data-testid="nca-terminal">
          <h4 className="font-medium text-foreground">Terminal phase</h4>
          <p>
            Selected observations: source rows {analysis.terminalPhase.selectedSourceRows.join(', ')} at times{' '}
            {analysis.terminalPhase.selectedTimes.map((time) => `${time} ${timeUnit}`).join(', ')}.
          </p>
          <p>
            Log-linear regression of ln(concentration) on time: slope ={' '}
            <span className="font-mono">{formatNumber(analysis.terminalPhase.regression.slope)}</span>, R² ={' '}
            <span className="font-mono">{formatNumber(analysis.terminalPhase.regression.rSquared)}</span> over{' '}
            {analysis.terminalPhase.regression.observationCount} points.
          </p>
        </div>
      ) : null}

      {unavailableRows.length > 0 ? (
        <div className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground" role="note" data-testid="nca-unavailable">
          <h4 className="font-medium text-foreground">Why some parameters are unavailable</h4>
          <ul className="list-disc space-y-1 pl-4">
            {unavailableRows.map((row) => (
              <li key={row.label}>
                {row.label}: {row.metric.status === 'unavailable' ? row.metric.message : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.warnings.length > 0 ? (
        <div className="space-y-1 rounded-md border border-amber-500/40 p-3 text-xs text-amber-700" role="status" data-testid="nca-warnings">
          <h4 className="font-medium">Notes and cautions</h4>
          <ul className="list-disc space-y-1 pl-4">
            {analysis.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        AUC is reported in {concentrationUnit}·{timeUnit} (area under the concentration–time curve);
        λ_z in {timeUnit}⁻¹. The extrapolated fraction is a quality criterion, not a proof that the
        estimate is valid.
      </p>
    </>
  )
}
