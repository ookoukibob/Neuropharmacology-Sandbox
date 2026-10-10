/**
 * DataSourcesView integration tests (jsdom + fake-indexeddb, real Dexie
 * repositories through the app composition root): the full on-demand
 * chain — search against stubbed PubChem responses, explicit selection,
 * preview, confirmed import into IndexedDB — plus every Layer C apply
 * rule at the UI level (endpoint mapping, qualifiers, occupied slots).
 *
 * HTTP is never live: `fetch` is stubbed with checked-in fixtures or a
 * rejecting mock, and one test asserts that mounting the page performs
 * ZERO network requests (no startup download, no seeding). All record
 * content is synthetic test data — not pharmacological information.
 */
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceDataRepository, useDataSourcesStore } from '@/app/dataSourcesStore'
import { libraryRepository, useLibraryStore } from '@/app/libraryStore'
import { SandboxDatabase } from '@/data/db/database'
import {
  syntheticCompound,
  syntheticDrug,
  syntheticLibrary,
  syntheticObservation,
} from '../../tests/fixtures'
import type { RemoteObservation } from '../../domain/sources/observation'
import cidsFixture from '../../tests/fixtures/sources/pubchem-cids.json'
import propertiesFixture from '../../tests/fixtures/sources/pubchem-properties.json'
import synonymsFixture from '../../tests/fixtures/sources/pubchem-synonyms.json'
import { DataSourcesView } from './DataSourcesView'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** URL-based PubChem PUG REST mock built from the checked-in fixtures. */
function stubPubChem(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: string) => {
    const url = String(input)
    if (url.includes('/cids/JSON')) return json(cidsFixture)
    if (url.includes('/property/')) return json(propertiesFixture)
    if (url.includes('/synonyms/JSON')) return json(synonymsFixture)
    return json({ Fault: { Code: 'PUGREST.NotFound' } }, 404)
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

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
    query: '',
    scope: 'compounds',
    endpointScope: 'parameters',
    search: { status: 'idle', error: null, errorCode: null, compounds: [], targets: [] },
    activeTarget: null,
    observations: {
      status: 'idle',
      error: null,
      errorCode: null,
      items: [],
      total: null,
      nextOffset: null,
      omitted: 0,
      fetchedFor: null,
      pageSource: null,
    },
    selectedCompoundIds: [],
    selectedObservationIds: [],
    importOutcome: null,
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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Seed real repositories, then reflect them into the session state. */
async function seedStored(options: {
  readonly withLibrary?: boolean
  readonly observation?: RemoteObservation
} = {}): Promise<void> {
  const report = await sourceDataRepository.importSourceRecords({
    compounds: [syntheticCompound()],
    observations: [options.observation ?? syntheticObservation()],
  })
  expect(report.ok).toBe(true)
  if (options.withLibrary === true) {
    await libraryRepository.replaceLibrary(syntheticLibrary([syntheticDrug()]))
  }
  await useDataSourcesStore.getState().hydrateStored()
}

/** An observation whose endpoint honestly maps to no parameter slot. */
function unmappableObservation(): RemoteObservation {
  const clone: Record<string, unknown> = {
    ...syntheticObservation(),
    id: 'chembl:99000021',
    endpoint: "Log K'",
  }
  delete clone['parameterKind']
  return clone as unknown as RemoteObservation
}

describe('DataSourcesView — startup and search', () => {
  it('renders the source picker and empty stored panel with ZERO network requests', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    render(<DataSourcesView />)

    // Both sources offered; nothing hardcoded beyond the adapter registry.
    const picker = screen.getByTestId('source-select')
    expect(picker).toHaveValue('pubchem')
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['PubChem', 'ChEMBL'])

    // Stored panel reflects an empty database — and nothing was fetched.
    expect(await screen.findByText(/0 compound identity records/)).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()

    // Identity-only sources say so instead of pretending to offer activity.
    expect(screen.getByTestId('observations-unavailable')).toHaveTextContent(
      'not presented as an activity source',
    )
    expect(screen.getByTestId('on-demand-notice')).toHaveTextContent('never')
    expect(screen.getByTestId('source-attribution')).toHaveTextContent('PubChem aggregates')
  })

  it('searches, previews and imports a selection into IndexedDB on confirmation', async () => {
    stubPubChem()
    render(<DataSourcesView />)

    fireEvent.change(screen.getByTestId('query-input'), { target: { value: 'synthetic' } })
    fireEvent.click(screen.getByTestId('search-button'))

    await screen.findByTestId('compound-result')
    expect(screen.getByTestId('search-status')).toHaveTextContent('1 result')
    expect(screen.getByTestId('compound-results')).toHaveTextContent('Synthetic Fixture Compound')
    // Identity facts are shown, not invented.
    expect(screen.getByTestId('compound-results')).toHaveTextContent('C12H14N2O')
    expect(screen.getByTestId('compound-results')).toHaveTextContent('SFC-1')

    // Nothing is written by searching or selecting.
    fireEvent.click(screen.getByTestId('compound-select-pubchem:90000001'))
    expect(screen.getByTestId('import-preview-text')).toHaveTextContent(
      '1 compound identity record',
    )
    expect(screen.getByTestId('import-preview-text')).toHaveTextContent('0 measurement records')
    expect((await sourceDataRepository.listCompounds()).records).toEqual([])

    fireEvent.click(screen.getByTestId('confirm-import-button'))
    const report = await screen.findByTestId('import-report')
    expect(report).toHaveTextContent('1 new compound identity record')
    expect(report).toHaveTextContent('0 new measurement records')

    // The stored panel now lists it — from the real repository.
    const stored = await screen.findByTestId('stored-compounds')
    expect(within(stored).getByText('Synthetic Fixture Compound')).toBeTruthy()
    const records = (await sourceDataRepository.listCompounds()).records
    expect(records.map((record) => record.id)).toEqual(['pubchem:90000001'])
    expect(records[0]?.provenance.url).toContain('pubchem.ncbi.nlm.nih.gov')
  })

  it('surfaces a network failure as a code-specific, retryable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    render(<DataSourcesView />)

    fireEvent.change(screen.getByTestId('query-input'), { target: { value: 'synthetic' } })
    fireEvent.click(screen.getByTestId('search-button'))

    const error = await screen.findByTestId('search-error', {}, { timeout: 5000 })
    expect(error).toHaveTextContent('Network error')
    expect(screen.getByTestId('search-status')).toHaveTextContent('The search failed')
    expect(screen.getByTestId('retry-search')).toBeTruthy()
    // A failed search writes nothing.
    expect((await sourceDataRepository.listCompounds()).records).toEqual([])
  })

  it('reports an empty result set honestly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ IdentifierList: { CID: [] } })),
    )
    render(<DataSourcesView />)

    fireEvent.change(screen.getByTestId('query-input'), { target: { value: 'nothing' } })
    fireEvent.click(screen.getByTestId('search-button'))
    await waitFor(() =>
      expect(screen.getByTestId('search-status')).toHaveTextContent('No matches for'),
    )
    expect(screen.queryByTestId('compound-result')).toBeNull()
  })
})

