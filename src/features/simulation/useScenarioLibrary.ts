/**
 * Saved-scenario session state (phase 45).
 *
 * Orchestrates the saved-scenario WORKFLOW for the simulation page: the list,
 * the loaded record, busy/feedback state and the unsaved-changes guard. It
 * performs no persistence itself (every write goes through the injected
 * `ScenarioRepository`) and never touches the simulation engine: persisting,
 * loading, renaming, duplicating, deleting or refreshing are data-management
 * actions, not simulation requests.
 *
 * Identity: scenarios are addressed by `id` only; names are display text.
 *
 * Dirty tracking: the draft is compared to a deterministic JSON snapshot of
 * the draft that was loaded or last saved. Object identity is never used,
 * because every edit produces a new object.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SavedScenarioSummary } from '@/domain/simulation/saved-scenario'
import type { ScenarioRepository } from '@/data/repositories/scenarioRepository'
import type { SimulationDraft } from './draft'

export interface ScenarioFeedback {
  readonly kind: 'success' | 'error'
  readonly message: string
}

export type ScenarioListStatus = 'idle' | 'loading' | 'ready' | 'error'

/** A draft-replacing action that is waiting for confirmation. */
export interface PendingLoad {
  readonly id: string
  readonly name: string
}

export interface ScenarioLibraryState {
  readonly status: ScenarioListStatus
  readonly summaries: readonly SavedScenarioSummary[]
  readonly corrupt: readonly { readonly id: string; readonly message: string }[]
  /** The saved record the current draft came from, when any. */
  readonly loadedId: string | null
  readonly loadedName: string | null
  /** True when the draft differs from the loaded/saved snapshot. */
  readonly dirty: boolean
  /** A load waiting for the user to confirm discarding edits. */
  readonly pending: PendingLoad | null
  readonly busy: boolean
  readonly feedback: ScenarioFeedback | null
}

export interface ScenarioLibraryApi extends ScenarioLibraryState {
  refresh(): Promise<void>
  /** Save the current draft as a NEW record; never overwrites an existing one. */
  saveAs(name: string, draft: SimulationDraft): Promise<boolean>
  /** Save the current draft over the loaded record (by id). */
  saveOverCurrent(draft: SimulationDraft): Promise<boolean>
  /**
   * Load a saved record by id. With unsaved edits the request is parked in
   * `pending` instead; the draft is never replaced without confirmation.
   */
  requestLoad(id: string, apply: (draft: SimulationDraft) => void): Promise<void>
  confirmPending(apply: (draft: SimulationDraft) => void): Promise<void>
  cancelPending(): void
  rename(id: string, name: string): Promise<boolean>
  duplicate(id: string): Promise<boolean>
  remove(id: string): Promise<boolean>
  /** Restart dirty tracking from `draft` (after load/reset/save). */
  markBaseline(draft: SimulationDraft): void
  /** Called by the view whenever the draft changes. */
  syncDirty(draft: SimulationDraft): void
}

