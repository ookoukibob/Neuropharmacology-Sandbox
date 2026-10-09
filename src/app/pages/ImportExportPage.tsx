import { PageHeader } from '@/app/layout/PageHeader'
import { ImportExportView } from '@/features/import-export'

/**
 * Import / Export: NPSL/JSON import with preview + confirmation, explicit
 * CSV column mapping, and full-library NPSL/JSON/CSV downloads.
 */
export function ImportExportPage() {
  return (
    <PageHeader
      title="Import / Export"
      description="Validate and preview imports before anything is written; export the complete library while preserving provenance."
    >
      <ImportExportView />
    </PageHeader>
  )
}
