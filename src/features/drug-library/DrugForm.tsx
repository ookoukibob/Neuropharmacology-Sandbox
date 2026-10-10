/**
 * Create/edit form for drug records — minimal by design (phase 3): name,
 * synonyms, tags, notes, and target rows with an explicit parameter kind,
 * value and unit. No PK editing (read-only), no provenance editing.
 *
 * Scientific editing safeguards:
 * - explicit units: the unit select starts empty; a parameter cannot be
 *   saved without choosing a molar-concentration unit from the catalog;
 * - validated numbers: values must parse to a finite, non-negative number;
 * - one provenance policy: an existing parameter keeps its complete stored
 *   provenance when it is unchanged (same stable target id and kind,
 *   `Object.is`-equal parsed value, identical unit) — written back as the
 *   same object, never rebuilt or mutated; every new or changed parameter
 *   is stamped `{ type: 'user', recordedAt }` at submit. The form cannot
 *   create or upgrade any provenance, and existing provenance is never
 *   edited;
 * - duplicate target names or duplicate parameter kinds in one target are
 *   rejected before anything reaches the repository;
 * - preserved target metadata: the supported target-level fields this form
 *   cannot edit (`gene`, `action`, `species`, `notes`) are reattached from
 *   the stored record by stable target id at submit — the same identity
 *   basis as provenance — so an unrelated edit never silently deletes them,
 *   and fields the record never had stay absent (nothing is filled in or
 *   synthesized);
 * - preserved identifier metadata: the recognized identifier fields this
 *   form cannot edit (`description`, `casNumber`) are reattached from the
 *   stored record at submit (data-integrity audit DI-01). `name` and
 *   `synonyms` keep coming from form state; a stored-only field keeps its
 *   exact stored value when present and stays absent — omitted, never an
 *   explicit `undefined` — when the record never had it;
 * - preserved untouched fields (data-integrity audit DI-03): synonyms,
 *   tags, name and top-level notes submit the stored source value
 *   verbatim whenever their draft text is still the mount-time baseline,
 *   so embedded commas, duplicate entries and edge whitespace in a field
 *   the user never touched survive an unrelated edit. Only a field the
 *   user actually changed follows the established policy — lists are
 *   comma-split, trimmed and de-duplicated (`splitList`), name and notes
 *   are trimmed — and the comma-delimited inputs cannot represent an
 *   individual list entry containing a comma once that list is edited
 *   (documented limitation; no escaping syntax exists).
 */
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { Drug, ReceptorTarget } from '@/domain/drug/drug'
import type { ScientificValue } from '@/domain/pharmacology/scientific-value'
import { unitCatalog } from '@/domain/pharmacology/unit-catalog'
import type { DrugInput, TargetInput } from '@/data/repositories/repository'

const PARAM_KINDS = [
  { value: 'kd', label: 'Kd' },
  { value: 'ki', label: 'Ki' },
  { value: 'ec50', label: 'EC50' },
  { value: 'ic50', label: 'IC50' },
] as const

type ParamKind = (typeof PARAM_KINDS)[number]['value']

const MOLAR_UNITS: readonly string[] = unitCatalog
  .unitsOfDimension('molar-concentration')
  .map((unit) => unit.symbol)

function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ]
}

interface ParamDraft {
  kind: '' | ParamKind
  value: string
  unit: string
}

/**
 * One validation failure: the exact message shown in the summary plus the
 * ids of the controls it belongs to, so each message can be announced with
 * the relevant field (`aria-describedby`) and flagged (`aria-invalid`).
 */
interface FormError {
  readonly message: string
  readonly fieldIds: readonly string[]
}

interface TargetDraft {
  /** React list key (UI-only — never stored). */
  key: number
  /**
   * Domain identity — present only for rows loaded from an existing record.
   * The draft holds only what the form edits plus this stable id; stored-
   * only data (parameter provenance, target-level metadata) is resolved
   * from the record at submit time by that id — see `storedProvenance` and
   * `storedTargetMetadata`.
   */
  id?: string
  name: string
  params: ParamDraft[]
}

