/**
 * Minimal UI tests: list rendering/filtering/quarantine banner, detail
 * provenance + storage-origin display, edit/create safeguard behavior
 * (explicit units, validated numbers, provenance preservation on edit,
 * no provenance editing).
 *
 * The singleton store is seeded directly with synthetic fixture state — no
 * database access happens in these tests, and form submissions that fail
 * local validation never reach the repository.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Drug } from '@/domain/drug/drug'
import type { DrugInput } from '@/data/repositories/repository'
import {
  FIXTURE_NOTE,
  FIXTURE_TIMESTAMP,
  syntheticDrug,
  syntheticDrugB,
} from '../../tests/fixtures'
import { useLibraryStore } from '@/app/libraryStore'
import { DrugDetailView } from './DrugDetailView'
import { DrugForm } from './DrugForm'
import { DrugLibraryView } from './DrugLibraryView'
import type { LibraryState } from './store'

function seedState(partial: Partial<LibraryState>): void {
  useLibraryStore.setState(partial)
}

/** Original action, restored after tests that swap it for a spy. */
const originalDeleteDrug = useLibraryStore.getState().deleteDrug

afterEach(() => {
  useLibraryStore.setState({
    status: 'idle',
    drugs: [],
    metadata: undefined,
    quarantine: [],
    selectedDrugId: null,
    error: null,
    filter: '',
    deleteDrug: originalDeleteDrug,
  })
})

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <Routes>
        <Route path="/library" element={<DrugLibraryView />} />
        <Route path="/library/new" element={<p>new page</p>} />
        <Route path="/library/:drugId" element={<p>detail page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderDetail(drugId: string) {
  return render(
    <MemoryRouter initialEntries={[`/library/${drugId}`]}>
      <Routes>
        <Route path="/library/:drugId" element={<DrugDetailView drugId={drugId} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('DrugLibraryView', () => {
  it('lists records with storage-origin badges and a count', () => {
    seedState({
      status: 'ready',
      drugs: [syntheticDrug(), syntheticDrugB()],
      metadata: undefined,
    })
    renderList()

    expect(screen.getByText('Fixture Compound A')).toBeInTheDocument()
    expect(screen.getByText('Fixture Compound B')).toBeInTheDocument()
    expect(screen.getAllByTestId('origin-badge')[0]).toHaveTextContent('Entered by you')
    expect(screen.getByTestId('library-count')).toHaveTextContent('2 of 2 records')
  })

  it('filters by name and synonym without touching storage', () => {
    seedState({
      status: 'ready',
      drugs: [syntheticDrug(), syntheticDrugB()],
      metadata: undefined,
    })
    renderList()

    fireEvent.change(screen.getByTestId('library-filter'), {
      target: { value: 'compound b' },
    })
    expect(screen.getByText('Fixture Compound B')).toBeInTheDocument()
    expect(screen.queryByText('Fixture Compound A')).not.toBeInTheDocument()
    expect(screen.getByTestId('library-count')).toHaveTextContent('1 of 2 records')
  })

  it('reports quarantined records in a banner instead of hiding them', () => {
    seedState({
      status: 'ready',
      drugs: [syntheticDrug()],
      metadata: undefined,
      quarantine: [{ id: 'bad-1', errors: ['origin: invalid'], record: { id: 'bad-1' } }],
    })
    renderList()

    const banner = screen.getByTestId('quarantine-banner')
    expect(banner).toHaveTextContent('bad-1')
    expect(banner).toHaveTextContent('never deleted')
    // The valid record still renders.
    expect(screen.getByText('Fixture Compound A')).toBeInTheDocument()
  })

  it('shows the first-run empty state', () => {
    seedState({ status: 'ready', drugs: [], metadata: undefined })
    renderList()
    expect(screen.getByText(/The library is empty/)).toBeInTheDocument()
  })

  it('surfaces the loading and failure states', () => {
    seedState({ status: 'loading', drugs: [], metadata: undefined })
    const { unmount } = renderList()
    // Announced as a status, so assistive technology hears the wait state.
    expect(screen.getByRole('status')).toHaveTextContent('Loading library…')
    unmount()

    seedState({ status: 'error', drugs: [], metadata: undefined, error: 'storage unavailable' })
    renderList()
    // Blocking failure is announced as an alert, not rendered as plain text.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Library failed to load: storage unavailable',
    )
  })
})

describe('DrugDetailView', () => {
  it('shows parameters with units and whole provenance badges (user record)', () => {
    seedState({ status: 'ready', drugs: [syntheticDrug()], metadata: undefined })
    renderDetail('fixture-drug-1')

    expect(screen.getByTestId('drug-detail')).toBeInTheDocument()
    expect(screen.getByTestId('param-Kd')).toHaveTextContent('12.4 nM')
    const badges = screen.getAllByTestId('provenance-badge')
    expect(badges[0]).toHaveTextContent('Literature')
    expect(badges[0]?.getAttribute('title')).toContain('Synthetic fixture source')
    expect(badges[1]).toHaveTextContent('User-entered')

    // User-entered records are editable.
    expect(screen.getByTestId('edit-drug')).toBeInTheDocument()
    expect(screen.getByTestId('delete-drug')).toBeInTheDocument()
  })

  it('keeps imported records read-only in the UI', () => {
    seedState({
      status: 'ready',
      drugs: [syntheticDrug({ origin: 'imported' })],
      metadata: undefined,
    })
    renderDetail('fixture-drug-1')

    expect(screen.queryByTestId('edit-drug')).not.toBeInTheDocument()
    expect(screen.getByTestId('readonly-note')).toHaveTextContent('read-only')
    expect(screen.getByTestId('origin-badge')).toHaveTextContent('Imported')
  })

  it('reports unknown ids instead of rendering an empty shell', () => {
    seedState({ status: 'ready', drugs: [], metadata: undefined })
    renderDetail('no-such-id')
    expect(screen.getByTestId('drug-not-found')).toBeInTheDocument()
  })

  it('opens a prefilled form on Edit; local validation blocks an empty name', () => {
    seedState({ status: 'ready', drugs: [syntheticDrug()], metadata: undefined })
    renderDetail('fixture-drug-1')

    fireEvent.click(screen.getByTestId('edit-drug'))
    const nameInput = screen.getByTestId('drug-name') as HTMLInputElement
    expect(nameInput.value).toBe('Fixture Compound A')

    fireEvent.change(nameInput, { target: { value: '   ' } })
    fireEvent.submit(screen.getByTestId('drug-form'))

    expect(screen.getByTestId('form-errors')).toHaveTextContent('Name is required.')
    // Still on the form — nothing was sent to the repository.
    expect(screen.getByTestId('drug-form')).toBeInTheDocument()
  })

  it('requires an explicit acknowledgement before deleting', () => {
    seedState({ status: 'ready', drugs: [syntheticDrug()], metadata: undefined })
    renderDetail('fixture-drug-1')

    fireEvent.click(screen.getByTestId('delete-drug'))

    // The destructive button is replaced by a named confirmation step that
    // names the record and carries focus.
    const confirm = screen.getByTestId('delete-drug-confirm')
    expect(screen.getByTestId('delete-confirm-text')).toHaveTextContent('Fixture Compound A')
    expect(screen.queryByTestId('delete-drug')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(confirm)
    // Nothing was deleted yet.
    expect(useLibraryStore.getState().drugs).toHaveLength(1)

    // Escape cancels and returns focus to the Delete button.
    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(screen.queryByTestId('delete-drug-confirm')).not.toBeInTheDocument()
    expect(screen.getByTestId('delete-drug')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByTestId('delete-drug'))
    expect(useLibraryStore.getState().drugs).toHaveLength(1)
  })

  it('deletes only after the explicit confirmation is activated', async () => {
    const deleteDrug = vi.fn(async () => true)
    useLibraryStore.setState({ deleteDrug })
    seedState({ status: 'ready', drugs: [syntheticDrug()], metadata: undefined })
    renderDetail('fixture-drug-1')

    fireEvent.click(screen.getByTestId('delete-drug'))
    fireEvent.click(screen.getByTestId('delete-drug-confirm'))

    await vi.waitFor(() => expect(deleteDrug).toHaveBeenCalledWith('fixture-drug-1'))
    // The record leaves the detail view once the repository confirmed it.
    await vi.waitFor(() =>
      expect(screen.queryByTestId('drug-detail')).not.toBeInTheDocument(),
    )
  })
})

describe('DrugForm — scientific editing safeguards', () => {
  function renderForm() {
    const onSave = vi.fn<(input: DrugInput) => Promise<unknown>>(async () => undefined)
    render(<DrugForm onSave={onSave} onCancel={vi.fn()} />)
    return { onSave }
  }

  function addTargetWithName(name: string): void {
    fireEvent.click(screen.getByTestId('add-target'))
    const nameInputs = screen.getAllByLabelText(/Target name/)
    fireEvent.change(nameInputs[nameInputs.length - 1] as HTMLInputElement, {
      target: { value: name },
    })
  }

  function fillParam(kind: string, value: string, unit: string): void {
    fireEvent.click(screen.getByTestId('add-param'))
    fireEvent.change(screen.getByLabelText('Parameter *'), { target: { value: kind } })
    fireEvent.change(screen.getByLabelText('Value *'), { target: { value } })
    fireEvent.change(screen.getByLabelText('Unit *'), { target: { value: unit } })
  }

  it('offers only catalog molar-concentration units, with no default', () => {
    renderForm()
    addTargetWithName('TEST-R')
    fireEvent.click(screen.getByTestId('add-param'))
    const unitSelect = screen.getByLabelText('Unit *') as HTMLSelectElement
    expect([...unitSelect.options].map((o) => o.value)).toEqual([
      '',
      'M',
      'mM',
      'µM',
      'nM',
      'pM',
      'fM',
    ])
    expect(unitSelect.value).toBe('') // explicit choice required
    const kindSelect = screen.getByLabelText('Parameter *') as HTMLSelectElement
    expect(kindSelect.value).toBe('')
  })

  it('rejects a non-finite value', () => {
    const { onSave } = renderForm()
    addTargetWithName('TEST-R')
    fillParam('kd', 'not-a-number', 'nM')
    fireEvent.submit(screen.getByTestId('drug-form'))
    expect(screen.getByTestId('form-errors')).toHaveTextContent('is not a finite number')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('rejects a negative concentration', () => {
    const { onSave } = renderForm()
    addTargetWithName('TEST-R')
    fillParam('kd', '-3', 'nM')
    fireEvent.submit(screen.getByTestId('drug-form'))
    expect(screen.getByTestId('form-errors')).toHaveTextContent('cannot be negative')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('announces a failed submit as an alert and focuses the first invalid control', () => {
    renderForm()
    fireEvent.submit(screen.getByTestId('drug-form'))

    expect(screen.getByTestId('form-errors')).toHaveAttribute('role', 'alert')

    const nameInput = screen.getByTestId('drug-name')
    expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    expect(nameInput).toHaveAttribute('aria-describedby', 'drug-form-error-0')
    expect(document.getElementById('drug-form-error-0')).toHaveTextContent('Name is required.')
    expect(document.activeElement).toBe(nameInput)
  })

  it('points a parameter error at exactly that parameter control', async () => {
    const { onSave } = renderForm()
    fireEvent.change(screen.getByLabelText('Name *'), {
      target: { value: 'Fixture Compound N' },
    })
    addTargetWithName('TEST-R')
    fillParam('kd', '-3', 'nM')
    fireEvent.submit(screen.getByTestId('drug-form'))

    const valueInput = document.getElementById('param-value-1-0')
    expect(valueInput).toHaveAttribute('aria-invalid', 'true')
    expect(valueInput).toHaveAttribute('aria-describedby', 'drug-form-error-0')
    expect(document.getElementById('drug-form-error-0')).toHaveTextContent('cannot be negative')
    expect(document.activeElement).toBe(valueInput)
    expect(onSave).not.toHaveBeenCalled()

    // Correcting the value clears the association on the next submit.
    fireEvent.change(valueInput as HTMLInputElement, { target: { value: '3' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('form-errors')).not.toBeInTheDocument()
    expect(screen.getByTestId('drug-name')).toHaveAttribute('aria-invalid', 'false')
  })

  it('requires kind, value and unit together', () => {
    const { onSave } = renderForm()
    addTargetWithName('TEST-R')
    fireEvent.click(screen.getByTestId('add-param'))
    fireEvent.change(screen.getByLabelText('Value *'), { target: { value: '5' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    expect(screen.getByTestId('form-errors')).toHaveTextContent(
      'each parameter needs a kind, a value and a unit',
    )
    expect(onSave).not.toHaveBeenCalled()
  })

  it('rejects duplicate target names', () => {
    const { onSave } = renderForm()
    addTargetWithName('TEST-R')
    addTargetWithName('test-r')
    fireEvent.submit(screen.getByTestId('drug-form'))
    expect(screen.getByTestId('form-errors')).toHaveTextContent('duplicate target name')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves a valid record with user-entry provenance stamped per parameter', async () => {
    const { onSave } = renderForm()
    addTargetWithName('TEST-R')
    fillParam('kd', '12.4', 'nM')
    fireEvent.change(screen.getByLabelText('Name *'), {
      target: { value: 'Fixture Compound N' },
    })
    fireEvent.change(screen.getByLabelText(/^Synonyms/), {
      target: { value: 'FCN, other' },
    })
    fireEvent.change(screen.getByLabelText(/^Tags/), { target: { value: 'fixture, demo' } })
    fireEvent.change(screen.getByLabelText(/^Notes/), { target: { value: '  ' } })

    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const input = onSave.mock.calls[0]?.[0] as DrugInput
    expect(input.identifiers.name).toBe('Fixture Compound N')
    expect(input.identifiers.synonyms).toEqual(['FCN', 'other'])
    expect(input.tags).toEqual(['fixture', 'demo'])
    expect(input.notes).toBeUndefined() // blank notes are stored as absent
    expect(input.targets).toHaveLength(1)
    const target = input.targets?.[0]
    expect(target?.name).toBe('TEST-R')
    expect(target?.kd?.value).toBe(12.4)
    expect(target?.kd?.unit).toBe('nM')
    // Provenance: exactly user-entry, stamped now — never anything else.
    expect(target?.kd?.provenance).toMatchObject({ type: 'user' })
    expect(target?.kd?.provenance).toHaveProperty('recordedAt')
    expect(Object.keys(target?.kd?.provenance ?? {})).toEqual(['type', 'recordedAt'])
  })

  it('prefills an edit from the stored record, keeping its provenance out of reach', () => {
    render(<DrugForm drug={syntheticDrug()} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect((screen.getByTestId('drug-name') as HTMLInputElement).value).toBe('Fixture Compound A')
    // Two targets, each with its stored parameter preselected.
    expect(screen.getAllByTestId('target-row')).toHaveLength(2)
    expect((screen.getAllByLabelText('Parameter *')[0] as HTMLSelectElement).value).toBe('kd')
    expect((screen.getAllByLabelText('Value *')[0] as HTMLInputElement).value).toBe('12.4')
    expect((screen.getAllByLabelText('Unit *')[0] as HTMLSelectElement).value).toBe('nM')
    expect(screen.getByLabelText('Notes')).toHaveTextContent(FIXTURE_NOTE)
    // No provenance controls exist anywhere in the form.
    expect(screen.queryByText(/provenance/i)).not.toBeInTheDocument()
  })
})

describe('DrugForm — provenance preservation on edit', () => {
  /**
   * Complete synthetic literature provenance: every optional field plus an
   * unknown extension key — exactly the whole object an unchanged parameter
   * must keep through an unrelated edit. Invented fixture data, never
   * pharmacological information.
   */
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

  /**
   * Two targets whose Kd parameters share the same value and unit but carry
   * different provenance — any name-based, position-based or order-based
   * identity mistake therefore surfaces as the wrong provenance object on
   * the wrong target.
   */
  function editableFixture(): Drug {
    return syntheticDrug({
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
  }

  function renderEdit(drug: Drug) {
    const onSave = vi.fn<(input: DrugInput) => Promise<unknown>>(async () => undefined)
    render(<DrugForm drug={drug} onSave={onSave} onCancel={vi.fn()} />)
    return { onSave }
  }

  function targetRows(): HTMLElement[] {
    return screen.getAllByTestId('target-row')
  }

  /** A fresh user entry: exactly `{ type, recordedAt }` with a current ISO time. */
  function expectFreshUserStamp(provenance: unknown): void {
    expect(provenance).toMatchObject({ type: 'user' })
    expect(Object.keys(provenance ?? {})).toEqual(['type', 'recordedAt'])
    const recordedAt = (provenance as { recordedAt?: unknown }).recordedAt
    expect(recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(recordedAt).not.toBe(FIXTURE_TIMESTAMP)
  }

  it('preserves the complete provenance of unchanged parameters when name, tags and notes change', async () => {
    const drug = editableFixture()
    const { onSave } = renderEdit(drug)

    fireEvent.change(screen.getByLabelText('Name *'), {
      target: { value: 'Fixture Compound A Renamed' },
    })
    fireEvent.change(screen.getByLabelText(/^Tags/), { target: { value: 'fixture, edited' } })
    fireEvent.change(screen.getByLabelText(/^Notes/), {
      target: { value: 'Synthetic note after edit' },
    })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const input = onSave.mock.calls[0]?.[0] as DrugInput
    expect(input.identifiers.name).toBe('Fixture Compound A Renamed')
    expect(input.tags).toEqual(['fixture', 'edited'])
    expect(input.notes).toBe('Synthetic note after edit')

    // Rows keep their stable stored identity through the edit.
    expect(input.targets?.[0]?.id).toBe('fixture-target-1')
    expect(input.targets?.[1]?.id).toBe('fixture-target-2')

    // The literature provenance is written back as the very same whole
    // object — citation, DOI, URL, accessedAt, notes, unknown extension key.
    const kd = input.targets?.[0]?.kd
    expect(kd?.value).toBe(12.4)
    expect(kd?.unit).toBe('nM')
    expect(kd?.provenance).toEqual(LITERATURE)
    expect(kd?.provenance).toBe(LITERATURE) // same object — never rebuilt or mutated
    expect(kd?.provenance).toHaveProperty('syntheticExtension', 'synthetic-extension-value')

    // Sibling parameters keep their original provenance objects too, and the
    // source drug object itself was not mutated along the way.
    expect(input.targets?.[1]?.kd?.provenance).toBe(USER_PROVENANCE)
    expect(input.targets?.[1]?.ic50?.provenance).toBe(USER_PROVENANCE)
    expect(drug.targets[0]?.kd?.provenance).toEqual(LITERATURE)
  })

  it("restamps only the parameter whose value changed; others retain their provenance", async () => {
    const { onSave } = renderEdit(editableFixture())
    const rowA = targetRows()[0] as HTMLElement
    fireEvent.change(within(rowA).getByLabelText('Value *'), { target: { value: '50' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const input = onSave.mock.calls[0]?.[0] as DrugInput
    const kd = input.targets?.[0]?.kd
    expect(kd?.value).toBe(50)
    expectFreshUserStamp(kd?.provenance)

    // Every unaffected parameter keeps its original provenance object.
    expect(input.targets?.[1]?.kd?.provenance).toBe(USER_PROVENANCE)
    expect(input.targets?.[1]?.ic50?.provenance).toBe(USER_PROVENANCE)
  })

  it("restamps only the parameter whose unit changed; others retain their provenance", async () => {
    const { onSave } = renderEdit(editableFixture())
    const rowA = targetRows()[0] as HTMLElement
    fireEvent.change(within(rowA).getByLabelText('Unit *'), { target: { value: 'µM' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const input = onSave.mock.calls[0]?.[0] as DrugInput
    const kd = input.targets?.[0]?.kd
    expect(kd?.value).toBe(12.4)
    expect(kd?.unit).toBe('µM')
    expectFreshUserStamp(kd?.provenance)

    expect(input.targets?.[1]?.kd?.provenance).toBe(USER_PROVENANCE)
    expect(input.targets?.[1]?.ic50?.provenance).toBe(USER_PROVENANCE)
  })

  it('keeps provenance when an equivalent textual number parses to the same value (12.4 → 12.40)', async () => {
    const { onSave } = renderEdit(editableFixture())
    const rowA = targetRows()[0] as HTMLElement
    fireEvent.change(within(rowA).getByLabelText('Value *'), { target: { value: '12.40' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const input = onSave.mock.calls[0]?.[0] as DrugInput
    const kd = input.targets?.[0]?.kd
    expect(kd?.value).toBe(12.4) // Object.is-equal to the stored number
    expect(kd?.provenance).toBe(LITERATURE)
  })

  it("never carries the previous kind's provenance over to a changed kind", async () => {
    const { onSave } = renderEdit(editableFixture())
    const rowA = targetRows()[0] as HTMLElement
    fireEvent.change(within(rowA).getByLabelText('Parameter *'), { target: { value: 'ki' } })
    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const input = onSave.mock.calls[0]?.[0] as DrugInput
    const target = input.targets?.[0]
    expect(target?.kd).toBeUndefined() // the old kind is gone, not merged
    expect(target?.ki?.value).toBe(12.4)
    expect(target?.ki?.unit).toBe('nM')
    expectFreshUserStamp(target?.ki?.provenance) // fresh entry — never the old kind's
    expect(target?.ki?.provenance).not.toHaveProperty('source')

    expect(input.targets?.[1]?.kd?.provenance).toBe(USER_PROVENANCE)
    expect(input.targets?.[1]?.ic50?.provenance).toBe(USER_PROVENANCE)
  })

  it('matches provenance by stable identity only — never by name, position or order', async () => {
    const { onSave } = renderEdit(editableFixture())

    // Rename the surviving target: its own parameters must not move.
    const rowB = targetRows()[1] as HTMLElement
    fireEvent.change(within(rowB).getByLabelText('Target name *'), {
      target: { value: 'TEST-S RENAMED' },
    })

    // Remove the first target — its literature provenance leaves with it.
    fireEvent.click(
      within(targetRows()[0] as HTMLElement).getByRole('button', { name: 'Remove target TEST-R' }),
    )

    // Re-create a target with the same name and the same Kd value/unit as
    // the removed one: a new identity must not inherit the old provenance.
    fireEvent.click(screen.getByTestId('add-target'))
    const rowsAfterAdd = targetRows()
    const newRow = rowsAfterAdd[rowsAfterAdd.length - 1] as HTMLElement
    fireEvent.change(within(newRow).getByLabelText('Target name *'), {
      target: { value: 'TEST-R' },
    })
    fireEvent.click(within(newRow).getByTestId('add-param'))
    fireEvent.change(within(newRow).getByLabelText('Parameter *'), { target: { value: 'kd' } })
    fireEvent.change(within(newRow).getByLabelText('Value *'), { target: { value: '12.4' } })
    fireEvent.change(within(newRow).getByLabelText('Unit *'), { target: { value: 'nM' } })

    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const input = onSave.mock.calls[0]?.[0] as DrugInput
    expect(input.targets).toHaveLength(2)

    // The surviving target shifted array position — its provenance did not.
    const survivor = input.targets?.[0]
    expect(survivor?.id).toBe('fixture-target-2')
    expect(survivor?.name).toBe('TEST-S RENAMED')
    expect(survivor?.kd?.provenance).toBe(USER_PROVENANCE)
    expect(survivor?.ic50?.provenance).toBe(USER_PROVENANCE)

    // The re-created row has no stored identity: a fresh user entry — not
    // the removed target's literature provenance, not the other target's.
    const recreated = input.targets?.[1]
    expect(recreated?.name).toBe('TEST-R')
    expect(recreated).not.toHaveProperty('id')
    expect(recreated?.kd?.value).toBe(12.4)
    expectFreshUserStamp(recreated?.kd?.provenance)
    expect(recreated?.kd?.provenance).not.toHaveProperty('source')
  })

  it('stamps only a newly added parameter with user provenance', async () => {
    const { onSave } = renderEdit(editableFixture())
    const rowA = targetRows()[0] as HTMLElement
    fireEvent.click(within(rowA).getByTestId('add-param'))
    const kinds = within(rowA).getAllByLabelText('Parameter *')
    fireEvent.change(kinds[kinds.length - 1] as HTMLSelectElement, { target: { value: 'ki' } })
    const values = within(rowA).getAllByLabelText('Value *')
    fireEvent.change(values[values.length - 1] as HTMLInputElement, { target: { value: '7' } })
    const units = within(rowA).getAllByLabelText('Unit *')
    fireEvent.change(units[units.length - 1] as HTMLSelectElement, { target: { value: 'nM' } })

    fireEvent.submit(screen.getByTestId('drug-form'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    const input = onSave.mock.calls[0]?.[0] as DrugInput
    const target = input.targets?.[0]
    expect(target?.kd?.provenance).toBe(LITERATURE) // existing parameter untouched
    expect(target?.ki?.value).toBe(7)
    expectFreshUserStamp(target?.ki?.provenance) // new parameter: normal user entry

    expect(input.targets?.[1]?.kd?.provenance).toBe(USER_PROVENANCE)
    expect(input.targets?.[1]?.ic50?.provenance).toBe(USER_PROVENANCE)
  })
})
