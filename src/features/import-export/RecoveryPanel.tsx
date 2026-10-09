/**
 * Recovery panel — the `.npsb` full-recovery archive (Phase 8B, ADR-18).
 *
 * Deliberately separate from ordinary Import/Export: `.npsl`/`.json`/CSV
 * are interchange formats that EXCLUDE quarantined rows, while `.npsb`
 * snapshots and restores the raw storage of BOTH object stores (`drugs`
 * and `meta`), quarantined rows and unknown future fields included.
 *
 * Invariants enforced by construction:
 * - export performs no pre-checks and never mutates storage
 *   (`exportRecoveryArchive`); a failed export shows the structured
 *   BACKUP_* issues and offers NO file;
 * - selecting a restore archive only validates and previews it — the sole
 *   write path is the confirm button, which calls the store's
 *   `restoreArchive` (complete §8.2 validation, then ONE rw transaction);
 * - confirm stays disabled until the explicit acknowledgement checkbox
 *   (whose label embeds the record/quarantine counts) is checked, and
 *   `busy` blocks duplicate submissions;
 * - the four outcomes are reported distinctly: `rejected` and `failed`
 *   state the library was NOT modified; `committed-refresh-failed` states
 *   the restore WAS committed, shows the refresh error and retries only
 *   the session refresh — never the restore transaction.
 */
import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { libraryRepository, useLibraryStore } from '@/app/libraryStore'
import {
  BACKUP_EXTENSION,
  BACKUP_MIME_TYPE,
  MAX_ARCHIVE_BYTES,
  type RecoveryIssue,
} from '@/data/recovery/format'
import type { RecoveryReport } from '@/data/repositories/repository'
import type { LibraryRestoreOutcome } from '@/features/drug-library/store'
import { downloadTextFile, readTextFile, safeFileName } from './fileIo'

interface ExportStatus {
  readonly kind: 'ok' | 'error'
  readonly message?: string
  readonly issues?: readonly RecoveryIssue[]
}

