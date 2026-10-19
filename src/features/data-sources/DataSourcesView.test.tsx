/**
 * DataSourcesView integration tests (jsdom + fake-indexeddb, real Dexie
 * repositories through the app composition root): the full on-demand
 * chain — search against stubbed PubChem responses, explicit selection,
 * preview, confirmed import into IndexedDB — plus every Layer C apply
 * rule at the UI level (endpoint mapping, qualifiers, occupied slots),
 * plus translator-style DOM mutation resilience: the status paragraphs
 * must survive a page translator re-parenting their text nodes
 * (facebook/react#11538).
 *
 * HTTP is never live: `fetch` is stubbed with checked-in fixtures or a
 * rejecting mock, and one test asserts that mounting the page performs
 * ZERO network requests (no startup download, no seeding). All record
 * content is synthetic test data — not pharmacological information.
 */
import 'fake-indexeddb/auto'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import type { DrugLibrary } from '../../domain/library/library'
import type { RemoteObservation } from '../../domain/sources/observation'
import activitiesFixture from '../../tests/fixtures/sources/chembl-activities.json'
import moleculesFixture from '../../tests/fixtures/sources/chembl-molecules.json'
import targetsFixture from '../../tests/fixtures/sources/chembl-targets.json'
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

/** URL-based ChEMBL mock built from the checked-in fixtures. */
function stubChEMBL(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: string) => {
    const url = String(input)
    if (url.includes('/target/search.json')) return json(targetsFixture)
    if (url.includes('/activity.json')) return json(activitiesFixture)
    if (url.includes('/molecule.json')) return json(moleculesFixture)
    return json({ detail: 'not mocked' }, 404)
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

/** Every ChEMBL activity-request URL the spy has seen, in order. */
function activityUrls(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes('/activity.json'))
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
    sourceId: 'pubchem',
    query: '',
    scope: 'compounds',
    endpointSelection: { mode: 'selected', endpoints: ['Ki', 'Kd', 'IC50', 'EC50'] },
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
  readonly library?: DrugLibrary
  readonly observation?: RemoteObservation
  /** Store the compound with no measurements at all. */
  readonly noObservations?: boolean
} = {}): Promise<void> {
  const observations =
    options.noObservations === true
      ? []
      : [options.observation ?? syntheticObservation()]
  const report = await sourceDataRepository.importSourceRecords({
    compounds: [syntheticCompound()],
    observations,
  })
  expect(report.ok).toBe(true)
  if (options.withLibrary === true) {
    await libraryRepository.replaceLibrary(options.library ?? syntheticLibrary([syntheticDrug()]))
  }
  await useDataSourcesStore.getState().hydrateStored()
}

/** An observation whose endpoint honestly maps to no parameter slot. */
function unmappableObservation(): RemoteObservation {
  const clone: Record<string, unknown> = {
    ...syntheticObservation(),
    id: 'chembl:99000021',
    endpoint: "Log K'",
    provenance: { ...syntheticObservation().provenance, recordId: '99000021' },
  }
  delete clone['parameterKind']
  return clone as unknown as RemoteObservation
}

/**
 * SIMULATION of the DOM mutation a page translator performs — not the real
 * Google Translate extension. Translators re-parent React-rendered text
 * nodes by wrapping them (Google Translate wraps text in <font> elements);
 * when React later removes such a re-parented text node during a status
 * transition, the commit throws
 * "NotFoundError: Failed to execute 'removeChild' on 'Node'" and the tree
 * unmounts (facebook/react#11538; reproduced against the production build).
 * Wraps every non-empty text node under `root` in a <font> element and
 * returns how many were wrapped (0 means the simulation did not apply).
 */
function wrapTextNodesLikeTranslator(root: HTMLElement): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode() !== null) {
    const node = walker.currentNode
    if (node instanceof Text && node.textContent.trim() !== '') textNodes.push(node)
  }
  for (const text of textNodes) {
    const font = document.createElement('font')
    font.setAttribute('style', 'vertical-align: inherit;')
    text.parentNode?.insertBefore(font, text)
    font.appendChild(text)
  }
  return textNodes.length
}

