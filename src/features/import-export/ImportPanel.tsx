/**
 * Import flow: file → (CSV: explicit mapping) → preview → confirm → report.
 *
 * Invariants enforced by construction:
 * - selecting a file and building a preview are pure — the only write
 *   path is `onConfirm`, which calls the store's transactional
 *   `importLibrary` (repository validation runs again inside its
 *   transaction);
 * - confirmation is disabled unless preview validation succeeded, while
 *   a replace additionally requires the explicit acknowledgement checkbox;
 * - `busy` blocks duplicate submissions (file inputs, preview and confirm
 *   are disabled during an import);
 * - a rejected import (`invalid`) and a genuine transaction failure
 *   (`failed`) surface the real error and leave the preview in place so
 *   the user can retry or cancel — the library itself is never touched;
 * - a merge id that collides with a quarantined raw record is a blocking
 *   conflict (audit GAP-3): the preview shows an advisory naming the
 *   ids, and the authoritative check runs inside the repository's
 *   transaction — a stale preview cannot bypass it;
 * - a committed import clears the preview (no double-submit). That
 *   includes `committed-refresh-failed`: the records are already written,
 *   so the report says so, shows the refresh error, and offers a session
 *   refresh retry — never "nothing was written" and never an automatic
 *   re-run of the import.
 */
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLibraryStore } from '@/app/libraryStore'
import {
  previewNpslImport,
  type ImportIssue,
  type ImportPreview,
  type ImportWarning,
} from '@/data/import/importPipeline'
import { serializeNpslDocument } from '@/data/mappers/npslDocument'
import type { ImportMode } from '@/data/repositories/repository'
import { DEFAULT_LIBRARY_ID, type LibraryMetadata } from '@/domain/library/library'
import type { Drug } from '@/domain/drug/drug'
import type { LibraryImportOutcome } from '@/features/drug-library/store'
import { CsvMappingCard } from './CsvMappingCard'
import { buildCsvImport, type CsvMappingState } from './csv/csvImport'
import { parseCsv } from './csv/parseCsv'
import { CSV_PK_PARAMS, CSV_TARGET_PARAMS } from './csv/params'
import { readTextFile } from './fileIo'

const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background px-2 text-sm'