/** Deterministic draft snapshot used for dirty comparison (never identity). */
export function draftSnapshot(draft: SimulationDraft): string {
  return JSON.stringify(draft)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useScenarioLibrary(repository: ScenarioRepository): ScenarioLibraryApi {
  // The list starts in 'loading': the mount effect performs the first read,
  // and until it resolves the library is unknown — never a confirmed empty
  // library (the panel would otherwise flash "no saved scenarios yet").
  const [status, setStatus] = useState<ScenarioListStatus>('loading')
  const [summaries, setSummaries] = useState<readonly SavedScenarioSummary[]>([])
  const [corrupt, setCorrupt] = useState<readonly { id: string; message: string }[]>([])
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [loadedName, setLoadedName] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<PendingLoad | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<ScenarioFeedback | null>(null)
  const baseline = useRef<string | null>(null)
  /** First draft observed in this session (the editor's seed), for a draft
   *  that was never loaded from or saved as a scenario. */
  const initialSnapshot = useRef<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    // No synchronous setState here: the initial status already renders as
    // "loading", and later refreshes keep the previous list visible until the
    // new one arrives (only the resolved status changes).
    try {
      const result = await repository.list()
      setSummaries(result.scenarios)
      setCorrupt(result.corrupt)
      setStatus('ready')
    } catch (error) {
      setStatus('error')
      setFeedback({ kind: 'error', message: `Saved scenarios could not be read: ${messageOf(error)}` })
    }
  }, [repository])

  // Load the list once on mount. This is a read; it never simulates. It is
  // written as a direct repository call (not the `refresh` callback) because
  // the result arrives asynchronously: the rule against synchronous setState
  // in an effect is about cascading renders, which this avoids by construction.
  useEffect(() => {
    let active = true
    repository
      .list()
      .then((result) => {
        if (!active) return
        setSummaries(result.scenarios)
        setCorrupt(result.corrupt)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        setStatus('error')
        setFeedback({ kind: 'error', message: `Saved scenarios could not be read: ${messageOf(error)}` })
      })
    return () => {
      active = false
    }
  }, [repository])

  const markBaseline = useCallback((draft: SimulationDraft): void => {
    baseline.current = draftSnapshot(draft)
    setDirty(false)
  }, [])

  /**
   * Dirty = the draft differs from the loaded/saved snapshot.
   *
   * A draft with NO baseline (a fresh page, or a draft never loaded from or
   * saved as a scenario) counts as unsaved once it moves away from the value
   * it was first seen at: the editor seeds the synthetic example on mount, and
   * any later change is the user's own work that a load would destroy. The
   * first observation therefore records the seed snapshot rather than
   * silently treating an edited, never-saved draft as clean.
   */
  const syncDirty = useCallback((draft: SimulationDraft): void => {
    const snapshot = draftSnapshot(draft)
    if (baseline.current === null) {
      baseline.current = initialSnapshot.current
      initialSnapshot.current ??= snapshot
      baseline.current ??= snapshot
    }
    setDirty(baseline.current !== snapshot)
  }, [])

  /**
   * Run one repository operation with busy state, feedback and a list refresh.
   *
   * Generic over the successful value: an operation that creates a record can
   * hand its exact identity back to the caller instead of forcing the caller
   * to rediscover it (e.g. by display name) from the refreshed list.
   */
  const runOperation = useCallback(
    async <T>(
      success: string,
      operation: () => Promise<
        | { readonly ok: true; readonly value: T }
        | { readonly ok: false; readonly message?: string }
      >,
    ): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> => {
      setBusy(true)
      try {
        const outcome = await operation()
        if (!outcome.ok) {
          setFeedback({ kind: 'error', message: outcome.message ?? 'The operation failed.' })
          return { ok: false }
        }
        setFeedback({ kind: 'success', message: success })
        await refresh()
        return outcome
      } catch (error) {
        setFeedback({ kind: 'error', message: `The operation failed: ${messageOf(error)}` })
        return { ok: false }
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  const saveAs = useCallback(
    async (name: string, draft: SimulationDraft): Promise<boolean> => {
      const displayed = name.trim()
      const saved = await runOperation(`Saved as “${displayed}”.`, async () => {
        const outcome = await repository.create(name, draft)
        // The created record carries its own id: that identity is the result
        // of the operation, never something to rediscover by display name
        // (duplicate names are allowed, so a name lookup would be ambiguous).
        return outcome.ok
          ? { ok: true as const, value: { id: outcome.scenario.id, name: outcome.scenario.name } }
          : { ok: false as const, message: outcome.message }
      })
      if (!saved.ok) return false
      // Adopt the EXACT record this create produced; the list refresh inside
      // runOperation already updated the displayed summaries.
      setLoadedId(saved.value.id)
      setLoadedName(saved.value.name)
      markBaseline(draft)
      return true
    },
    [repository, runOperation, markBaseline],
  )

  const saveOverCurrent = useCallback(
    async (draft: SimulationDraft): Promise<boolean> => {
      if (loadedId === null) {
        setFeedback({ kind: 'error', message: 'No saved scenario is loaded.' })
        return false
      }
      const saved = await runOperation('Saved changes to the saved scenario.', async () => {
        const outcome = await repository.saveOver(loadedId, draft)
        return outcome.ok ? { ok: true as const, value: null } : { ok: false as const, message: outcome.message }
      })
      if (saved.ok) markBaseline(draft)
      return saved.ok
    },
    [repository, runOperation, markBaseline, loadedId],
  )

  const loadNow = useCallback(
    async (id: string, apply: (draft: SimulationDraft) => void): Promise<void> => {
      setBusy(true)
      try {
        const outcome = await repository.get(id)
        if (!outcome.ok) {
          setFeedback({ kind: 'error', message: outcome.message })
          return
        }
        apply(outcome.scenario.draft)
        setLoadedId(outcome.scenario.id)
        setLoadedName(outcome.scenario.name)
        markBaseline(outcome.scenario.draft)
        setFeedback({ kind: 'success', message: `Loaded “${outcome.scenario.name}”.` })
      } catch (error) {
        setFeedback({ kind: 'error', message: `The scenario could not be loaded: ${messageOf(error)}` })
      } finally {
        setBusy(false)
      }
    },
    [repository, markBaseline],
  )

  const requestLoad = useCallback(
    async (id: string, apply: (draft: SimulationDraft) => void): Promise<void> => {
      const summary = summaries.find((row) => row.id === id)
      if (dirty) {
        setPending({ id, name: summary?.name ?? id })
        return
      }
      await loadNow(id, apply)
    },
    [dirty, summaries, loadNow],
  )

  const confirmPending = useCallback(
    async (apply: (draft: SimulationDraft) => void): Promise<void> => {
      const action = pending
      if (action === null) return
      setPending(null)
      await loadNow(action.id, apply)
    },
    [pending, loadNow],
  )

  const cancelPending = useCallback((): void => {
    setPending(null)
    setFeedback(null)
  }, [])

  const rename = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      const displayed = name.trim()
      const renamed = await runOperation(`Renamed to “${displayed}”.`, async () => {
        const outcome = await repository.rename(id, name)
        return outcome.ok
          ? { ok: true as const, value: { id: outcome.scenario.id } }
          : { ok: false as const, message: outcome.message }
      })
      if (renamed.ok && loadedId === id) setLoadedName(displayed)
      return renamed.ok
    },
    [repository, runOperation, loadedId],
  )

  const duplicate = useCallback(
    (id: string): Promise<boolean> =>
      runOperation('Duplicated the saved scenario.', async () => {
        const outcome = await repository.duplicate(id)
        return outcome.ok ? { ok: true as const, value: null } : { ok: false as const, message: outcome.message }
      }).then((result) => result.ok),
    [repository, runOperation],
  )

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const removed = await runOperation('Deleted the saved scenario.', async () => {
        const outcome = await repository.delete(id)
        return outcome.ok ? { ok: true as const, value: null } : { ok: false as const, message: outcome.message }
      })
      if (removed.ok && loadedId === id) {
        setLoadedId(null)
        setLoadedName(null)
      }
      return removed.ok
    },
    [repository, runOperation, loadedId],
  )

  return useMemo(
    () => ({
      status,
      summaries,
      corrupt,
      loadedId,
      loadedName,
      dirty,
      pending,
      busy,
      feedback,
      refresh,
      saveAs,
      saveOverCurrent,
      requestLoad,
      confirmPending,
      cancelPending,
      rename,
      duplicate,
      remove,
      markBaseline,
      syncDirty,
    }),
    [
      status,
      summaries,
      corrupt,
      loadedId,
      loadedName,
      dirty,
      pending,
      busy,
      feedback,
      refresh,
      saveAs,
      saveOverCurrent,
      requestLoad,
      confirmPending,
      cancelPending,
      rename,
      duplicate,
      remove,
      markBaseline,
      syncDirty,
    ],
  )
}
