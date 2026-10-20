/**
 * Saved scenarios panel (phase 45).
 *
 * Renders the scenario library and collects user intent; every write goes
 * through `useScenarioLibrary` → `ScenarioRepository`. The panel never calls
 * the simulation engine and never touches storage directly.
 *
 * Accessibility: the list is a listbox of buttons (one tab stop each), every
 * action has an accessible name that names the scenario it affects, the
 * delete confirmation is an inline confirmation dialog with Escape-to-cancel
 * and focus return, and validation/feedback use role="alert" / role="status".
 */
import { useRef, useState } from 'react'
import { AlertCircle, Check, Copy, Pencil, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  normalizeScenarioName,
  type SavedScenarioSummary,
} from '@/domain/simulation/saved-scenario'
import type { SimulationDraft } from '../draft'
import type { ScenarioLibraryApi } from '../useScenarioLibrary'

export interface SavedScenariosPanelProps {
  readonly library: ScenarioLibraryApi
  /** The current editable draft (saved by Save / Save over). */
  readonly draft: SimulationDraft
  /** Replaces the editor draft after a confirmed load. */
  readonly onDraftReplaced: (draft: SimulationDraft) => void
}

const formatStamp = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`
}

export function SavedScenariosPanel({ library, draft, onDraftReplaced }: SavedScenariosPanelProps) {
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>())

  const nameInputId = 'scenario-save-name'
  const nameErrorId = 'scenario-save-name-error'

  function submitSave(): void {
    const normalized = normalizeScenarioName(name)
    if (!normalized.ok) {
      setNameError(normalized.message)
      return
    }
    setNameError(null)
    void library.saveAs(normalized.name, draft).then((ok) => {
      if (ok) setName('')
    })
  }

  function submitRename(id: string): void {
    const normalized = normalizeScenarioName(renameValue)
    if (!normalized.ok) return
    void library.rename(id, normalized.name).then((ok) => {
      if (ok) setRenamingId(null)
    })
  }

  function confirmDelete(id: string): void {
    void library.remove(id).then((ok) => {
      if (ok) {
        setConfirmingDeleteId(null)
        deleteButtonRefs.current.get(id)?.focus()
      }
    })
  }

  const { summaries, corrupt, status, feedback, busy, pending, dirty, loadedId } = library

  return (
    <section aria-labelledby="saved-scenarios-heading" className="flex flex-col gap-3" data-testid="saved-scenarios">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="saved-scenarios-heading" className="text-base font-medium">
          Saved scenarios
        </h2>
        <p className="text-xs text-muted-foreground">
          {loadedId === null
            ? 'The draft is not linked to a saved scenario.'
            : `Draft loaded from “${library.loadedName ?? loadedId}”${dirty ? ' — modified since it was saved' : ''}.`}
        </p>
      </div>

      {/* Save / save over */}
      <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
        <div className="grid min-w-48 flex-1 gap-1.5">
          <Label htmlFor={nameInputId} className="text-xs text-muted-foreground">
            Scenario name
          </Label>
          <Input
            id={nameInputId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitSave()
              }
            }}
            aria-invalid={nameError === null ? 'false' : 'true'}
            aria-describedby={nameError === null ? undefined : nameErrorId}
            data-testid="scenario-name-input"
          />
          {nameError === null ? null : (
            <p id={nameErrorId} role="alert" className="text-xs text-destructive">
              {nameError}
            </p>
          )}
        </div>
        <Button type="button" onClick={submitSave} disabled={busy} data-testid="scenario-save">
          <Save className="size-4" aria-hidden="true" />
          Save as new
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void library.saveOverCurrent(draft)}
          disabled={busy || loadedId === null}
          title={loadedId === null ? 'Load a saved scenario first' : undefined}
          data-testid="scenario-save-over"
        >
          Save over loaded
        </Button>
      </div>

      {/* Feedback */}
      {feedback === null ? null : (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'}
          className={`text-sm ${feedback.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid="scenario-feedback"
        >
          {feedback.kind === 'error' ? (
            <AlertCircle className="mr-1 inline size-4" aria-hidden="true" />
          ) : (
            <Check className="mr-1 inline size-4" aria-hidden="true" />
          )}
          {feedback.message}
        </p>
      )}

      {/* Unsaved-changes guard for loading another scenario */}
      {pending === null ? null : (
        <div
          role="alertdialog"
          aria-labelledby="scenario-load-confirm-text"
          className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3"
          data-testid="scenario-load-confirm"
          onKeyDown={(event) => {
            if (event.key === 'Escape') library.cancelPending()
          }}
        >
          <p id="scenario-load-confirm-text" className="text-sm">
            The current draft has unsaved changes. Load “{pending.name}” and discard them?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="scenario-load-confirm-accept"
              onClick={() => void library.confirmPending(onDraftReplaced)}
            >
              Discard changes and load
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="scenario-load-confirm-cancel"
              onClick={() => library.cancelPending()}
            >
              Keep editing
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      {status === 'loading' ? (
        <p className="text-sm text-muted-foreground" role="status" data-testid="scenarios-loading">
          Loading saved scenarios…
        </p>
      ) : status === 'error' ? (
        <p className="text-sm text-destructive" role="alert" data-testid="scenarios-error">
          Saved scenarios could not be read. Try again.
        </p>
      ) : summaries.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="scenarios-empty">
          No saved scenarios yet. Give the current draft a name and choose “Save as new”.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="scenario-list">
          {summaries.map((scenario) => (
            <ScenarioRow
              key={scenario.id}
              scenario={scenario}
              busy={busy}
              loaded={loadedId === scenario.id}
              renaming={renamingId === scenario.id}
              renameValue={renameValue}
              confirmingDelete={confirmingDeleteId === scenario.id}
              onLoad={() => void library.requestLoad(scenario.id, onDraftReplaced)}
              onStartRename={() => {
                setRenamingId(scenario.id)
                setRenameValue(scenario.name)
              }}
              onRenameChange={setRenameValue}
              onRenameCommit={() => submitRename(scenario.id)}
              onRenameCancel={() => setRenamingId(null)}
              onDuplicate={() => void library.duplicate(scenario.id)}
              onStartDelete={() => setConfirmingDeleteId(scenario.id)}
              onConfirmDelete={() => confirmDelete(scenario.id)}
              onCancelDelete={() => setConfirmingDeleteId(null)}
              deleteRef={(element) => {
                if (element === null) deleteButtonRefs.current.delete(scenario.id)
                else deleteButtonRefs.current.set(scenario.id, element)
              }}
            />
          ))}
        </ul>
      )}

      {/* Unreadable stored rows are reported, never offered as scenarios. */}
      {corrupt.length === 0 ? null : (
        <p className="text-xs text-destructive" role="status" data-testid="scenarios-corrupt">
          {corrupt.length} stored scenario record{corrupt.length === 1 ? '' : 's'} could not be read and{' '}
          {corrupt.length === 1 ? 'is' : 'are'} not shown. They remain in storage.
        </p>
      )}
    </section>
  )
}

