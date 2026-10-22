/**
 * `.npex` import card for experimental datasets (phase 47A).
 *
 * Selecting a file parses and validates it read-only into a preview. No local
 * id, timestamp or database row is created until the explicit Confirm action.
 * The preview shows the file's declared units, provenance and ordered values
 * exactly as they will be stored.
 */
import { useState } from 'react'
import { FolderOpen, Upload } from 'lucide-react'
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
import type {
  ExperimentalDataset,
  ExperimentalDatasetInput,
} from '@/domain/experiments/experimental-dataset'
import { readTextFile } from '@/features/import-export/fileIo'
import {
  MAX_NPEX_BYTES,
  parseNpexText,
  type NpexIssue,
} from '@/data/npex/npex'

interface NpexPreview {
  readonly fileName: string
  readonly exportedAt: string
  readonly dataset: ExperimentalDatasetInput
}

interface NpexDatasetImportProps {
  readonly busy: boolean
  readonly onImport: (input: ExperimentalDatasetInput) => Promise<ExperimentalDataset | null>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function NpexDatasetImport({ busy, onImport }: NpexDatasetImportProps) {
  const [preview, setPreview] = useState<NpexPreview | null>(null)
  const [issues, setIssues] = useState<readonly NpexIssue[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onFile(file: File): Promise<void> {
    setPreview(null)
    setIssues([])
    setError(null)
    if (file.size > MAX_NPEX_BYTES) {
      setError(
        `The selected file is ${file.size} bytes; the limit is ${MAX_NPEX_BYTES} bytes (10 MiB).`,
      )
      return
    }
    try {
      const text = await readTextFile(file)
      const parsed = parseNpexText(text)
      if (!parsed.ok) {
        setIssues(parsed.issues)
        return
      }
      setPreview({ fileName: file.name, exportedAt: parsed.exportedAt, dataset: parsed.dataset })
    } catch (cause) {
      setError(`The .npex file could not be read: ${messageOf(cause)}`)
    }
  }

  async function onConfirm(): Promise<void> {
    if (preview === null || submitting) return
    setSubmitting(true)
    try {
      const imported = await onImport(preview.dataset)
      if (imported !== null) {
        setPreview(null)
        setIssues([])
        setError(null)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const rows = preview?.dataset.measurements.slice(0, 20) ?? []
  const disabled = busy || submitting

  return (
    <Card data-testid="npex-dataset-import">
      <CardHeader>
        <CardTitle headingLevel={2}>Import an .npex dataset</CardTitle>
        <p className="text-sm text-muted-foreground">
          A versioned single-dataset interchange file. Import is exact: declared units, source
          order, source rows, timestamps, duplicate points, sample ids and notes are preserved. No
          local database ids are read from the file.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="npex-dataset-file">.npex file</Label>
          <Input
            id="npex-dataset-file"
            type="file"
            accept=".npex,application/json"
            data-testid="npex-dataset-file"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void onFile(file)
            }}
          />
          <p className="text-xs text-muted-foreground">
            Maximum {MAX_NPEX_BYTES / (1024 * 1024)} MiB. Unknown keys, duplicate JSON keys,
            unsupported versions and non-finite or negative values are rejected before anything is
            written.
          </p>
        </div>

        {error !== null && (
          <Alert variant="destructive" data-testid="npex-dataset-error">
            <AlertTitle>.npex file rejected</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {issues.length > 0 && (
          <Alert variant="destructive" data-testid="npex-dataset-issues">
            <AlertTitle>.npex file rejected — no data was written</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {issues.map((entry, index) => (
                  <li key={`${entry.code}-${entry.path ?? ''}-${String(index)}`}>
                    {entry.path !== undefined && <code>{entry.path}</code>} {entry.message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {preview !== null && (
          <div className="space-y-3" data-testid="npex-dataset-preview">
            <p className="text-sm" data-testid="npex-dataset-preview-summary">
              <strong>{preview.dataset.name}</strong> — {preview.dataset.measurements.length}{' '}
              measurement{preview.dataset.measurements.length === 1 ? '' : 's'}. Time unit{' '}
              <strong>{preview.dataset.timeUnit}</strong>; concentration unit{' '}
              <strong>{preview.dataset.concentrationUnit}</strong>.
            </p>
            <dl className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground md:grid-cols-2">
              <div>
                <dt className="inline">File: </dt>
                <dd className="inline">{preview.fileName}</dd>
              </div>
              <div>
                <dt className="inline">Originally imported from: </dt>
                <dd className="inline">
                  {preview.dataset.provenance.source}
                  {preview.dataset.provenance.fileName === undefined
                    ? ''
                    : ` (${preview.dataset.provenance.fileName})`}
                </dd>
              </div>
              <div>
                <dt className="inline">Original import time: </dt>
                <dd className="inline">
                  <time dateTime={preview.dataset.provenance.importedAt}>
                    {preview.dataset.provenance.importedAt}
                  </time>
                </dd>
              </div>
              <div>
                <dt className="inline">File exported at: </dt>
                <dd className="inline">
                  <time dateTime={preview.exportedAt}>{preview.exportedAt}</time>
                </dd>
              </div>
            </dl>
            {preview.dataset.notes !== undefined && (
              <p className="whitespace-pre-wrap text-sm">Notes: {preview.dataset.notes}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Showing the first {rows.length} of {preview.dataset.measurements.length} measurements;
              import keeps every row in this order.
            </p>
            <Table>
              <TableCaption>Preview of stored values, source order.</TableCaption>
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
              data-testid="npex-dataset-confirm"
            >
              <Upload aria-hidden="true" />
              {submitting ? 'Importing…' : 'Import dataset'}
            </Button>
          </div>
        )}

        {preview === null && issues.length === 0 && error === null && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <FolderOpen aria-hidden="true" className="size-4" />
            Select a file to validate and preview it.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
