/**
 * Export panel — downloads of the COMPLETE current library.
 *
 * `.npsl` and `.json` are the same versioned NPSL envelope (UTF-8 JSON,
 * built by `toNpslDocument`/`serializeNpslDocument`): metadata, ids,
 * scientific values, units, storage origin and every supported provenance
 * field survive verbatim. `.csv` is a documented lossy projection of the
 * same library (see the always-visible warning).
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
import { libraryRepository } from '@/app/libraryStore'
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
          Exports always contain the entire current library — not a filtered or selected subset.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert data-testid="csv-lossiness">
          <AlertTitle>CSV is a lossy projection</AlertTitle>
          <AlertDescription>
            CSV flattens the library to one row per target, stores nested provenance as JSON
            strings in cells, and drops fields the current schema does not know; a CSV re-import
            re-stamps storage origin and bookkeeping timestamps. Use .npsl (recommended) or .json
            for backup and interchange — CSV is not a substitute for it.
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
