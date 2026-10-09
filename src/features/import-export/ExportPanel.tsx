/**
 * Export panel — downloads of the current library.
 *
 * `.npsl` and `.json` are the same versioned NPSL envelope (UTF-8 JSON,
 * built by `toNpslDocument`/`serializeNpslDocument`): metadata, ids,
 * scientific values, units, storage origin and every supported provenance
 * field survive verbatim. `.csv` is a documented lossy projection of the
 * same library (see the always-visible warning) whose text cells are
 * guarded against spreadsheet formula injection.
 *
 * Exports contain every record the repository can validate — quarantined
 * records (invalid stored rows, reported on hydration) are excluded from
 * all three formats by the repository's export contract. When quarantine
 * is non-empty this panel shows an explicit notice with the excluded
 * count, so a "backup" is never silently incomplete.
 *
 * Reads go through the repository (source of truth) and only serialize —
 * exporting never mutates the library. Object URLs are managed by
 * `downloadTextFile` (at most one live URL; revoked on failure or when
 * the next download starts).
 */
import { useState } from 'react'
import { Download } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { libraryRepository, useLibraryStore } from '@/app/libraryStore'
import { serializeNpslDocument, toNpslDocument } from '@/data/mappers/npslDocument'
import { libraryToCsv } from './csv/csvExport'
import { downloadTextFile, safeFileName } from './fileIo'

type ExportKind = 'npsl' | 'json' | 'csv'

interface ExportStatus {
  readonly kind: 'ok' | 'error'
  readonly message: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ExportPanel() {
  const quarantine = useLibraryStore((s) => s.quarantine)
  const [busy, setBusy] = useState<ExportKind | null>(null)
  const [status, setStatus] = useState<ExportStatus | null>(null)

  async function run(kind: ExportKind): Promise<void> {
    setBusy(kind)
    setStatus(null)
    try {
      const library = await libraryRepository.exportLibrary()
      const base = safeFileName(library.metadata.name)
      if (kind === 'csv') {
        downloadTextFile(`${base}.csv`, libraryToCsv(library), 'text/csv;charset=utf-8')
      } else {
        const text = serializeNpslDocument(toNpslDocument(library))
        downloadTextFile(`${base}.${kind}`, text, 'application/json;charset=utf-8')
      }
      setStatus({
        kind: 'ok',
        message: `Downloaded ${base}.${kind} — ${library.drugs.length} record${library.drugs.length === 1 ? '' : 's'} from "${library.metadata.name}".`,
      })
    } catch (error) {
      setStatus({ kind: 'error', message: `Export failed: ${messageOf(error)}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export the library</CardTitle>
        <p className="text-sm text-muted-foreground">
          Exports are not filtered or selected: every validated record in the current library is
          included. Records that fail validation are quarantined and excluded from every format —
          a notice below appears when that applies.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {quarantine.length > 0 && (
          <Alert variant="destructive" data-testid="export-quarantine-warning">
            <AlertTitle>Quarantined records are not exported</AlertTitle>
            <AlertDescription>
              {quarantine.length} stored record{quarantine.length === 1 ? '' : 's'} failed
              validation and {quarantine.length === 1 ? 'is' : 'are'} quarantined in storage.
              Normal .npsl, .json and CSV exports contain only validated records — the
              quarantined record{quarantine.length === 1 ? '' : 's'}{' '}
              {quarantine.length === 1 ? 'is' : 'are'} NOT included, so this export is not a
              complete backup of everything in storage. Review the quarantine report on the Drug
              Library page first; quarantined records are never deleted automatically.
            </AlertDescription>
          </Alert>
        )}

        <Alert data-testid="csv-lossiness">
          <AlertTitle>CSV is a lossy projection</AlertTitle>
          <AlertDescription>
            CSV flattens the library to one row per target, stores nested provenance as JSON
            strings in cells, and drops fields the current schema does not know; a CSV re-import
            re-stamps storage origin and bookkeeping timestamps. Text cells that could be read as
            spreadsheet formulas are prefixed with an apostrophe on export (the library itself is
            never modified), and a CSV re-import keeps that apostrophe verbatim. Use .npsl
            (recommended) or .json for backup and interchange — CSV is not a substitute for it.
          </AlertDescription>
        </Alert>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            data-testid="export-npsl"
            disabled={busy !== null}
            onClick={() => void run('npsl')}
          >
            <Download aria-hidden="true" />
            Export .npsl
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="export-json"
            disabled={busy !== null}
            onClick={() => void run('json')}
          >
            <Download aria-hidden="true" />
            Export .json
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="export-csv"
            disabled={busy !== null}
            onClick={() => void run('csv')}
          >
            <Download aria-hidden="true" />
            Export .csv
          </Button>
        </div>

        {status !== null && (
          <p
            data-testid="export-status"
            role={status.kind === 'error' ? 'alert' : 'status'}
            className={status.kind === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
          >
            {status.message}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