function draftsFromDrug(drug: Drug): TargetDraft[] {
  let key = 0
  return drug.targets.map((target) => {
    key += 1
    const params: ParamDraft[] = []
    for (const kind of ['kd', 'ki', 'ec50', 'ic50'] as const) {
      const value = target[kind]
      if (value !== undefined) {
        params.push({ kind, value: String(value.value), unit: value.unit })
      }
    }
    return target.id !== undefined
      ? { key, id: target.id, name: target.name, params }
      : { key, name: target.name, params }
  })
}

/**
 * Stored parameter provenance for edit mode, keyed by stable target id and
 * then parameter kind — the identity basis of the preservation rule below.
 * Never matched by name, array position or rendering order. A target
 * without a stored id cannot establish identity, so it is deliberately
 * absent: its parameters fall back to user-entry stamping.
 */
function storedProvenance(drug: Drug | undefined): Map<string, Map<ParamKind, ScientificValue>> {
  const byTarget = new Map<string, Map<ParamKind, ScientificValue>>()
  if (drug === undefined) return byTarget
  for (const target of drug.targets) {
    if (target.id === undefined) continue
    const byKind = new Map<ParamKind, ScientificValue>()
    for (const kind of ['kd', 'ki', 'ec50', 'ic50'] as const) {
      const value = target[kind]
      if (value !== undefined) byKind.set(kind, value)
    }
    byTarget.set(target.id, byKind)
  }
  return byTarget
}

/** Target-level fields the form preserves but has no editing control for. */
type TargetMetadata = Pick<ReceptorTarget, 'gene' | 'action' | 'species' | 'notes'>

/**
 * Supported target-level metadata for edit mode, keyed by stable target id
 * — the same identity basis as `storedProvenance`, never array position or
 * display name: removing a row shifts positions and names are editable, so
 * neither may decide which stored `gene` / `action` / `species` / `notes`
 * belongs to which target. A target without a stored id cannot establish
 * identity, so it is deliberately absent — the form never guesses which
 * original target a row represents (the repository assigns a fresh id to
 * rows that arrive without one). Each entry carries only the fields the
 * record actually has; nothing is defaulted or synthesized, so absent
 * metadata stays absent.
 */
function storedTargetMetadata(drug: Drug | undefined): Map<string, TargetMetadata> {
  const byTarget = new Map<string, TargetMetadata>()
  if (drug === undefined) return byTarget
  for (const target of drug.targets) {
    if (target.id === undefined) continue
    byTarget.set(target.id, {
      ...(target.gene !== undefined ? { gene: target.gene } : {}),
      ...(target.action !== undefined ? { action: target.action } : {}),
      ...(target.species !== undefined ? { species: target.species } : {}),
      ...(target.notes !== undefined ? { notes: target.notes } : {}),
    })
  }
  return byTarget
}

