import { expect, test, type Page } from '@playwright/test'

/**
 * Library persistence end-to-end (phase 6, extended in phase 10).
 *
 * This is the workflow the testing documentation listed as pending: a
 * record created through the real UI must survive a real browser reload
 * (IndexedDB), remain editable, and be deletable. Nothing is mocked — no
 * component stubs, no store manipulation, no fake repository: every
 * assertion below is made through user-visible behaviour of the actual
 * application backed by Dexie/IndexedDB.
 *
 * The second workflow is the phase 10 regression: a user-origin record
 * whose target carries supported target-level metadata (entered via the
 * supported NPSL import path — the create form has no such controls) must
 * keep `gene` / `action` / `species` / `notes` through an unrelated edit
 * and a real reload.
 *
 * Every value used here is synthetic test data — no real pharmacological
 * parameter is ever introduced to make a test convenient.
 */

const DRUG_NAME = 'Synthetic Persistence Probe'
const TARGET_NAME = 'PSY-R1'
const METADATA_DRUG_NAME = 'Synthetic Metadata Probe'

/** Fill the create form and save through the normal validation path. */
async function createDrug(page: Page, kdValue: string): Promise<void> {
  await page.goto('/library')
  await page.getByTestId('new-drug').click()
  await expect(page.getByRole('heading', { name: 'New Drug Record' })).toBeVisible()

  await page.getByTestId('drug-name').fill(DRUG_NAME)
  await page.locator('#drug-tags').fill('synthetic-fixture')
  await page
    .locator('#drug-notes')
    .fill('Synthetic record created by end-to-end tests — not pharmacological information.')

  await page.getByTestId('add-target').click()
  await page.locator('#target-name-1').fill(TARGET_NAME)
  await page.getByTestId('add-param').click()
  await page.locator('#param-kind-1-0').selectOption('kd')
  await page.locator('#param-value-1-0').fill(kdValue)
  await page.locator('#param-unit-1-0').selectOption('nM')

  await page.getByTestId('save-drug').click()
  await expect(page.getByRole('heading', { name: 'Drug Detail' })).toBeVisible()
}

/** Assert the detail view shows the record with units and provenance. */
async function expectDetailShows(page: Page, kdValue: string): Promise<void> {
  await expect(page.getByTestId('drug-detail')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: DRUG_NAME })).toBeVisible()
  await expect(page.getByText(TARGET_NAME, { exact: true })).toBeVisible()
  await expect(page.getByTestId('param-Kd')).toContainText(`${kdValue} nM`)
  // Storage origin and provenance survive hydration from IndexedDB.
  await expect(page.getByTestId('origin-badge')).toContainText('Entered by you')
  await expect(
    page.getByTestId('param-Kd').locator('..').getByTestId('provenance-badge'),
  ).toContainText('User-entered')
}

test('library: a created record survives reload, stays editable and is deletable', async ({
  page,
}) => {
  await test.step('create a synthetic record through the form', async () => {
    await createDrug(page, '7.5')
    await expectDetailShows(page, '7.5')
  })

  await test.step('reload the real page and verify the persisted record', async () => {
    await page.reload()

    await expect(page.getByRole('heading', { name: 'Drug Detail' })).toBeVisible()
    await expectDetailShows(page, '7.5')

    // The record is in the library list after a fresh hydration as well.
    await page.goto('/library')
    await expect(page.getByTestId('drug-list')).toContainText(DRUG_NAME)
    await page.getByTestId('drug-list').getByText(DRUG_NAME).click()
    await expect(page.getByTestId('drug-detail')).toBeVisible()
  })

  await test.step('edit a scientific value, reload and verify it persisted', async () => {
    await page.getByTestId('edit-drug').click()
    await expect(page.getByTestId('drug-form')).toBeVisible()
    await page.locator('#param-value-1-0').fill('9.5')
    await page.getByTestId('save-drug').click()
    await expect(page.getByTestId('param-Kd')).toContainText('9.5 nM')

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Drug Detail' })).toBeVisible()
    await expectDetailShows(page, '9.5')
  })

  await test.step('delete the record through the acknowledgement step', async () => {
    await page.getByTestId('delete-drug').click()
    // Irreversible deletion always asks for an explicit acknowledgement.
    await expect(page.getByTestId('delete-confirm-text')).toContainText(DRUG_NAME)
    await page.getByTestId('delete-drug-confirm').click()

    await expect(page.getByRole('heading', { name: 'Drug Library' })).toBeVisible()
    // An empty library renders no list at all — the record is gone.
    await expect(page.getByTestId('drug-list')).toHaveCount(0)
    await expect(page.getByTestId('library-count')).toHaveText('0 of 0 records')
    await expect(page.getByText(DRUG_NAME)).toHaveCount(0)
  })

  await test.step('the deletion survives another reload', async () => {
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Drug Library' })).toBeVisible()
    await expect(page.getByTestId('library-count')).toHaveText(/0 of 0 records/)
    await expect(page.getByTestId('drug-list')).toHaveCount(0)
  })
})

