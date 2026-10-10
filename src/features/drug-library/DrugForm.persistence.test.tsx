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
