/**
 * Edit → persistence integration tests (jsdom + fake-indexeddb, real Dexie
 * repository): a save through the actual detail → form → store → repository
 * chain writes unchanged parameters with their whole provenance (citation,
 * DOI, URL, unknown extension keys included) into the stored record, and
 * stamps user provenance only on the parameter that actually changed.
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
    identifiers: { name: 'Fixture Compound A', synonyms: ['FCA'] },
    tags: ['fixture'],
    notes: FIXTURE_NOTE,
    targets: [
      {
        id: 'fixture-target-1',
        name: 'TEST-R',
        kd: { value: 12.4, unit: 'nM', provenance: LITERATURE },
      },
      {
        id: 'fixture-target-2',
        name: 'TEST-S',
        kd: { value: 12.4, unit: 'nM', provenance: USER_PROVENANCE },
        ic50: { value: 88, unit: 'nM', provenance: USER_PROVENANCE },
      },
    ],
  })
  drugId = created.id
  await useLibraryStore.getState().hydrate()
})

function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={[`/library/${drugId}`]}>
      <Routes>
        <Route path="/library/:drugId" element={<DrugDetailView drugId={drugId} />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** The raw stored row — before any mapper touches it on the way out. */
async function storedRecord() {
  const db = new SandboxDatabase()
  try {
    return await db.drugs.get(drugId)
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
})
