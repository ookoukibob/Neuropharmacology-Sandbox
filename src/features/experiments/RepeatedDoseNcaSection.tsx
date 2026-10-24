/**
 * Repeated-dose interval AUCτ and steady-state parameter display (phase 50C).
 *
 * Presentation only. Every number, formula, status and refusal reason comes
 * from `analyzeIntervalAuc` / `analyzeSteadyStateDoseNca`; this component only
 * renders them and forwards the analyst's explicit interval selection and
 * alignment confirmation. It never integrates, converts units or decides
 * whether steady state holds.
 */
import { formatNumber } from '@/engine/numeric/decimal'
import { DoseParameterTable } from './DoseParameterTable'
import { IntervalExposureSummary } from './IntervalExposureSummary'
import type { AdministrationQuantity } from '@/domain/experiments/experimental-dataset'
import type { IntervalAucReport, IntervalAucSelection } from '@/domain/experiments/interval-auc'
import type { IntervalExposureReport } from '@/domain/experiments/interval-exposure-metrics'
import type { SteadyStateDoseNcaReport } from '@/domain/experiments/steady-state-dose-nca'

interface RepeatedDoseNcaSectionProps {
  readonly interval: IntervalAucReport
  readonly steady: SteadyStateDoseNcaReport
  /** Observed interval exposure metrics over the same selected interval. */
  readonly exposure: IntervalExposureReport
  readonly timeUnit: string
  readonly concentrationUnit: string
  /** Observed sampling times only, ascending; used to build the selectors. */
  readonly observedTimes: readonly number[]
  readonly selection: IntervalAucSelection | null
  readonly aligned: boolean
  readonly dosingInterval: AdministrationQuantity | undefined
  readonly onSelectStart: (time: number | null) => void
  readonly onSelectEnd: (time: number | null) => void
  readonly onAlignedChange: (aligned: boolean) => void
  readonly onClearSelection: () => void
}

