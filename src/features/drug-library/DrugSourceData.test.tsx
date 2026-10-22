/**
 * Drug detail UI for imported source data (phase 36): the sections a user
 * must be able to reach from the normal Library workflow — identifiers,
 * chemical properties, source attribution/license and the imported
 * experimental observations — plus the honest empty states and the
 * list-level source-origin indicator.
 *
 * The store is seeded directly with synthetic fixture state; no database
 * access happens here, and every value is invented test data.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { Drug } from '@/domain/drug/drug'
import type { DrugSourceRecord } from '@/domain/drug/source-data'
import { FIXTURE_TIMESTAMP, syntheticDrug, syntheticObservation } from '../../tests/fixtures'
import { useLibraryStore } from '@/app/libraryStore'
import { DrugDetailView } from './DrugDetailView'
import { DrugLibraryView } from './DrugLibraryView'

const CHEMBL_ATTRIBUTION = {
  source: 'chembl',
  sourceName: 'ChEMBL',
  recordId: 'CHEMBL99990001',
  url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
  retrievedAt: FIXTURE_TIMESTAMP,
  sourceVersion: 'ChEMBL_36',
  licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
}

function snapshot(overrides: Partial<DrugSourceRecord> = {}): DrugSourceRecord {
  return {
    source: 'chembl',
    sourceId: 'CHEMBL99990001',
    name: 'Synthetic Fixture Compound',
    synonyms: ['SFC-1', 'Fixture Alias'],
    identifiers: {
      chemblId: 'CHEMBL99990001',
      pubchemCid: '90000001',
      inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
      molecularFormula: 'C12H14N2O',
      molecularWeight: 202.25,
      casNumber: 'SYNTH-CAS-0001',
    },
    provenance: CHEMBL_ATTRIBUTION,
    observations: [syntheticObservation()],
    importedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

/** A snapshot carrying only the fields a minimal source record supplies. */
function sparseSnapshot(): DrugSourceRecord {
  const { name: _noName, ...base } = snapshot({
    synonyms: [],
    identifiers: { chemblId: 'CHEMBL99990001' },
    provenance: {
      source: 'chembl',
      sourceName: 'ChEMBL',
      recordId: 'CHEMBL99990001',
      url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
      retrievedAt: FIXTURE_TIMESTAMP,
    },
    observations: [],
  })
  return base
}

function drugWithSource(overrides: Partial<Drug> = {}): Drug {
  return { ...syntheticDrug(), sourceRecords: [snapshot()], ...overrides }
}