function validate(
  name: string,
  targets: readonly TargetDraft[],
): { errors: FormError[]; cleaned: TargetDraft[] } {
  const errors: FormError[] = []
  const trimmedName = name.trim()
  if (trimmedName.length === 0) {
    errors.push({ message: 'Name is required.', fieldIds: ['drug-name'] })
  }

  const cleaned: TargetDraft[] = []
  const seenNames = new Set<string>()
  targets.forEach((target, index) => {
    const label = `Target ${index + 1}`
    const targetName = target.name.trim()
    if (targetName.length === 0) {
      // A fully blank row is ignored; a row with parameters but no name is an error.
      if (target.params.some((p) => p.kind !== '' || p.value.trim() !== '' || p.unit !== '')) {
        errors.push({
          message: `${label}: name is required when parameters are entered.`,
          fieldIds: [`target-name-${target.key}`],
        })
      }
      return
    }
    const nameKey = targetName.toLowerCase()
    if (seenNames.has(nameKey)) {
      errors.push({
        message: `${label}: duplicate target name “${targetName}”.`,
        fieldIds: [`target-name-${target.key}`],
      })
      return
    }
    seenNames.add(nameKey)

    const seenKinds = new Set<ParamKind>()
    const params: ParamDraft[] = []
    target.params.forEach((param, paramIndex) => {
      const valueBlank = param.value.trim() === ''
      const unitBlank = param.unit === ''
      if (param.kind === '' && valueBlank && unitBlank) return // blank sub-row
      if (param.kind === '' || valueBlank || unitBlank) {
        const missing: string[] = []
        if (param.kind === '') missing.push(`param-kind-${target.key}-${paramIndex}`)
        if (valueBlank) missing.push(`param-value-${target.key}-${paramIndex}`)
        if (unitBlank) missing.push(`param-unit-${target.key}-${paramIndex}`)
        errors.push({
          message: `${label} (“${targetName}”): each parameter needs a kind, a value and a unit.`,
          fieldIds: missing,
        })
        return
      }
      if (seenKinds.has(param.kind)) {
        errors.push({
          message: `${label} (“${targetName}”): duplicate ${param.kind.toUpperCase()} parameter.`,
          fieldIds: [`param-kind-${target.key}-${paramIndex}`],
        })
        return
      }
      const numeric = Number(param.value.trim())
      if (!Number.isFinite(numeric)) {
        errors.push({
          message: `${label} (“${targetName}”): “${param.value}” is not a finite number.`,
          fieldIds: [`param-value-${target.key}-${paramIndex}`],
        })
        return
      }
      if (numeric < 0) {
        errors.push({
          message: `${label} (“${targetName}”): concentration values cannot be negative.`,
          fieldIds: [`param-value-${target.key}-${paramIndex}`],
        })
        return
      }
      seenKinds.add(param.kind)
      params.push({ kind: param.kind, value: param.value.trim(), unit: param.unit })
    })
    cleaned.push({ ...target, name: targetName, params })
  })

  return { errors, cleaned }
}

/**
 * Assembles the repository input from the resolved field values `submit`
 * computed (stored source verbatim for an untouched draft, the established
 * parse/trim policy for a changed one — data-integrity audit DI-03) plus
 * the reattached stored-only fields. `notes` is likewise resolved by the
 * caller: the source value verbatim (or `undefined` when the record never
 * had notes) for an untouched draft, the trim-to-`undefined`-when-blank
 * policy for an edited one.
 */
