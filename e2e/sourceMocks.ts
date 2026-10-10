import type { Page } from '@playwright/test'

/**
 * Source mocks for the data-sources end-to-end and accessibility specs.
 *
 * Every payload mirrors the *shape* of the real PUG REST / ChEMBL API
 * responses with synthetic values (including a letters-only fixture
 * InChIKey, since real InChIKeys are 14 letters). The suites never
 * contact PubChem or ChEMBL — CI stays deterministic and offline.
 */

export const PUBCHEM_CIDS = { IdentifierList: { CID: [90000001] } }
export const PUBCHEM_PROPERTIES = {
  PropertyTable: {
    Properties: [
      {
        CID: 90000001,
        Title: 'Synthetic Fixture Compound',
        IUPACName: 'synthetic fixture compound',
        MolecularFormula: 'C12H14N2O',
        MolecularWeight: '202.25',
        ConnectivitySMILES: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
        InChIKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      },
    ],
  },
}
export const PUBCHEM_SYNONYMS = {
  InformationList: {
    Information: [{ CID: 90000001, Synonym: ['Synthetic Fixture Compound', 'SFC-1'] }],
  },
}

export const CHEMBL_TARGETS = {
  page_meta: { limit: 8, next: null, offset: 0, previous: null, total_count: 1 },
  targets: [
    {
      target_chembl_id: 'CHEMBL99991001',
      pref_name: 'Synthetic Target A',
      organism: 'Homo sapiens',
      target_type: 'SINGLE PROTEIN',
      tax_id: 9606,
    },
  ],
}
export const CHEMBL_MOLECULES = {
  page_meta: { limit: 8, next: null, offset: 0, previous: null, total_count: 2 },
  molecules: [
    {
      molecule_chembl_id: 'CHEMBL99990001',
      pref_name: 'SYNTHETIC FIXTURE COMPOUND',
      molecule_structures: {
        canonical_smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
        standard_inchi_key: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      },
      molecule_properties: { full_molformula: 'C12H14N2O', full_mwt: '202.25' },
      molecule_synonyms: [
        { molecule_synonym: 'Synthetic Fixture Compound', syn_type: 'OTHER' },
        { molecule_synonym: 'SFC-1', syn_type: 'TRADE_NAME' },
      ],
    },
    { molecule_chembl_id: 'CHEMBL99990002', pref_name: null },
  ],
}

function activity(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    molecule_chembl_id: 'CHEMBL99990001',
    molecule_pref_name: 'SYNTHETIC FIXTURE COMPOUND',
    standard_relation: '=',
    standard_units: 'nM',
    target_chembl_id: 'CHEMBL99991001',
    target_pref_name: 'Synthetic Target A',
    target_organism: 'Homo sapiens',
    assay_chembl_id: 'CHEMBL99992001',
    assay_type: 'B',
    assay_description: 'Synthetic fixture binding assay (test data)',
    ...overrides,
  }
}

export const CHEMBL_ACTIVITIES = {
  page_meta: { limit: 25, next: null, offset: 0, previous: null, total_count: 7 },
  activities: [
    activity({ activity_id: 99000001, standard_type: 'IC50', standard_value: '3.5' }),
    activity({
      activity_id: 99000002,
      standard_type: 'Ki',
      standard_relation: '>',
      standard_value: '12',
    }),
    activity({
      activity_id: 99000003,
      standard_type: 'EC50',
      standard_value: '0.5',
      standard_units: 'uM',
      target_chembl_id: 'CHEMBL99991002',
      target_pref_name: 'Synthetic Target B',
      target_organism: 'Mus musculus',
    }),
    // No numeric value — must be counted as omitted, never coerced.
    activity({ activity_id: 99000004, standard_type: 'IC50', standard_value: null }),
    // Unmappable endpoint — stored and labelled, never substituted.
    activity({
      activity_id: 99000005,
      standard_type: "Log K'",
      standard_value: '1.39',
      standard_units: null,
    }),
    // Unknown raw relation — preserved verbatim, not dropped.
    activity({
      activity_id: 99000006,
      standard_type: 'IC50',
      standard_relation: '>>',
      standard_value: '7.7',
    }),
    activity({
      activity_id: 99000007,
      molecule_chembl_id: 'CHEMBL99990002',
      molecule_pref_name: null,
      standard_type: 'IC50',
      standard_relation: '<',
      standard_value: '0.9',
    }),
  ],
}

/** Answer PUG REST name-search requests from the fixture payloads. */
export async function mockPubChem(page: Page): Promise<void> {
  await page.route('**/pubchem.ncbi.nlm.nih.gov/rest/pug/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/cids/JSON')) return route.fulfill({ json: PUBCHEM_CIDS })
    if (url.includes('/property/')) return route.fulfill({ json: PUBCHEM_PROPERTIES })
    if (url.includes('/synonyms/JSON')) return route.fulfill({ json: PUBCHEM_SYNONYMS })
    return route.fulfill({ status: 404, json: { Fault: { Code: 'PUGREST.NotFound' } } })
  })
}

/** Answer ChEMBL web-service requests from the fixture payloads. */
export async function mockChEMBL(page: Page): Promise<void> {
  // Regex, not glob: the host segment is `www.ebi.ac.uk`, which a
  // `**/ebi.ac.uk/**` glob would never match (globs compare whole path
  // segments; `**` does not absorb `www.` into the hostname segment).
  await page.route(/ebi\.ac\.uk\/chembl\/api\/data\//, async (route) => {
    const url = route.request().url()
    if (url.includes('/target/search')) return route.fulfill({ json: CHEMBL_TARGETS })
    if (url.includes('/activity.json')) return route.fulfill({ json: CHEMBL_ACTIVITIES })
    if (url.includes('/molecule.json')) return route.fulfill({ json: CHEMBL_MOLECULES })
    return route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  })
}
