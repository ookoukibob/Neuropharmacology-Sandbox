/**
 * Experimental datasets page: measured data, fitting and diagnostics.
 *
 * Owns layout and user intent only: the repository-backed hook performs every
 * read/write, CSV/`.npex` import cards produce validated previews, and this
 * page commits a dataset only after an explicit confirmation. The chart is
 * presentation-only; the ordered measurement table is the accessible source
 * of every stored value.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  fitCurvePoints,
  fitMonoExponentialDecay,
  type MonoExponentialFitResult,
} from '@/domain/experiments/mono-exponential-fit'
import { diagnoseMonoExponentialFit } from '@/domain/experiments/mono-exponential-fit-diagnostics'
import {
  analyzeMonoExponentialProfile,
  type MonoExponentialProfileResult,
  type ProfileLocalization,
} from '@/domain/experiments/mono-exponential-profile'
import {
  analyzeBaselineResiduals,
  analyzeMonoExponentialResiduals,
  type ResidualStructureModelResult,
  type SpreadStatus,
} from '@/domain/experiments/residual-structure'
import {
  ERROR_MODEL_CAVEAT,
  ERROR_MODEL_STATEMENT,
  GAUSSIAN_ADDITIVE_ERROR_MODEL,
  buildComparisonAicc,
  compareMonoExponentialModels,
  type CandidateModel,
  type ConditionalAicc,
  type MonoExponentialModelComparisonResult,
} from '@/domain/experiments/mono-exponential-model-comparison'
import { formatNumber } from '@/engine/numeric/decimal'
import {
  AlertTriangle,
  Database,
  Download,
  Pencil,
  RefreshCw,
  Trash2,
  TrendingDown,
  X,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ScientificText } from '@/components/scientific/ScientificText'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
import type { ExperimentalDataset } from '@/domain/experiments/experimental-dataset'
import type { ExperimentalDatasetRepository } from '@/data/repositories/experimentalDatasetRepository'
import { buildNpexFile, NPEX_EXTENSION, NPEX_MIME_TYPE } from '@/data/npex/npex'
import { downloadTextFile, safeFileName } from '@/features/import-export/fileIo'
import { CsvDatasetImport } from './CsvDatasetImport'
import { NpexDatasetImport } from './NpexDatasetImport'
import {
  useExperimentalDatasetLibrary,
  type DatasetLibraryApi,
} from './useExperimentalDatasetLibrary'

const ExperimentalDatasetChart = lazy(async () => {
  const module = await import('@/components/charts/ExperimentalDatasetChart')
  return { default: module.ExperimentalDatasetChart }
})

const ExperimentalFitResidualChart = lazy(async () => {
  const module = await import('@/components/charts/ExperimentalFitResidualChart')
  return { default: module.ExperimentalFitResidualChart }
})

const ExperimentalFitProfileChart = lazy(async () => {
  const module = await import('@/components/charts/ExperimentalFitProfileChart')
  return { default: module.ExperimentalFitProfileChart }
})

const ExperimentalFitResidualVsFittedChart = lazy(async () => {
  const module = await import('@/components/charts/ExperimentalFitResidualVsFittedChart')
  return { default: module.ExperimentalFitResidualVsFittedChart }
})

export interface ExperimentalDatasetsViewProps {
  readonly repository: ExperimentalDatasetRepository
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ExperimentalDatasetsView({ repository }: ExperimentalDatasetsViewProps) {
  const library = useExperimentalDatasetLibrary(repository)

  return (
    <div className="space-y-6" aria-busy={library.busy}>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Database aria-hidden="true" className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Experimental Datasets</h1>
        </div>
        <p className="max-w-4xl text-sm text-muted-foreground">
          Import, validate, store and export measured concentration–time datasets. Values are kept in
          source order exactly as measured — duplicates and replicates are never averaged,
          deduplicated or interpolated. A one-compartment mono-exponential decay fit can be run on
          the selected dataset; the fit is a temporary derived result that never modifies or saves
          the measurements. Residuals and RMSE are descriptive diagnostics. A practical
          identifiability screen profiles the same least-squares objective over a documented set of
          candidate rates: it is a heuristic screening aid, not a proof of structural
          identifiability and not a confidence region. A two-candidate comparison (decay versus
          decay with an additive baseline) reports descriptive metrics, and a conditional AICc
          that becomes available only after you explicitly declare the supported error assumption.
          No other model-selection metric and no formal uncertainty estimate is provided.
        </p>
      </header>

      {library.feedback !== null && (
        <Alert
          variant={library.feedback.kind === 'error' ? 'destructive' : 'default'}
          role={library.feedback.kind === 'error' ? 'alert' : 'status'}
          data-testid="dataset-feedback"
        >
          <AlertTitle>
            {library.feedback.kind === 'error' ? 'Action not completed' : 'Done'}
          </AlertTitle>
          <AlertDescription>{library.feedback.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <CsvDatasetImport busy={library.busy} onImport={library.importDataset} />
        <NpexDatasetImport busy={library.busy} onImport={library.importDataset} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
        <DatasetList library={library} />
        <section aria-label="Selected dataset" className="min-w-0">
          {library.selected === null ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Select a saved dataset to inspect its metadata, chart and ordered measurements.
              </CardContent>
            </Card>
          ) : (
            <DatasetDetail
              key={library.selected.id}
              dataset={library.selected}
              busy={library.busy}
              onRename={library.rename}
              onDelete={library.remove}
            />
          )}
        </section>
      </div>
    </div>
  )
}

function DatasetList({ library }: { readonly library: DatasetLibraryApi }) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle headingLevel={2}>Saved datasets</CardTitle>
          <p className="text-xs text-muted-foreground">
            {library.summaries.length} dataset{library.summaries.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void library.refresh()}
          disabled={library.busy}
          data-testid="datasets-refresh"
        >
          <RefreshCw aria-hidden="true" /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {library.status === 'loading' && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading saved datasets…
          </p>
        )}
        {library.status === 'error' && (
          <Alert variant="destructive">
            <AlertTitle>Saved datasets unavailable</AlertTitle>
            <AlertDescription>See the action message above for details.</AlertDescription>
          </Alert>
        )}
        {library.status === 'ready' && library.summaries.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="datasets-empty">
            No experimental datasets are saved yet. Import a CSV or `.npex` file above.
          </p>
        )}
        {library.summaries.length > 0 && (
          <ul className="space-y-2" aria-label="Saved experimental datasets">
            {library.summaries.map((summary) => {
              const selected = library.selected?.id === summary.id
              return (
                <li key={summary.id}>
                  <button
                    type="button"
                    className={`w-full rounded-lg border p-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
                      selected ? 'border-primary bg-muted/60' : 'hover:bg-muted/40'
                    }`}
                    aria-current={selected ? 'true' : undefined}
                    disabled={library.busy}
                    onClick={() => void library.select(summary.id)}
                  >
                    <span className="block truncate font-medium">{summary.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {summary.measurementCount} measurement
                      {summary.measurementCount === 1 ? '' : 's'} · {summary.timeUnit} ·{' '}
                      {summary.concentrationUnit}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      Updated {summary.updatedAt}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {library.corrupt.length > 0 && (
          <Alert variant="destructive" data-testid="datasets-corrupt">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Unreadable stored datasets</AlertTitle>
            <AlertDescription>
              <p>
                These rows failed storage validation and are reported rather than loaded, edited or
                deleted:
              </p>
              <ul className="list-disc pl-4">
                {library.corrupt.map((entry) => (
                  <li key={entry.id}>
                    <code>{entry.id}</code>: {entry.message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

interface DatasetDetailProps {
  readonly dataset: ExperimentalDataset
  readonly busy: boolean
  readonly onRename: (
    id: string,
    name: string,
    expectedUpdatedAt: string,
  ) => Promise<boolean>
  readonly onDelete: (id: string, expectedUpdatedAt: string) => Promise<boolean>
}

function DatasetDetail({ dataset, busy, onRename, onDelete }: DatasetDetailProps) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(dataset.name)
  const [deleting, setDeleting] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  // A fit is DERIVED and ephemeral: never persisted, and cleared whenever the
  // selected dataset or its updatedAt changes so a stale result can never be
  // shown against different data.
  // A fit is stored TOGETHER with the dataset version it was computed from, so
  // staleness is derived during render: if the dataset (or its updatedAt)
  // changes, the stored fit simply no longer matches and is not shown. This
  // avoids resetting state from an effect.
  const fitKey = `${dataset.id}:${dataset.updatedAt}`
  const [storedFit, setStoredFit] = useState<{
    readonly key: string
    readonly result: MonoExponentialFitResult
  } | null>(null)
  const fit = storedFit !== null && storedFit.key === fitKey ? storedFit.result : null
  const fitDiagnostics = useMemo(
    () => (fit === null || !fit.ok ? null : diagnoseMonoExponentialFit(dataset.measurements, fit)),
    [dataset.measurements, fit],
  )
  // Derived from the same fit and never persisted; recomputed only when the
  // dataset rows or the fit change, exactly like the residual diagnostics.
  const fitProfile = useMemo(
    () => (fit === null || !fit.ok ? null : analyzeMonoExponentialProfile(dataset.measurements, fit)),
    [dataset.measurements, fit],
  )
  // The comparison re-fits M1 against the same rows; it is recomputed on the
  // same triggers and is never persisted. Declaring the error model does not
  // re-run it (see ModelComparisonCard).
  const modelComparison = useMemo(
    () => (fit === null || !fit.ok ? null : compareMonoExponentialModels(dataset.measurements, fit)),
    [dataset.measurements, fit],
  )
  // Residual structure reuses the two existing fits: M0's diagnostics and the
  // M1 fit the comparison already produced. Neither model is fitted again.
  const m0ResidualStructure = useMemo(
    () => (fit === null || !fit.ok ? null : analyzeMonoExponentialResiduals(dataset.measurements, fit)),
    [dataset.measurements, fit],
  )
  const m1ResidualStructure = useMemo(
    () =>
      modelComparison === null || !modelComparison.ok
        ? null
        : analyzeBaselineResiduals(dataset.measurements, modelComparison.baselineFit),
    [dataset.measurements, modelComparison],
  )
  // A visible spread pattern is a caveat on how the criterion should be read,
  // never a change to the criterion itself or to the declared assumption.
  const spreadConcern = useMemo(() => {
    const labels: string[] = []
    for (const structure of [m0ResidualStructure, m1ResidualStructure]) {
      if (structure !== null && structure.ok && structure.spread.ok && structure.spread.status === 'visible-pattern') {
        labels.push(structure.label)
      }
    }
    return labels
  }, [m0ResidualStructure, m1ResidualStructure])
  const runFit = (): void => {
    setStoredFit({ key: fitKey, result: fitMonoExponentialDecay(dataset.measurements) })
  }
  const [exportError, setExportError] = useState<string | null>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (deleting) cancelDeleteRef.current?.focus()
  }, [deleting])

  async function submitRename(): Promise<void> {
    const saved = await onRename(dataset.id, name, dataset.updatedAt)
    if (saved) setRenaming(false)
  }

  async function confirmDelete(): Promise<void> {
    const removed = await onDelete(dataset.id, dataset.updatedAt)
    if (!removed) {
      setAcknowledged(false)
      setDeleting(false)
    }
  }

  function cancelDelete(): void {
    setAcknowledged(false)
    setDeleting(false)
    deleteTriggerRef.current?.focus()
  }

  function exportNpex(): void {
    setExportStatus(null)
    setExportError(null)
    try {
      const built = buildNpexFile(dataset)
      if (!built.ok) {
        setExportError(built.issues.map((entry) => entry.message).join(' '))
        return
      }
      const base = safeFileName(dataset.name)
      const fileName =
        base === 'library' ? `experimental-dataset-${dataset.id}` : base
      downloadTextFile(`${fileName}${NPEX_EXTENSION}`, built.text, NPEX_MIME_TYPE)
      setExportStatus(
        `Exported ${dataset.measurements.length} measurements to ${fileName}${NPEX_EXTENSION}.`,
      )
    } catch (error) {
      setExportError(`The .npex file could not be generated: ${messageOf(error)}`)
    }
  }

  const minTime = dataset.measurements.reduce(
    (min, measurement) => (measurement.time < min ? measurement.time : min),
    Number.POSITIVE_INFINITY,
  )
  const maxTime = dataset.measurements.reduce(
    (max, measurement) => (measurement.time > max ? measurement.time : max),
    Number.NEGATIVE_INFINITY,
  )
  const fitOverlay = useMemo(() => {
    if (fit === null || !fit.ok) return undefined
    const points = fitCurvePoints(fit, minTime, maxTime)
    if (points.length === 0) return undefined
    return { points, label: 'Fitted mono-exponential curve' }
  }, [fit, minTime, maxTime])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle headingLevel={2} className="break-words text-xl">
                {dataset.name}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {dataset.measurements.length} measurement
                {dataset.measurements.length === 1 ? '' : 's'} · stored in source order
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setName(dataset.name)
                  setRenaming((current) => !current)
                }}
                disabled={busy}
                data-testid="dataset-rename"
              >
                {renaming ? <X aria-hidden="true" /> : <Pencil aria-hidden="true" />}
                {renaming ? 'Cancel rename' : 'Rename'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={exportNpex}
                data-testid="dataset-export"
              >
                <Download aria-hidden="true" /> Export .npex
              </Button>
            </div>
          </div>

          {renaming && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submitRename()
              }}
            >
              <div className="grid min-w-48 flex-1 gap-1.5">
                <Label htmlFor="dataset-rename-name">Dataset name</Label>
                <Input
                  id="dataset-rename-name"
                  value={name}
                  maxLength={120}
                  autoFocus
                  disabled={busy}
                  data-testid="dataset-rename-name"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <Button type="submit" size="sm" disabled={busy} data-testid="dataset-rename-save">
                Save name
              </Button>
            </form>
          )}

          {exportStatus !== null && (
            <p role="status" className="text-xs text-muted-foreground" data-testid="dataset-export-status">
              {exportStatus}
            </p>
          )}
          {exportError !== null && (
            <p role="alert" className="text-xs text-destructive" data-testid="dataset-export-error">
              {exportError}
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Time unit</dt>
              <dd>{dataset.timeUnit}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Concentration unit</dt>
              <dd>{dataset.concentrationUnit}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Created</dt>
              <dd>
                <time dateTime={dataset.createdAt}>{dataset.createdAt}</time>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last updated</dt>
              <dd>
                <time dateTime={dataset.updatedAt}>{dataset.updatedAt}</time>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Original import</dt>
              <dd>
                {dataset.provenance.source}
                {dataset.provenance.fileName === undefined
                  ? ''
                  : ` · ${dataset.provenance.fileName}`}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Imported at</dt>
              <dd>
                <time dateTime={dataset.provenance.importedAt}>
                  {dataset.provenance.importedAt}
                </time>
              </dd>
            </div>
            {dataset.notes !== undefined && (
              <div className="md:col-span-2">
                <dt className="text-xs text-muted-foreground">Notes</dt>
                <dd className="whitespace-pre-wrap">{dataset.notes}</dd>
              </div>
            )}
          </dl>

          {deleting ? (
            <div
              className="space-y-3 rounded-lg border border-destructive/40 p-3"
              role="alertdialog"
              aria-labelledby="dataset-delete-title"
              aria-describedby="dataset-delete-description"
            >
              <h3 id="dataset-delete-title" className="font-medium">
                Delete “{dataset.name}” permanently?
              </h3>
              <p id="dataset-delete-description" className="text-sm text-muted-foreground">
                This removes the dataset and all {dataset.measurements.length} stored measurements
                from this browser. Export it first if you need a copy. This cannot be undone.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={acknowledged}
                  disabled={busy}
                  data-testid="dataset-delete-ack"
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>I understand this dataset will be permanently deleted.</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={!acknowledged || busy}
                  onClick={() => void confirmDelete()}
                  data-testid="dataset-delete-confirm"
                >
                  <Trash2 aria-hidden="true" /> Delete permanently
                </Button>
                <Button
                  ref={cancelDeleteRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={cancelDelete}
                  data-testid="dataset-delete-cancel"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              ref={deleteTriggerRef}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDeleting(true)}
              disabled={busy}
              data-testid="dataset-delete"
            >
              <Trash2 aria-hidden="true" /> Delete dataset
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle headingLevel={3}>Observed measurements</CardTitle>
          <p className="text-xs text-muted-foreground">
            Measured observations are drawn as markers; no interpolation, averaging or unit
            conversion is applied. A mono-exponential fit, when you run one, appears as a separate
            model curve and never replaces the measured points. The table below remains the
            accessible source of the measured values.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <section aria-labelledby="fit-heading" className="space-y-3" data-testid="fit-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 id="fit-heading" className="text-sm font-medium">
                  One-compartment mono-exponential decay fit
                </h3>
                <p className="text-xs text-muted-foreground">
                  <ScientificText
                    value={
                      'C(t) = C_ref · exp(−k · (t − t_ref)), fitted by unweighted least squares ' +
                      'on the original concentration scale. This is a derived result — it is not ' +
                      'saved and does not change the measurements.'
                    }
                  />
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={runFit}
                disabled={busy}
                data-testid="dataset-fit"
              >
                <TrendingDown aria-hidden="true" /> Fit mono-exponential decay
              </Button>
            </div>

            {fit === null ? null : fit.ok ? (
              <div className="rounded-md border p-3 text-sm" data-testid="fit-results">
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
                  <dt className="text-muted-foreground">
                    <ScientificText value="Reference time t_ref" />
                  </dt>
                  <dd className="font-mono text-xs" data-testid="fit-tref">
                    {formatNumber(fit.tRef)} {dataset.timeUnit}
                  </dd>
                  <dt className="text-muted-foreground">
                    <ScientificText value="C_ref at t_ref" />
                  </dt>
                  <dd className="font-mono text-xs" data-testid="fit-cref">
                    {formatNumber(fit.cRef)} {dataset.concentrationUnit}
                  </dd>
                  <dt className="text-muted-foreground">Decay rate k</dt>
                  <dd className="font-mono text-xs" data-testid="fit-k">
                    {formatNumber(fit.k)} {dataset.timeUnit}⁻¹
                  </dd>
                  <dt className="text-muted-foreground">Half-life t½ = ln(2)/k</dt>
                  <dd className="font-mono text-xs" data-testid="fit-half-life">
                    {fit.halfLife === undefined
                      ? `no finite half-life (k = 0)`
                      : `${formatNumber(fit.halfLife)} ${dataset.timeUnit}`}
                  </dd>
                  <dt className="text-muted-foreground">Observations used</dt>
                  <dd className="font-mono text-xs">{fit.measurementCount}</dd>
                </dl>
                {fit.warnings.length === 0 ? null : (
                  // The announcement role belongs to the wrapper: putting it on
                  // the list itself removes the list semantics and leaves every
                  // <li> without a list parent.
                  <div role="status" data-testid="fit-warnings">
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-700">
                      {fit.warnings.map((warning) => (
                        <li key={warning.code}>{warning.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  A converged fit is a numerical result, not evidence that this decay model suits
                  the data. RMSE and raw residuals are shown below without a pass/fail threshold;
                  parameter uncertainty is not inferred, and no model is chosen for you.
                </p>
              </div>
            ) : (
              <p role="alert" className="text-sm text-destructive" data-testid="fit-error">
                {fit.message}
              </p>
            )}
          </section>

          <figure className="min-w-0">
            <Suspense
              fallback={
                <p role="status" className="py-8 text-sm text-muted-foreground">
                  Loading observed-point chart…
                </p>
              }
            >
              <ExperimentalDatasetChart
                dataset={dataset}
                graphId={`experimental-dataset-${dataset.id}`}
                {...(fitOverlay === undefined ? {} : { fitOverlay })}
              />
            </Suspense>
            <figcaption className="mt-2 text-xs text-muted-foreground">
              {fitOverlay === undefined
                ? 'Observed measurements (markers). Run the fit above to overlay the fitted model curve as a separate line.'
                : 'Observed points (markers) with the fitted mono-exponential curve (line). The curve is a model visualization, not additional measurements.'}{' '}
              Time axis in {dataset.timeUnit}; concentration axis in {dataset.concentrationUnit}.
              Hover shows the source row, sample id and note when present.
            </figcaption>
          </figure>

          {fitDiagnostics !== null && (
            <Card data-testid="fit-diagnostics">
              <CardHeader>
                <CardTitle headingLevel={3}>Residual diagnostics</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Residual = observed concentration − fitted concentration, in the dataset’s original
                  concentration unit. These are raw residuals from the same unweighted least-squares
                  fit, not standardized residuals; no universal pass/fail cutoff is applied. The
                  residual plots and the spread screen are shown in the residual structure section
                  below.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {fitDiagnostics.ok ? (
                  <>
                    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3" data-testid="fit-diagnostic-summary">
                      <div>
                        <dt className="text-xs text-muted-foreground">RMSE</dt>
                        <dd className="font-mono text-sm" data-testid="fit-rmse">
                          {formatNumber(fitDiagnostics.rmse)} {dataset.concentrationUnit}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Residual degrees of freedom (n − 2)</dt>
                        <dd className="font-mono text-sm" data-testid="fit-residual-df">
                          {fitDiagnostics.residualDegreesOfFreedom}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Distinct time points</dt>
                        <dd className="font-mono text-sm" data-testid="fit-distinct-times">
                          {fitDiagnostics.distinctTimeCount}
                        </dd>
                      </div>
                    </dl>
                    <div className="space-y-2 rounded-md border p-3 text-sm" role="note" data-testid="fit-identifiability-screen">
                      <h4 className="font-medium">Preliminary data-support screen</h4>
                      <p className="text-xs text-muted-foreground">
                        This screen flags boundary estimates and very sparse time coverage. It is not
                        a formal structural or practical identifiability test and does not estimate
                        parameter uncertainty.
                      </p>
                      <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                        {fitDiagnostics.dataSupportNotes.map((note) => <li key={note}>{note}</li>)}
                      </ul>
                    </div>
                  </>
                ) : (
                  <p role="alert" className="text-sm text-destructive" data-testid="fit-diagnostics-error">
                    {fitDiagnostics.message}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {fitProfile !== null && (
            <FitProfileDiagnostics
              profile={fitProfile}
              timeUnit={dataset.timeUnit}
              concentrationUnit={dataset.concentrationUnit}
              datasetName={dataset.name}
            />
          )}

          {modelComparison !== null && (
            <ModelComparisonCard
              comparison={modelComparison}
              spreadConcern={spreadConcern}
              timeUnit={dataset.timeUnit}
              concentrationUnit={dataset.concentrationUnit}
            />
          )}

          {m0ResidualStructure !== null && (
            <ResidualStructureCard
              m0={m0ResidualStructure}
              m1={m1ResidualStructure}
              timeUnit={dataset.timeUnit}
              concentrationUnit={dataset.concentrationUnit}
              datasetName={dataset.name}
            />
          )}

          <div className="max-h-[36rem] overflow-auto rounded-md border">
            <Table data-testid="dataset-measurements">
              <TableCaption>
                {dataset.name}: all {dataset.measurements.length} measurements in source order.
                Duplicate timestamps are stored and shown as separate rows.
              </TableCaption>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead scope="col">Source row</TableHead>
                  <TableHead scope="col">Time ({dataset.timeUnit})</TableHead>
                  <TableHead scope="col">Concentration ({dataset.concentrationUnit})</TableHead>
                  <TableHead scope="col">Sample id</TableHead>
                  <TableHead scope="col">Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dataset.measurements.map((measurement) => (
                  <TableRow key={measurement.id} data-testid="dataset-measurement-row">
                    <TableCell>{measurement.sourceRow}</TableCell>
                    <TableCell>{measurement.time}</TableCell>
                    <TableCell>{measurement.concentration}</TableCell>
                    <TableCell>{measurement.sampleId ?? '—'}</TableCell>
                    <TableCell className="max-w-72 whitespace-normal">{measurement.note ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

const PROFILE_LOCALIZATION_TEXT: Record<ProfileLocalization, string> = {
  localized:
    'The objective has a narrow minimum: moving the rate away from the estimate makes the residual clearly worse.',
  broad:
    'The objective has a broad minimum: a wide range of decay rates fits almost as well as the estimate.',
  'boundary-zero-rate':
    'The best fit sits at the zero-rate boundary, so there is no interior minimum to locate.',
  'boundary-upper-rate':
    'The best fit reached the optimizer’s numerical upper bound, so the rate is not resolved inside the evaluated range.',
  indeterminate:
    'This dataset does not support a shape classification for the objective.',
}

interface FitProfileDiagnosticsProps {
  readonly profile: MonoExponentialProfileResult
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly datasetName: string
}

/**
 * Practical identifiability screen for the mono-exponential fit.
 *
 * Rendered only for a dataset that already has a successful fit, so no
 * diagnostic is ever shown against a failed or missing estimate. Every number
 * comes from the domain layer; this component only chooses words and layout.
 */