function buildInput(
  cleaned: readonly TargetDraft[],
  identifiers: { name: string; synonyms: readonly string[] },
  tags: readonly string[],
  notes: string | undefined,
  now: string,
  original: Drug | undefined,
): DrugInput {
  const stored = storedProvenance(original)
  const metadata = storedTargetMetadata(original)
  const targets: TargetInput[] = cleaned.map((row) => {
    const prior = row.id !== undefined ? stored.get(row.id) : undefined
    const meta = row.id !== undefined ? metadata.get(row.id) : undefined
    const byKind: Partial<Record<ParamKind, ScientificValue>> = {}
    for (const param of row.params) {
      if (param.kind === '') continue
      const value = Number(param.value)
      const previous = prior?.get(param.kind)
      byKind[param.kind] = {
        value,
        unit: param.unit,
        // Preservation rule: same target id + kind, `Object.is`-equal parsed
        // value and identical unit means the parameter did not change — keep
        // the complete stored provenance object (all fields, unknown
        // extension keys included) untouched. Anything else is a normal user
        // entry; the form never creates or upgrades any other provenance.
        provenance:
          previous !== undefined &&
          Object.is(previous.value, value) &&
          previous.unit === param.unit
            ? previous.provenance
            : { type: 'user', recordedAt: now },
      }
    }
    return {
      ...(row.id !== undefined ? { id: row.id } : {}),
      name: row.name,
      // Supported target-level metadata the form cannot edit: reattached
      // from the stored record by stable target id (never by position,
      // name or parameter similarity) so an unrelated edit — including a
      // row removal that shifts positions — never silently drops it. Each
      // key is emitted only when that exact stored target has it: absent
      // stays absent, present values are written back unchanged.
      ...(meta?.gene !== undefined ? { gene: meta.gene } : {}),
      ...(meta?.action !== undefined ? { action: meta.action } : {}),
      ...(meta?.species !== undefined ? { species: meta.species } : {}),
      ...(meta?.notes !== undefined ? { notes: meta.notes } : {}),
      ...(byKind.kd !== undefined ? { kd: byKind.kd } : {}),
      ...(byKind.ki !== undefined ? { ki: byKind.ki } : {}),
      ...(byKind.ec50 !== undefined ? { ec50: byKind.ec50 } : {}),
      ...(byKind.ic50 !== undefined ? { ic50: byKind.ic50 } : {}),
    }
  })

  return {
    // Editable identifier fields arrive already resolved by `submit`
    // (stored source verbatim when untouched, form state when edited);
    // the stored-only recognized fields this form cannot edit are
    // reattached from the original record — the same source-of-truth rule
    // as target metadata, keyed by the record itself. Present keeps its
    // exact stored value, absent stays absent (conditional spread, no
    // explicit `undefined`), and nothing is ever invented.
    identifiers: {
      name: identifiers.name,
      synonyms: identifiers.synonyms,
      ...(original?.identifiers.description !== undefined
        ? { description: original.identifiers.description }
        : {}),
      ...(original?.identifiers.casNumber !== undefined
        ? { casNumber: original.identifiers.casNumber }
        : {}),
    },
    tags,
    targets,
    // Resolved by `submit`: verbatim source (present stays present,
    // absent stays `undefined`) when the draft is untouched, the
    // trim-when-edited policy otherwise. The explicit-`undefined`
    // contract of `DrugChanges` is unchanged.
    notes,
  }
}

/** A pending "move focus here" request raised when a form row is removed. */
interface FocusRequest {
  readonly id: string
  readonly nonce: number
}

