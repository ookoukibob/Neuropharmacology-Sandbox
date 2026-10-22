/**
 * CSV import card for experimental datasets (phase 47A).
 *
 * Selecting and parsing a file, editing a mapping and building a preview are
 * all pure/read-only. The only write is the explicit Confirm action, which
 * hands the validated dataset to the page's repository-backed import function.
 * Any mapping change invalidates the preview, so stale values are never
 * committed.
 */
import { useMemo, useState } from 'react'
import { FileUp, Upload } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Textarea } from '@/components/ui/textarea'
import { unitCatalog } from '@/domain/pharmacology/unit-catalog'
import type {
  ExperimentalDataset,
  ExperimentalDatasetInput,
} from '@/domain/experiments/experimental-dataset'
import { readTextFile } from '@/features/import-export/fileIo'
import type { CsvTable } from '@/features/import-export/csv/parseCsv'
import {
  MAX_CSV_BYTES,
  buildDatasetFromCsv,
  readExperimentalCsv,
  type CsvDatasetMapping,
  type CsvDatasetPreview,
} from './csvDataset'

interface LoadedCsv {
  readonly fileName: string
  readonly table: CsvTable
}

interface CsvDatasetImportProps {
  readonly busy: boolean
  readonly onImport: (input: ExperimentalDatasetInput) => Promise<ExperimentalDataset | null>
}

const EMPTY_MAPPING: CsvDatasetMapping = {
  datasetName: '',
  notes: '',
  timeColumn: null,
  timeUnit: '',
  concentrationColumn: null,
  concentrationUnit: '',
  sampleColumn: null,
  noteColumn: null,
}

const TIME_UNITS = unitCatalog.unitsOfDimension('time')
const CONCENTRATION_UNITS = [
  ...unitCatalog.unitsOfDimension('molar-concentration'),
  ...unitCatalog.unitsOfDimension('mass-concentration'),
]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultDatasetName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim()
}

function previewMeasurements(preview: CsvDatasetPreview) {
  return preview.dataset?.measurements.slice(0, 20) ?? []
}

