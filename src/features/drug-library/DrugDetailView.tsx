/**
 * Minimal drug detail view (phase 3): identifiers, target parameters with
 * explicit units + provenance badges, PK parameters (read-only), storage
 * origin, bookkeeping timestamps, and edit/delete for user-entered records.
 *
 * Editing safeguards: only `origin === 'user'` records are editable in the
 * UI (demo/imported rows are read-only views); provenance is displayed,
 * never edited — nothing here can upgrade a value's provenance.
 */
import { ArrowLeft, Pencil, Trash2, Calculator } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import type { Drug } from '@/domain/drug/drug'
import type { MaybeScientificValue } from '@/domain/pharmacology/scientific-value'
import { useLibraryStore } from '@/app/libraryStore'
import { OriginBadge } from './components/OriginBadge'
import { ProvenanceBadge } from './components/ProvenanceBadge'
import { DrugForm } from './DrugForm'

function ParameterRow({
  label,
  value,
}: {
  label: string
  value: MaybeScientificValue
}) {
  if (value === undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-20 font-medium">{label}</span>
      <span data-testid={`param-${label}`}>
        {value.value} {value.unit}
      </span>
      <ProvenanceBadge provenance={value.provenance} />
    </div>
  )
}

export function DrugDetailView({ drugId }: { drugId: string }) {
  const navigate = useNavigate()
  const status = useLibraryStore((s) => s.status)
  const drug: Drug | undefined = useLibraryStore((s) =>
    s.drugs.find((d) => d.id === drugId),
  )
  const error = useLibraryStore((s) => s.error)
  const updateDrug = useLibraryStore((s) => s.updateDrug)
  const deleteDrug = useLibraryStore((s) => s.deleteDrug)
  const [editing, setEditing] = useState(false)
  // Deletion is irreversible, so it always goes through an explicit,
  // keyboard-operable acknowledgement step instead of one stray click.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const wasConfirming = useRef(false)

  // Focus follows the acknowledgement step: into the confirmation when it
  // opens, back to the Delete button when it is cancelled (Escape or the
  // Cancel button) — never on first render, so nothing is stolen on load.
  useEffect(() => {
    if (confirmingDelete) {
      document.getElementById('delete-drug-confirm')?.focus()
    } else if (wasConfirming.current) {
      document.getElementById('delete-drug')?.focus()
    }
    wasConfirming.current = confirmingDelete
  }, [confirmingDelete])

  if (status !== 'ready') {
    return status === 'error' ? (
      <Alert variant="destructive" data-testid="detail-load-error">
        <AlertTitle>Library failed to load</AlertTitle>
        <AlertDescription>{error ?? 'unknown error'}</AlertDescription>
      </Alert>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    )
  }

  if (drug === undefined) {
    return (
      <div className="space-y-3">
        <Alert data-testid="drug-not-found">
          <AlertTitle>Record not found</AlertTitle>
          <AlertDescription>
            No stored record has id “{drugId}”. It may have been deleted.
          </AlertDescription>
        </Alert>
        <Button variant="outline" asChild>
          <Link to="/library">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back to library
          </Link>
        </Button>
      </div>
    )
  }

  if (editing) {
    return (
      <DrugForm
        drug={drug}
        onCancel={() => setEditing(false)}
        onSave={async (changes) => {
          const saved = await updateDrug(drug.id, changes)
          if (saved !== null) setEditing(false)
        }}
      />
    )
  }

  const editable = drug.origin === 'user'

  return (
    <div className="space-y-4" data-testid="drug-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link to="/library">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Library
          </Link>
        </Button>
        <OriginBadge origin={drug.origin} />
        {drug.tags.map((tag) => (
          <span key={tag} className="text-xs text-muted-foreground">
            #{tag}
          </span>
        ))}
      </div>

      <h2 className="text-xl font-semibold">{drug.identifiers.name}</h2>
      {drug.identifiers.synonyms.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Also known as: {drug.identifiers.synonyms.join(', ')}
        </p>
      )}
      {drug.identifiers.description !== undefined && (
        <p className="text-sm">{drug.identifiers.description}</p>
      )}
      {drug.identifiers.casNumber !== undefined && (
        <p className="text-sm text-muted-foreground">CAS: {drug.identifiers.casNumber}</p>
      )}

      {/* Data status badge for example/demo libraries */}
      {drug.origin === 'built-in-demo' && (
        <Badge variant="secondary" className="text-xs" data-testid="data-status-badge">
          Example data — not pharmacological information
        </Badge>
      )}

      {error !== null && (
        <Alert variant="destructive" data-testid="detail-error">
          <AlertTitle>Operation failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle headingLevel={2} className="text-base">Targets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {drug.targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No target entries.</p>
          ) : (
            drug.targets.map((target) => (
              <div key={target.id} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{target.name}</span>
                  {target.gene !== undefined && (
                    <span className="text-xs text-muted-foreground">gene {target.gene}</span>
                  )}
                  {target.species !== undefined && (
                    <span className="text-xs text-muted-foreground">species {target.species}</span>
                  )}
                  {target.action !== undefined && (
                    <Badge variant="secondary">{target.action}</Badge>
                  )}
                </div>
                <ParameterRow label="Kd" value={target.kd} />
                <ParameterRow label="Ki" value={target.ki} />
                <ParameterRow label="EC50" value={target.ec50} />
                <ParameterRow label="IC50" value={target.ic50} />
                {target.notes !== undefined && (
                  <p className="text-xs text-muted-foreground">{target.notes}</p>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle headingLevel={2} className="text-base">Pharmacokinetics (read-only)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <ParameterRow label="Half-life" value={drug.pharmacokinetics.halfLife} />
          <ParameterRow label="Clearance" value={drug.pharmacokinetics.clearance} />
          <ParameterRow label="Vd" value={drug.pharmacokinetics.volumeOfDistribution} />
          <ParameterRow label="F" value={drug.pharmacokinetics.bioavailability} />
          {drug.pharmacokinetics.halfLife === undefined &&
            drug.pharmacokinetics.clearance === undefined &&
            drug.pharmacokinetics.volumeOfDistribution === undefined &&
            drug.pharmacokinetics.bioavailability === undefined && (
              <p className="text-sm text-muted-foreground">No PK parameters stored.</p>
            )}
        </CardContent>
      </Card>

      {drug.notes !== undefined && (
        <p className="text-sm whitespace-pre-wrap">{drug.notes}</p>
      )}

      <Separator />
      <p className="text-xs text-muted-foreground">
        Created {drug.createdAt ?? 'unknown'} · Updated {drug.updatedAt ?? 'unknown'} · Record id{' '}
        {drug.id}
      </p>

      <div className="flex flex-wrap gap-2">
        {editable ? (
          <>
            {confirmingDelete ? (
              <>
                <p
                  id="delete-confirm-text"
                  className="flex items-center text-sm text-destructive"
                  data-testid="delete-confirm-text"
                >
                  Delete “{drug.identifiers.name}” permanently? This cannot be undone.
                </p>
                <div
                  className="flex gap-2"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setConfirmingDelete(false)
                  }}
                >
                  <Button
                    variant="destructive"
                    id="delete-drug-confirm"
                    data-testid="delete-drug-confirm"
                    aria-describedby="delete-confirm-text"
                    onClick={async () => {
                      const done = await deleteDrug(drug.id)
                      if (done) navigate('/library')
                    }}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    Confirm delete
                  </Button>
                  <Button
                    variant="outline"
                    id="delete-drug-cancel"
                    data-testid="delete-drug-cancel"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setEditing(true)}
                  data-testid="edit-drug"
                >
                  <Pencil aria-hidden="true" className="size-4" />
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  id="delete-drug"
                  data-testid="delete-drug"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  Delete
                </Button>
              </>
            )}
            <Button asChild data-testid="calculate-from-detail">
              <Link to={`/calculator?drug=${drug.id}`}>
                <Calculator className="size-4" aria-hidden="true" />
                Calculate
              </Link>
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground" data-testid="readonly-note">
              This record's storage origin ("{drug.origin}") is read-only in the UI — edits are
              limited to records you entered.
            </p>
            <Button asChild data-testid="calculate-from-detail">
              <Link to={`/calculator?drug=${drug.id}`}>
                <Calculator className="size-4" aria-hidden="true" />
                Calculate
              </Link>
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
