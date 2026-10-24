/**
 * Sampling coverage diagnostics (phase 50E).
 *
 * Presentation only: every count, duration, median, proportion and status comes
 * from `analyzeSamplingCoverage`. This component never subtracts times, sorts
 * them, converts a unit, decides that sampling is adequate — or inadequate.
 */
import { formatNumber } from '@/engine/numeric/decimal'
import type {
  ObservedExtremeLocations,
  SamplingCoverageReport,
  SamplingGap,
  SamplingPosition,
} from '@/domain/experiments/sampling-coverage'

const POSITION_LABEL: Record<SamplingPosition, string> = {
  start: 'at the interval start',
  end: 'at the interval end',
  inside: 'inside the interval',
}

export function SamplingCoverageSummary({ report }: { readonly report: SamplingCoverageReport }) {
  if (report.status === 'unavailable' || report.window === null) {
    return (
      <section
        aria-labelledby="sampling-coverage-heading"
        className="space-y-2 border-t pt-4"
        data-testid="sampling-coverage"
      >
        <h5 id="sampling-coverage-heading" className="text-sm font-medium">
          Sampling coverage diagnostics
        </h5>
        <p className="text-xs text-muted-foreground" role="note" data-testid="sampling-unavailable">
          <span className="font-mono text-[0.7rem]">{report.code}</span>: {report.message}
        </p>
        <Limitations limits={report.limits} />
      </section>
    )
  }

  const { window, gaps, maximumGapFraction, extremeLocations } = report

  return (
    <section
      aria-labelledby="sampling-coverage-heading"
      className="space-y-3 border-t pt-4"
      data-testid="sampling-coverage"
    >
      <div className="space-y-1">
        <h5 id="sampling-coverage-heading" className="text-sm font-medium">
          Sampling coverage diagnostics
        </h5>
        <p className="text-xs text-muted-foreground" data-testid="sampling-coverage-summary">
          {report.summary}
        </p>
      </div>

      <div className="rounded-md border p-3 text-xs" data-testid="sampling-summary">
        <h6 className="font-medium">Sampling summary</h6>
        <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <Row label="Measurement records in the interval" value={String(window.observationCount)} />
          <Row label="Distinct sampling times" value={String(window.distinctTimeCount)} />
          <Row
            label="Selected interval"
            value={`${formatNumber(window.startTime)} → ${formatNumber(window.endTime)} ${window.timeUnit}`}
          />
          <Row
            label="Interval width"
            value={
              window.duration === null
                ? 'unavailable (zero or non-finite width)'
                : `${formatNumber(window.duration)} ${window.timeUnit}`
            }
          />
          <Row
            label="Adjacent gaps"
            value={gaps.status === 'available' ? String(gaps.value.gapCount) : 'unavailable'}
          />
          <Row
            label="Recorded dosing interval τ"
            value={
              report.dosingInterval === null
                ? 'not recorded'
                : `${formatNumber(report.dosingInterval.recorded.value)} ${report.dosingInterval.recorded.unit} = ${formatNumber(report.dosingInterval.inDatasetTimeUnit)} ${report.timeUnit}`
            }
          />
        </dl>
        <p className="mt-1 text-muted-foreground">
          Records and sampling times are counted separately: several measurements can share one sampling
          time and are never merged into a single observation.
        </p>
      </div>

      <div className="rounded-md border p-3 text-xs" data-testid="sampling-gaps">
        <h6 className="font-medium">Gap statistics</h6>
        {gaps.status === 'available' ? (
          <>
            <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
              <Row
                label="Minimum gap"
                value={`${formatNumber(gaps.value.minimumGap)} ${window.timeUnit}`}
                testId="sampling-gap-min"
              />
              <Row
                label="Median gap"
                value={`${formatNumber(gaps.value.medianGap)} ${window.timeUnit}`}
                testId="sampling-gap-median"
              />
              <Row
                label="Mean gap"
                value={`${formatNumber(gaps.value.meanGap)} ${window.timeUnit}`}
                testId="sampling-gap-mean"
              />
              <Row
                label="Maximum gap"
                value={`${formatNumber(gaps.value.maximumGap)} ${window.timeUnit}`}
                testId="sampling-gap-max"
              />
            </dl>
            <p className="mt-1 text-muted-foreground">
              Gaps are measured between ascending distinct sampling times inside the interval. The median
              averages the two middle gaps when their number is even.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-[0.7rem] text-muted-foreground">
                Show all {gaps.value.gapCount} adjacent gap(s)
              </summary>
              <ul className="mt-1 space-y-0.5 font-mono text-[0.7rem]">
                {gaps.value.gaps.map((gap) => (
                  <li key={`${gap.fromTime}-${gap.toTime}`} data-testid="sampling-gap-item">
                    {formatNumber(gap.fromTime)} → {formatNumber(gap.toTime)} {window.timeUnit}:{' '}
                    {formatNumber(gap.gapDuration)} {window.timeUnit} · rows {gap.fromSourceRows.join(', ')}{' '}
                    → {gap.toSourceRows.join(', ')}
                    {gap.isMaximum ? ' · largest' : ''}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p className="mt-1 text-muted-foreground" role="note" data-testid="sampling-gaps-unavailable">
            <span className="font-mono text-[0.7rem]">{gaps.code}</span>: {gaps.message}
          </p>
        )}
      </div>

      <div className="rounded-md border p-3 text-xs" data-testid="sampling-longest-gaps">
        <h6 className="font-medium">Longest gap(s)</h6>
        {gaps.status === 'available' ? (
          <ul className="mt-1 space-y-1">
            {gaps.value.maximumGaps.map((gap) => (
              <GapItem key={`${gap.fromTime}-${gap.toTime}`} gap={gap} timeUnit={window.timeUnit} />
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-muted-foreground">No gap exists, so there is no longest gap.</p>
        )}
        {gaps.status === 'available' && gaps.value.maximumGaps.length > 1 ? (
          <p className="mt-1 text-muted-foreground" data-testid="sampling-longest-gap-tie">
            {gaps.value.maximumGaps.length} gaps share the same maximum; all of them are listed.
          </p>
        ) : null}
        {maximumGapFraction.status === 'available' ? (
          <p className="mt-1 text-muted-foreground" data-testid="sampling-gap-fraction">
            The largest gap is {formatNumber(maximumGapFraction.value.percent)} % of the{' '}
            {formatNumber(maximumGapFraction.value.windowDuration)} {maximumGapFraction.value.timeUnit}{' '}
            interval ({formatNumber(maximumGapFraction.value.maximumGap)}{' '}
            {maximumGapFraction.value.timeUnit}). This is a proportion of the selected window, not a
            coverage score.
          </p>
        ) : (
          <p className="mt-1 text-muted-foreground" data-testid="sampling-gap-fraction-unavailable">
            <span className="font-mono text-[0.7rem]">{maximumGapFraction.code}</span>:{' '}
            {maximumGapFraction.message}
          </p>
        )}
      </div>

      <div className="rounded-md border p-3 text-xs" data-testid="sampling-repeated">
        <h6 className="font-medium">Repeated sampling times</h6>
        {report.repeatedTimes.length === 0 ? (
          <p className="mt-1 text-muted-foreground">No sampling time is shared by more than one record.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {report.repeatedTimes.map((entry) => (
              <li key={entry.time} data-testid="sampling-repeated-item">
                <span className="font-mono">
                  {formatNumber(entry.time)} {window.timeUnit}
                </span>{' '}
                — {entry.observationCount} records, source rows {entry.sourceRows.join(', ')}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-muted-foreground">
          Records that share a sampling time are kept as separate measurements; they are never averaged,
          deleted or counted as additional sampling coverage.
        </p>
      </div>

      <div className="rounded-md border p-3 text-xs" data-testid="sampling-boundaries">
        <h6 className="font-medium">Boundary coverage</h6>
        <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <Row
            label="Observation at the interval start"
            value={window.startObserved ? 'yes' : 'no'}
            testId="sampling-start-observed"
          />
          <Row
            label="Observation at the interval end"
            value={window.endObserved ? 'yes' : 'no'}
            testId="sampling-end-observed"
          />
        </dl>
      </div>

      <div className="rounded-md border p-3 text-xs" data-testid="sampling-extremes">
        <h6 className="font-medium">Observed-extreme location</h6>
        {extremeLocations.status === 'available' ? (
          <div className="mt-1 space-y-2">
            <ExtremeBlock
              title="Observed maximum (Cmax,obs)"
              extreme={extremeLocations.value.maximum}
              timeUnit={window.timeUnit}
              testId="sampling-max"
            />
            <ExtremeBlock
              title="Observed minimum (Cmin,obs)"
              extreme={extremeLocations.value.minimum}
              timeUnit={window.timeUnit}
              testId="sampling-min"
            />
            <p className="text-muted-foreground">
              These describe where the sampled extremes happen to sit. An extreme at a boundary does not
              prove that the true peak or trough was missed, and an extreme inside the interval does not
              prove that it was captured.
            </p>
          </div>
        ) : (
          <p className="mt-1 text-muted-foreground" role="note" data-testid="sampling-extremes-unavailable">
            <span className="font-mono text-[0.7rem]">{extremeLocations.code}</span>:{' '}
            {extremeLocations.message}
          </p>
        )}
      </div>

      <Limitations limits={report.limits} />
    </section>
  )
}

function ExtremeBlock({
  title,
  extreme,
  timeUnit,
  testId,
}: {
  readonly title: string
  readonly extreme: ObservedExtremeLocations
  readonly timeUnit: string
  readonly testId: string
}) {
  return (
    <div data-testid={`${testId}-locations`}>
      <p className="font-medium text-foreground">
        {title}: {formatNumber(extreme.concentration)} {extreme.concentrationUnit}
      </p>
      <p className="text-muted-foreground" data-testid={`${testId}-positions`}>
        Observed {extreme.positions.map((position) => POSITION_LABEL[position]).join(', ')}.
      </p>
      <ul className="space-y-0.5 font-mono text-[0.7rem]">
        {extreme.observations.map((observation) => (
          <li key={`${observation.sourceRow}-${observation.time}`} data-testid={`${testId}-item`}>
            {formatNumber(observation.concentration)} {extreme.concentrationUnit} at{' '}
            {formatNumber(observation.time)} {timeUnit} · source row {observation.sourceRow} ·{' '}
            {POSITION_LABEL[observation.position]}
          </li>
        ))}
      </ul>
    </div>
  )
}

function GapItem({ gap, timeUnit }: { readonly gap: SamplingGap; readonly timeUnit: string }) {
  return (
    <li data-testid="sampling-longest-gap-item">
      <span className="font-mono">
        {formatNumber(gap.fromTime)} → {formatNumber(gap.toTime)} {timeUnit}
      </span>{' '}
      · {formatNumber(gap.gapDuration)} {timeUnit} · source rows {gap.fromSourceRows.join(', ')} →{' '}
      {gap.toSourceRows.join(', ')}
    </li>
  )
}

function Limitations({ limits }: { readonly limits: readonly string[] }) {
  return (
    <div className="rounded-md border p-3 text-xs" data-testid="sampling-limits">
      <h6 className="font-medium">Limitations</h6>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
        {limits.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
    </div>
  )
}

function Row({
  label,
  value,
  testId,
}: {
  readonly label: string
  readonly value: string
  readonly testId?: string
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}
