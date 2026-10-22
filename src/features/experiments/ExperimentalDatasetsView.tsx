/**
 * Experimental datasets page (phase 47A).
 *
 * Owns layout and user intent only: the repository-backed hook performs every
 * read/write, CSV/`.npex` import cards produce validated previews, and this
 * page commits a dataset only after an explicit confirmation. The chart is
 * presentation-only; the ordered measurement table is the accessible source
 * of every stored value.
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Database,
  Download,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
          <Badge variant="secondary">Phase 47A · measured data only</Badge>
        </div>
        <p className="max-w-4xl text-sm text-muted-foreground">
          Import, validate, store and export measured concentration–time datasets. Values are kept in
          source order exactly as measured — duplicates and replicates are never averaged,
          deduplicated or interpolated. No fitting, parameter estimation or diagnostics are
          performed on this page.
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
            Markers only. No fitted curve, interpolation, averaging or unit conversion is shown.
            The table below is the accessible source of the same values.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <figure className="min-w-0">
            <Suspense
              fallback={
                <p role="status" className="py-8 text-sm text-muted-foreground">
                  Loading observed-point chart…
                </p>
              }
            >
              <ExperimentalDatasetChart dataset={dataset} graphId={`experimental-dataset-${dataset.id}`} />
            </Suspense>
            <figcaption className="mt-2 text-xs text-muted-foreground">
              Observed points only. Time axis in {dataset.timeUnit}; concentration axis in{' '}
              {dataset.concentrationUnit}. Hover shows the source row, sample id and note when
              present.
            </figcaption>
          </figure>

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
