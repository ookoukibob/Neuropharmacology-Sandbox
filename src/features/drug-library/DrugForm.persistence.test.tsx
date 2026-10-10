/**
 * Edit → persistence integration tests (jsdom + fake-indexeddb, real Dexie
 * repository): a save through the actual detail → form → store → repository
 * chain writes unchanged parameters with their whole provenance (citation,
 * DOI, URL, unknown extension keys included) into the stored record, stamps
 * user provenance only on the parameter that actually changed, keeps the
 * supported target-level metadata (`gene`, `action`, `species`, `notes`)
 * of every surviving target in the raw stored row — matched by stable
 * target id, never by position or name — keeps the stored-only
 * identifier metadata (`description`, `casNumber`) the form cannot edit
 * (data-integrity audit DI-01), keeps untouched list/text fields
 * (`synonyms`, `tags`, name, top-level `notes`) byte-identical through
 * an unrelated edit (audit DI-03), and keeps a negative-zero parameter
 * and its complete provenance exact through an unrelated edit, with the
 * top-level `notes` present/absent distinction proven by raw-row
 * own-property checks (audit DI-04 and the DI-03 follow-up).
 * All fixture values are synthetic test data — not pharmacological
 * information.
 */
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { libraryRepository, useLibraryStore } from '@/app/libraryStore'
import { SandboxDatabase } from '@/data/db/database'
import { FIXTURE_NOTE, FIXTURE_TIMESTAMP } from '../../tests/fixtures'
import { fieldAt } from '../../tests/runtimeFields'
import { DrugDetailView } from './DrugDetailView'

/** Complete synthetic literature provenance incl. an unknown extension key. */
const LITERATURE = {
  type: 'literature' as const,
  source: 'Synthetic fixture source',
  citation: 'Invented for tests, 2026',
  doi: '10.5555/synthetic-fixture',
  url: 'https://example.invalid/synthetic-fixture',
  accessedAt: FIXTURE_TIMESTAMP,
  notes: FIXTURE_NOTE,
  syntheticExtension: 'synthetic-extension-value',
}
const USER_PROVENANCE = { type: 'user' as const, recordedAt: FIXTURE_TIMESTAMP }

/** Synthetic CAS-shaped string — schema only requires a non-empty value. */
const FIXTURE_CAS = 'SYNTH-CAS-0001'

let drugId = ''

beforeEach(async () => {
  await new SandboxDatabase().delete()
  useLibraryStore.setState({
    status: 'idle',
    drugs: [],
    metadata: undefined,
    quarantine: [],
    selectedDrugId: null,
    error: null,
    filter: '',
  })
  const created = await libraryRepository.createDrug({
    identifiers: {
      // Edge-whitespace name, comma-bearing and duplicate-carrying lists,
      // padded notes (audit DI-03): none of it may be normalized by an
      // edit that never touches these fields.
      name: '  Fixture Compound A  ',
      synonyms: ['Alpha,Beta', 'X', 'X'],
      // Stored-only identifier metadata (DI-01): no form control exists,
      // so an unrelated edit must never erase these.
      description: FIXTURE_NOTE,
      casNumber: FIXTURE_CAS,
    },
    tags: ['one,two', 'duplicate', 'duplicate'],
    notes: '  Synthetic edge-note with padding  ',
    targets: [
      {
        id: 'fixture-target-1',
        name: 'TEST-R',
        // Full supported target metadata on the first target, partial
        // (gene only) on the second, none expected to migrate either way.
        gene: 'SYNTH-P1',
        action: 'modulator',
        species: 'synthetic',
        notes: 'Synthetic target metadata — not pharmacological information.',
        kd: { value: 12.4, unit: 'nM', provenance: LITERATURE },
      },
      {
        id: 'fixture-target-2',
        name: 'TEST-S',
        gene: 'SYNTH-P2',
        kd: { value: 12.4, unit: 'nM', provenance: USER_PROVENANCE },
        ic50: { value: 88, unit: 'nM', provenance: USER_PROVENANCE },
      },
    ],
  })
  drugId = created.id
  await useLibraryStore.getState().hydrate()
})

