/**
 * Session state for the experimental-dataset page (phase 47A).
 *
 * Owns the saved-dataset list, selection, busy/feedback state and the small
 * set of write intents. Every persistence action goes through the injected
 * `ExperimentalDatasetRepository`; components never touch Dexie. Imports are
 * committed only when this hook's `importDataset` is called after an explicit
 * preview confirmation.
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  ExperimentalDataset,
  ExperimentalDatasetInput,
  ExperimentalDatasetSummary,
} from '@/domain/experiments/experimental-dataset'
import type {
  CorruptExperimentalDataset,
  ExperimentalDatasetRepository,
} from '@/data/repositories/experimentalDatasetRepository'

export interface DatasetFeedback {
  readonly kind: 'success' | 'error'
  readonly message: string
}

export type DatasetListStatus = 'loading' | 'ready' | 'error'

export interface DatasetLibraryApi {
  readonly status: DatasetListStatus
  readonly summaries: readonly ExperimentalDatasetSummary[]
  readonly corrupt: readonly CorruptExperimentalDataset[]
  readonly selected: ExperimentalDataset | null
  readonly busy: boolean
  readonly feedback: DatasetFeedback | null
  refresh(): Promise<void>
  select(id: string): Promise<void>
  clearSelection(): void
  importDataset(input: ExperimentalDatasetInput): Promise<ExperimentalDataset | null>
  rename(id: string, name: string, expectedUpdatedAt: string): Promise<boolean>
  remove(id: string, expectedUpdatedAt: string): Promise<boolean>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useExperimentalDatasetLibrary(
  repository: ExperimentalDatasetRepository,
): DatasetLibraryApi {
  const [status, setStatus] = useState<DatasetListStatus>('loading')
  const [summaries, setSummaries] = useState<readonly ExperimentalDatasetSummary[]>([])
  const [corrupt, setCorrupt] = useState<readonly CorruptExperimentalDataset[]>([])
  const [selected, setSelected] = useState<ExperimentalDataset | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<DatasetFeedback | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await repository.list()
      setSummaries(result.datasets)
      setCorrupt(result.corrupt)
      setStatus('ready')
    } catch (error) {
      setStatus('error')
      setFeedback({
        kind: 'error',
        message: `Saved datasets could not be read: ${messageOf(error)}`,
      })
    }
  }, [repository])

  useEffect(() => {
    let active = true
    repository
      .list()
      .then((result) => {
        if (!active) return
        setSummaries(result.datasets)
        setCorrupt(result.corrupt)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        setStatus('error')
        setFeedback({
          kind: 'error',
          message: `Saved datasets could not be read: ${messageOf(error)}`,
        })
      })
    return () => {
      active = false
    }
  }, [repository])

  const select = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true)
      try {
        const outcome = await repository.get(id)
        if (!outcome.ok) {
          setFeedback({ kind: 'error', message: outcome.message })
          if (outcome.code === 'NOT_FOUND') {
            setSelected(null)
            await refresh()
          }
          return
        }
        setSelected(outcome.dataset)
      } catch (error) {
        setFeedback({
          kind: 'error',
          message: `The dataset could not be loaded: ${messageOf(error)}`,
        })
      } finally {
        setBusy(false)
      }
    },
    [repository, refresh],
  )

  const clearSelection = useCallback((): void => {
    setSelected(null)
  }, [])

  const importDataset = useCallback(
    async (input: ExperimentalDatasetInput): Promise<ExperimentalDataset | null> => {
      setBusy(true)
      try {
        const outcome = await repository.create(input)
        if (!outcome.ok) {
          setFeedback({ kind: 'error', message: outcome.message })
          return null
        }
        setFeedback({
          kind: 'success',
          message: `Imported "${outcome.dataset.name}" with ${outcome.dataset.measurements.length} measurement${outcome.dataset.measurements.length === 1 ? '' : 's'}.`,
        })
        setSelected(outcome.dataset)
        await refresh()
        return outcome.dataset
      } catch (error) {
        setFeedback({
          kind: 'error',
          message: `The dataset could not be imported: ${messageOf(error)}`,
        })
        return null
      } finally {
        setBusy(false)
      }
    },
    [repository, refresh],
  )

  const rename = useCallback(
    async (id: string, name: string, expectedUpdatedAt: string): Promise<boolean> => {
      setBusy(true)
      try {
        const outcome = await repository.update(id, { name }, expectedUpdatedAt)
        if (!outcome.ok) {
          setFeedback({ kind: 'error', message: outcome.message })
          return false
        }
        setSelected(outcome.dataset)
        setFeedback({ kind: 'success', message: `Renamed to "${outcome.dataset.name}".` })
        await refresh()
        return true
      } catch (error) {
        setFeedback({ kind: 'error', message: `The dataset could not be renamed: ${messageOf(error)}` })
        return false
      } finally {
        setBusy(false)
      }
    },
    [repository, refresh],
  )

  const remove = useCallback(
    async (id: string, expectedUpdatedAt: string): Promise<boolean> => {
      setBusy(true)
      try {
        const outcome = await repository.delete(id, expectedUpdatedAt)
        if (!outcome.ok) {
          setFeedback({ kind: 'error', message: outcome.message })
          return false
        }
        setSelected((current) => (current?.id === id ? null : current))
        setFeedback({ kind: 'success', message: 'Dataset deleted.' })
        await refresh()
        return true
      } catch (error) {
        setFeedback({ kind: 'error', message: `The dataset could not be deleted: ${messageOf(error)}` })
        return false
      } finally {
        setBusy(false)
      }
    },
    [repository, refresh],
  )

  return {
    status,
    summaries,
    corrupt,
    selected,
    busy,
    feedback,
    refresh,
    select,
    clearSelection,
    importDataset,
    rename,
    remove,
  }
}
