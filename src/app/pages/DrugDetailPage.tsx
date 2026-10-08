import { useParams } from 'react-router-dom'
import { PageHeader } from '@/app/layout/PageHeader'

export function DrugDetailPage() {
  const { drugId } = useParams<{ drugId: string }>()

  return (
    <PageHeader
      title="Drug Detail"
      description="Overview, pharmacokinetics, targets and provenance for a single drug record."
    >
      <p className="text-sm text-muted-foreground">Record id: {drugId ?? 'unknown'}</p>
    </PageHeader>
  )
}