/** Collect uncaught window errors so tests can assert none occurred. */
function trackWindowErrors(): { readonly errors: string[]; stop: () => void } {
  const errors: string[] = []
  const onError = (event: ErrorEvent): void => {
    errors.push(event.message)
  }
  window.addEventListener('error', onError)
  return {
    errors,
    stop: () => {
      window.removeEventListener('error', onError)
    },
  }
}

/** The removeChild DOMException signature of the translator crash. */
function removeChildErrors(errors: readonly string[]): string[] {
  return errors.filter((message) => message.includes('removeChild'))
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

    // The row name ("TEST-S") differs from the reported target — that
    // acknowledgement is required IN ADDITION to the overwrite one.
    fireEvent.click(screen.getByTestId('apply-overwrite'))
    expect(screen.getByTestId('apply-confirm')).toBeDisabled()
    fireEvent.click(screen.getByTestId('apply-target-mismatch-ack'))
    fireEvent.click(screen.getByTestId('apply-confirm'))
    await screen.findByTestId('apply-notice')

    const drug = await libraryRepository.getDrug('fixture-drug-1')
    expect(drug?.targets.find((target) => target.id === 'fixture-target-2')?.ic50?.value).toBe(3.5)
  })

  it('shows both targets together and gates linking on the mismatch acknowledgement', async () => {
    await seedStored({ withLibrary: true })
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('apply-to-parameter-chembl:99000001'))
    await screen.findByTestId('apply-card')
    fireEvent.change(screen.getByTestId('apply-drug-select'), {
      target: { value: 'fixture-drug-1' },
    })
    fireEvent.change(screen.getByTestId('apply-target-select'), {
      target: { value: 'fixture-target-1' },
    })

    // Both sides are shown together — the UI never pretends a name match
    // (or a name mismatch) proves biological identity.
    const comparison = screen.getByTestId('apply-target-comparison')
    expect(comparison).toHaveTextContent('Synthetic Target A')
    expect(comparison).toHaveTextContent('TEST-R')
    expect(screen.getByTestId('apply-target-mismatch')).toBeVisible()
    expect(screen.getByTestId('apply-confirm')).toBeDisabled()

    fireEvent.click(screen.getByTestId('apply-target-mismatch-ack'))
    fireEvent.click(screen.getByTestId('apply-confirm'))
    await screen.findByTestId('apply-notice')

    const drug = await libraryRepository.getDrug('fixture-drug-1')
    const linked = drug?.targets.find((target) => target.id === 'fixture-target-1')
    expect(linked?.ic50?.value).toBe(3.5)
    expect(linked?.ic50?.provenance).toMatchObject({
      type: 'literature',
      observationId: 'chembl:99000001',
    })
  })
})

describe('DataSourcesView — stored panel actions', () => {
  it('adds a compound to the drug library with its complete source snapshot', async () => {
    await seedStored()
    render(<DataSourcesView />)

    const button = await screen.findByTestId('add-to-library-chembl:CHEMBL99990001')
    fireEvent.click(button)

    await waitFor(() => {
      expect(
        screen.getByTestId('linked-notice-chembl:CHEMBL99990001'),
      ).toHaveTextContent('In library')
    })
    const drugs = (await libraryRepository.getAllDrugs()).drugs
    expect(drugs).toHaveLength(1)
    expect(drugs[0]?.identifiers.name).toBe('Synthetic Fixture Compound')
    expect(drugs[0]?.targets).toEqual([]) // no pharmacological values invented
    const snapshot = drugs[0]?.sourceRecords?.[0]
    expect(snapshot?.provenance.url).toBe(
      'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
    )
    expect(snapshot?.provenance.licenseNotice).toContain('CC BY-SA 3.0')
    // Measurements travel with the snapshot; nothing becomes a parameter.
    expect(snapshot?.observations).toHaveLength(1)
    expect(drugs[0]?.notes).toBeUndefined()
  })
})

