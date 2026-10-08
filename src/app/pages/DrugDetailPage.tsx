import { useParams } from 'react-router-dom'
import { PageHeader } from '@/app/layout/PageHeader'
import { DrugDetailView } from '@/features/drug-library/DrugDetailView'

export function DrugDetailPage() {
  const { drugId } = useParams<{ drugId: string }>()

  return (
    <PageHeader
      title="Drug Detail"
      description="Overview, pharmacokinetics, targets and provenance for a single drug record."
    >
      <DrugDetailView drugId={drugId ?? ''} />
    </PageHeader>
  )
}