interface ActivePreview {
  readonly fileName: string
  readonly format: 'npsl' | 'json' | 'csv'
  /** Exact text handed to `importLibrary` on confirmation. */
  readonly text: string
  readonly preview: ImportPreview
  /** CSV declarations (grouping, unit and provenance policies, unmapped). */
  readonly notes: readonly string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Short human-readable summary of one record for the preview list. */
function describeDrug(drug: Drug): string {
  const parts: string[] = []
  for (const target of drug.targets) {
    const values = CSV_TARGET_PARAMS.flatMap((param) => {
      const value = target[param.key]
      return value === undefined ? [] : [`${param.label} ${value.value} ${value.unit}`]
    })
    parts.push(values.length > 0 ? `${target.name} (${values.join(', ')})` : target.name)
  }
  const pk = CSV_PK_PARAMS.flatMap((param) => {
    const value = drug.pharmacokinetics[param.key]
    return value === undefined ? [] : [`${param.label} ${value.value} ${value.unit}`]
  })
  if (pk.length > 0) parts.push(`PK: ${pk.join(', ')}`)
  return parts.join(' · ')
}

function IssueList({ errors }: { readonly errors: readonly ImportIssue[] }) {
  return (
    <ul className="list-disc pl-4">
      {errors.map((error, index) => (
        <li key={index}>
          {error.code}
          {error.path !== undefined ? ` at ${error.path}` : ''}: {error.message}
        </li>
      ))}
    </ul>
  )
}

function WarningList({ warnings }: { readonly warnings: readonly ImportWarning[] }) {
  return (
    <ul className="list-disc pl-4">
      {warnings.map((warning, index) => (
        <li key={index}>[{warning.code}] {warning.message}</li>
      ))}
    </ul>
  )
}

function ImportReportCard({ outcome }: { readonly outcome: LibraryImportOutcome }) {
  const hydrate = useLibraryStore((s) => s.hydrate)

  if (outcome.status === 'ok') {
    const report = outcome.report
    return (
      <Alert data-testid="import-report">
        <AlertTitle>Import complete ({report.mode})</AlertTitle>
        <AlertDescription>
          <p>
            {report.total} record{report.total === 1 ? '' : 's'} in the file: {report.created}{' '}
            created, {report.updated} updated.
          </p>
          {report.warnings.length > 0 && <WarningList warnings={report.warnings} />}
        </AlertDescription>
      </Alert>
    )
  }
  if (outcome.status === 'committed-refresh-failed') {
    // The transaction committed — only the session refresh failed. Never
    // presented as a failed import: the records ARE in the database.
    const report = outcome.report
    return (
      <Alert variant="destructive" data-testid="import-report">
        <AlertTitle>Import committed — session refresh failed</AlertTitle>
        <AlertDescription>
          <p>
            The database contains the imported records ({report.total} in the file:{' '}
            {report.created} created, {report.updated} updated). Nothing was rolled back, but
            re-reading them into this session failed, so the list on screen may be stale:
          </p>
          <p className="break-words" data-testid="refresh-error">
            {outcome.message}
          </p>
          <p>
            Retry the session refresh below (the import itself is not repeated), or reload the
            page.
          </p>
          {report.warnings.length > 0 && <WarningList warnings={report.warnings} />}
          <Button
            type="button"
            variant="outline"
            data-testid="retry-refresh"
            onClick={() => void hydrate()}
          >
            Retry session refresh
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (outcome.status === 'invalid') {
    return (
      <Alert variant="destructive" data-testid="import-report">
        <AlertTitle>Import rejected — nothing was written</AlertTitle>
        <AlertDescription>
          <IssueList errors={outcome.errors} />
          <WarningList warnings={outcome.warnings} />
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive" data-testid="import-report">
      <AlertTitle>Import failed — the library is unchanged</AlertTitle>
      <AlertDescription>{outcome.message}</AlertDescription>
    </Alert>
  )
}

export function ImportPanel() {
  const drugs = useLibraryStore((s) => s.drugs)
  const metadata = useLibraryStore((s) => s.metadata)
  const quarantine = useLibraryStore((s) => s.quarantine)
  const importLibrary = useLibraryStore((s) => s.importLibrary)

  const [active, setActive] = useState<ActivePreview | null>(null)
  const [csv, setCsv] = useState<CsvMappingState | null>(null)
  const [mappingErrors, setMappingErrors] = useState<readonly string[]>([])
  const [mode, setMode] = useState<ImportMode>('merge')
  const [replaceOk, setReplaceOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<LibraryImportOutcome | null>(null)
  const [readError, setReadError] = useState<string | null>(null)

  const existingIds = drugs.map((drug) => drug.id)

  // Merge advisory (audit GAP-3): incoming ids that collide with rows the
  // hydration classifier quarantined. Advisory only — the authoritative
  // check runs inside the repository transaction, so this cached list is
  // never the integrity boundary (staleness cannot let a blocked merge in).
  const quarantineIds = new Set(quarantine.map((record) => record.id))
  const quarantinedIdConflicts =
    active !== null && active.preview.ok && mode === 'merge'
      ? active.preview.drugs.filter((drug) => quarantineIds.has(drug.id)).map((drug) => drug.id)
      : []

  function resetForNewFile(): void {
    setOutcome(null)
    setReadError(null)
    setReplaceOk(false)
    setMappingErrors([])
    setActive(null)
  }

  async function onNpslFile(file: File): Promise<void> {
    resetForNewFile()
    setCsv(null)
    try {
      const text = await readTextFile(file)
      const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'npsl'
      setActive({
        fileName: file.name,
        format,
        text,
        preview: previewNpslImport(text, existingIds),
        notes: [],
      })
    } catch (error) {
      setReadError(messageOf(error))
    }
  }

  async function onCsvFile(file: File): Promise<void> {
    resetForNewFile()
    setCsv(null)
    try {
      const text = await readTextFile(file)
      const parsed = parseCsv(text)
      if (!parsed.ok) {
        setReadError(`CSV parse error — ${parsed.error}.`)
        return
      }
      setCsv({
        fileName: file.name,
        headers: [...parsed.table.headers],
        rows: parsed.table.rows,
        destinations: parsed.table.headers.map(() => null),
        fixedUnits: {},
      })
    } catch (error) {
      setReadError(messageOf(error))
    }
  }

  function onPreviewCsv(): void {
    if (csv === null) return
    const now = new Date().toISOString()
    const contextMetadata: LibraryMetadata = metadata ?? {
      id: DEFAULT_LIBRARY_ID,
      name: 'Imported CSV library',
      createdAt: now,
      updatedAt: now,
      dataStatus: 'user',
    }
    const result = buildCsvImport(csv, { now, metadata: contextMetadata })
    if (!result.ok || result.document === null) {
      setMappingErrors(result.errors)
      return
    }
    setMappingErrors([])
    const text = serializeNpslDocument(result.document)
    setActive({
      fileName: csv.fileName,
      format: 'csv',
      text,
      preview: previewNpslImport(text, existingIds),
      notes: result.notes,
    })
  }

  async function onConfirm(): Promise<void> {
    if (active === null || !active.preview.ok || busy) return
    if (mode === 'replace' && !replaceOk) return
    setBusy(true)
    try {
      const result = await importLibrary(active.text, mode)
      setOutcome(result)
      // Both committed outcomes clear the preview so the Confirm button
      // cannot be pressed again for an import whose records are already
      // written (even when the session refresh afterwards failed).
      if (result.status === 'ok' || result.status === 'committed-refresh-failed') {
        setActive(null)
        setCsv(null)
        setMappingErrors([])
        setReplaceOk(false)
      }
    } finally {
      setBusy(false)
    }
  }

  function onCancelPreview(): void {
    setActive(null)
    setReplaceOk(false)
  }

  function onDiscardCsv(): void {
    setCsv(null)
    setMappingErrors([])
    setReadError(null)
  }

  const previewOk = active !== null && active.preview.ok
  const confirmDisabled =
    !previewOk || busy || (mode === 'replace' && !replaceOk)

  return (
    <div className="space-y-6">
      {readError !== null && (
        <Alert variant="destructive" data-testid="import-read-error">
          <AlertTitle>File could not be read</AlertTitle>
          <AlertDescription>{readError}</AlertDescription>
        </Alert>
      )}

      {outcome !== null && <ImportReportCard outcome={outcome} />}

      <Card>
        <CardHeader>
          <CardTitle headingLevel={2}>Select a file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="npsl-file">NPSL / JSON library file</Label>
            <Input
              id="npsl-file"
              type="file"
              accept=".npsl,.json,application/json"
              data-testid="npsl-file-input"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file !== undefined) void onNpslFile(file)
              }}
            />
            <p className="text-xs text-muted-foreground">
              .npsl and .json are the same versioned NPSL envelope serialized as UTF-8 JSON.
              Selecting a file only validates and previews — nothing is written until you confirm.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="csv-file">CSV file</Label>
            <Input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              data-testid="csv-file-input"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file !== undefined) void onCsvFile(file)
              }}
            />
            <p className="text-xs text-muted-foreground">
              CSV requires explicit column mapping — column names such as Kd/Ki or affinity are
              never interpreted automatically.
            </p>
          </div>
        </CardContent>
      </Card>

