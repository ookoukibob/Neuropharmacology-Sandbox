import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/app/layout/PageHeader'
import { useLibraryStore } from '@/app/libraryStore'
import { DrugForm, type SaveOutcome } from '@/features/drug-library/DrugForm'
import type { DrugInput } from '@/data/repositories/repository'

/** Create flow: validate in the form, persist via the repository, navigate back. */
export function DrugNewPage() {
  const navigate = useNavigate()
  const createDrug = useLibraryStore((s) => s.createDrug)

  async function handleSave(input: DrugInput): Promise<SaveOutcome> {
    const created = await createDrug(input)
    if (created !== null) {
      navigate(`/library/${created.id}`)
      return { ok: true }
    }
    // Create can never conflict (a new id has no stored state to be
    // stale against); a failure is reported back so the form shows it
    // above the preserved draft — same recovery shape as an edit save.
    return {
      ok: false,
      conflict: false,
      message: useLibraryStore.getState().error ?? 'The record could not be saved.',
    }
  }

  return (
    <PageHeader
      title="New Drug Record"
      description="Entered values are stored locally with user-entry provenance — no source is ever invented for them."
    >
      <DrugForm onCancel={() => navigate('/library')} onSave={handleSave} />
    </PageHeader>
  )
}
