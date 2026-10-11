/**
 * Stored source data panel: what is already in IndexedDB and therefore
 * usable offline, plus the two explicit promotion flows.
 *
 * Layer C (parameter application) is a one-way, provenance-preserving
 * promotion of ONE stored observation onto ONE drug parameter slot:
 * - the store enforces the rules (endpoint mapping, qualifier, unit,
 *   explicit overwrite of occupied slots, explicit acknowledgement when
 *   the observation's reported target differs from the chosen row) — this
 *   panel only collects the user's explicit choices and shows the reason
 *   when a value cannot be applied;
 * - choosing an existing target row always shows the observation's
 *   reported target next to that row, and a differing name/species
 *   requires a checkbox acknowledgement — name-only matching is never
 *   presented as established biological identity;
 * - the drug record receives the observation id (source record id, URL,
 *   retrieval time, license notice) in its provenance, so the parameter
 *   stays traceable back to the source record — including after the
 *   library is exported.
 *
 * "Add to library" creates an identity-only drug record (name, synonyms,
 * CAS) whose notes carry the full source attribution — it never invents
 * pharmacological values.
 */
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { useDataSourcesStore } from '@/app/dataSourcesStore'
import { useLibraryStore } from '@/app/libraryStore'
import type { Drug } from '../../domain/drug/drug'
import type { Compound } from '../../domain/sources/compound'
import type { ExperimentalObservation } from '../../domain/sources/observation'
import { ObservationSummary } from './ObservationSummary'
import { findTargetMismatch } from './store'

const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background px-2 text-sm'
const NEW_TARGET = '__new__'

