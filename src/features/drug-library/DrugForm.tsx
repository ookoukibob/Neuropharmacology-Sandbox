/**
 * Create/edit form for drug records — minimal by design (phase 3): name,
 * synonyms, tags, notes, and target rows with an explicit parameter kind,
 * value and unit. No PK editing (read-only), no provenance editing.
 *
 * Scientific editing safeguards:
 * - explicit units: the unit select starts empty; a parameter cannot be
 *   saved without choosing a molar-concentration unit from the catalog;
 * - validated numbers: values must parse to a finite, non-negative number;
 * - one provenance policy: every stored parameter is stamped
 *   `{ type: 'user', recordedAt }` at submit — the form cannot create or
 *   upgrade any other provenance, and existing provenance is never edited;
 * - duplicate target names or duplicate parameter kinds in one target are
 *   rejected before anything reaches the repository.
 */
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { Drug } from '@/domain/drug/drug'
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

interface TargetDraft {
  /** React list key (UI-only — never stored). */
  key: number
  /** Domain identity — present only for rows loaded from an existing record. */
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

function validate(
  name: string,
  targets: readonly TargetDraft[],
): { errors: string[]; cleaned: TargetDraft[] } {
  const errors: string[] = []
  const trimmedName = name.trim()
  if (trimmedName.length === 0) errors.push('Name is required.')

  const cleaned: TargetDraft[] = []
  const seenNames = new Set<string>()
  targets.forEach((target, index) => {
    const label = `Target ${index + 1}`
    const targetName = target.name.trim()
    if (targetName.length === 0) {
      // A fully blank row is ignored; a row with parameters but no name is an error.
      if (target.params.some((p) => p.kind !== '' || p.value.trim() !== '' || p.unit !== '')) {
        errors.push(`${label}: name is required when parameters are entered.`)
      }
      return
    }
    const nameKey = targetName.toLowerCase()
    if (seenNames.has(nameKey)) {
      errors.push(`${label}: duplicate target name “${targetName}”.`)
      return
    }
    seenNames.add(nameKey)

    const seenKinds = new Set<ParamKind>()
    const params: ParamDraft[] = []
    for (const param of target.params) {
      const valueBlank = param.value.trim() === ''
      const unitBlank = param.unit === ''
      if (param.kind === '' && valueBlank && unitBlank) continue // blank sub-row
      if (param.kind === '' || valueBlank || unitBlank) {
        errors.push(
          `${label} (“${targetName}”): each parameter needs a kind, a value and a unit.`,
        )
        continue
      }
      if (seenKinds.has(param.kind)) {
        errors.push(`${label} (“${targetName}”): duplicate ${param.kind.toUpperCase()} parameter.`)
        continue
      }
      const numeric = Number(param.value.trim())
      if (!Number.isFinite(numeric)) {
        errors.push(`${label} (“${targetName}”): “${param.value}” is not a finite number.`)
        continue
      }
      if (numeric < 0) {
        errors.push(`${label} (“${targetName}”): concentration values cannot be negative.`)
        continue
      }
      seenKinds.add(param.kind)
      params.push({ kind: param.kind, value: param.value.trim(), unit: param.unit })
    }
    cleaned.push({ ...target, name: targetName, params })
  })

  return { errors, cleaned }
}

function buildInput(
  cleaned: readonly TargetDraft[],
  identifiers: { name: string; synonyms: string[] },
  tags: string[],
  notes: string,
  now: string,
): DrugInput {
  const targets: TargetInput[] = cleaned.map((row) => {
    const byKind: Partial<Record<ParamKind, ScientificValue>> = {}
    for (const param of row.params) {
      if (param.kind === '') continue
      byKind[param.kind] = {
        value: Number(param.value),
        unit: param.unit,
        provenance: { type: 'user', recordedAt: now },
      }
    }
    return {
      ...(row.id !== undefined ? { id: row.id } : {}),
      name: row.name,
      ...(byKind.kd !== undefined ? { kd: byKind.kd } : {}),
      ...(byKind.ki !== undefined ? { ki: byKind.ki } : {}),
      ...(byKind.ec50 !== undefined ? { ec50: byKind.ec50 } : {}),
      ...(byKind.ic50 !== undefined ? { ic50: byKind.ic50 } : {}),
    }
  })

  return {
    identifiers,
    tags,
    targets,
    notes: notes.trim() === '' ? undefined : notes.trim(),
  }
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
  const [targets, setTargets] = useState<TargetDraft[]>(() =>
    drug !== undefined ? draftsFromDrug(drug) : [],
  )
  const [errors, setErrors] = useState<string[]>([])

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
    const input = buildInput(
      cleaned,
      { name: name.trim(), synonyms: splitList(synonyms) },
      splitList(tags),
      notes,
      new Date().toISOString(),
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
          <CardTitle className="text-base">Targets</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
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
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove target ${row.name || row.key}`}
                  onClick={() =>
                    setTargets((rows) => rows.filter((r) => r.key !== row.key))
                  }
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
                      onChange={(e) => updateParam(row.key, index, { value: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`param-unit-${row.key}-${index}`}>Unit *</Label>
                    <select
                      id={`param-unit-${row.key}-${index}`}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={param.unit}
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
                    onClick={() =>
                      setTargets((rows) =>
                        rows.map((r) =>
                          r.key === row.key
                            ? { ...r, params: r.params.filter((_, i) => i !== index) }
                            : r,
                        ),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              ))}

              <Button
                type="button"
                variant="ghost"
                size="sm"
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
        <Alert variant="destructive" data-testid="form-errors">
          <AlertTitle>Fix before saving</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {errors.map((error) => (
                <li key={error}>{error}</li>
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
