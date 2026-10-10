import { PageHeader } from '@/app/layout/PageHeader'
import { DataSourcesView } from '@/features/data-sources'

/**
 * Data sources: search PubChem/ChEMBL on demand, preview and confirm every
 * import, and promote individual stored measurements onto model
 * parameters with full provenance.
 */
export function DataSourcesPage() {
  return (
    <PageHeader
      title="Data Sources"
      description="Search external compound databases on demand, review every record before importing, and choose explicitly which measurement supplies each model parameter. Nothing is downloaded automatically."
    >
      <DataSourcesView />
    </PageHeader>
  )
}