describe('DataSourcesView — import outcome reporting (phase 36)', () => {
  it('creates a record, then reports the compound as already linked', async () => {
    await seedStored()
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('add-to-library-chembl:CHEMBL99990001'))
    const notice = await screen.findByTestId('apply-notice')
    expect(notice).toHaveTextContent('complete ChEMBL source record')
    expect(notice).toHaveTextContent('1 stored measurement')

    // The row now states the link instead of offering to create a duplicate.
    const linkedNotice = await screen.findByTestId('linked-notice-chembl:CHEMBL99990001')
    expect(linkedNotice).toHaveTextContent('In library')
    expect(linkedNotice).toHaveTextContent('1 stored measurement')
    expect((await libraryRepository.getAllDrugs()).drugs).toHaveLength(1)
  })

  it('links a chosen existing record without replacing its contents', async () => {
    await seedStored({ withLibrary: true })
    render(<DataSourcesView />)

    const select = (await screen.findByTestId(
      'link-target-chembl:CHEMBL99990001',
    )) as HTMLSelectElement
    // The manual record is offered as an explicit choice — never preselected.
    expect(select.value).toBe('')
    const option = within(select).getByRole('option', { name: 'Fixture Compound A' })
    expect(option).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'fixture-drug-1' } })
    fireEvent.click(screen.getByTestId('add-to-library-chembl:CHEMBL99990001'))

    const notice = await screen.findByTestId('apply-notice')
    expect(notice).toHaveTextContent('Linked the ChEMBL source record')
    expect(notice).toHaveTextContent('preserved')

    const drugs = (await libraryRepository.getAllDrugs()).drugs
    expect(drugs).toHaveLength(1) // linked, not duplicated
    const drug = drugs[0]
    expect(drug?.identifiers.name).toBe('Fixture Compound A') // untouched
    expect(drug?.targets).toHaveLength(2) // its parameters survive
    expect(drug?.notes).toBeDefined()
    expect(drug?.sourceRecords).toHaveLength(1)
    expect(drug?.sourceRecords?.[0]?.observations).toHaveLength(1)
  })

  it('reports a failure without claiming success when the target record vanished', async () => {
    await seedStored({ withLibrary: true })
    render(<DataSourcesView />)

    // The store is the boundary that resolves the target; a stale id must
    // fail cleanly instead of creating or overwriting anything.
    const outcome = await useDataSourcesStore
      .getState()
      .addToLibrary('chembl:CHEMBL99990001', { drugId: 'no-such-drug' })
    expect(outcome.status).toBe('failed')
    expect((await libraryRepository.getAllDrugs()).drugs).toHaveLength(1)
  })
})