interface ScenarioRowProps {
  readonly scenario: SavedScenarioSummary
  readonly busy: boolean
  readonly loaded: boolean
  readonly renaming: boolean
  readonly renameValue: string
  readonly confirmingDelete: boolean
  readonly onLoad: () => void
  readonly onStartRename: () => void
  readonly onRenameChange: (value: string) => void
  readonly onRenameCommit: () => void
  readonly onRenameCancel: () => void
  readonly onDuplicate: () => void
  readonly onStartDelete: () => void
  readonly onConfirmDelete: () => void
  readonly onCancelDelete: () => void
  readonly deleteRef: (element: HTMLButtonElement | null) => void
}

function ScenarioRow({
  scenario,
  busy,
  loaded,
  renaming,
  renameValue,
  confirmingDelete,
  onLoad,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDuplicate,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
  deleteRef,
}: ScenarioRowProps) {
  const confirmId = `scenario-delete-confirm-${scenario.id}`
  return (
    <li className="flex flex-col gap-2 p-3" data-testid={`scenario-row-${scenario.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {renaming ? (
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`rename-${scenario.id}`} className="sr-only">
                New name for {scenario.name}
              </Label>
              <Input
                id={`rename-${scenario.id}`}
                value={renameValue}
                onChange={(event) => onRenameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onRenameCommit()
                  }
                  if (event.key === 'Escape') onRenameCancel()
                }}
                className="h-8 max-w-64"
                data-testid={`rename-input-${scenario.id}`}
              />
              <Button size="sm" type="button" onClick={onRenameCommit} disabled={busy} data-testid={`rename-save-${scenario.id}`}>
                Save name
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={onRenameCancel} data-testid={`rename-cancel-${scenario.id}`}>
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <p className="truncate text-sm font-medium">
                {scenario.name}
                {loaded ? <span className="ml-2 text-xs text-muted-foreground">(loaded)</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                Modified {formatStamp(scenario.updatedAt)}
              </p>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" type="button" onClick={onLoad} disabled={busy} data-testid={`load-${scenario.id}`} aria-label={`Load “${scenario.name}”`}>
            Load
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={onStartRename} disabled={busy} data-testid={`rename-${scenario.id}`} aria-label={`Rename “${scenario.name}”`}>
            <Pencil className="size-4" aria-hidden="true" />
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={onDuplicate} disabled={busy} data-testid={`duplicate-${scenario.id}`} aria-label={`Duplicate “${scenario.name}”`}>
            <Copy className="size-4" aria-hidden="true" />
          </Button>
          <Button
            ref={deleteRef}
            size="sm"
            type="button"
            variant="ghost"
            onClick={onStartDelete}
            disabled={busy}
            data-testid={`delete-${scenario.id}`}
            aria-label={`Delete “${scenario.name}”`}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {confirmingDelete ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-destructive/40 p-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancelDelete()
          }}
          data-testid={`delete-confirm-panel-${scenario.id}`}
        >
          <p id={confirmId} className="text-sm text-destructive" data-testid={`delete-confirm-text-${scenario.id}`}>
            Delete the saved scenario “{scenario.name}” permanently? This removes only the saved copy —
            the draft currently in the editor is not affected. This cannot be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              type="button"
              variant="destructive"
              aria-describedby={confirmId}
              onClick={onConfirmDelete}
              disabled={busy}
              data-testid={`delete-confirm-${scenario.id}`}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Confirm delete
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={onCancelDelete} disabled={busy} data-testid={`delete-cancel-${scenario.id}`}>
              <X className="size-4" aria-hidden="true" />
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