export function RepeatedDoseNcaSection({
  interval,
  steady,
  exposure,
  timeUnit,
  concentrationUnit,
  observedTimes,
  selection,
  aligned,
  dosingInterval,
  onSelectStart,
  onSelectEnd,
  onAlignedChange,
  onClearSelection,
}: RepeatedDoseNcaSectionProps) {
  const parameters = [steady.parameters.cl, steady.parameters.clF, steady.parameters.vz, steady.parameters.vzF]
  const unavailable = parameters.filter((parameter) => parameter.status === 'unavailable')
  const conditional = parameters.filter((parameter) => parameter.status === 'conditional')
  const isSteadyState = steady.regimen === 'repeated-dose-steady-state'

  return (
    <section
      aria-labelledby="repeated-dose-heading"
      className="space-y-3 border-t pt-4"
      data-testid="repeated-dose-nca"
    >
      <div className="space-y-1">
        <h4 id="repeated-dose-heading" className="text-sm font-medium">
          Repeated dosing: interval AUCτ
        </h4>
        <p className="text-xs text-muted-foreground" data-testid="repeated-dose-intro">
          AUCτ is the observed area between two sampled times that are exactly one dosing interval apart.
          Nothing is extrapolated, interpolated or zero-filled, and a computable area never implies steady
          state.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2" role="group" aria-labelledby="repeated-dose-heading">
        <TimeSelect
          id="repeated-interval-start"
          label={`Interval start (observed ${timeUnit})`}
          value={selection?.startTime ?? null}
          choices={observedTimes}
          onChange={onSelectStart}
        />
        <TimeSelect
          id="repeated-interval-end"
          label={`Interval end (observed ${timeUnit})`}
          value={selection?.endTime ?? null}
          choices={observedTimes}
          onChange={onSelectEnd}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span data-testid="repeated-dose-tau">
          Recorded dosing interval τ:{' '}
          {dosingInterval === undefined
            ? 'not recorded'
            : `${formatNumber(dosingInterval.value)} ${dosingInterval.unit}`}
        </span>
        {selection === null ? null : (
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={onClearSelection}
            data-testid="interval-clear"
          >
            Clear interval selection
          </button>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3 text-xs" data-testid="interval-auc">
        <h5 className="font-medium text-sm">Selected interval</h5>
        {interval.aucTau.status === 'available' ? (
          <>
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              <Detail label="AUCτ" value={`${formatNumber(interval.aucTau.value)} ${interval.aucTau.unit}`} />
              <Detail label="Integration method" value={interval.aucTau.method} />
              <Detail
                label="Interval"
                value={
                  interval.interval === null
                    ? '—'
                    : `${formatNumber(interval.interval.startTime)} → ${formatNumber(interval.interval.endTime)} ${timeUnit} (${formatNumber(interval.interval.observedDurationHours)} h)`
                }
              />
              <Detail
                label="τ used for the length check"
                value={
                  interval.interval === null
                    ? '—'
                    : `${formatNumber(interval.interval.declaredInterval.value)} ${interval.interval.declaredInterval.unit} = ${formatNumber(interval.interval.declaredIntervalHours)} h`
                }
              />
              <Detail
                label="Observed points"
                value={
                  interval.interval === null
                    ? '—'
                    : `${interval.interval.observationCount} (boundary rows ${interval.interval.startSourceRow} and ${interval.interval.endSourceRow})`
                }
              />
              <Detail
                label="Contributing source rows"
                value={interval.aucTau.contributingSourceRows.join(', ')}
              />
              <Detail
                label="λ_z from this interval"
                value={
                  interval.lambdaZ !== null && interval.lambdaZ.status === 'available'
                    ? `${formatNumber(interval.lambdaZ.value)} ${interval.lambdaZ.unit}`
                    : 'unavailable (volume parameters only)'
                }
              />
            </dl>
            {interval.aucTau.notes.length > 0 ? (
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                {interval.aucTau.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground" role="note" data-testid="interval-auc-unavailable">
            <span className="font-mono text-[0.7rem]">{interval.aucTau.code}</span>: {interval.aucTau.message}
          </p>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3 text-xs">
        <div className="flex items-start gap-2">
          <input
            id="repeated-interval-aligned"
            type="checkbox"
            className="mt-0.5 size-4 rounded border-input focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            checked={aligned}
            data-testid="interval-aligned"
            aria-describedby="repeated-interval-aligned-help"
            onChange={(event) => onAlignedChange(event.target.checked)}
          />
          <label htmlFor="repeated-interval-aligned" className="font-medium text-foreground">
            This interval starts at the recorded administration time of the dose it describes
          </label>
        </div>
        <p id="repeated-interval-aligned-help" className="pl-6 text-muted-foreground">
          Required before any steady-state parameter is derived. τ alone does not identify which dose a window
          belongs to. This confirmation is an input to the analysis shown here; it is never written to the
          dataset or treated as source metadata.
        </p>
      </div>

      <IntervalExposureSummary report={exposure} />

      <div className="space-y-1 border-t pt-4">
        <h5 className="text-sm font-medium">Steady-state dose-dependent parameters</h5>
        <p className="text-xs text-muted-foreground" data-testid="steady-state-summary">
          {steady.summary}
        </p>
      </div>

      <DoseParameterTable
        parameters={parameters}
        testIdPrefix="steady-state"
        caption="Steady-state clearance and terminal volume from the per-administration dose and the selected interval's AUCτ. Each parameter has its own status and reason."
      />

      {isSteadyState ? null : (
        <p
          className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-700"
          role="status"
          data-testid="steady-state-declaration-missing"
        >
          This dataset is not declared to be at steady state, so no CL, CL/F, Vz or Vz/F is derived. The
          selected interval AUCτ above is still reported. Dose/interval AUCτ is not a clearance unless the
          interval is one dosing interval at steady state, and that is a recorded declaration — never a
          conclusion drawn from the curve.
        </p>
      )}

      {unavailable.length > 0 ? (
        <div
          className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground"
          role="note"
          data-testid="steady-state-unavailable"
        >
          <h5 className="font-medium text-foreground">Why a steady-state parameter is unavailable</h5>
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
          data-testid="steady-state-conditional"
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

      <div className="space-y-1 rounded-md border p-3 text-xs" data-testid="steady-state-inputs">
        <h5 className="font-medium">Inputs and substitutions</h5>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <Detail label="Dose_τ" value={doseText(steady)} />
          <Detail label="Dose basis" value={steady.doseBasis} />
          <Detail label="AUCτ used" value={aucText(steady)} />
          <Detail label="λ_z used" value={lambdaText(steady)} />
          <Detail label="Bioavailability F" value={fText(steady)} />
          <Detail
            label="Interval used"
            value={
              steady.parameters.cl.inputs.interval === undefined
                ? 'not selected'
                : `${formatNumber(steady.parameters.cl.inputs.interval.startTime)} → ${formatNumber(steady.parameters.cl.inputs.interval.endTime)} ${steady.parameters.cl.inputs.interval.timeUnit}`
            }
          />
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

      <div className="rounded-md border p-3 text-xs" data-testid="steady-state-preconditions">
        <h5 className="mb-1 font-medium">Preconditions checked</h5>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          {steady.preconditions.map((precondition) => (
            <li key={precondition.id}>
              <span className="font-mono text-[0.7rem]">{precondition.id}</span>{' '}
              <span className="font-medium text-foreground">{precondition.status}</span>: {precondition.message}
            </li>
          ))}
        </ul>
      </div>

      {steady.warnings.length > 0 ? (
        <div
          className="space-y-1 rounded-md border border-amber-500/40 p-3 text-xs text-amber-700"
          role="status"
          data-testid="steady-state-warnings"
        >
          <h5 className="font-medium">Notes</h5>
          <ul className="list-disc space-y-1 pl-4">
            {steady.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid="repeated-dose-scope">
        Scope: repeated dosing only. A plain repeated-dose dataset reports interval AUCτ but no dose-dependent
        parameters; only a declared steady-state dataset with a per-administration dose and a confirmed
        interval yields CL, CL/F, Vz or Vz/F. τ is never treated as an analysis interval by itself, and steady
        state is never inferred from the curve. AUCτ is reported in {concentrationUnit}·{timeUnit}. These are
        exploratory pharmacokinetic summaries, not clinical dose recommendations.
      </p>
    </section>
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

function TimeSelect({
  id,
  label,
  value,
  choices,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly value: number | null
  readonly choices: readonly number[]
  readonly onChange: (time: number | null) => void
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={value === null ? '' : String(value)}
        data-testid={id}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
      >
        <option value="">Select an observed time…</option>
        {choices.map((time) => (
          <option key={time} value={String(time)}>
            {formatNumber(time)}
          </option>
        ))}
      </select>
    </div>
  )
}

function doseText(report: SteadyStateDoseNcaReport): string {
  const dose = report.parameters.cl.inputs.dose ?? report.parameters.clF.inputs.dose
  return dose === undefined ? 'not recorded' : `${formatNumber(dose.value)} ${dose.unit}`
}

function aucText(report: SteadyStateDoseNcaReport): string {
  const auc = report.parameters.cl.inputs.auc ?? report.parameters.clF.inputs.auc
  return auc === undefined ? 'unavailable' : `${auc.name} = ${formatNumber(auc.value)} ${auc.unit}`
}

function lambdaText(report: SteadyStateDoseNcaReport): string {
  const lambdaZ = report.parameters.cl.inputs.lambdaZ
  return lambdaZ === undefined
    ? 'unavailable (volume parameters only)'
    : `${formatNumber(lambdaZ.value)} ${lambdaZ.unit}`
}

function fText(report: SteadyStateDoseNcaReport): string {
  const f = report.parameters.cl.inputs.bioavailability
  if (f !== undefined) return formatNumber(f)
  return report.route === 'iv-bolus' || report.route === 'iv-infusion'
    ? '1 by the IV route definition'
    : 'not recorded'
}