describe('DataSourcesView — deleting a stored compound (phase 39)', () => {
  it('requires an explicit confirmation naming the compound and its measurement count', async () => {
    await seedStored()
    render(<DataSourcesView />)

    // The row offers Delete, but nothing is deleted by the first click.
    const deleteButton = await screen.findByTestId('delete-compound-chembl:CHEMBL99990001')
    expect(deleteButton).toHaveTextContent('Delete')
    fireEvent.click(deleteButton)

    const confirmation = screen.getByTestId('delete-compound-confirm-text-chembl:CHEMBL99990001')
    expect(confirmation).toHaveTextContent('Synthetic Fixture Compound')
    expect(confirmation).toHaveTextContent('chembl:CHEMBL99990001')
    expect(confirmation).toHaveTextContent('1 associated measurement record')
    expect(confirmation).toHaveTextContent('cannot be undone')
    // The library independence is stated up front.
    expect(confirmation).toHaveTextContent('drug library is not affected')

    // Focus moves into the acknowledgement step.
    expect(document.activeElement).toBe(
      screen.getByTestId('delete-compound-confirm-chembl:CHEMBL99990001'),
    )
    // Nothing was deleted yet.
    expect((await sourceDataRepository.listCompounds()).records).toHaveLength(1)
  })

  it('cancelling leaves the record and its measurements in place', async () => {
    await seedStored()
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('delete-compound-chembl:CHEMBL99990001'))
    fireEvent.click(screen.getByTestId('delete-compound-cancel-chembl:CHEMBL99990001'))

    // Back to the Delete button, with focus restored.
    expect(screen.queryByTestId('delete-compound-confirm-chembl:CHEMBL99990001')).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByTestId('delete-compound-chembl:CHEMBL99990001'),
    )
    expect((await sourceDataRepository.listCompounds()).records).toHaveLength(1)
    expect((await sourceDataRepository.listObservations()).records).toHaveLength(1)
    expect(screen.getByTestId('stored-compounds')).toHaveTextContent('Synthetic Fixture Compound')
  })

  it('Escape cancels the confirmation', async () => {
    await seedStored()
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('delete-compound-chembl:CHEMBL99990001'))
    const panel = screen.getByTestId('delete-compound-confirm-panel-chembl:CHEMBL99990001')
    fireEvent.keyDown(panel, { key: 'Escape' })

    expect(screen.queryByTestId('delete-compound-confirm-chembl:CHEMBL99990001')).toBeNull()
    expect((await sourceDataRepository.listCompounds()).records).toHaveLength(1)
  })

  it('confirms, deletes both records, reports the count and refreshes the panel', async () => {
    await seedStored()
    render(<DataSourcesView />)
    expect(screen.getByTestId('stored-status')).toHaveTextContent('1 compound identity record')

    fireEvent.click(await screen.findByTestId('delete-compound-chembl:CHEMBL99990001'))
    fireEvent.click(screen.getByTestId('delete-compound-confirm-chembl:CHEMBL99990001'))

    const notice = await screen.findByTestId('apply-notice')
    expect(notice).toHaveTextContent('Deleted')
    expect(notice).toHaveTextContent('Synthetic Fixture Compound')
    expect(notice).toHaveTextContent('1 associated measurement record')
    expect(notice).toHaveTextContent('drug library was not changed')

    // The panel re-read IndexedDB: both empty states are back.
    await waitFor(() => {
      expect(screen.getByTestId('stored-compounds-empty')).toBeInTheDocument()
    })
    expect(screen.getByTestId('stored-observations-empty')).toBeInTheDocument()
    expect(screen.getByTestId('stored-status')).toHaveTextContent('0 compound identity records')
    expect(screen.getByTestId('stored-status')).toHaveTextContent('0 measurements')

    // Storage agrees.
    expect((await sourceDataRepository.listCompounds()).records).toEqual([])
    expect((await sourceDataRepository.listObservations()).records).toEqual([])
  })

  it('keeps other compounds and their measurements listed after a deletion', async () => {
    await seedStored()
    // A second compound with its own measurement, imported through the real
    // repository.
    const other = {
      ...syntheticCompound(),
      id: 'chembl:CHEMBL99990002',
      sourceId: 'CHEMBL99990002',
      name: 'Synthetic Fixture Compound B',
      identifiers: { chemblId: 'CHEMBL99990002' },
      provenance: {
        ...syntheticCompound().provenance,
        recordId: 'CHEMBL99990002',
        url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990002',
      },
    }
    const otherObservation = {
      ...syntheticObservation(),
      id: 'chembl:99000007',
      compoundId: 'chembl:CHEMBL99990002',
      compoundSourceId: 'CHEMBL99990002',
      compoundName: 'Synthetic Fixture Compound B',
      provenance: { ...syntheticObservation().provenance, recordId: '99000007' },
    }
    const report = await sourceDataRepository.importSourceRecords({
      compounds: [other],
      observations: [otherObservation],
    })
    expect(report.ok).toBe(true)
    await useDataSourcesStore.getState().hydrateStored()

    render(<DataSourcesView />)
    fireEvent.click(await screen.findByTestId('delete-compound-chembl:CHEMBL99990001'))
    fireEvent.click(screen.getByTestId('delete-compound-confirm-chembl:CHEMBL99990001'))

    // The success notice appears only after the store has actually re-read
    // IndexedDB, so waiting for it synchronises with the deletion; waiting
    // on the Delete button would be trivially true while the confirmation
    // panel was open. The refreshed list then drops the deleted row.
    await screen.findByTestId('apply-notice')
    await waitFor(() => {
      expect(screen.getByTestId('stored-compounds')).not.toHaveTextContent(
        'chembl:CHEMBL99990001',
      )
    })
    const remaining = screen.getByTestId('stored-compounds')
    expect(remaining).toHaveTextContent('Synthetic Fixture Compound B')
    expect(remaining).not.toHaveTextContent('Synthetic Fixture Compound”')
    // The other compound's measurement is still listed.
    expect(screen.getByTestId('stored-observations')).toHaveTextContent('3.5 nM')
    expect((await sourceDataRepository.listObservations()).records.map((o) => o.id)).toEqual([
      'chembl:99000007',
    ])
  })

  it('states honestly when a compound has no measurements to delete', async () => {
    await seedStored({ noObservations: true })
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId('delete-compound-chembl:CHEMBL99990001'))
    const confirmation = screen.getByTestId('delete-compound-confirm-text-chembl:CHEMBL99990001')
    expect(confirmation).toHaveTextContent('no stored measurement records')

    fireEvent.click(screen.getByTestId('delete-compound-confirm-chembl:CHEMBL99990001'))
    const notice = await screen.findByTestId('apply-notice')
    expect(notice).toHaveTextContent('0 associated measurement records')
  })

  it('shows an actionable error and keeps the row when deletion fails', async () => {
    await seedStored()
    render(<DataSourcesView />)
    await screen.findByTestId('delete-compound-chembl:CHEMBL99990001')

    // Force the repository's failure path: the stored row is quarantined.
    await new SandboxDatabase().compounds.put({
      id: 'chembl:CHEMBL99990001',
      source: 'chembl',
    } as never)

    fireEvent.click(screen.getByTestId('delete-compound-chembl:CHEMBL99990001'))
    fireEvent.click(screen.getByTestId('delete-compound-confirm-chembl:CHEMBL99990001'))

    const error = await screen.findByTestId('apply-error')
    expect(error).toHaveTextContent('quarantined')
    expect(error).toHaveTextContent('nothing was deleted')
    // No success notice is claimed.
    expect(screen.queryByTestId('apply-notice')).toBeNull()
  })
})