function FitProfileDiagnostics({
  profile,
  timeUnit,
  concentrationUnit,
  datasetName,
}: FitProfileDiagnosticsProps) {
  return (
    <Card data-testid="fit-profile-diagnostics">
      <CardHeader>
        <CardTitle headingLevel={3}>Practical identifiability screen</CardTitle>
        <p className="text-xs text-muted-foreground">
          The same least-squares objective is re-evaluated at a documented set of candidate decay
          rates, with the amplitude re-solved at each one exactly as the fit does. The plotted curve
          is a residual sum of squares — not a likelihood and not a profile likelihood — and it is
          not a confidence region.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {profile.ok ? (
          <>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3" data-testid="fit-profile-summary">
              <div className="sm:col-span-3">
                <dt className="text-xs text-muted-foreground">Objective shape</dt>
                <dd className="text-sm" data-testid="fit-profile-localization">
                  {PROFILE_LOCALIZATION_TEXT[profile.localization]}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Candidate rates evaluated</dt>
                <dd className="font-mono text-sm" data-testid="fit-profile-points">
                  {profile.validPointCount}
                  {profile.invalidPointCount === 0
                    ? ''
                    : ` of ${profile.points.length} (${profile.invalidPointCount} unavailable)`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Near-minimum band</dt>
                <dd className="font-mono text-xs" data-testid="fit-profile-band">
                  {profile.nearMinimumRateRange === null
                    ? profile.nearMinimumBandResolution === 'narrower-than-grid'
                      ? 'narrower than the evaluated grid'
                      : 'not defined for this dataset'
                    : `${formatNumber(profile.nearMinimumRateRange.min)} – ${formatNumber(
                        profile.nearMinimumRateRange.max,
                      )} ${timeUnit}⁻¹`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Estimate position</dt>
                <dd className="text-xs" data-testid="fit-profile-boundary">
                  {profile.boundary.atLowerBound
                    ? 'at the k = 0 boundary'
                    : profile.boundary.atUpperBound
                      ? 'at the numerical upper bound'
                      : profile.boundary.nearLowerBound
                        ? 'close to the k = 0 boundary'
                        : profile.boundary.nearUpperBound
                          ? 'in the unresolvable band below the upper bound'
                          : 'interior to the evaluated range'}
                </dd>
              </div>
            </dl>

            <Suspense
              fallback={
                <p role="status" className="py-6 text-sm text-muted-foreground">
                  Loading objective profile…
                </p>
              }
            >
              <ExperimentalFitProfileChart
                points={profile.points}
                fittedRate={profile.fittedRate}
                fittedSse={profile.fittedSse}
                timeUnit={timeUnit}
                concentrationUnit={concentrationUnit}
                datasetName={datasetName}
              />
            </Suspense>
            <p className="text-xs text-muted-foreground">
              Diamond: the fitted estimate. Line: the residual sum of squares at each evaluated
              rate. Lower is better for this objective only; the vertical axis is in squared{' '}
              {concentrationUnit} and has no threshold.
            </p>

            {profile.warnings.length === 0 ? null : (
              <div
                className="space-y-1 rounded-md border border-amber-500/40 p-3 text-xs text-amber-700"
                role="status"
                data-testid="fit-profile-warnings"
              >
                <h4 className="font-medium">What limits this screen here</h4>
                <ul className="list-disc space-y-1 pl-4">
                  {profile.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div
              className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground"
              role="note"
              data-testid="fit-profile-limitations"
            >
              <h4 className="font-medium text-foreground">Standing limitations</h4>
              <ul className="list-disc space-y-1 pl-4">
                {profile.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <p role="alert" className="text-sm text-destructive" data-testid="fit-profile-error">
            {profile.message} The fit itself is unaffected.
          </p>
        )}
      </CardContent>
    </Card>
  )
}


interface ModelComparisonCardProps {
  readonly comparison: MonoExponentialModelComparisonResult
  /** Models whose residual spread screen found a visible pattern. */
  readonly spreadConcern: readonly string[]
  readonly timeUnit: string
  readonly concentrationUnit: string
}

/**
 * Two-candidate model comparison with a CONDITIONAL AICc.
 *
 * The error-model declaration is component state that starts false, so no
 * information criterion can ever appear from an implicit assumption. Changing
 * it only recomputes the criterion — neither model is re-fitted.
 */
function ModelComparisonCard({
  comparison,
  spreadConcern,
  timeUnit,
  concentrationUnit,
}: ModelComparisonCardProps) {
  const [errorModelDeclared, setErrorModelDeclared] = useState(false)
  const aicc = useMemo(
    () =>
      comparison.ok
        ? buildComparisonAicc(
            comparison,
            errorModelDeclared ? GAUSSIAN_ADDITIVE_ERROR_MODEL : null,
          )
        : null,
    [comparison, errorModelDeclared],
  )

  const unitLabel = (unit: 'concentration' | 'inverse-time'): string =>
    unit === 'concentration' ? concentrationUnit : `${timeUnit}⁻¹`

  const parameterText = (model: CandidateModel, key: 'A' | 'B' | 'k'): string => {
    if (!model.ok) return '—'
    const parameter = model.parameters.find((entry) => entry.key === key)
    return parameter === undefined ? '—' : `${formatNumber(parameter.value)} ${unitLabel(parameter.unit)}`
  }

  const metricText = (
    model: CandidateModel,
    pick: (fitted: Extract<CandidateModel, { ok: true }>) => string,
  ): string => (model.ok ? pick(model) : '—')

  const aiccText = (result: ConditionalAicc | undefined): string =>
    result === undefined ? '—' : result.ok ? formatNumber(result.aicc) : 'unavailable'

  const fittedWarnings: string[] = []
  if (comparison.ok) {
    for (const model of comparison.models) {
      for (const warning of model.ok ? model.warnings : [model.message]) {
        fittedWarnings.push(`${model.modelId}: ${warning}`)
      }
    }
  }
  const hasBoundary =
    comparison.ok && comparison.models.some((model) => model.ok && model.hasBoundaryEstimate)

  return (
    <Card data-testid="fit-model-comparison">
      <CardHeader>
        <CardTitle headingLevel={3}>Model comparison (two candidates)</CardTitle>
        <p className="text-xs text-muted-foreground">
          The existing decay fit (M0) is compared with the same decay plus an additive baseline (M1).
          Both are fitted to the same rows, reference time, observed span and original concentration
          scale, with the same unweighted objective. A lower residual sum of squares for M1 is
          expected when a baseline is added — it is not evidence that M1 is the better description of
          the system, and the baseline is a shape, not a mechanism.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!comparison.ok ? (
          <p role="alert" className="text-sm text-destructive" data-testid="comparison-error">
            {comparison.message} The mono-exponential fit above is unaffected.
          </p>
        ) : (
          <>
            <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="comparison-assumption-block">
              <h4 className="font-medium">Error-model assumption required for AICc</h4>
              <p className="text-xs text-muted-foreground">{ERROR_MODEL_STATEMENT}</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={errorModelDeclared}
                  data-testid="comparison-assumption"
                  onChange={(event) => setErrorModelDeclared(event.target.checked)}
                />
                <span>I declare this error assumption for this comparison.</span>
              </label>
              <p className="text-xs text-muted-foreground" data-testid="comparison-caveat">
                {ERROR_MODEL_CAVEAT}
              </p>
              {errorModelDeclared ? null : (
                <p className="text-xs text-muted-foreground" data-testid="comparison-aicc-gate">
                  AICc stays unavailable until this assumption is declared. The descriptive
                  comparison below does not depend on it.
                </p>
              )}
            </div>

            <Table data-testid="comparison-table">
              <TableCaption>
                Descriptive comparison of M0 and M1 on {comparison.observationCount} observations
                ({comparison.distinctTimeCount} distinct times). Parameter counts include the residual
                variance where the information criterion is concerned.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Quantity</TableHead>
                  <TableHead scope="col">M0 · decay</TableHead>
                  <TableHead scope="col">M1 · decay + baseline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableHead scope="row">Model</TableHead>
                  <TableCell className="text-xs">{comparison.models[0].label}</TableCell>
                  <TableCell className="text-xs">
                    {comparison.models[1].label}
                    {comparison.models[1].ok ? '' : ' · fit unavailable'}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">Equation</TableHead>
                  <TableCell className="font-mono text-xs">
                    <ScientificText value={comparison.models[0].formula} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <ScientificText value={comparison.models[1].formula} />
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">A (amplitude)</TableHead>
                  <TableCell className="font-mono text-xs" data-testid="comparison-m0-amplitude">
                    {parameterText(comparison.models[0], 'A')}
                  </TableCell>
                  <TableCell className="font-mono text-xs" data-testid="comparison-m1-amplitude">
                    {parameterText(comparison.models[1], 'A')}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">B (baseline)</TableHead>
                  <TableCell className="text-xs text-muted-foreground">
                    not a parameter of M0
                  </TableCell>
                  <TableCell className="font-mono text-xs" data-testid="comparison-m1-baseline">
                    {parameterText(comparison.models[1], 'B')}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">k (decay rate)</TableHead>
                  <TableCell className="font-mono text-xs">{parameterText(comparison.models[0], 'k')}</TableCell>
                  <TableCell className="font-mono text-xs">{parameterText(comparison.models[1], 'k')}</TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">SSE (residual sum of squares)</TableHead>
                  <TableCell className="font-mono text-xs" data-testid="comparison-m0-sse">
                    {metricText(comparison.models[0], (model) =>
                      `${formatNumber(model.sse)} (${concentrationUnit})²`,
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs" data-testid="comparison-m1-sse">
                    {metricText(comparison.models[1], (model) =>
                      `${formatNumber(model.sse)} (${concentrationUnit})²`,
                    )}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">RMSE</TableHead>
                  <TableCell className="font-mono text-xs">
                    {metricText(comparison.models[0], (model) =>
                      `${formatNumber(model.rmse)} ${concentrationUnit}`,
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {metricText(comparison.models[1], (model) =>
                      `${formatNumber(model.rmse)} ${concentrationUnit}`,
                    )}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">Observations used</TableHead>
                  <TableCell className="font-mono text-xs">
                    {metricText(comparison.models[0], (model) => String(model.measurementCount))}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {metricText(comparison.models[1], (model) => String(model.measurementCount))}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">Mean-model parameters</TableHead>
                  <TableCell className="font-mono text-xs">{comparison.models[0].meanParameterCount}</TableCell>
                  <TableCell className="font-mono text-xs">{comparison.models[1].meanParameterCount}</TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">Total parameters K (incl. variance)</TableHead>
                  <TableCell className="font-mono text-xs">{comparison.models[0].totalParameterCount}</TableCell>
                  <TableCell className="font-mono text-xs">{comparison.models[1].totalParameterCount}</TableCell>
                </TableRow>
                <TableRow>
                  <TableHead scope="row">AICc</TableHead>
                  <TableCell className="font-mono text-xs" data-testid="comparison-m0-aicc">
                    {aiccText(aicc?.m0)}
                  </TableCell>
                  <TableCell className="font-mono text-xs" data-testid="comparison-m1-aicc">
                    {aiccText(aicc?.m1)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            {aicc !== null && aicc.difference !== null && (
              <p className="text-xs text-muted-foreground" data-testid="comparison-difference">
                AICc difference (M1 − M0):{' '}
                <span className="font-mono" data-testid="comparison-difference-value">
                  {formatNumber(aicc.difference)}
                </span>
                . This is arithmetic only: no threshold, model weight, probability or verdict is
                applied, and a lower value is relative support within these two candidates under the
                declared assumption.
              </p>
            )}

            {aicc !== null && (!aicc.m0.ok || !aicc.m1.ok) && (
              <div
                className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground"
                role="note"
                data-testid="comparison-aicc-reasons"
              >
                <h4 className="font-medium text-foreground">Why AICc is unavailable</h4>
                <ul className="list-disc space-y-1 pl-4">
                  {!aicc.m0.ok && <li>M0: {aicc.m0.message}</li>}
                  {!aicc.m1.ok && <li>M1: {aicc.m1.message}</li>}
                </ul>
              </div>
            )}

            {fittedWarnings.length > 0 && (
              <div
                className="space-y-1 rounded-md border border-amber-500/40 p-3 text-xs text-amber-700"
                role="status"
                data-testid="comparison-warnings"
              >
                <h4 className="font-medium">Fit warnings from the compared models</h4>
                <ul className="list-disc space-y-1 pl-4">
                  {fittedWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            {spreadConcern.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="comparison-spread-caveat">
                The residual spread screen found a visible difference between the fitted halves for{' '}
                {spreadConcern.join(' and ')}. That raises a concern about the common-variance part
                of the declared assumption, but it does not establish that the assumption is false:
                a mean model missing structure, or a few unusual observations, can produce a similar
                pattern. The values above are unchanged and no different assumption has been
                substituted.
              </p>
            )}

            {hasBoundary && (
              <p className="text-xs text-muted-foreground" data-testid="comparison-boundary-note">
                At least one estimate sits on a constraint boundary or is unresolved. Constrained
                estimates weaken the regular-likelihood assumptions behind information criteria, so
                treat any criterion shown here as less reliable than the numbers suggest.
              </p>
            )}

            <div
              className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground"
              role="note"
              data-testid="comparison-notes"
            >
              <h4 className="font-medium text-foreground">Standing limitations of this comparison</h4>
              <ul className="list-disc space-y-1 pl-4">
                {comparison.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

interface ResidualStructureCardProps {
  readonly m0: ResidualStructureModelResult
  readonly m1: ResidualStructureModelResult | null
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly datasetName: string
}

const SPREAD_STATUS_TEXT: Record<SpreadStatus, string> = {
  'visible-pattern':
    'A visible difference in observed mean absolute residual between the two fitted halves.',
  'no-visible-pattern': 'No visible difference at the screening resolution used here.',
  inconclusive: 'Inconclusive: these residuals cannot show a spread difference.',
}

/**
 * Residual structure for both fitted candidates.
 *
 * Every number and classification comes from the domain layer; this component
 * only arranges it. Charts are lazy-loaded, and each model keeps its own pair
 * of views so the two candidates are never mixed.
 */
function ResidualStructureCard({
  m0,
  m1,
  timeUnit,
  concentrationUnit,
  datasetName,
}: ResidualStructureCardProps) {
  return (
    <Card data-testid="residual-structure">
      <CardHeader>
        <CardTitle headingLevel={3}>Residual structure</CardTitle>
        <p className="text-xs text-muted-foreground">
          The same residuals shown two ways for each fitted model: against the measured time and
          against the fitted concentration. Markers are individual stored observations — points are
          never connected, observations sharing a timestamp stay separate, and every point keeps its
          source row on hover. Nothing here is sorted, averaged or rewritten.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <ResidualStructureBlock
          structure={m0}
          idSuffix="m0"
          timeChartTestId="fit-residual-chart"
          timeUnit={timeUnit}
          concentrationUnit={concentrationUnit}
          datasetName={datasetName}
        />
        {m1 === null ? null : (
          <ResidualStructureBlock
            structure={m1}
            idSuffix="m1"
            timeChartTestId="fit-residual-chart-m1"
            timeUnit={timeUnit}
            concentrationUnit={concentrationUnit}
            datasetName={datasetName}
          />
        )}

        <div
          className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground"
          role="note"
          data-testid="residual-structure-notes"
        >
          <h4 className="font-medium text-foreground">What these views can and cannot tell you</h4>
          <ul className="list-disc space-y-1 pl-4">
            {(m0.ok ? m0.notes : []).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

interface ResidualStructureBlockProps {
  readonly structure: ResidualStructureModelResult
  readonly idSuffix: 'm0' | 'm1'
  readonly timeChartTestId: string
  readonly timeUnit: string
  readonly concentrationUnit: string
  readonly datasetName: string
}

function ResidualStructureBlock({
  structure,
  idSuffix,
  timeChartTestId,
  timeUnit,
  concentrationUnit,
  datasetName,
}: ResidualStructureBlockProps) {
  const headingId = `residual-structure-${idSuffix}-heading`

  if (!structure.ok) {
    return (
      <section aria-labelledby={headingId} data-testid={`residual-structure-${idSuffix}`}>
        <h4 id={headingId} className="text-sm font-medium">
          {structure.label}
        </h4>
        <p
          role="status"
          className="mt-1 text-xs text-muted-foreground"
          data-testid={`residual-structure-${idSuffix}-unavailable`}
        >
          Residual diagnostics are unavailable for this model: {structure.message}
        </p>
      </section>
    )
  }

  const spread = structure.spread
  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid={`residual-structure-${idSuffix}`}>
      <div>
        <h4 id={headingId} className="text-sm font-medium">
          {structure.label}
        </h4>
        <dl className="mt-1 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Observations</dt>
            <dd className="font-mono">{structure.measurementCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">RMSE</dt>
            <dd className="font-mono">
              {formatNumber(structure.rmse)} {concentrationUnit}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Distinct times</dt>
            <dd className="font-mono">{structure.timeOrder.distinctTimeCount}</dd>
          </div>
        </dl>
      </div>

      <div className="space-y-2 rounded-md border p-3 text-sm" data-testid={`residual-spread-${idSuffix}`}>
        <h5 className="font-medium">Residual spread screen</h5>
        <p className="text-xs" data-testid={`residual-spread-status-${idSuffix}`}>
          {spread.ok ? SPREAD_STATUS_TEXT[spread.status] : 'Unavailable for these data.'}
        </p>
        {spread.ok ? (
          <>
            {spread.status === 'inconclusive' ? null : (
              <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">
                    Mean absolute residual · lower fitted half ({spread.lowerHalf.count})
                  </dt>
                  <dd className="font-mono">
                    {formatNumber(spread.lowerHalf.meanAbsoluteResidual)} {concentrationUnit}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Mean absolute residual · upper fitted half ({spread.upperHalf.count})
                  </dt>
                  <dd className="font-mono">
                    {formatNumber(spread.upperHalf.meanAbsoluteResidual)} {concentrationUnit}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Larger ÷ smaller</dt>
                  <dd className="font-mono" data-testid={`residual-spread-ratio-${idSuffix}`}>
                    {spread.ratio === null ? 'not defined' : formatNumber(spread.ratio)}
                  </dd>
                </div>
              </dl>
            )}
            {spread.status === 'inconclusive' ? null : (
              <p className="text-xs text-muted-foreground" data-testid={`residual-spread-split-${idSuffix}`}>
                {spread.splitDisclosure}
              </p>
            )}
            <p className="text-xs text-muted-foreground" data-testid={`residual-spread-message-${idSuffix}`}>
              {spread.message}
            </p>
            <p className="text-xs text-muted-foreground">
              Screening only: a ratio of about {formatNumber(spread.heuristicRatio)} or more is
              reported as a visible difference. It is a documented convention with no p-value, and
              a smaller ratio is not evidence that the spread is constant. A difference between the
              halves can also come from the mean model missing structure, or from a few unusual
              observations, so this does not establish heteroscedasticity or identify its cause.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid={`residual-spread-message-${idSuffix}`}>
            {spread.message}
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="min-w-0">
          <Suspense
            fallback={
              <p role="status" className="py-6 text-sm text-muted-foreground">
                Loading residual plot…
              </p>
            }
          >
            <ExperimentalFitResidualChart
              residuals={structure.residuals}
              timeUnit={timeUnit}
              concentrationUnit={concentrationUnit}
              datasetName={datasetName}
              modelLabel={structure.label}
              testId={timeChartTestId}
            />
          </Suspense>
          <figcaption className="mt-1 text-xs text-muted-foreground">
            Residual against measured time, in {concentrationUnit} on the vertical axis. The
            horizontal zero line is a perfect prediction. Points are not connected because the
            observations are not a continuous time course.
          </figcaption>
        </figure>
        <figure className="min-w-0">
          <Suspense
            fallback={
              <p role="status" className="py-6 text-sm text-muted-foreground">
                Loading residual plot…
              </p>
            }
          >
            <ExperimentalFitResidualVsFittedChart
              residuals={structure.residuals}
              timeUnit={timeUnit}
              concentrationUnit={concentrationUnit}
              datasetName={datasetName}
              modelLabel={structure.label}
              testId={`residual-fitted-chart-${idSuffix}`}
            />
          </Suspense>
          <figcaption className="mt-1 text-xs text-muted-foreground">
            Residual against fitted concentration, both in {concentrationUnit}. A widening or
            narrowing cloud describes this sample; it is not a test of constant variance.
          </figcaption>
        </figure>
      </div>

      <div className="space-y-1 text-xs text-muted-foreground" data-testid={`residual-ordering-${idSuffix}`}>
        <h5 className="font-medium text-foreground">How the points are ordered</h5>
        <ul className="list-disc space-y-1 pl-4">
          {structure.timeOrder.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}