export function CsvDatasetImport({ busy, onImport }: CsvDatasetImportProps) {
  const [loaded, setLoaded] = useState<LoadedCsv | null>(null)
  const [mapping, setMapping] = useState<CsvDatasetMapping>(EMPTY_MAPPING)
  const [preview, setPreview] = useState<CsvDatasetPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const uniqueHeaders = useMemo(() => loaded?.table.headers ?? [], [loaded])

  function reset(): void {
    setLoaded(null)
    setMapping(EMPTY_MAPPING)
    setPreview(null)
  }

  function updateMapping(patch: Partial<CsvDatasetMapping>): void {
    setMapping((current) => ({ ...current, ...patch }))
    // A preview belongs to the exact mapping it was built from.
    setPreview(null)
  }

  async function onFile(file: File): Promise<void> {
    reset()
    setError(null)
    if (file.size > MAX_CSV_BYTES) {
      setError(`The selected file is ${file.size} bytes; the limit is ${MAX_CSV_BYTES} bytes (10 MiB).`)
      return
    }
    try {
      const text = await readTextFile(file)
      const parsed = readExperimentalCsv(text)
      if (!parsed.ok) {
        setError(`CSV rejected: ${parsed.error}`)
        return
      }
      setLoaded({ fileName: file.name, table: parsed.table })
      setMapping({ ...EMPTY_MAPPING, datasetName: defaultDatasetName(file.name) })
    } catch (cause) {
      setError(`The CSV file could not be read: ${messageOf(cause)}`)
    }
  }

  function onPreview(): void {
    if (loaded === null) return
    setPreview(buildDatasetFromCsv(loaded.table, mapping, loaded.fileName))
  }

  async function onConfirm(): Promise<void> {
    if (preview?.dataset === undefined || submitting) return
    setSubmitting(true)
    try {
      const imported = await onImport(preview.dataset)
      if (imported !== null) {
        reset()
        setError(null)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const rows = preview === null ? [] : previewMeasurements(preview)
  const disabled = busy || submitting

  return (
    <Card data-testid="csv-dataset-import">
      <CardHeader>
        <CardTitle headingLevel={2}>Import measured data from CSV</CardTitle>
        <p className="text-sm text-muted-foreground">
          Map every column explicitly and choose the time and concentration units. Nothing is
          inferred from headers, file names, values or neighbouring rows. Rows keep source order;
          duplicates and replicates are preserved.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="csv-dataset-file">CSV file</Label>
          <Input
            id="csv-dataset-file"
            type="file"
            accept=".csv,text/csv"
            data-testid="csv-dataset-file"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void onFile(file)
            }}
          />
          <p className="text-xs text-muted-foreground">
            Maximum {MAX_CSV_BYTES / (1024 * 1024)} MiB and 25,000 data rows. Blank cells,
            qualifiers such as “&lt;0.1”, “BLQ” and “N/A” are rejected with the row number.
          </p>
        </div>

        {error !== null && (
          <Alert variant="destructive" data-testid="csv-dataset-error">
            <AlertTitle>CSV file rejected</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loaded !== null && (
          <div className="space-y-4" data-testid="csv-dataset-mapping">
            <p className="text-sm" data-testid="csv-dataset-file-info">
              File: <strong>{loaded.fileName}</strong> — {loaded.table.rows.length} data row
              {loaded.table.rows.length === 1 ? '' : 's'}, {loaded.table.headers.length} column
              {loaded.table.headers.length === 1 ? '' : 's'}.
            </p>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="csv-dataset-name">Dataset name</Label>
                <Input
                  id="csv-dataset-name"
                  value={mapping.datasetName}
                  maxLength={120}
                  disabled={disabled}
                  data-testid="csv-dataset-name"
                  onChange={(event) => updateMapping({ datasetName: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="csv-dataset-notes">Dataset notes (optional)</Label>
                <Textarea
                  id="csv-dataset-notes"
                  value={mapping.notes}
                  maxLength={10_000}
                  disabled={disabled}
                  data-testid="csv-dataset-notes"
                  onChange={(event) => updateMapping({ notes: event.target.value })}
                />
              </div>
            </div>

            <fieldset className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
              <legend className="px-1 text-sm font-medium">Column mapping</legend>
              <ColumnSelect
                id="csv-dataset-time-column"
                label="Time column"
                headers={uniqueHeaders}
                value={mapping.timeColumn}
                disabled={disabled}
                onChange={(value) => updateMapping({ timeColumn: value })}
              />
              <div className="grid gap-1.5">
                <Label htmlFor="csv-dataset-time-unit">Time unit</Label>
                <select
                  id="csv-dataset-time-unit"
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  value={mapping.timeUnit}
                  disabled={disabled}
                  data-testid="csv-dataset-time-unit"
                  onChange={(event) => updateMapping({ timeUnit: event.target.value })}
                >
                  <option value="">Select a time unit…</option>
                  {TIME_UNITS.map((unit) => (
                    <option key={unit.symbol} value={unit.symbol}>
                      {unit.symbol}
                    </option>
                  ))}
                </select>
              </div>
              <ColumnSelect
                id="csv-dataset-concentration-column"
                label="Concentration column"
                headers={uniqueHeaders}
                value={mapping.concentrationColumn}
                disabled={disabled}
                onChange={(value) => updateMapping({ concentrationColumn: value })}
              />
              <div className="grid gap-1.5">
                <Label htmlFor="csv-dataset-concentration-unit">Concentration unit</Label>
                <select
                  id="csv-dataset-concentration-unit"
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  value={mapping.concentrationUnit}
                  disabled={disabled}
                  data-testid="csv-dataset-concentration-unit"
                  onChange={(event) => updateMapping({ concentrationUnit: event.target.value })}
                >
                  <option value="">Select a concentration unit…</option>
                  <optgroup label="Molar concentration">
                    {CONCENTRATION_UNITS.filter((unit) =>
                      unitCatalog.dimensionOf(unit.symbol) === 'molar-concentration',
                    ).map((unit) => (
                      <option key={unit.symbol} value={unit.symbol}>
                        {unit.symbol}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Mass concentration">
                    {CONCENTRATION_UNITS.filter(
                      (unit) => unitCatalog.dimensionOf(unit.symbol) === 'mass-concentration',
                    ).map((unit) => (
                      <option key={unit.symbol} value={unit.symbol}>
                        {unit.symbol}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <ColumnSelect
                id="csv-dataset-sample-column"
                label="Sample / replicate id column (optional)"
                headers={uniqueHeaders}
                value={mapping.sampleColumn}
                disabled={disabled}
                optional
                onChange={(value) => updateMapping({ sampleColumn: value })}
              />
              <ColumnSelect
                id="csv-dataset-note-column"
                label="Measurement note column (optional)"
                headers={uniqueHeaders}
                value={mapping.noteColumn}
                disabled={disabled}
                optional
                onChange={(value) => updateMapping({ noteColumn: value })}
              />
            </fieldset>

            <Button type="button" onClick={onPreview} disabled={disabled} data-testid="csv-dataset-preview">
              <FileUp aria-hidden="true" />
              Preview and validate
            </Button>

            {preview !== null && (
              <div className="space-y-3" data-testid="csv-dataset-preview-result">
                <p className="text-sm" data-testid="csv-dataset-preview-counts">
                  <strong>{preview.rowCount}</strong> source row{preview.rowCount === 1 ? '' : 's'}:{' '}
                  <strong>{preview.validRowCount}</strong> valid,{' '}
                  <strong>{preview.invalidRowCount}</strong> invalid.
                  {preview.dataset === undefined
                    ? ' Nothing can be imported until every issue is corrected.'
                    : ' Every row is valid; the dataset is ready to import.'}
                </p>

                {preview.issues.length > 0 && (
                  <Alert variant="destructive" data-testid="csv-dataset-issues">
                    <AlertTitle>Rows rejected — no data was written</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-4">
                        {preview.issues.slice(0, 200).map((issue, index) => (
                          <li key={`${issue.row ?? 'map'}-${issue.column ?? ''}-${String(index)}`}>
                            {issue.message}
                          </li>
                        ))}
                      </ul>
                      {preview.issues.length > 200 && (
                        <p>…and {preview.issues.length - 200} more issue(s).</p>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {preview.dataset !== undefined && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Time unit <strong>{preview.dataset.timeUnit}</strong>; concentration unit{' '}
                      <strong>{preview.dataset.concentrationUnit}</strong>. Showing the first{' '}
                      {rows.length} of {preview.dataset.measurements.length} measurements; the saved
                      dataset will contain every row.
                    </p>
                    <Table>
                      <TableCaption>
                        Import preview, source order. Duplicate timestamps are intentional.
                      </TableCaption>
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">Source row</TableHead>
                          <TableHead scope="col">Time ({preview.dataset.timeUnit})</TableHead>
                          <TableHead scope="col">
                            Concentration ({preview.dataset.concentrationUnit})
                          </TableHead>
                          <TableHead scope="col">Sample id</TableHead>
                          <TableHead scope="col">Note</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((measurement) => (
                          <TableRow key={measurement.sourceRow}>
                            <TableCell>{measurement.sourceRow}</TableCell>
                            <TableCell>{measurement.time}</TableCell>
                            <TableCell>{measurement.concentration}</TableCell>
                            <TableCell>{measurement.sampleId ?? '—'}</TableCell>
                            <TableCell>{measurement.note ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <Button
                      type="button"
                      onClick={() => void onConfirm()}
                      disabled={disabled}
                      data-testid="csv-dataset-confirm"
                    >
                      <Upload aria-hidden="true" />
                      {submitting ? 'Importing…' : 'Import dataset'}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface ColumnSelectProps {
  readonly id: string
  readonly label: string
  readonly headers: readonly string[]
  readonly value: number | null
  readonly disabled: boolean
  readonly optional?: boolean
  readonly onChange: (value: number | null) => void
}

function ColumnSelect({
  id,
  label,
  headers,
  value,
  disabled,
  optional = false,
  onChange,
}: ColumnSelectProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        value={value === null ? '' : String(value)}
        disabled={disabled}
        data-testid={id}
        onChange={(event) =>
          onChange(event.target.value === '' ? null : Number(event.target.value))
        }
      >
        <option value="">{optional ? 'Not mapped' : 'Select a column…'}</option>
        {headers.map((header, index) => (
          <option key={`${String(index)}-${header}`} value={String(index)}>
            Column {index + 1}: {header === '' ? '(unnamed)' : header}
          </option>
        ))}
      </select>
    </div>
  )
}