describe('DataSourcesView — measurement endpoint multi-select (phase 40)', () => {
  /** ChEMBL source, one searched-and-selected compound — ready to fetch. */
  async function searchAndSelectCompound(): Promise<void> {
    useDataSourcesStore.setState({ sourceId: 'chembl' })
    render(<DataSourcesView />)
    fireEvent.change(screen.getByTestId('query-input'), {
      target: { value: 'synthetic fixture' },
    })
    fireEvent.click(screen.getByTestId('search-button'))
    // The fixture search returns two compounds — wait for and select the
    // one whose id the fetch helper targets.
    fireEvent.click(await screen.findByTestId('compound-select-chembl:CHEMBL99990001'))
  }

  it('offers the four parameter endpoints as independent, accessible choices (default: all four)', () => {
    const spy = stubChEMBL()
    useDataSourcesStore.setState({ sourceId: 'chembl' })
    render(<DataSourcesView />)

    // The default selection matches the previous parameter-only behaviour.
    expect(screen.getByTestId('endpoint-option-ki')).toBeChecked()
    expect(screen.getByTestId('endpoint-option-kd')).toBeChecked()
    expect(screen.getByTestId('endpoint-option-ic50')).toBeChecked()
    expect(screen.getByTestId('endpoint-option-ec50')).toBeChecked()
    expect(screen.getByTestId('endpoint-option-all')).not.toBeChecked()

    // A properly labelled group; every option is an independently named,
    // keyboard-operable checkbox.
    const group = screen.getByRole('group', { name: 'Measurement endpoints to retrieve' })
    expect(group).toBe(screen.getByTestId('endpoint-selection'))
    for (const name of ['Ki', 'Kd', 'IC50', 'EC50', 'All reported endpoints']) {
      expect(within(group).getByRole('checkbox', { name })).toBeInTheDocument()
    }

    // Choosing is a local decision — it performs no retrieval.
    fireEvent.click(screen.getByTestId('endpoint-option-ki'))
    expect(screen.getByTestId('endpoint-option-ki')).not.toBeChecked()
    expect(activityUrls(spy)).toEqual([])
  })

  it('sends only the checked endpoints; "All reported endpoints" omits the filter', async () => {
    const spy = stubChEMBL()
    await searchAndSelectCompound()

    fireEvent.click(screen.getByTestId('endpoint-option-ki')) // Ki off
    fireEvent.click(screen.getByTestId('fetch-observations-button'))
    await screen.findByTestId('observation-rows')
    expect(activityUrls(spy)[0] ?? '').toContain('standard_type__in=Kd%2CIC50%2CEC50')
    expect(screen.getByTestId('observations-status')).toHaveTextContent('endpoints: Kd, IC50, EC50')

    // "All reported endpoints" disables the four individual choices while
    // it is active — the modes cannot ambiguously combine...
    fireEvent.click(screen.getByTestId('endpoint-option-all'))
    expect(screen.getByTestId('endpoint-option-all')).toBeChecked()
    expect(screen.getByTestId('endpoint-option-kd')).toBeDisabled()
    expect(screen.getByTestId('endpoint-option-kd')).not.toBeChecked()

    // ...and the request intentionally carries no endpoint filter.
    fireEvent.click(screen.getByTestId('fetch-observations-button'))
    await waitFor(() => expect(activityUrls(spy)).toHaveLength(2))
    expect(activityUrls(spy)[1] ?? '').not.toContain('standard_type__in')
    await waitFor(() =>
      expect(screen.getByTestId('observations-status')).toHaveTextContent(
        'endpoints: all reported endpoints',
      ),
    )
  })

  it('blocks retrieval with a validation message when no endpoint is selected', async () => {
    const spy = stubChEMBL()
    await searchAndSelectCompound()

    for (const testId of [
      'endpoint-option-ki',
      'endpoint-option-kd',
      'endpoint-option-ic50',
      'endpoint-option-ec50',
    ]) {
      fireEvent.click(screen.getByTestId(testId))
    }

    expect(screen.getByTestId('endpoint-selection-error')).toHaveTextContent(
      'Select at least one endpoint',
    )
    expect(screen.getByTestId('fetch-observations-button')).toBeDisabled()
    expect(screen.getByTestId('fetch-hint')).toHaveTextContent('endpoint')

    // A disabled button performs nothing — an empty selection can never
    // become an unfiltered request.
    fireEvent.click(screen.getByTestId('fetch-observations-button'))
    expect(activityUrls(spy)).toEqual([])
  })

  it('clears already-fetched rows when the filter changes (the label cannot misdescribe them)', async () => {
    const spy = stubChEMBL()
    await searchAndSelectCompound()

    fireEvent.click(screen.getByTestId('fetch-observations-button'))
    await screen.findByTestId('observation-rows')
    expect(screen.getByTestId('observations-status')).toHaveTextContent(
      'endpoints: Ki, Kd, IC50, EC50',
    )

    fireEvent.click(screen.getByTestId('endpoint-option-ki')) // filter change
    expect(screen.queryByTestId('observation-rows')).toBeNull()
    expect(screen.getByTestId('observations-status')).toHaveTextContent(
      'No measurements fetched yet.',
    )

    fireEvent.click(screen.getByTestId('fetch-observations-button'))
    await waitFor(() => expect(activityUrls(spy)).toHaveLength(2))
    expect(activityUrls(spy)[1] ?? '').toContain('standard_type__in=Kd%2CIC50%2CEC50')
  })
})