describe('DataSourcesView — applying a stored observation (Layer C)', () => {
  it('applies a measurement onto a new target with a provenance link to the observation', async () => {
    await seedStored({ withLibrary: true })
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('apply-to-parameter-chembl:99000001'))
    await screen.findByTestId('apply-card')
    expect(screen.getByTestId('apply-observation-summary')).toHaveTextContent('IC50 = 3.5 nM')

    fireEvent.change(screen.getByTestId('apply-drug-select'), {
      target: { value: 'fixture-drug-1' },
    })
    fireEvent.click(screen.getByTestId('apply-confirm'))

    await screen.findByTestId('apply-notice')
    expect(screen.getByTestId('apply-notice')).toHaveTextContent('Applied IC50')

    const drug = await libraryRepository.getDrug('fixture-drug-1')
    const created = drug?.targets.find((target) => target.name === 'Synthetic Target A')
    expect(created?.ic50?.value).toBe(3.5)
    expect(created?.ic50?.unit).toBe('nM')
    expect(created?.ic50?.provenance).toMatchObject({
      type: 'literature',
      observationId: 'chembl:99000001',
    })
  })

  it('refuses an endpoint that maps to no parameter slot (no substitution)', async () => {
    await seedStored({ withLibrary: true, observation: unmappableObservation() })
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('apply-to-parameter-chembl:99000021'))
    await screen.findByTestId('apply-card')
    expect(screen.getByTestId('apply-unmappable')).toHaveTextContent('never')
    expect(screen.getByTestId('apply-confirm')).toBeDisabled()

    // The stored drug record is untouched.
    const drug = await libraryRepository.getDrug('fixture-drug-1')
    expect(drug?.targets.find((target) => target.id === 'fixture-target-2')?.ic50?.value).toBe(88)
  })

  it('shows the bound-value note and keeps apply disabled for a "<" qualifier', async () => {
    const bounded: RemoteObservation = { ...syntheticObservation(), qualifier: '<' }
    await seedStored({ withLibrary: true, observation: bounded })
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('apply-to-parameter-chembl:99000001'))
    await screen.findByTestId('apply-card')
    expect(screen.getByTestId('apply-qualifier-note')).toHaveTextContent('“<”')
    expect(screen.getByTestId('apply-confirm')).toBeDisabled()
  })

  it('requires the explicit overwrite checkbox for an occupied slot', async () => {
    await seedStored({ withLibrary: true })
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('apply-to-parameter-chembl:99000001'))
    await screen.findByTestId('apply-card')
    fireEvent.change(screen.getByTestId('apply-drug-select'), {
      target: { value: 'fixture-drug-1' },
    })
    // Pick the target whose IC50 slot is already occupied.
    fireEvent.change(screen.getByTestId('apply-target-select'), {
      target: { value: 'fixture-target-2' },
    })

    expect(screen.getByTestId('apply-overwrite-wrapper')).toHaveTextContent('88 nM')
    expect(screen.getByTestId('apply-confirm')).toBeDisabled()

    fireEvent.click(screen.getByTestId('apply-overwrite'))
    fireEvent.click(screen.getByTestId('apply-confirm'))
    await screen.findByTestId('apply-notice')

    const drug = await libraryRepository.getDrug('fixture-drug-1')
    expect(drug?.targets.find((target) => target.id === 'fixture-target-2')?.ic50?.value).toBe(3.5)
  })
})

describe('DataSourcesView — stored panel actions', () => {
  it('adds a compound to the drug library as identity only, with attribution', async () => {
    await seedStored()
    render(<DataSourcesView />)

    const button = await screen.findByTestId('add-to-library-chembl:CHEMBL99990001')
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByTestId('add-to-library-chembl:CHEMBL99990001')).toHaveTextContent('In library')
    })
    const drugs = (await libraryRepository.getAllDrugs()).drugs
    expect(drugs).toHaveLength(1)
    expect(drugs[0]?.identifiers.name).toBe('Synthetic Fixture Compound')
    expect(drugs[0]?.targets).toEqual([]) // no pharmacological values invented
    expect(drugs[0]?.notes).toContain('https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001')
    expect(drugs[0]?.notes).toContain('CC BY-SA 3.0')
  })
})