      {csv !== null && active === null && (
        <CsvMappingCard
          state={csv}
          errors={mappingErrors}
          disabled={busy}
          onChange={setCsv}
          onPreview={onPreviewCsv}
          onDiscard={onDiscardCsv}
        />
      )}

      {active !== null && (
        <Card data-testid="import-preview">
          <CardHeader>
            <CardTitle headingLevel={2}>
              Preview — {active.fileName} ({active.format === 'json' ? '.json' : active.format === 'npsl' ? '.npsl' : '.csv'})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {active.preview.ok ? (
              <>
                <p data-testid="preview-stats">
                  Library "{active.preview.metadata.name}" — {active.preview.stats.total} record
                  {active.preview.stats.total === 1 ? '' : 's'}: {active.preview.stats.newIds}{' '}
                  new id{active.preview.stats.newIds === 1 ? '' : 's'},{' '}
                  {active.preview.stats.conflictingIds} conflicting id
                  {active.preview.stats.conflictingIds === 1 ? '' : 's'} with the current library.
                </p>
                {quarantinedIdConflicts.length > 0 && (
                  <Alert variant="destructive" data-testid="preview-quarantine-conflicts">
                    <AlertTitle>
                      Quarantined id conflict — this merge import will be blocked
                    </AlertTitle>
                    <AlertDescription>
                      <p>
                        {quarantinedIdConflicts.join(', ')}{' '}
                        {quarantinedIdConflicts.length === 1 ? 'matches' : 'match'} a stored
                        record{quarantinedIdConflicts.length === 1 ? '' : 's'} that failed
                        validation and {quarantinedIdConflicts.length === 1 ? 'is' : 'are'}{' '}
                        quarantined in storage. Confirming this merge will be rejected: the
                        quarantined record{quarantinedIdConflicts.length === 1 ? ' is' : 's are'}{' '}
                        preserved unchanged and nothing from this file is written. Resolve the
                        quarantine conflict first — see the quarantine report on the Drug Library
                        page.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}
                <ul className="space-y-1 text-sm" data-testid="preview-records">
                  {active.preview.drugs.slice(0, 5).map((drug) => {
                    const summary = describeDrug(drug)
                    return (
                      <li key={drug.id}>
                        {drug.identifiers.name}
                        {summary === '' ? '' : ` — ${summary}`}
                      </li>
                    )
                  })}
                  {active.preview.drugs.length > 5 && (
                    <li className="text-muted-foreground">
                      … and {active.preview.drugs.length - 5} more
                    </li>
                  )}
                </ul>
                {active.notes.length > 0 && (
                  <div data-testid="csv-declarations">
                    <p className="text-sm font-medium">Declarations for this CSV import</p>
                    <ul className="list-disc pl-4 text-xs text-muted-foreground">
                      {active.notes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {active.preview.warnings.length > 0 && (
                  <Alert data-testid="import-warnings">
                    <AlertTitle>Warnings (import proceeds)</AlertTitle>
                    <AlertDescription>
                      <WarningList warnings={active.preview.warnings} />
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid gap-2">
                  <Label htmlFor="import-mode">Import mode</Label>
                  <select
                    id="import-mode"
                    data-testid="import-mode"
                    className={SELECT_CLASS}
                    value={mode}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value
                      if (next === 'merge' || next === 'replace') {
                        setMode(next)
                        setReplaceOk(false)
                      }
                    }}
                  >
                    <option value="merge">Merge</option>
                    <option value="replace">Replace</option>
                  </select>
                  <ul className="text-xs text-muted-foreground">
                    <li>
                      <strong>Merge</strong> — imported records win for matching ids; unrelated
                      existing records remain.
                    </li>
                    <li>
                      <strong>Replace</strong> — the imported library replaces the entire current
                      library, including library metadata.
                    </li>
                  </ul>
                </div>

                {mode === 'replace' && (
                  <Alert variant="destructive" data-testid="replace-warning">
                    <AlertTitle>Replace the entire library?</AlertTitle>
                    <AlertDescription>
                      <p>
                        Replace permanently overwrites every existing record and the library
                        metadata with this file ({active.preview.stats.total} record
                        {active.preview.stats.total === 1 ? '' : 's'}). This cannot be undone.
                      </p>
                      <label className="mt-2 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          data-testid="replace-acknowledge"
                          checked={replaceOk}
                          disabled={busy}
                          onChange={(e) => setReplaceOk(e.target.checked)}
                        />
                        I understand that existing records will be replaced
                      </label>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="cancel-import"
                    disabled={busy}
                    onClick={onCancelPreview}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    data-testid="confirm-import"
                    disabled={confirmDisabled}
                    onClick={() => void onConfirm()}
                  >
                    {busy ? 'Importing…' : 'Confirm import'}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Alert variant="destructive" data-testid="import-errors">
                  <AlertTitle>This file cannot be imported — nothing was written</AlertTitle>
                  <AlertDescription>
                    <IssueList errors={active.preview.errors} />
                    {active.preview.warnings.length > 0 && (
                      <WarningList warnings={active.preview.warnings} />
                    )}
                  </AlertDescription>
                </Alert>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="cancel-import"
                  disabled={busy}
                  onClick={onCancelPreview}
                >
                  Cancel
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