describe('DataSourcesView — translator-style DOM mutation resilience (facebook/react#11538)', () => {
  /**
   * The status paragraphs below used to render several mutually exclusive
   * conditional text children. A translator re-parents those text nodes;
   * the state transition then removes a text node that is no longer a child
   * of the paragraph and React's commit throws NotFoundError, unmounting
   * the app (reproduced against the production build). Each test wraps the
   * live status text, drives a real state transition, and asserts that the
   * UI survives, no removeChild exception is raised, and the correct text
   * stays visible.
   */

  it('keeps the search status alive across results → searching → results after a text-node wrap', async () => {
    stubPubChem()
    render(<DataSourcesView />)

    fireEvent.change(screen.getByTestId('query-input'), { target: { value: 'synthetic' } })
    fireEvent.click(screen.getByTestId('search-button'))
    await screen.findByText('1 result')
    expect(screen.getByTestId('compound-results')).toBeInTheDocument()

    // Reach into the live DOM exactly as a translator would.
    expect(wrapTextNodesLikeTranslator(screen.getByTestId('search-status'))).toBe(1)

    const tracker = trackWindowErrors()
    fireEvent.click(screen.getByTestId('search-button'))
    await waitFor(() => {
      expect(screen.getByTestId('search-status')).toHaveTextContent('1 result')
    })
    tracker.stop()

    expect(removeChildErrors(tracker.errors)).toEqual([])
    expect(screen.getByTestId('data-sources-view')).toBeInTheDocument()
    expect(screen.getByTestId('search-status')).toHaveTextContent('1 result')
    expect(screen.getByTestId('compound-results')).toBeInTheDocument()
  })

  it('keeps the stored-data status alive across loading → ready after a text-node wrap', () => {
    // Mount in 'loading' so the status text exists before the wrap. The
    // store's hydrateStored() has an in-flight guard for this state, so the
    // loading → ready transition it performs is driven directly on the
    // store — the UI reconciliation is exactly what this test covers.
    useDataSourcesStore.setState({
      stored: {
        status: 'loading',
        error: null,
        compounds: [],
        observations: [],
        drugs: [],
        quarantinedCompounds: 0,
        quarantinedObservations: 0,
      },
    })
    render(<DataSourcesView />)
    screen.getByText('Reading stored records…')

    expect(wrapTextNodesLikeTranslator(screen.getByTestId('stored-status'))).toBe(1)

    const tracker = trackWindowErrors()
    act(() => {
      useDataSourcesStore.setState({
        stored: {
          status: 'ready',
          error: null,
          compounds: [],
          observations: [],
          drugs: [],
          quarantinedCompounds: 0,
          quarantinedObservations: 0,
        },
      })
    })
    tracker.stop()

    expect(removeChildErrors(tracker.errors)).toEqual([])
    expect(screen.getByTestId('stored-status')).toHaveTextContent(
      '0 compound identity records · 0 measurements · 0 drug records',
    )
    expect(screen.getByTestId('data-sources-view')).toBeInTheDocument()
  })

  it('keeps the measurements status alive across idle → loading after a text-node wrap', () => {
    useDataSourcesStore.setState({ sourceId: 'chembl' })
    render(<DataSourcesView />)

    // ChEMBL offers measurements, so the live status paragraph is shown.
    expect(screen.getByTestId('observations-status')).toHaveTextContent(
      'No measurements fetched yet.',
    )
    expect(wrapTextNodesLikeTranslator(screen.getByTestId('observations-status'))).toBe(1)

    const tracker = trackWindowErrors()
    act(() => {
      useDataSourcesStore.setState({
        observations: { ...useDataSourcesStore.getState().observations, status: 'loading' },
      })
    })
    tracker.stop()

    expect(screen.getByTestId('observations-status')).toHaveTextContent('Fetching measurements…')
    expect(removeChildErrors(tracker.errors)).toEqual([])
    expect(screen.getByTestId('data-sources-view')).toBeInTheDocument()
  })

  it('keeps the selected-row comparison alive across a target switch after a text-node wrap', async () => {
    // One fixture target reports a species, the other does not — switching
    // between them makes the species suffix of the line disappear.
    const drug = syntheticDrug({
      targets: [
        { id: 'fixture-target-1', name: 'TEST-R', species: 'Mus musculus' },
        { id: 'fixture-target-2', name: 'TEST-S' },
      ],
    })
    await seedStored({ withLibrary: true, library: syntheticLibrary([drug]) })
    render(<DataSourcesView />)

    fireEvent.click(await screen.findByTestId(`apply-to-parameter-${syntheticObservation().id}`))
    fireEvent.change(screen.getByTestId('apply-drug-select'), {
      target: { value: 'fixture-drug-1' },
    })
    fireEvent.change(screen.getByTestId('apply-target-select'), {
      target: { value: 'fixture-target-1' },
    })
    await screen.findByTestId('apply-target-comparison')
    expect(screen.getByTestId('apply-selected-target')).toHaveTextContent(
      'Selected row: “TEST-R”, species “Mus musculus”',
    )

    expect(wrapTextNodesLikeTranslator(screen.getByTestId('apply-selected-target'))).toBe(1)

    const tracker = trackWindowErrors()
    fireEvent.change(screen.getByTestId('apply-target-select'), {
      target: { value: 'fixture-target-2' },
    })
    tracker.stop()

    expect(screen.getByTestId('apply-selected-target')).toHaveTextContent('Selected row: “TEST-S”')
    expect(screen.getByTestId('apply-selected-target')).not.toHaveTextContent('species')
    expect(removeChildErrors(tracker.errors)).toEqual([])
    expect(screen.getByTestId('data-sources-view')).toBeInTheDocument()
  })
})
