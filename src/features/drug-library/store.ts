/**
 * Drug-library session store (ADR-17): a factory bound to a repository.
 *
 * Zustand holds *session state only* — the hydrated working set, selection,
 * UI flags and error text. IndexedDB remains the source of truth: every
 * mutation goes through the repository and re-reads the affected list, so a
 * reload re-derives the same state from storage. Nothing is cached here
 * without a matching record on disk, and no scientific value is ever
 * computed or defaulted in this layer.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { Drug, DrugId } from '../../domain/drug/drug'
import type { LibraryMetadata } from '../../domain/library/library'
import type {
  DrugChanges,
  DrugInput,
  DrugRepository,
  QuarantinedRecord,
} from '../../data/repositories/repository'

export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface LibraryState {
  readonly status: LibraryStatus
  readonly drugs: readonly Drug[]
  readonly metadata: LibraryMetadata | undefined
  /** Invalid records reported at hydration — never dropped silently. */
  readonly quarantine: readonly QuarantinedRecord[]
  readonly selectedDrugId: DrugId | null
  readonly error: string | null
  /** Simple case-insensitive name filter (no search feature). */
  readonly filter: string

  hydrate(): Promise<void>
  selectDrug(id: DrugId | null): void
  setFilter(filter: string): void
  createDrug(input: DrugInput): Promise<Drug | null>
  updateDrug(id: DrugId, changes: DrugChanges): Promise<Drug | null>
  deleteDrug(id: DrugId): Promise<boolean>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createLibraryStore(
  repo: DrugRepository,
): UseBoundStore<StoreApi<LibraryState>> {
  /** Re-read storage after a mutation so session state mirrors the DB. */
  async function refresh(set: (partial: Partial<LibraryState>) => void): Promise<void> {
    const loaded = await repo.getAllDrugs()
    const metadata = await repo.getLibraryMetadata()
    set({
      drugs: loaded.drugs,
      quarantine: loaded.quarantine,
      metadata,
      error: null,
    })
  }

  return create<LibraryState>()((set, get) => ({
    status: 'idle',
    drugs: [],
    metadata: undefined,
    quarantine: [],
    selectedDrugId: null,
    error: null,
    filter: '',

    async hydrate() {
      // In-flight guard: React StrictMode double-mounts must not race two
      // reads of the same database.
      if (get().status === 'loading') return
      set({ status: 'loading', error: null })
      try {
        await refresh(set)
        set({ status: 'ready' })
      } catch (error) {
        set({ status: 'error', error: messageOf(error) })
      }
    },

    selectDrug(id) {
      set({ selectedDrugId: id })
    },

    setFilter(filter) {
      set({ filter })
    },

    async createDrug(input) {
      try {
        const drug = await repo.createDrug(input)
        await refresh(set)
        return drug
      } catch (error) {
        set({ error: messageOf(error) })
        return null
      }
    },

    async updateDrug(id, changes) {
      try {
        const drug = await repo.updateDrug(id, changes)
        await refresh(set)
        return drug
      } catch (error) {
        set({ error: messageOf(error) })
        return null
      }
    },

    async deleteDrug(id) {
      try {
        await repo.deleteDrug(id)
        await refresh(set)
        if (get().selectedDrugId === id) set({ selectedDrugId: null })
        return true
      } catch (error) {
        set({ error: messageOf(error) })
        return false
      }
    },
  }))
}