function renderDetail(drug: Drug): void {
  useLibraryStore.setState({ status: 'ready', drugs: [drug], metadata: undefined })
  render(
    <MemoryRouter initialEntries={[`/library/${drug.id}`]}>
      <Routes>
        <Route path="/library/:drugId" element={<DrugDetailView drugId={drug.id} />} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderList(drugs: readonly Drug[]): void {
  useLibraryStore.setState({ status: 'ready', drugs, metadata: undefined })
  render(
    <MemoryRouter initialEntries={['/library']}>
      <Routes>
        <Route path="/library" element={<DrugLibraryView />} />
        <Route path="/library/:drugId" element={<p>detail page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  // Unmount before touching the store so no mounted view sees the reset.
  cleanup()
  useLibraryStore.setState({
    status: 'idle',
    drugs: [],
    metadata: undefined,
    quarantine: [],
    selectedDrugId: null,
    error: null,
    filter: '',
  })
})

describe('DrugDetailView — imported source data', () => {
  it('renders identifiers, chemical properties and attribution', () => {
    renderDetail(drugWithSource())

    const section = screen.getByTestId('drug-source-data')
    expect(section).toBeInTheDocument()

    const identifiers = within(section).getByTestId('source-identifiers')
    expect(identifiers).toHaveTextContent('Synthetic Fixture Compound')
    expect(identifiers).toHaveTextContent('SFC-1, Fixture Alias')
    expect(identifiers).toHaveTextContent('SYNTH-CAS-0001')
    expect(identifiers).toHaveTextContent('90000001')
    expect(identifiers).toHaveTextContent('CHEMBL99990001')
    expect(identifiers).toHaveTextContent('FIXTUREKEYSXYZ-UHFFFAOYSA-N')

    const properties = within(section).getByTestId('source-chemical-properties')
    expect(properties).toHaveTextContent('C12H14N2O')
    const formula = within(section).getByTestId('source-field-Molecular formula')
    expect(
      [...formula.querySelectorAll('sub')].map((element) => element.textContent),
    ).toEqual(['12', '14', '2'])
    expect(properties).toHaveTextContent('202.25 g/mol')
    expect(properties).toHaveTextContent('CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1')

    const attribution = within(section).getByTestId('source-attribution')
    expect(attribution).toHaveTextContent('ChEMBL')
    expect(attribution).toHaveTextContent('ChEMBL_36')
    expect(attribution).toHaveTextContent('CC BY-SA 3.0')
    expect(attribution).toHaveTextContent(FIXTURE_TIMESTAMP)
    const recordLink = within(section).getByTestId('source-record-link')
    expect(recordLink).toHaveAttribute(
      'href',
      'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
    )
    expect(recordLink).toHaveAttribute('target', '_blank')
    expect(recordLink).toHaveAttribute('rel', 'noreferrer noopener')
  })

  it('renders each imported observation with its context and provenance', () => {
    renderDetail(drugWithSource())
    const list = screen.getByTestId('source-observations')
    const rows = within(list).getAllByTestId('imported-observation')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row === undefined) throw new Error('expected an observation row')
    expect(row).toHaveTextContent('IC50')
    expect(row).toHaveTextContent('3.5 nM')
    expect(row).toHaveTextContent('Synthetic Target A')
    expect(row).toHaveTextContent('CHEMBL99991001')
    expect(row).toHaveTextContent('species Homo sapiens')
    expect(row).toHaveTextContent('maps to IC50')
    const source = within(row).getByTestId('imported-observation-source')
    expect(source).toHaveTextContent('ChEMBL record 99000001')
    expect(source).toHaveTextContent('CC BY-SA 3.0')
    expect(source.querySelector('a')).toHaveAttribute(
      'href',
      'https://www.ebi.ac.uk/chembl/api/data/activity.json?activity_id=99000001',
    )
  })

  it('keeps disagreeing measurements separate — nothing averaged or merged', () => {
    const second = syntheticObservation({
      id: 'chembl:99000002',
      value: 9.1,
      qualifier: '>',
      endpoint: 'Ki',
      parameterKind: 'ki',
      assay: { assayId: 'CHEMBL99992002', assayType: 'F', description: 'Synthetic functional assay' },
      provenance: { ...syntheticObservation().provenance, recordId: '99000002' },
    })
    renderDetail(
      drugWithSource({
        sourceRecords: [snapshot({ observations: [syntheticObservation(), second] })],
      }),
    )
    const rows = screen.getAllByTestId('imported-observation')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('3.5 nM')
    expect(rows[1]).toHaveTextContent('> 9.1 nM')
    expect(rows[1]).toHaveTextContent('Ki')
    expect(rows[1]).toHaveTextContent('CHEMBL99992002')
    expect(rows[1]).toHaveTextContent('Synthetic functional assay')
  })

  it('shows "not reported" for fields the source did not supply', () => {
    renderDetail(
      drugWithSource({
        sourceRecords: [
          sparseSnapshot(),
        ],
      }),
    )
    const identifiers = screen.getByTestId('source-identifiers')
    expect(identifiers).toHaveTextContent('not reported')
    const properties = screen.getByTestId('source-chemical-properties')
    expect(properties).toHaveTextContent('not reported')
    // An honest empty state instead of an empty table.
    expect(screen.getByTestId('source-observations-empty')).toHaveTextContent(
      'No measurements are stored for this source record.',
    )
  })

  it('renders nothing for a record without imported source data', () => {
    renderDetail(syntheticDrug())
    expect(screen.queryByTestId('drug-source-data')).not.toBeInTheDocument()
    // The rest of the detail view is unaffected.
    expect(screen.getByTestId('drug-detail')).toBeInTheDocument()
  })

  it('shows every source system when a record carries more than one', () => {
    const pubchem = snapshot({
      source: 'pubchem',
      sourceId: '90000001',
      provenance: {
        source: 'pubchem',
        sourceName: 'PubChem',
        recordId: '90000001',
        url: 'https://pubchem.ncbi.nlm.nih.gov/compound/90000001',
        retrievedAt: FIXTURE_TIMESTAMP,
        licenseNotice: 'PubChem aggregates contributions from many data providers.',
      },
      identifiers: { pubchemCid: '90000001', molecularFormula: 'C12H14N2O' },
      observations: [],
    })
    renderDetail(drugWithSource({ sourceRecords: [snapshot(), pubchem] }))
    const sections = screen.getAllByTestId('source-record')
    expect(sections).toHaveLength(2)
    expect(sections[0]).toHaveTextContent('ChEMBL')
    expect(sections[1]).toHaveTextContent('PubChem')
  })

  it('does not turn an imported measurement into a model parameter', () => {
    renderDetail(drugWithSource())
    // The record's own parameters are unchanged…
    expect(screen.getByTestId('param-Kd')).toHaveTextContent('12.4 nM')
    // …and the only IC50 shown is the record's stored one (88 nM), never the
    // imported observation's 3.5 nM — an import never fills a parameter slot.
    const ic50 = screen.getByTestId('param-IC50')
    expect(ic50).toHaveTextContent('88 nM')
    expect(ic50).not.toHaveTextContent('3.5')
    // The measurement itself is still visible, in the source-data section.
    expect(screen.getByTestId('source-observations')).toHaveTextContent('3.5 nM')
  })
})

describe('DrugLibraryView — source-origin indicator', () => {
  it('shows which source a record came from and how many measurements it carries', () => {
    renderList([drugWithSource()])
    const origin = screen.getByTestId('list-source-origin')
    expect(origin).toHaveTextContent('ChEMBL CHEMBL99990001')
    expect(origin).toHaveTextContent('CID 90000001')
    expect(origin).toHaveTextContent('CAS SYNTH-CAS-0001')
    expect(origin).toHaveTextContent('1 measurement')
    // The list stays scannable: chemical properties live on the detail page.
    expect(origin).not.toHaveTextContent('C12H14N2O')
  })

  it('shows no indicator for a record without imported source data', () => {
    renderList([syntheticDrug()])
    expect(screen.queryByTestId('list-source-origin')).not.toBeInTheDocument()
  })
})