export function DrugForm({
  drug,
  onSave,
  onCancel,
}: {
  /** Absent = create mode. */
  drug?: Drug
  onSave: (input: DrugInput) => Promise<unknown>
  onCancel: () => void
}) {
  const editing = drug !== undefined
  const [name, setName] = useState(drug?.identifiers.name ?? '')
  const [synonyms, setSynonyms] = useState(drug?.identifiers.synonyms.join(', ') ?? '')
  const [tags, setTags] = useState(drug?.tags.join(', ') ?? '')
  const [notes, setNotes] = useState(drug?.notes ?? '')
  /**
   * Mount-time baseline for untouched-field preservation (data-integrity
   * audit DI-03): the stored source values this edit started from and
   * each field's initial draft text. `submit` decides "unchanged" by
   * comparing the *current draft string* against this exact baseline —
   * never by re-parsing it — so a comma-bearing, duplicate-carrying or
   * padded source value survives an untouched submit verbatim (the
   * comma-delimited display is potentially lossy: distinct arrays can
   * render identically), while a draft the user actually changed — even
   * one later reverted to its initial text — still follows the
   * established parse/trim policy. Captured once at mount so form
   * rerenders cannot drift it; read only inside event handlers.
   */
  const baseline = useRef(
    drug === undefined
      ? undefined
      : {
          source: {
            name: drug.identifiers.name,
            synonyms: drug.identifiers.synonyms,
            tags: drug.tags,
            notes: drug.notes,
          },
          initialDraft: {
            name: drug.identifiers.name,
            synonyms: drug.identifiers.synonyms.join(', '),
            tags: drug.tags.join(', '),
            notes: drug.notes ?? '',
          },
        },
  )
  const [targets, setTargets] = useState<TargetDraft[]>(() =>
    drug !== undefined ? draftsFromDrug(drug) : [],
  )
  const [errors, setErrors] = useState<readonly FormError[]>([])
  // Focus destination after a row is removed: the button that performed
  // the removal disappears together with its row, which would otherwise
  // drop keyboard focus back to the top of the document. The nonce keeps
  // repeated removals distinct requests even for the same control.
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)

  // After a failed submit, move focus to the first invalid control — the
  // same placement native constraint validation uses — so keyboard and
  // screen-reader users land on the field and hear its `aria-describedby`
  // message. Errors only change on submit, never per keystroke, so focus
  // is never stolen while typing.
  useEffect(() => {
    const firstId = errors[0]?.fieldIds[0]
    if (firstId !== undefined) document.getElementById(firstId)?.focus()
  }, [errors])

  useEffect(() => {
    if (focusRequest === null) return
    document.getElementById(focusRequest.id)?.focus()
  }, [focusRequest])

  /** Ask the effect above to place focus on a control after the next render. */
  function requestFocusAfterRemoval(id: string): void {
    setFocusRequest((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }))
  }

  /** `aria-describedby` value: links a control to its message(s) in the summary. */
  function describedBy(fieldId: string): string | undefined {
    const ids = errors.flatMap((error, index) =>
      error.fieldIds.includes(fieldId) ? [`drug-form-error-${index}`] : [],
    )
    return ids.length > 0 ? ids.join(' ') : undefined
  }

  function isInvalid(fieldId: string): boolean {
    return errors.some((error) => error.fieldIds.includes(fieldId))
  }

  /** Next list key derived from current rows — updaters must stay pure
   * (React StrictMode may run them twice, so a shared counter would drift). */
  function nextKeyOf(rows: readonly TargetDraft[]): number {
    return rows.reduce((max, row) => Math.max(max, row.key), 0) + 1
  }

  function updateTarget(key: number, patch: Partial<TargetDraft>): void {
    setTargets((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    )
  }

  function updateParam(key: number, index: number, patch: Partial<ParamDraft>): void {
    setTargets((rows) =>
      rows.map((row) =>
        row.key === key
          ? {
              ...row,
              params: row.params.map((param, i) =>
                i === index ? { ...param, ...patch } : param,
              ),
            }
          : row,
      ),
    )
  }

  async function submit(): Promise<void> {
    const { errors: validationErrors, cleaned } = validate(name, targets)
    if (validationErrors.length > 0) {
      setErrors(validationErrors)
      return
    }
    setErrors([])
    // Untouched-field rule (data-integrity audit DI-03): a draft still at
    // its mount-time baseline submits the stored source value verbatim —
    // embedded commas, duplicate entries, edge whitespace and the
    // present/absent distinction included. Only a field the user actually
    // changed follows the established policy (lists: `splitList`; name
    // and notes: trim). Draft-text equality — never a re-parse of the
    // display string — decides, so a draft edited and reverted to its
    // exact initial text is untouched again.
    const base = baseline.current
    const nameValue =
      base !== undefined && name === base.initialDraft.name ? base.source.name : name.trim()
    const synonymsValue =
      base !== undefined && synonyms === base.initialDraft.synonyms
        ? base.source.synonyms
        : splitList(synonyms)
    const tagsValue =
      base !== undefined && tags === base.initialDraft.tags ? base.source.tags : splitList(tags)
    const notesValue =
      base !== undefined && notes === base.initialDraft.notes
        ? base.source.notes
        : notes.trim() === ''
          ? undefined
          : notes.trim()
    const input = buildInput(
      cleaned,
      { name: nameValue, synonyms: synonymsValue },
      tagsValue,
      notesValue,
      new Date().toISOString(),
      drug,
    )
    await onSave(input)
  }

  return (
    <form
      className="space-y-4"
      data-testid="drug-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {editing ? 'Edit record' : 'New drug record'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="drug-name">Name *</Label>
            <Input
              id="drug-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={isInvalid('drug-name')}
              aria-describedby={describedBy('drug-name')}
              data-testid="drug-name"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="drug-synonyms">Synonyms (comma-separated)</Label>
            <Input
              id="drug-synonyms"
              value={synonyms}
              onChange={(e) => setSynonyms(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="drug-tags">Tags (comma-separated)</Label>
            <Input id="drug-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="drug-notes">Notes</Label>
            <Textarea
              id="drug-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle headingLevel={2} className="text-base">Targets</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            id="add-target"
            data-testid="add-target"
            onClick={() =>
              setTargets((rows) => [
                ...rows,
                { key: nextKeyOf(rows), name: '', params: [] },
              ])
            }
          >
            <Plus aria-hidden="true" className="size-4" />
            Add target
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {targets.length === 0 && (
            <p className="text-sm text-muted-foreground">No target rows yet.</p>
          )}
          {targets.map((row) => (
            <div key={row.key} className="space-y-2 rounded-md border p-3" data-testid="target-row">
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-2">
                  <Label htmlFor={`target-name-${row.key}`}>Target name *</Label>
                  <Input
                    id={`target-name-${row.key}`}
                    value={row.name}
                    onChange={(e) => updateTarget(row.key, { name: e.target.value })}
                    aria-invalid={isInvalid(`target-name-${row.key}`)}
                    aria-describedby={describedBy(`target-name-${row.key}`)}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove target ${row.name || row.key}`}
                  onClick={() => {
                    setTargets((rows) => rows.filter((r) => r.key !== row.key))
                    requestFocusAfterRemoval('add-target')
                  }}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </div>

              {row.params.map((param, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <div className="grid gap-2">
                    <Label htmlFor={`param-kind-${row.key}-${index}`}>Parameter *</Label>
                    <select
                      id={`param-kind-${row.key}-${index}`}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={param.kind}
                      aria-invalid={isInvalid(`param-kind-${row.key}-${index}`)}
                      aria-describedby={describedBy(`param-kind-${row.key}-${index}`)}
                      onChange={(e) =>
                        updateParam(row.key, index, {
                          kind: e.target.value as '' | ParamKind,
                        })
                      }
                    >
                      <option value="">Select…</option>
                      {PARAM_KINDS.map((kind) => (
                        <option key={kind.value} value={kind.value}>
                          {kind.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`param-value-${row.key}-${index}`}>Value *</Label>
                    <Input
                      id={`param-value-${row.key}-${index}`}
                      value={param.value}
                      inputMode="decimal"
                      aria-invalid={isInvalid(`param-value-${row.key}-${index}`)}
                      aria-describedby={describedBy(`param-value-${row.key}-${index}`)}
                      onChange={(e) => updateParam(row.key, index, { value: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`param-unit-${row.key}-${index}`}>Unit *</Label>
                    <select
                      id={`param-unit-${row.key}-${index}`}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={param.unit}
                      aria-invalid={isInvalid(`param-unit-${row.key}-${index}`)}
                      aria-describedby={describedBy(`param-unit-${row.key}-${index}`)}
                      onChange={(e) => updateParam(row.key, index, { unit: e.target.value })}
                    >
                      <option value="">Select…</option>
                      {MOLAR_UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove parameter"
                    onClick={() => {
                      setTargets((rows) =>
                        rows.map((r) =>
                          r.key === row.key
                            ? { ...r, params: r.params.filter((_, i) => i !== index) }
                            : r,
                        ),
                      )
                      requestFocusAfterRemoval(`add-param-${row.key}`)
                    }}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              ))}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                id={`add-param-${row.key}`}
                data-testid="add-param"
                onClick={() =>
                  setTargets((rows) =>
                    rows.map((r) =>
                      r.key === row.key
                        ? { ...r, params: [...r.params, { kind: '', value: '', unit: '' }] }
                        : r,
                    ),
                  )
                }
              >
                <Plus aria-hidden="true" className="size-4" />
                Add parameter
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {errors.length > 0 && (
        <Alert
          variant="destructive"
          id="drug-form-error-summary"
          data-testid="form-errors"
        >
          <AlertTitle>Fix before saving</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {errors.map((error, index) => (
                <li key={`error-${index}`} id={`drug-form-error-${index}`}>
                  {error.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button type="submit" data-testid="save-drug">
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} data-testid="cancel-drug">
          Cancel
        </Button>
      </div>
    </form>
  )
}