interface ActiveArchive {
  readonly fileName: string
  readonly text: string
  readonly report: RecoveryReport
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** One structured issue as a human-readable line (store/key/path/type). */
function formatIssue(issue: RecoveryIssue): string {
  const where: string[] = []
  if (issue.store !== undefined) {
    let location = issue.store
    if (issue.index !== undefined) location += `[${issue.index}]`
    if (issue.key !== undefined) location += ` key "${issue.key}"`
    where.push(location)
  }
  if (issue.path !== undefined && issue.path !== '') where.push(`path ${issue.path}`)
  if (issue.valueType !== undefined) where.push(`type ${issue.valueType}`)
  if (issue.limit !== undefined) where.push(`limit: ${issue.limit}`)
  return where.length > 0
    ? `${issue.code} (${where.join(', ')}): ${issue.message}`
    : `${issue.code}: ${issue.message}`
}

function IssueList({ issues }: { readonly issues: readonly RecoveryIssue[] }) {
  return (
    <ul className="list-disc pl-4" data-testid="recovery-issues">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${String(index)}`}>{formatIssue(issue)}</li>
      ))}
    </ul>
  )
}

function RestoreReportCard({ outcome }: { readonly outcome: LibraryRestoreOutcome }) {
  const hydrate = useLibraryStore((s) => s.hydrate)

  if (outcome.status === 'ok') {
    const report = outcome.report
    const quarantined = report.currentBuild.quarantined
    return (
      <Alert data-testid="recovery-restore-report">
        <AlertTitle>Restore complete</AlertTitle>
        <AlertDescription>
          <p>
            {plural(report.counts.drugRows, 'stored row')} and{' '}
            {plural(report.counts.metaRows, 'metadata row')} were restored verbatim (full
            snapshot replacement). This build classifies the restored rows as{' '}
            {report.currentBuild.readable} readable and {quarantined} quarantined
            {quarantined > 0
              ? ' — quarantined rows remain stored and appear in the quarantine report on the Drug Library page.'
              : '.'}
          </p>
        </AlertDescription>
      </Alert>
    )
  }
  if (outcome.status === 'committed-refresh-failed') {
    // The transaction committed — only the session refresh failed. Never
    // presented as a failed restore: the records ARE in the database.
    const report = outcome.report
    return (
      <Alert variant="destructive" data-testid="recovery-restore-report">
        <AlertTitle>Restore committed — session refresh failed</AlertTitle>
        <AlertDescription>
          <p>
            The database contains the restored archive ({plural(report.counts.drugRows, 'stored row')}
            , {plural(report.counts.metaRows, 'metadata row')}). Nothing was rolled back — the
            restore WAS written to storage — but re-reading it into this session failed, so the
            list on screen may be stale:
          </p>
          <p className="break-words" data-testid="recovery-refresh-error">
            {outcome.message}
          </p>
          <p>
            Retry the session refresh below (the restore itself is never re-run automatically),
            or reload the page.
          </p>
          <Button
            type="button"
            variant="outline"
            data-testid="recovery-refresh-retry"
            onClick={() => void hydrate()}
          >
            Retry session refresh
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (outcome.status === 'failed') {
    return (
      <Alert variant="destructive" data-testid="recovery-restore-report">
        <AlertTitle>Restore failed — no changes were written</AlertTitle>
        <AlertDescription>
          <p>
            The restore transaction was rolled back; the current library is unchanged. You can
            fix the cause (for example, free disk space) and try again.
          </p>
          <p className="break-words" data-testid="recovery-restore-error">
            {outcome.message}
          </p>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive" data-testid="recovery-rejected">
      <AlertTitle>Restore rejected — the current library was not modified</AlertTitle>
      <AlertDescription>
        <IssueList issues={outcome.issues} />
      </AlertDescription>
    </Alert>
  )
}

export function RecoveryPanel() {
  const drugs = useLibraryStore((s) => s.drugs)
  const quarantine = useLibraryStore((s) => s.quarantine)
  const metadata = useLibraryStore((s) => s.metadata)
  const restoreArchive = useLibraryStore((s) => s.restoreArchive)

  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [rejected, setRejected] = useState<readonly RecoveryIssue[] | null>(null)
  const [active, setActive] = useState<ActiveArchive | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<LibraryRestoreOutcome | null>(null)

  async function onExport(): Promise<void> {
    setExporting(true)
    setExportStatus(null)
    try {
      const result = await libraryRepository.exportRecoveryArchive()
      if (!result.ok) {
        // Structured failure: no file, no success status, no "backup" claim.
        setExportStatus({ kind: 'error', issues: result.issues })
        return
      }
      const fileName = `${safeFileName(metadata?.name ?? 'library')}${BACKUP_EXTENSION}`
      downloadTextFile(fileName, result.text, BACKUP_MIME_TYPE)
      const counts = result.counts
      setExportStatus({
        kind: 'ok',
        message: `Downloaded ${fileName} — ${plural(counts.drugRows, 'stored row')} (${counts.readableAtExport} readable, ${counts.quarantinedAtExport} quarantined at export) and ${plural(counts.metaRows, 'metadata row')}. This archive has no checksum or signature: it proves schema conformance only, not integrity or authenticity — verify where a file came from before restoring it.`,
      })
    } catch (error) {
      setExportStatus({
        kind: 'error',
        issues: [
          { code: 'BACKUP_READ_FAILED', message: `the backup could not be created: ${messageOf(error)}` },
        ],
      })
    } finally {
      setExporting(false)
    }
  }

  function resetRestoreState(): void {
    setActive(null)
    setRejected(null)
    setReadError(null)
    setOutcome(null)
    setAck(false)
  }

  async function onRestoreFile(file: File): Promise<void> {
    resetRestoreState()
    // Oversized files are rejected BEFORE being read into memory; the
    // parser re-checks the decoded text at its own UTF-8 byte boundary.
    if (file.size > MAX_ARCHIVE_BYTES) {
      setRejected([
        {
          code: 'ARCHIVE_TOO_LARGE',
          message: `the selected file is ${file.size} bytes; the limit is ${MAX_ARCHIVE_BYTES} bytes (64 MiB)`,
        },
      ])
      return
    }
    try {
      const text = await readTextFile(file)
      const preview = await libraryRepository.previewRecoveryArchive(text)
      if (!preview.ok) {
        setRejected(preview.issues)
        return
      }
      setActive({ fileName: file.name, text, report: preview.report })
    } catch (error) {
      setReadError(`the archive file could not be read: ${messageOf(error)}`)
    }
  }

  async function onConfirm(): Promise<void> {
    if (active === null || !ack || busy) return
    setBusy(true)
    try {
      const result = await restoreArchive(active.text)
      setOutcome(result)
      // Committed outcomes clear the preview so the Confirm button cannot
      // be pressed again for a restore whose rows are already written
      // (even when the session refresh afterwards failed).
      if (result.status === 'ok' || result.status === 'committed-refresh-failed') {
        setActive(null)
        setAck(false)
      }
    } finally {
      setBusy(false)
    }
  }

  function onCancelPreview(): void {
    setActive(null)
    setRejected(null)
    setAck(false)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle headingLevel={2}>Create a full recovery backup (.npsb)</CardTitle>
          <p className="text-sm text-muted-foreground">
            A .npsb archive is a complete snapshot of local storage: every stored row — including
            rows this build cannot validate (quarantined) and unknown future fields — plus every
            library-metadata row, from both object stores. It is separate from the interchange
            formats on the Import/Export tabs, which exclude quarantined rows. Export is
            read-only: creating a backup never modifies the library.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              data-testid="recovery-export"
              disabled={exporting}
              onClick={() => void onExport()}
            >
              <Download aria-hidden="true" />
              {exporting ? 'Creating backup…' : 'Download .npsb backup'}
            </Button>
          </div>
          {exportStatus !== null && exportStatus.kind === 'ok' && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="recovery-export-status"
              role="status"
            >
              {exportStatus.message}
            </p>
          )}
          {exportStatus !== null && exportStatus.kind === 'error' && (
            <Alert variant="destructive" data-testid="recovery-export-status">
              <AlertTitle>Recovery backup failed — no file was created</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4" data-testid="recovery-export-issues">
                  {(exportStatus.issues ?? []).map((issue, index) => (
                    <li key={`${issue.code}-${String(index)}`}>{formatIssue(issue)}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle headingLevel={2}>Restore a recovery backup (.npsb)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Restoring REPLACES the entire current library — every record and all library
            metadata — with the archive contents. Selecting a file only validates and previews
            it; nothing is written until you confirm below.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="recovery-restore-file">Recovery archive (.npsb)</Label>
            <Input
              id="recovery-restore-file"
              type="file"
              accept=".npsb,application/json"
              data-testid="recovery-restore-file"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file !== undefined) void onRestoreFile(file)
              }}
            />
            <p className="text-xs text-muted-foreground">
              Maximum {MAX_ARCHIVE_BYTES / (1024 * 1024)} MiB (UTF-8 bytes). The file is
              validated completely before any write is attempted.
            </p>
          </div>

          {readError !== null && (
            <Alert variant="destructive" data-testid="recovery-read-error">
              <AlertTitle>Archive file could not be read</AlertTitle>
              <AlertDescription>{readError}</AlertDescription>
            </Alert>
          )}

          {rejected !== null && (
            <Alert variant="destructive" data-testid="recovery-rejected">
              <AlertTitle>Archive rejected — the current library was not modified</AlertTitle>
              <AlertDescription>
                <IssueList issues={rejected} />
              </AlertDescription>
            </Alert>
          )}

          {outcome !== null && <RestoreReportCard outcome={outcome} />}

          {active !== null && (
            <div className="space-y-4" data-testid="recovery-preview">
              <p className="text-sm" data-testid="recovery-preview-file">
                Archive: <strong>{active.fileName}</strong>
              </p>
              <div className="text-sm" data-testid="recovery-preview-counts">
                <p>
                  <strong>Recorded at export:</strong>{' '}
                  {plural(active.report.counts.drugRows, 'stored row')} (
                  {active.report.counts.readableAtExport} readable,{' '}
                  {active.report.counts.quarantinedAtExport} quarantined) and{' '}
                  {plural(active.report.counts.metaRows, 'metadata row')}.
                </p>
                <p>
                  <strong>This build classifies the archive rows as:</strong>{' '}
                  {active.report.currentBuild.readable} readable,{' '}
                  {active.report.currentBuild.quarantined} quarantined.
                </p>
                <p>
                  <strong>Current library that will be replaced:</strong>{' '}
                  {plural(drugs.length, 'record')} and {plural(quarantine.length, 'quarantined row')}
                  .
                </p>
              </div>

              {active.report.warnings.length > 0 && (
                <Alert data-testid="recovery-warnings">
                  <AlertTitle>Warnings — the restore can still proceed</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {active.report.warnings.map((warning) => (
                        <li key={warning.code}>
                          [{warning.code}] {warning.message}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              <Alert variant="destructive" data-testid="recovery-restore-warning">
                <AlertTitle>Replace the entire library with this archive?</AlertTitle>
                <AlertDescription>
                  <p>
                    Restoring permanently overwrites every existing record and all library
                    metadata with the archive contents (
                    {plural(active.report.counts.drugRows, 'row')}). This cannot be undone.
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid="recovery-acknowledge"
                      checked={ack}
                      disabled={busy}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    I understand this will permanently replace my current library —{' '}
                    {plural(drugs.length, 'record')} and{' '}
                    {plural(quarantine.length, 'quarantined row')} — with the archive contents (
                    {plural(active.report.counts.drugRows, 'row')})
                  </label>
                </AlertDescription>
              </Alert>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  data-testid="recovery-cancel"
                  disabled={busy}
                  onClick={onCancelPreview}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  data-testid="recovery-restore-confirm"
                  disabled={!ack || busy}
                  onClick={() => void onConfirm()}
                >
                  <Upload aria-hidden="true" />
                  {busy ? 'Restoring…' : 'Restore backup — replaces everything'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
