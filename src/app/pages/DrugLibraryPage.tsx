import { PageHeader } from '@/app/layout/PageHeader'
import { DrugLibraryView } from '@/features/drug-library/DrugLibraryView'

export function DrugLibraryPage() {
  return (
    <PageHeader
      title="Drug Library"
      description="Browse built-in, user-created and imported drug records with full provenance metadata. Records are stored locally in your browser."
    >
      <DrugLibraryView />
    </PageHeader>
  )
}
