/**
 * "Edit then reload keeps the imported data" (phase 36), through the real
 * UI chain: import a compound from Data Sources into the Library, open the
 * record, edit it through the actual form, save, re-read storage with a
 * FRESH repository (the reload path), and assert the source snapshot and
 * its measurements are still there — while the edit itself did land.
 *
 * All fixture values are synthetic test data — not pharmacological
 * information.
 */
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sourceDataRepository, useDataSourcesStore } from '@/app/dataSourcesStore'
import { libraryRepository, useLibraryStore } from '@/app/libraryStore'
import { SandboxDatabase } from '@/data/db/database'
import { DexieDrugRepository } from '@/data/repositories/dexieDrugRepository'
import { syntheticCompound, syntheticDrug, syntheticObservation } from '../../tests/fixtures'
import { DrugDetailView } from './DrugDetailView'

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
  useDataSourcesStore.setState({
    stored: {
      status: 'idle',
      error: null,
      compounds: [],
      observations: [],
      drugs: [],
      quarantinedCompounds: 0,
      quarantinedObservations: 0,
    },
    actionError: null,
    actionNotice: null,
  })

  // 1. Store a source compound and one measurement (Layer A + Layer B).
  const report = await sourceDataRepository.importSourceRecords({
    compounds: [syntheticCompound()],
    observations: [syntheticObservation()],
  })
  expect(report.ok).toBe(true)
  await useDataSourcesStore.getState().hydrateStored()

  // 2. Import it into the Library through the real store action.
  const outcome = await useDataSourcesStore.getState().addToLibrary('chembl:CHEMBL99990001')
  if (outcome.status !== 'created') throw new Error('expected a created record')
  drugId = outcome.drug.id
  await useLibraryStore.getState().hydrate()
})

afterEach(() => {
  cleanup()
})

function renderDetail(id: string = drugId) {
  return render(
    <MemoryRouter initialEntries={[`/library/${id}`]}>
      <Routes>
        <Route path="/library/:drugId" element={<DrugDetailView drugId={id} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('imported source data survives an ordinary edit and a reload', () => {
  it('keeps identifiers, properties, attribution and measurements after a rename', async () => {
    renderDetail()
    expect(await screen.findByTestId('drug-source-data')).toBeInTheDocument()

    // Edit the record through the real form — name and notes only.
    fireEvent.click(screen.getByTestId('edit-drug'))
    fireEvent.change(screen.getByTestId('drug-name'), {
      target: { value: 'Renamed Fixture Compound' },
    })
    fireEvent.change(screen.getByLabelText('Notes'), {
      target: { value: 'User note added after the import' },
    })
    fireEvent.click(screen.getByTestId('save-drug'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    // The edit landed…
    const fresh = new DexieDrugRepository(new SandboxDatabase())
    const reloaded = await fresh.getDrug(drugId)
    expect(reloaded?.identifiers.name).toBe('Renamed Fixture Compound')
    expect(reloaded?.notes).toBe('User note added after the import')

    // …and the complete source snapshot is intact.
    expect(reloaded?.sourceRecords).toHaveLength(1)
    const snapshot = reloaded?.sourceRecords?.[0]
    expect(snapshot?.source).toBe('chembl')
    expect(snapshot?.sourceId).toBe('CHEMBL99990001')
    expect(snapshot?.synonyms).toEqual(['SFC-1'])
    expect(snapshot?.identifiers.inchiKey).toBe('FIXTUREKEYSXYZ-UHFFFAOYSA-N')
    expect(snapshot?.provenance.licenseNotice).toContain('CC BY-SA 3.0')
    expect(snapshot?.observations).toHaveLength(1)
    expect(snapshot?.observations[0]?.value).toBe(3.5)
    expect(snapshot?.observations[0]?.qualifier).toBe('=')

    // A full session reload re-renders the imported data from storage.
    cleanup()
    await useLibraryStore.getState().hydrate()
    renderDetail()
    const section = await screen.findByTestId('drug-source-data')
    expect(section).toHaveTextContent('FIXTUREKEYSXYZ-UHFFFAOYSA-N')
    expect(section).toHaveTextContent('CC BY-SA 3.0')
    expect(screen.getByTestId('source-observations')).toHaveTextContent('3.5 nM')
  })

  it('keeps imported data when the user adds a target parameter by hand', async () => {
    renderDetail()
    await screen.findByTestId('drug-source-data')

    fireEvent.click(screen.getByTestId('edit-drug'))
    fireEvent.click(screen.getByTestId('add-target'))
    const nameInputs = screen.getAllByLabelText(/Target name/)
    fireEvent.change(nameInputs[nameInputs.length - 1] as HTMLInputElement, {
      target: { value: 'MANUAL-TARGET' },
    })
    fireEvent.click(screen.getByTestId('add-param'))
    fireEvent.change(screen.getByLabelText('Parameter *'), { target: { value: 'kd' } })
    fireEvent.change(screen.getByLabelText('Value *'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Unit *'), { target: { value: 'nM' } })
    fireEvent.click(screen.getByTestId('save-drug'))
    await waitFor(() => expect(screen.queryByTestId('drug-form')).not.toBeInTheDocument())

    const fresh = new DexieDrugRepository(new SandboxDatabase())
    const reloaded = await fresh.getDrug(drugId)
    expect(reloaded?.targets).toHaveLength(1)
    expect(reloaded?.targets[0]?.kd?.value).toBe(5)
    // The user-entered parameter is distinct from the imported measurement.
    expect(reloaded?.sourceRecords?.[0]?.observations[0]?.value).toBe(3.5)
    expect(reloaded?.targets[0]?.kd?.provenance.type).toBe('user')
  })
})

describe('imported source data is independent of the transient selection', () => {
  it('stays readable after the source-data session is cleared entirely', async () => {
    renderDetail()
    await screen.findByTestId('drug-source-data')

    // Drop every piece of session state — nothing about the selection, the
    // stored lists or the source stores is needed to read the record.
    useDataSourcesStore.setState({
      stored: {
        status: 'idle',
        error: null,
        compounds: [],
        observations: [],
        drugs: [],
        quarantinedCompounds: 0,
        quarantinedObservations: 0,
      },
    })
    cleanup()

    const fresh = new DexieDrugRepository(new SandboxDatabase())
    const reloaded = await fresh.getDrug(drugId)
    expect(reloaded?.sourceRecords?.[0]?.identifiers.molecularFormula).toBeUndefined()
    expect(reloaded?.sourceRecords?.[0]?.identifiers.chemblId).toBe('CHEMBL99990001')

    useLibraryStore.setState({ status: 'ready', drugs: reloaded === undefined ? [] : [reloaded] })
    renderDetail()
    expect(await screen.findByTestId('drug-source-data')).toHaveTextContent('CHEMBL99990001')
  })
})

describe('a record that never imported source data', () => {
  it('renders no source section and is unaffected by the feature', async () => {
    await libraryRepository.replaceLibrary({
      metadata: {
        id: 'local-library',
        name: 'Local library',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dataStatus: 'user',
      },
      drugs: [syntheticDrug()],
    })
    await useLibraryStore.getState().hydrate()
    renderDetail('fixture-drug-1')
    expect(await screen.findByTestId('drug-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('drug-source-data')).not.toBeInTheDocument()
  })
})
