import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/app/layout/PageHeader'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useLibraryStore } from '@/app/libraryStore'
import { DrugForm } from '@/features/drug-library/DrugForm'
import type { DrugInput } from '@/data/repositories/repository'

/** Create flow: validate in the form, persist via the repository, navigate back. */
export function DrugNewPage() {
  const navigate = useNavigate()
  const createDrug = useLibraryStore((s) => s.createDrug)
  const error = useLibraryStore((s) => s.error)

  async function handleSave(input: DrugInput): Promise<void> {
    const created = await createDrug(input)
    if (created !== null) navigate(`/library/${created.id}`)
  }

  return (
    <PageHeader
      title="New Drug Record"
      description="Entered values are stored locally with user-entry provenance — no source is ever invented for them."
    >
      {error !== null && (
        <Alert variant="destructive" data-testid="create-error">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DrugForm onCancel={() => navigate('/library')} onSave={handleSave} />
    </PageHeader>
  )
}