function renderDetail(id: string = drugId): void {
  render(
    <MemoryRouter initialEntries={[`/library/${id}`]}>
      <Routes>
        <Route path="/library/:drugId" element={<DrugDetailView drugId={id} />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** The raw stored row — before any mapper touches it on the way out. */
async function storedRecord(id: string = drugId) {
  const db = new SandboxDatabase()
  try {
    return await db.drugs.get(id)
  } finally {
    db.close()
  }
}

describe('DrugForm — edit persistence (real repository)', () => {
  it('stores the whole provenance of unchanged parameters after an unrelated edit', async () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('edit-drug'))
    fireEvent.change(screen.getByTestId('drug-name'), {
      target: { value: 'Fixture Compound A Renamed' },
    })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // The actual stored record keeps the literature provenance complete.
    const raw = await storedRecord()
    expect(raw?.identifiers.name).toBe('Fixture Compound A Renamed')
    expect(raw?.targets[0]?.kd?.value).toBe(12.4)
    expect(raw?.targets[0]?.kd?.provenance).toEqual(LITERATURE)
    expect(raw?.targets[1]?.kd?.provenance).toEqual(USER_PROVENANCE)
    expect(raw?.targets[1]?.ic50?.provenance).toEqual(USER_PROVENANCE)

    // A fresh read through the repository/mapper hydrates the same data.
    const reloaded = await libraryRepository.getDrug(drugId)
    expect(reloaded?.targets[0]?.kd?.provenance).toEqual(LITERATURE)
    expect(reloaded?.targets[0]?.kd?.provenance).toHaveProperty(
      'syntheticExtension',
      'synthetic-extension-value',
    )
    expect(reloaded?.targets[1]?.ic50?.provenance).toEqual(USER_PROVENANCE)
    expect(reloaded?.updatedAt).toBeDefined()
  })

  it('stores a user stamp only on the parameter whose value changed', async () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('edit-drug'))
    const rowA = screen.getAllByTestId('target-row')[0] as HTMLElement
    fireEvent.change(within(rowA).getByLabelText('Value *'), { target: { value: '50' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    const raw = await storedRecord()
    const kd = raw?.targets[0]?.kd
    expect(kd?.value).toBe(50)
    expect(kd?.unit).toBe('nM')
    // The stored provenance is exactly the normal user-entry stamp — no
    // literature contract field (source/citation/doi/url/accessedAt/notes)
    // survives a real change; contract keys are governed by the new domain
    // value. The lone extra key is the unknown extension field, which rides
    // along by the mapper's lossless unknown-field rule (ADR-14) — this
    // task does not alter unknown-field preservation.
    expect(Object.keys(kd?.provenance ?? {}).sort()).toEqual([
      'recordedAt',
      'syntheticExtension',
      'type',
    ])
    expect(kd?.provenance).toMatchObject({ type: 'user' })
    expect(kd?.provenance).toHaveProperty(
      'recordedAt',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    )
    expect(kd?.provenance).toHaveProperty('syntheticExtension', 'synthetic-extension-value')

    // The unaffected sibling parameters are untouched in storage.
    expect(raw?.targets[1]?.kd?.provenance).toEqual(USER_PROVENANCE)
    expect(raw?.targets[1]?.ic50?.provenance).toEqual(USER_PROVENANCE)
  })

  it('keeps target gene/action/species/notes in the raw stored row after an unrelated edit', async () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('edit-drug'))
    fireEvent.change(screen.getByTestId('drug-name'), {
      target: { value: 'Fixture Compound A Renamed' },
    })
    fireEvent.change(screen.getByLabelText(/^Tags/), { target: { value: 'fixture, edited' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // The raw IndexedDB row still carries every supported metadata field
    // on the target that had them — with stable ids and untouched
    // provenance (the Phase 9A rule) — and the edited drug fields changed.
    const raw = await storedRecord()
    expect(raw?.identifiers.name).toBe('Fixture Compound A Renamed')
    expect(raw?.tags).toEqual(['fixture', 'edited'])
    expect(raw?.targets).toHaveLength(2)
    expect(raw?.targets[0]).toMatchObject({
      id: 'fixture-target-1',
      name: 'TEST-R',
      gene: 'SYNTH-P1',
      action: 'modulator',
      species: 'synthetic',
      notes: 'Synthetic target metadata — not pharmacological information.',
    })
    expect(raw?.targets[0]?.kd?.value).toBe(12.4)
    expect(raw?.targets[0]?.kd?.provenance).toEqual(LITERATURE)

    // The second target keeps only its own gene: no field migrated over
    // and nothing was fabricated (an explicit `undefined` key would fail
    // `not.toHaveProperty` just like a wrong value).
    expect(raw?.targets[1]).toMatchObject({ id: 'fixture-target-2', gene: 'SYNTH-P2' })
    expect(raw?.targets[1]).not.toHaveProperty('action')
    expect(raw?.targets[1]).not.toHaveProperty('species')
    expect(raw?.targets[1]).not.toHaveProperty('notes')
    expect(raw?.targets[1]?.kd?.provenance).toEqual(USER_PROVENANCE)
    expect(raw?.targets[1]?.ic50?.provenance).toEqual(USER_PROVENANCE)

    // A fresh repository read hydrates the same metadata and provenance.
    const reloaded = await libraryRepository.getDrug(drugId)
    expect(reloaded?.targets[0]).toMatchObject({
      id: 'fixture-target-1',
      gene: 'SYNTH-P1',
      action: 'modulator',
      species: 'synthetic',
      notes: 'Synthetic target metadata — not pharmacological information.',
    })
    expect(reloaded?.targets[0]?.kd?.provenance).toEqual(LITERATURE)
    expect(reloaded?.targets[1]).toMatchObject({ id: 'fixture-target-2', gene: 'SYNTH-P2' })
    expect(reloaded?.targets[1]).not.toHaveProperty('action')
    expect(reloaded?.targets[1]).not.toHaveProperty('species')
    expect(reloaded?.targets[1]).not.toHaveProperty('notes')
  })

  it('never migrates removed metadata onto survivors or recreated targets in storage', async () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('edit-drug'))

    // Remove the full-metadata target, then recreate a target with the
    // same name and the same Kd value/unit as the removed one.
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove target TEST-R' }),
    )
    fireEvent.click(screen.getByTestId('add-target'))
    const rows = screen.getAllByTestId('target-row')
    const newRow = rows[rows.length - 1] as HTMLElement
    fireEvent.change(within(newRow).getByLabelText('Target name *'), {
      target: { value: 'TEST-R' },
    })
    fireEvent.click(within(newRow).getByTestId('add-param'))
    fireEvent.change(within(newRow).getByLabelText('Parameter *'), { target: { value: 'kd' } })
    fireEvent.change(within(newRow).getByLabelText('Value *'), { target: { value: '12.4' } })
    fireEvent.change(within(newRow).getByLabelText('Unit *'), { target: { value: 'nM' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    const raw = await storedRecord()
    expect(raw?.targets).toHaveLength(2)

    // The survivor shifted from position 1 to position 0: it keeps its own
    // gene and provenance — never the removed target's action/species/notes.
    expect(raw?.targets[0]).toMatchObject({ id: 'fixture-target-2', gene: 'SYNTH-P2' })
    expect(raw?.targets[0]).not.toHaveProperty('action')
    expect(raw?.targets[0]).not.toHaveProperty('species')
    expect(raw?.targets[0]).not.toHaveProperty('notes')
    expect(raw?.targets[0]?.kd?.provenance).toEqual(USER_PROVENANCE)
    expect(raw?.targets[0]?.ic50?.provenance).toEqual(USER_PROVENANCE)

    // The recreated target is a new identity: the repository assigned it a
    // fresh id, it carries no metadata (name matching never reattaches the
    // removed target's fields), and its parameter is a normal user entry.
    const recreated = raw?.targets[1]
    expect(recreated?.name).toBe('TEST-R')
    expect(typeof recreated?.id).toBe('string')
    expect(recreated?.id).not.toBe('')
    expect(recreated?.id).not.toBe('fixture-target-1')
    expect(recreated).not.toHaveProperty('gene')
    expect(recreated).not.toHaveProperty('action')
    expect(recreated).not.toHaveProperty('species')
    expect(recreated).not.toHaveProperty('notes')
    expect(recreated?.kd?.value).toBe(12.4)
    expect(recreated?.kd?.provenance).toMatchObject({ type: 'user' })
    const freshStamp = recreated?.kd?.provenance as { recordedAt?: unknown } | undefined
    expect(freshStamp?.recordedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    )
    expect(freshStamp?.recordedAt).not.toBe(FIXTURE_TIMESTAMP)

    // The fresh read agrees with the raw row.
    const reloaded = await libraryRepository.getDrug(drugId)
    expect(reloaded?.targets[0]).toMatchObject({ id: 'fixture-target-2', gene: 'SYNTH-P2' })
    expect(reloaded?.targets[0]).not.toHaveProperty('action')
    expect(reloaded?.targets[1]?.name).toBe('TEST-R')
    expect(reloaded?.targets[1]).not.toHaveProperty('gene')
    expect(reloaded?.targets[1]).not.toHaveProperty('notes')
  })

  it('keeps identifiers description and CAS in the raw row after an unrelated edit', async () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('edit-drug'))
    fireEvent.change(screen.getByTestId('drug-name'), {
      target: { value: 'Fixture Compound A Renamed' },
    })
    fireEvent.change(screen.getByLabelText(/^Synonyms/), { target: { value: 'FCA, EDITED' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // Raw stored row — before any mapper touches it: the stored-only
    // identifier fields are byte-identical (exact key set, so an invented
    // or explicit-`undefined` key would fail), the editable fields took
    // the form's values, and Phase 9A provenance + Phase 10 target
    // metadata survive the same write untouched.
    const raw = await storedRecord()
    expect(raw?.identifiers).toEqual({
      name: 'Fixture Compound A Renamed',
      synonyms: ['FCA', 'EDITED'],
      description: FIXTURE_NOTE,
      casNumber: FIXTURE_CAS,
    })
    expect(Object.keys(raw?.identifiers ?? {}).sort()).toEqual([
      'casNumber',
      'description',
      'name',
      'synonyms',
    ])
    expect(raw?.targets).toHaveLength(2)
    expect(raw?.targets[0]).toMatchObject({
      id: 'fixture-target-1',
      gene: 'SYNTH-P1',
      action: 'modulator',
      species: 'synthetic',
    })
    expect(raw?.targets[0]?.kd?.value).toBe(12.4)
    expect(raw?.targets[0]?.kd?.provenance).toEqual(LITERATURE)
    expect(raw?.targets[1]).toMatchObject({ id: 'fixture-target-2', gene: 'SYNTH-P2' })
    expect(raw?.targets[1]?.ic50?.provenance).toEqual(USER_PROVENANCE)

    // A fresh repository read hydrates the same identifier metadata.
    const reloaded = await libraryRepository.getDrug(drugId)
    expect(reloaded?.identifiers).toEqual({
      name: 'Fixture Compound A Renamed',
      synonyms: ['FCA', 'EDITED'],
      description: FIXTURE_NOTE,
      casNumber: FIXTURE_CAS,
    })
  })

  it('keeps untouched list and text fields byte-identical in the raw row after an unrelated edit', async () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('edit-drug'))
    // Unrelated edit: add a new target with one parameter; no drug-level
    // draft (name/synonyms/tags/notes) is touched at all.
    fireEvent.click(screen.getByTestId('add-target'))
    const rows = screen.getAllByTestId('target-row')
    const newRow = rows[rows.length - 1] as HTMLElement
    fireEvent.change(within(newRow).getByLabelText('Target name *'), {
      target: { value: 'NEW-T' },
    })
    fireEvent.click(within(newRow).getByTestId('add-param'))
    fireEvent.change(within(newRow).getByLabelText('Parameter *'), { target: { value: 'kd' } })
    fireEvent.change(within(newRow).getByLabelText('Value *'), { target: { value: '4.2' } })
    fireEvent.change(within(newRow).getByLabelText('Unit *'), { target: { value: 'nM' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // Raw stored row — before any mapper touches it: every untouched
    // list/text value is byte-identical (embedded commas, duplicate
    // entries and edge whitespace included). Audit DI-03 previously
    // normalized all four here without the user touching them.
    const raw = await storedRecord()
    expect(raw?.identifiers.name).toBe('  Fixture Compound A  ')
    expect(raw?.identifiers.synonyms).toEqual(['Alpha,Beta', 'X', 'X'])
    expect(raw?.tags).toEqual(['one,two', 'duplicate', 'duplicate'])
    expect(raw?.notes).toBe('  Synthetic edge-note with padding  ')

    // The previously covered layers survive the same write: DI-01
    // identifier metadata, Phase 10 target metadata, Phase 9A provenance.
    expect(raw?.identifiers.description).toBe(FIXTURE_NOTE)
    expect(raw?.identifiers.casNumber).toBe(FIXTURE_CAS)
    expect(raw?.targets).toHaveLength(3)
    expect(raw?.targets[0]).toMatchObject({
      id: 'fixture-target-1',
      gene: 'SYNTH-P1',
      action: 'modulator',
      species: 'synthetic',
    })
    expect(raw?.targets[0]?.kd?.provenance).toEqual(LITERATURE)
    expect(raw?.targets[1]).toMatchObject({ id: 'fixture-target-2', gene: 'SYNTH-P2' })
    expect(raw?.targets[1]?.ic50?.provenance).toEqual(USER_PROVENANCE)
    expect(raw?.targets[2]).toMatchObject({ name: 'NEW-T' })
    expect(raw?.targets[2]?.kd?.provenance).toMatchObject({ type: 'user' })

    // A fresh repository read hydrates the same untouched values.
    const reloaded = await libraryRepository.getDrug(drugId)
    expect(reloaded?.identifiers.name).toBe('  Fixture Compound A  ')
    expect(reloaded?.identifiers.synonyms).toEqual(['Alpha,Beta', 'X', 'X'])
    expect(reloaded?.tags).toEqual(['one,two', 'duplicate', 'duplicate'])
    expect(reloaded?.notes).toBe('  Synthetic edge-note with padding  ')
  })
})

describe('DrugForm — negative-zero and notes-presence persistence (audit DI-04)', () => {
  /** Seed an own record and render its detail through the real store chain. */
  async function seedAndRender(input: Parameters<typeof libraryRepository.createDrug>[0]) {
    const created = await libraryRepository.createDrug(input)
    await useLibraryStore.getState().hydrate()
    renderDetail(created.id)
    return created
  }

  /** The supported unrelated edit: rename the drug; touch nothing else. */
  function renameDrug(to: string): void {
    fireEvent.click(screen.getByTestId('edit-drug'))
    fireEvent.change(screen.getByTestId('drug-name'), { target: { value: to } })
    fireEvent.submit(screen.getByTestId('drug-form'))
  }

  it('keeps a negative-zero parameter and its provenance exact in the raw row after an unrelated edit', async () => {
    const created = await seedAndRender({
      identifiers: { name: 'Synthetic Negative-Zero Record', synonyms: [] },
      targets: [
        {
          id: 'negzero-target-1',
          name: 'NZ-R',
          kd: { value: -0, unit: 'nM', provenance: LITERATURE },
        },
      ],
    })
    renameDrug('Synthetic Negative-Zero Record Renamed')
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // Raw stored row — the displayed "0" must not have been re-parsed.
    const raw = await storedRecord(created.id)
    expect(Object.is(raw?.targets[0]?.kd?.value, -0)).toBe(true)
    expect(raw?.targets[0]?.kd?.provenance).toEqual(LITERATURE)

    // A fresh repository read hydrates the same value and provenance.
    const reloaded = await libraryRepository.getDrug(created.id)
    expect(Object.is(reloaded?.targets[0]?.kd?.value, -0)).toBe(true)
    expect(reloaded?.targets[0]?.kd?.provenance).toEqual(LITERATURE)
    expect(reloaded?.targets[0]?.kd?.provenance).toHaveProperty(
      'syntheticExtension',
      'synthetic-extension-value',
    )
  })

  it('keeps an absent top-level notes field absent in the raw row (own-property check)', async () => {
    const created = await seedAndRender({
      identifiers: { name: 'Synthetic Absent-Notes Record', synonyms: [] },
      targets: [],
    })
    renameDrug('Synthetic Absent-Notes Record Renamed')
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // `raw.notes === undefined` alone cannot distinguish a missing key
    // from an explicit `undefined` key — assert own-property presence.
    const raw = await storedRecord(created.id)
    expect(raw).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(raw ?? {}, 'notes')).toBe(false)
    const reloaded = await libraryRepository.getDrug(created.id)
    expect(reloaded?.notes).toBeUndefined()
  })

  it('keeps an explicitly empty top-level notes string present in the raw row (own-property check)', async () => {
    const created = await seedAndRender({
      identifiers: { name: 'Synthetic Empty-Notes Record', synonyms: [] },
      targets: [],
      notes: '',
    })
    renameDrug('Synthetic Empty-Notes Record Renamed')
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    const raw = await storedRecord(created.id)
    expect(raw).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(raw ?? {}, 'notes')).toBe(true)
    expect(raw?.notes).toBe('')
    const reloaded = await libraryRepository.getDrug(created.id)
    expect(reloaded?.notes).toBe('')
  })
})

/**
 * GAP-1 / GAP-2 follow-up (data-integrity audit): the form ALWAYS submits
 * a replacement `targets` array and NEVER submits `pharmacokinetics`.
 * These tests drive the real detail → form → store → repository chain and
 * then inspect the raw stored row, so they protect the actual production
 * update path rather than a helper in isolation. Synthetic fixtures only.
 */
describe('DrugForm — extensions and pharmacokinetics through an unrelated edit (audit GAP-1/GAP-2)', () => {
  /**
   * NPSL document with unknown fields at record, target and provenance
   * level on two different targets (nested object + array included).
   * Built as a template literal so the unknown keys ride through the real
   * import pipeline — never through `JSON.stringify` of a typed fixture.
   */
  const GAP1_FORM_NPSL_TEXT = `{
  "formatVersion": "1.0.0",
  "schemaVersion": "1.0.0",
  "libraryMetadata": {
    "id": "fixture-library",
    "name": "Synthetic gap fixture library",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "dataStatus": "example"
  },
  "drugs": [
    {
      "id": "gap1-form-drug-1",
      "origin": "user",
      "identifiers": {
        "name": "Synthetic Gap1 Form Fixture",
        "synonyms": ["Synthetic"]
      },
      "tags": ["fixture"],
      "rootExtension": { "note": "gap-form root extension" },
      "targets": [
        {
          "id": "gap1-form-target-a",
          "name": "GAP1-FORM-A",
          "gene": "GFA",
          "kd": {
            "value": 3.2,
            "unit": "nM",
            "provenance": {
              "type": "literature",
              "source": "Synthetic fixture source",
              "provenanceExtension": { "family": "form-a", "markers": ["x", "y"] }
            }
          },
          "futureTargetFormA": { "nested": { "list": ["keep", "a"], "count": 7 }, "flag": true }
        },
        {
          "id": "gap1-form-target-b",
          "name": "GAP1-FORM-B",
          "ic50": {
            "value": 7.5,
            "unit": "nM",
            "provenance": {
              "type": "user",
              "recordedAt": "2026-01-01T00:00:00.000Z",
              "provenanceExtension": "prov-form-b"
            }
          },
          "futureTargetFormB": ["array", "extension"]
        }
      ],
      "notes": "Synthetic fixture — not pharmacological information."
    }
  ]
}`

  it('GAP-1: unknown target extensions survive the form targets-replacing save', async () => {
    const report = await libraryRepository.importLibrary(GAP1_FORM_NPSL_TEXT, { mode: 'merge' })
    expect(report.ok).toBe(true)
    await useLibraryStore.getState().hydrate()

    // Baseline: the import itself must already store each target's own
    // unknown fields in position (guards the import write, not only the
    // later edit).
    const imported = await storedRecord('gap1-form-drug-1')
    expect(fieldAt(imported, 'targets', '0', 'futureTargetFormA')).toEqual({
      nested: { list: ['keep', 'a'], count: 7 },
      flag: true,
    })
    expect(fieldAt(imported, 'targets', '1', 'futureTargetFormB')).toEqual(['array', 'extension'])

    renderDetail('gap1-form-drug-1')

    // Unrelated edit: rename the drug; no target is touched in the UI.
    fireEvent.click(screen.getByTestId('edit-drug'))
    fireEvent.change(screen.getByTestId('drug-name'), {
      target: { value: 'Synthetic Gap1 Form Fixture Renamed' },
    })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // The form submitted a REPLACEMENT targets array; the raw row still
    // carries each target's unknown fields under its stable id.
    const raw = await storedRecord('gap1-form-drug-1')
    expect(raw?.targets).toHaveLength(2)
    expect(fieldAt(raw, 'targets', '0', 'id')).toBe('gap1-form-target-a')
    expect(fieldAt(raw, 'targets', '0', 'futureTargetFormA')).toEqual({
      nested: { list: ['keep', 'a'], count: 7 },
      flag: true,
    })
    expect(fieldAt(raw, 'targets', '1', 'futureTargetFormB')).toEqual(['array', 'extension'])
    expect(fieldAt(raw, 'targets', '0', 'futureTargetFormB')).toBeUndefined()
    expect(fieldAt(raw, 'targets', '1', 'futureTargetFormA')).toBeUndefined()
    // Provenance-level and record-level extensions ride along untouched.
    expect(fieldAt(raw, 'targets', '0', 'kd', 'provenance', 'provenanceExtension')).toEqual({
      family: 'form-a',
      markers: ['x', 'y'],
    })
    expect(fieldAt(raw, 'targets', '1', 'ic50', 'provenance', 'provenanceExtension')).toBe(
      'prov-form-b',
    )
    expect(fieldAt(raw, 'rootExtension')).toEqual({ note: 'gap-form root extension' })
    // The unrelated edit was applied; recognized target fields stand.
    expect(raw?.identifiers.name).toBe('Synthetic Gap1 Form Fixture Renamed')
    expect(raw?.targets[0]?.name).toBe('GAP1-FORM-A')

    // A fresh repository read reconstructs the same extensions.
    const reloaded = await libraryRepository.getDrug('gap1-form-drug-1')
    expect(fieldAt(reloaded, 'targets', '0', 'futureTargetFormA', 'nested', 'list')).toEqual([
      'keep',
      'a',
    ])
    expect(fieldAt(reloaded, 'rootExtension')).toEqual({ note: 'gap-form root extension' })
  })

  /**
   * Complete synthetic literature provenance incl. an unknown extension
   * key, plus user provenance for the remaining PK parameters — the whole
   * object an unrelated edit must leave byte-identical.
   */
  const PK_PROVENANCE = {
    type: 'literature' as const,
    source: 'Synthetic fixture source',
    citation: 'Invented for tests, 2026',
    doi: '10.5555/synthetic-fixture',
    url: 'https://example.invalid/synthetic-fixture',
    accessedAt: FIXTURE_TIMESTAMP,
    notes: FIXTURE_NOTE,
    syntheticExtension: 'pk-prov-ext',
  }
  const PK_USER_PROVENANCE = { type: 'user' as const, recordedAt: FIXTURE_TIMESTAMP }

  const EXPECTED_PHARMACOKINETICS = {
    halfLife: { value: 8, unit: 'h', provenance: PK_PROVENANCE },
    clearance: { value: 2.5, unit: 'mL/min', provenance: PK_USER_PROVENANCE },
    volumeOfDistribution: { value: 42, unit: 'L', provenance: PK_USER_PROVENANCE },
    bioavailability: { value: 65, unit: '%', provenance: PK_USER_PROVENANCE },
  }

  it('GAP-2: pharmacokinetics values, units and provenance survive an unrelated edit', async () => {
    const created = await libraryRepository.createDrug({
      identifiers: { name: 'Synthetic PK Fixture', synonyms: [] },
      targets: [],
      pharmacokinetics: {
        halfLife: { value: 8, unit: 'h', provenance: PK_PROVENANCE },
        clearance: { value: 2.5, unit: 'mL/min', provenance: PK_USER_PROVENANCE },
        volumeOfDistribution: { value: 42, unit: 'L', provenance: PK_USER_PROVENANCE },
        bioavailability: { value: 65, unit: '%', provenance: PK_USER_PROVENANCE },
      },
    })
    await useLibraryStore.getState().hydrate()
    renderDetail(created.id)

    // Unrelated edit: rename the drug; the form never edits pharmacokinetics
    // (the form does not even submit the key).
    fireEvent.click(screen.getByTestId('edit-drug'))
    fireEvent.change(screen.getByTestId('drug-name'), {
      target: { value: 'Synthetic PK Fixture Renamed' },
    })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // Raw stored row: the WHOLE pharmacokinetics object is unchanged.
    // Deep equality fails if any value, unit or provenance field — the
    // extension key included — is dropped, rebuilt or normalized.
    const raw = await storedRecord(created.id)
    expect(raw).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(raw ?? {}, 'pharmacokinetics')).toBe(true)
    expect(raw?.pharmacokinetics).toEqual(EXPECTED_PHARMACOKINETICS)
    expect(raw?.identifiers.name).toBe('Synthetic PK Fixture Renamed')

    // A fresh repository read reconstructs the same data.
    const reloaded = await libraryRepository.getDrug(created.id)
    expect(reloaded?.pharmacokinetics).toEqual(EXPECTED_PHARMACOKINETICS)
  })
})