/**
 * Synthetic NPSL envelope with one user-origin record whose target carries
 * supported target-level metadata. Invented fixture values throughout —
 * the UI cannot enter these fields, so the supported import path is how a
 * record with metadata reaches the editable (origin `user`) state.
 */
function metadataNpslBuffer(): Buffer {
  return Buffer.from(
    JSON.stringify({
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: {
        id: 'e2e-meta-library',
        name: 'Synthetic Metadata Library',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dataStatus: 'example',
      },
      drugs: [
        {
          id: 'e2e-meta-drug',
          origin: 'user',
          identifiers: { name: METADATA_DRUG_NAME, synonyms: ['SMP'] },
          tags: ['synthetic-fixture'],
          targets: [
            {
              id: 'e2e-meta-target-1',
              name: 'META-R1',
              gene: 'SYNTH-META-A',
              action: 'modulator',
              species: 'synthetic',
              notes: 'Synthetic target metadata fixture — not pharmacological information.',
              kd: {
                value: 4.2,
                unit: 'nM',
                provenance: {
                  type: 'literature',
                  source: 'Synthetic E2E source',
                  citation: 'Invented for E2E, 2026',
                },
              },
            },
          ],
          pharmacokinetics: {},
          notes: 'Synthetic record created by end-to-end tests — not pharmacological information.',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    'utf8',
  )
}

/** Import the metadata-bearing record through preview + confirmation. */
async function importMetadataRecord(page: Page): Promise<void> {
  await page.goto('/import-export')
  await expect(page.getByTestId('library-record-count')).toBeVisible()
  await page
    .getByTestId('npsl-file-input')
    .setInputFiles({
      name: 'synthetic-metadata.npsl',
      mimeType: 'application/json',
      buffer: metadataNpslBuffer(),
    })
  await expect(page.getByTestId('import-preview')).toBeVisible()
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText('Import complete (merge)')
}

/** The target-level metadata must be visible on the detail view. */
async function expectTargetMetadataVisible(page: Page): Promise<void> {
  await expect(page.getByText('gene SYNTH-META-A')).toBeVisible()
  await expect(page.getByText('species synthetic')).toBeVisible()
  await expect(page.getByText('modulator', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Synthetic target metadata fixture — not pharmacological information.'),
  ).toBeVisible()
}

test('library: target metadata survives an unrelated edit and a real reload', async ({ page }) => {
  await test.step('import a user-origin record carrying target metadata', async () => {
    await importMetadataRecord(page)
    await page.goto('/library')
    await page.getByTestId('drug-list').getByText(METADATA_DRUG_NAME).click()
    await expect(page.getByTestId('drug-detail')).toBeVisible()
    await expectTargetMetadataVisible(page)
  })

  await test.step('an unrelated edit (drug name only) keeps all four metadata fields', async () => {
    await page.getByTestId('edit-drug').click()
    await expect(page.getByTestId('drug-form')).toBeVisible()
    await page.getByTestId('drug-name').fill(`${METADATA_DRUG_NAME} Renamed`)
    await page.getByTestId('save-drug').click()

    await expect(
      page.getByRole('heading', { level: 2, name: `${METADATA_DRUG_NAME} Renamed` }),
    ).toBeVisible()
    await expectTargetMetadataVisible(page)
    // The target itself is still there with its parameter.
    await expect(page.getByText('META-R1', { exact: true })).toBeVisible()
    await expect(page.getByTestId('param-Kd')).toContainText('4.2 nM')
  })

  await test.step('the metadata is persisted in IndexedDB across a real reload', async () => {
    await page.reload()
    await expect(
      page.getByRole('heading', { level: 2, name: `${METADATA_DRUG_NAME} Renamed` }),
    ).toBeVisible()
    await expectTargetMetadataVisible(page)
    await expect(page.getByText('META-R1', { exact: true })).toBeVisible()
    await expect(page.getByTestId('param-Kd')).toContainText('4.2 nM')
  })
})