function ActionMessages() {
  const error = useDataSourcesStore((s) => s.actionError)
  const notice = useDataSourcesStore((s) => s.actionNotice)
  const clear = useDataSourcesStore((s) => s.clearActionMessages)

  return (
    <>
      {error !== null && (
        <Alert variant="destructive" data-testid="apply-error">
          <AlertTitle>Not applied</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice !== null && (
        <Alert data-testid="apply-notice">
          <AlertTitle>Applied</AlertTitle>
          <AlertDescription>
            {notice}
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="dismiss-apply-notice"
                onClick={clear}
              >
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

/** One stored compound with its attribution and the library bridge. */
function StoredCompoundRow({ compound }: { readonly compound: Compound }) {
  const addToLibrary = useDataSourcesStore((s) => s.addToLibrary)
  const drugs = useDataSourcesStore((s) => s.stored.drugs)
  const [busy, setBusy] = useState(false)

  const name = compound.name ?? compound.sourceId
  const alreadyInLibrary = drugs.some((drug) => drug.identifiers.name === name)

  async function onAdd(): Promise<void> {
    setBusy(true)
    try {
      const created = await addToLibrary(compound.id)
      // Keep the shared drug-library session in sync with storage.
      if (created !== null) void useLibraryStore.getState().hydrate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="space-y-1 rounded-md border p-3 text-sm" data-testid="stored-compound-row">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{name}</span>
        {compound.identifiers.chemblId !== undefined && (
          <Badge variant="secondary">ChEMBL {compound.identifiers.chemblId}</Badge>
        )}
        {compound.identifiers.pubchemCid !== undefined && (
          <Badge variant="secondary">PubChem CID {compound.identifiers.pubchemCid}</Badge>
        )}
        {compound.identifiers.casNumber !== undefined && (
          <Badge variant="outline">CAS {compound.identifiers.casNumber}</Badge>
        )}
      </p>
      <p className="break-words text-xs text-muted-foreground">
        {[
          compound.identifiers.molecularFormula !== undefined
            ? `formula ${compound.identifiers.molecularFormula}`
            : null,
          compound.identifiers.molecularWeight !== undefined
            ? `MW ${compound.identifiers.molecularWeight} g/mol`
            : null,
          compound.identifiers.inchiKey !== undefined
            ? `InChIKey ${compound.identifiers.inchiKey}`
            : null,
          compound.synonyms.length > 0 ? `synonyms: ${compound.synonyms.join(', ')}` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ')}
      </p>
      <p className="break-words text-xs text-muted-foreground">
        Source:{' '}
        <a
          href={compound.provenance.url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2"
        >
          {compound.provenance.sourceName} record {compound.provenance.recordId}
        </a>{' '}
        · retrieved {compound.provenance.retrievedAt.slice(0, 10)}
        {compound.provenance.licenseNotice !== undefined
          ? ` · ${compound.provenance.licenseNotice}`
          : ''}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid={`add-to-library-${compound.id}`}
        disabled={busy || alreadyInLibrary}
        title={
          alreadyInLibrary
            ? 'A drug record with this name already exists in the library.'
            : 'Create an identity-only drug record (no pharmacological values).'
        }
        onClick={() => void onAdd()}
      >
        {alreadyInLibrary ? 'In library' : busy ? 'Adding…' : 'Add to drug library (identity only)'}
      </Button>
    </li>
  )
}

/** Explicit promotion of one observation onto one parameter slot. */
function ApplyCard({
  observation,
  onCancel,
}: {
  readonly observation: ExperimentalObservation
  readonly onCancel: () => void
}) {
  const drugs = useDataSourcesStore((s) => s.stored.drugs)
  const applyObservation = useDataSourcesStore((s) => s.applyObservation)
  const [drugId, setDrugId] = useState('')
  const [targetChoice, setTargetChoice] = useState<string>(NEW_TARGET)
  const [overwrite, setOverwrite] = useState(false)
  const [mismatchAck, setMismatchAck] = useState(false)
  const [busy, setBusy] = useState(false)

  const kind = observation.parameterKind
  const drug: Drug | undefined = drugs.find((candidate) => candidate.id === drugId)
  const target = drug?.targets.find((candidate) => candidate.id === targetChoice)
  const slotValue = kind !== undefined && target !== undefined ? target[kind] : undefined
  const occupied = slotValue !== undefined
  const namesNewTarget = observation.target.name !== undefined && observation.target.name !== ''
  const mapsToParameter = kind !== undefined
  /** Comparison (and possible mismatch) only apply to an EXISTING row. */
  const comparesRow = drugId !== '' && targetChoice !== NEW_TARGET && target !== undefined
  const mismatch =
    comparesRow && target !== undefined ? findTargetMismatch(observation, target) : null
  const reportedSpecies = observation.species ?? observation.target.organism

  async function onApply(): Promise<void> {
    if (drugId === '') return
    setBusy(true)
    try {
      const ok = await applyObservation({
        observationId: observation.id,
        drugId,
        targetId: targetChoice === NEW_TARGET ? null : targetChoice,
        overwrite,
        confirmTargetMismatch: mismatchAck,
      })
      if (ok) {
        // The parameter now lives on the drug record — keep the shared
        // library session in sync so other views show it too.
        void useLibraryStore.getState().hydrate()
        onCancel()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mt-2" data-testid="apply-card">
      <CardHeader>
        <CardTitle headingLevel={3}>Use this measurement as a model parameter</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm" data-testid="apply-observation-summary">
          {observation.endpoint} = {observation.value}
          {observation.unit === undefined ? '' : ` ${observation.unit}`} for{' '}
          {observation.compoundName ?? observation.compoundSourceId} ·{' '}
          {observation.provenance.sourceName} record {observation.provenance.recordId}
        </p>

        {!mapsToParameter && (
          <Alert variant="destructive" data-testid="apply-unmappable">
            <AlertTitle>This endpoint cannot supply a model parameter</AlertTitle>
            <AlertDescription>
              “{observation.endpoint}” does not map onto Kd, Ki, IC50 or EC50. Values are never
              substituted into a different parameter — the measurement stays stored as a record.
            </AlertDescription>
          </Alert>
        )}
        {observation.qualifier !== undefined && observation.qualifier !== '=' && (
          <Alert data-testid="apply-qualifier-note">
            <AlertTitle>Reported as a bound, not an exact value</AlertTitle>
            <AlertDescription>
              The source reports “{observation.qualifier}” (a bound such as “less than”). Only an
              exact reported value can supply a parameter, so this record cannot be applied.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2">
          <Label htmlFor="apply-drug-select">Drug record</Label>
          <select
            id="apply-drug-select"
            data-testid="apply-drug-select"
            className={SELECT_CLASS}
            value={drugId}
            disabled={busy}
            onChange={(e) => {
              setDrugId(e.target.value)
              setTargetChoice(NEW_TARGET)
              setOverwrite(false)
              setMismatchAck(false)
            }}
          >
            <option value="">Choose a drug record…</option>
            {drugs.map((drugOption) => (
              <option key={drugOption.id} value={drugOption.id}>
                {drugOption.identifiers.name}
              </option>
            ))}
          </select>
        </div>

        {drugId !== '' && (
          <div className="grid gap-2">
            <Label htmlFor="apply-target-select">Target row on that record</Label>
            <select
              id="apply-target-select"
              data-testid="apply-target-select"
              className={SELECT_CLASS}
              value={targetChoice}
              disabled={busy}
              onChange={(e) => {
                setTargetChoice(e.target.value)
                setOverwrite(false)
                setMismatchAck(false)
              }}
            >
              <option value={NEW_TARGET}>
                Create a new target from this measurement
                {namesNewTarget ? ` (“${observation.target.name}”)` : ''}
              </option>
              {drug?.targets.map((targetOption) => (
                <option key={targetOption.id} value={targetOption.id}>
                  {targetOption.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {comparesRow && target !== undefined && (
          <div
            className="space-y-1 rounded-md border p-2 text-sm"
            data-testid="apply-target-comparison"
          >
            <p className="font-medium">Compare the targets before linking</p>
            <p data-testid="apply-observation-target">
              Observation reports: “{observation.target.name ?? '(no target name reported)'}”
              {reportedSpecies !== undefined && `, species “${reportedSpecies}”`}
            </p>
            <p data-testid="apply-selected-target">
              Selected row: “{target.name}”
              {target.species !== undefined && `, species “${target.species}”`}
            </p>
            {observation.target.sourceTargetId !== undefined && (
              <p className="text-xs text-muted-foreground" data-testid="apply-observation-source-id">
                {observation.provenance.sourceName} target id: “
                {observation.target.sourceTargetId}”
                {observation.target.sourceTargetUrl !== undefined && (
                  <>
                    {' '}
                    (
                    <a
                      href={observation.target.sourceTargetUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline"
                    >
                      source target record
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                    )
                  </>
                )}
              </p>
            )}
            {target.sourceReferences !== undefined && target.sourceReferences.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="apply-stored-source-refs">
                Stored row source {target.sourceReferences.length === 1 ? 'identity' : 'identities'}
                :{' '}
                {target.sourceReferences.map((reference, index) => (
                  <span key={reference.source}>
                    {index > 0 ? ' · ' : ''}
                    {reference.sourceName} id “{reference.sourceTargetId}”
                    {reference.url !== undefined && (
                      <>
                        {' '}
                        (
                        <a
                          href={reference.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline"
                        >
                          record<span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        )
                      </>
                    )}
                  </span>
                ))}
              </p>
            )}
          </div>
        )}

        {mismatch !== null && (
          <Alert data-testid="apply-target-mismatch">
            <AlertTitle>The reported target differs from the selected row</AlertTitle>
            <AlertDescription>
              {mismatch.sourceIdConflict !== undefined && (
                <p data-testid="apply-source-id-conflict">
                  The observation identifies this target as “{mismatch.sourceIdConflict.sourceName}”
                  id “{mismatch.sourceIdConflict.observationTargetId}”, while the selected row
                  already stores “{mismatch.sourceIdConflict.sourceName}” target id “
                  {mismatch.sourceIdConflict.storedTargetId}”. Linking keeps the stored identity
                  exactly as it is — it is never overwritten or merged — and acknowledging this
                  mismatch is not proof that the two targets are the same.
                </p>
              )}
              <p>
                A differing name or species does not establish that these are the same target —
                linking them is a user judgement, and it is recorded in the parameter's
                provenance. Create a new target from the observation instead if they are not the
                same target.
              </p>
              <label
                className="mt-2 flex items-start gap-2 text-sm"
                data-testid="apply-target-mismatch-wrapper"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  data-testid="apply-target-mismatch-ack"
                  checked={mismatchAck}
                  disabled={busy}
                  onChange={(e) => setMismatchAck(e.target.checked)}
                />
                I understand these may be different targets — link this measurement to “
                {target?.name ?? ''}” anyway
              </label>
            </AlertDescription>
          </Alert>
        )}

        {occupied && kind !== undefined && slotValue !== undefined && (
          <label
            className="flex items-start gap-2 text-sm"
            data-testid="apply-overwrite-wrapper"
          >
            <input
              type="checkbox"
              className="mt-0.5"
              data-testid="apply-overwrite"
              checked={overwrite}
              disabled={busy}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            Overwrite the existing {kind.toUpperCase()} value of “{target?.name ?? ''}” (
            {slotValue.value} {slotValue.unit}) — it will be replaced, and the previous value and
            its provenance are lost from this record.
          </label>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            data-testid="apply-confirm"
            disabled={
              busy ||
              drugId === '' ||
              !mapsToParameter ||
              (observation.qualifier !== undefined && observation.qualifier !== '=') ||
              (occupied && !overwrite) ||
              (mismatch !== null && !mismatchAck) ||
              (targetChoice === NEW_TARGET && !namesNewTarget)
            }
            onClick={() => void onApply()}
          >
            {busy ? 'Applying…' : 'Apply to parameter'}
          </Button>
          <Button type="button" variant="outline" data-testid="apply-cancel" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {targetChoice === NEW_TARGET && !namesNewTarget && (
          <p className="text-xs text-muted-foreground" data-testid="apply-new-target-hint">
            This measurement reports no target name — add a target to the drug record first and
            select it above.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          The applied parameter keeps a provenance link to this observation (source name, record
          id, URL, retrieval time, license notice) — the citation stays with the drug record and
          survives exporting the library.
        </p>
      </CardContent>
    </Card>
  )
}

export function StoredDataPanel() {
  const stored = useDataSourcesStore((s) => s.stored)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const applyingObservation =
    applyingId === null
      ? undefined
      : stored.observations.find((observation) => observation.id === applyingId)

  return (
    <Card data-testid="stored-panel">
      <CardHeader>
        <CardTitle headingLevel={2}>Stored data — available offline</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p role="status" aria-live="polite" data-testid="stored-status">
          {stored.status === 'loading' && 'Reading stored records…'}
          {stored.status === 'idle' && 'Not read yet.'}
          {stored.status === 'ready' &&
            `${stored.compounds.length} compound identity record${stored.compounds.length === 1 ? '' : 's'} · ${stored.observations.length} measurement${stored.observations.length === 1 ? '' : 's'} · ${stored.drugs.length} drug record${stored.drugs.length === 1 ? '' : 's'}`}
        </p>

        {stored.status === 'error' && (
          <Alert variant="destructive" data-testid="stored-error">
            <AlertTitle>Stored records could not be read</AlertTitle>
            <AlertDescription>{stored.error}</AlertDescription>
          </Alert>
        )}

        {(stored.quarantinedCompounds > 0 || stored.quarantinedObservations > 0) && (
          <Alert variant="destructive" data-testid="stored-quarantine">
            <AlertTitle>Invalid stored rows are quarantined</AlertTitle>
            <AlertDescription>
              {stored.quarantinedCompounds} compound row
              {stored.quarantinedCompounds === 1 ? '' : 's'} and {stored.quarantinedObservations}{' '}
              measurement row{stored.quarantinedObservations === 1 ? '' : 's'} failed validation
              and were kept unchanged for recovery — they are not listed here and are never
              deleted.
            </AlertDescription>
          </Alert>
        )}

        <ActionMessages />

        {stored.status === 'ready' && (
          <div className="space-y-6">
            <section aria-labelledby="stored-compounds-heading" className="space-y-2">
              <h3 id="stored-compounds-heading" className="text-sm font-medium">
                Compound identity records
              </h3>
              {stored.compounds.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="stored-compounds-empty">
                  None stored yet — import records from a search above.
                </p>
              ) : (
                <ul className="space-y-2" data-testid="stored-compounds">
                  {stored.compounds.map((compound) => (
                    <StoredCompoundRow key={compound.id} compound={compound} />
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="stored-observations-heading" className="space-y-2">
              <h3 id="stored-observations-heading" className="text-sm font-medium">
                Measurement records
              </h3>
              {stored.observations.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="stored-observations-empty">
                  None stored yet — fetch measurements above, select rows and import them.
                </p>
              ) : (
                <ul className="space-y-2" data-testid="stored-observations">
                  {stored.observations.map((observation) => (
                    <li
                      key={observation.id}
                      className="flex items-start gap-3 rounded-md border p-3 text-sm"
                      data-testid="stored-observation-row"
                    >
                      <ObservationSummary observation={observation} />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`apply-to-parameter-${observation.id}`}
                        aria-expanded={applyingId === observation.id}
                        onClick={() =>
                          setApplyingId(applyingId === observation.id ? null : observation.id)
                        }
                      >
                        {applyingId === observation.id ? 'Close' : 'Use as parameter…'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {applyingObservation !== undefined && (
                <ApplyCard
                  observation={applyingObservation}
                  onCancel={() => setApplyingId(null)}
                />
              )}
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
