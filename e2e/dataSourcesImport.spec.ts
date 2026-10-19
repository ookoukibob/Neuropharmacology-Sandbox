import { expect, test } from '@playwright/test'
import { mockChEMBL, mockPubChem } from './sourceMocks.js'

/**
 * Complete Data Sources → Library import (phase 36), end to end in a real
 * browser against real IndexedDB.
 *
 * Every HTTP request is intercepted with `page.route` and answered from the
 * synthetic fixture payloads in `sourceMocks.ts` — the suite never contacts
 * PubChem or ChEMBL, and every value is invented test data.
 */

/** Import one compound from Data Sources and return to the stored panel. */
async function importCompound(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('query-input').fill('synthetic')
  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('compound-result')).toBeVisible()
  await page.getByTestId('compound-select-pubchem:90000001').check()
  await page.getByTestId('confirm-import-button').click()
  await expect(page.getByTestId('import-report')).toContainText('1 new compound identity record')
}

test('a PubChem compound imports into the library with its complete identity and properties', async ({
  page,
}) => {
  await mockPubChem(page)
  await page.goto('/data-sources')
  await importCompound(page)

  await page.getByTestId('add-to-library-pubchem:90000001').click()
  await expect(page.getByTestId('apply-notice')).toContainText('complete PubChem source record')
  await expect(page.getByTestId('linked-notice-pubchem:90000001')).toContainText('In library')

  // The library detail page shows the structured sections.
  await page.goto('/library')
  await page.getByRole('link', { name: 'Synthetic Fixture Compound' }).click()
  const section = page.getByTestId('drug-source-data')
  await expect(section).toBeVisible()

  const identifiers = page.getByTestId('source-identifiers')
  await expect(identifiers).toContainText('Synthetic Fixture Compound')
  await expect(identifiers).toContainText('SFC-1')
  await expect(identifiers).toContainText('90000001') // PubChem CID
  await expect(identifiers).toContainText('FIXTUREKEYSXYZ-UHFFFAOYSA-N') // InChIKey

  const properties = page.getByTestId('source-chemical-properties')
  await expect(properties).toContainText('C12H14N2O')
  await expect(properties).toContainText('202.25 g/mol')
  await expect(properties).toContainText('CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1')

  const attribution = page.getByTestId('source-attribution')
  await expect(attribution).toContainText('PubChem')
  await expect(attribution).toContainText('aggregates contributions')
  await expect(page.getByTestId('source-record-link')).toHaveAttribute(
    'href',
    /pubchem\.ncbi\.nlm\.nih\.gov\/compound\/90000001/,
  )
  // PubChem supplies no measurements — the empty state says so.
  await expect(page.getByTestId('source-observations-empty')).toContainText(
    'No measurements are stored for this source record.',
  )
})

test('a ChEMBL measurement is imported with its context and stays a measurement', async ({
  page,
}) => {
  await mockChEMBL(page)
  await page.goto('/data-sources')

  // Store a measurement (which also stores its compound identity).
  await page.getByTestId('source-select').selectOption('chembl')
  await page.getByTestId('scope-targets').click()
  await page.getByTestId('query-input').fill('synthetic target')
  await page.getByTestId('search-button').click()
  await page.getByTestId('target-select-CHEMBL99991001').click()
  await page.getByTestId('fetch-observations-button').click()
  await expect(page.getByTestId('observation-row').first()).toBeVisible()
  await page.getByTestId('observation-select-chembl:99000001').check()
  await page.getByTestId('confirm-import-button').click()
  await expect(page.getByTestId('import-report')).toContainText('1 new measurement record')

  // Import the compound into the library — the measurement comes with it.
  await page.getByTestId('add-to-library-chembl:CHEMBL99990001').click()
  await expect(page.getByTestId('apply-notice')).toContainText('1 stored measurement')

  await page.goto('/library')
  await page.getByRole('link', { name: 'SYNTHETIC FIXTURE COMPOUND' }).click()
  const observations = page.getByTestId('source-observations')
  await expect(observations).toBeVisible()
  await expect(observations).toContainText('IC50')
  await expect(observations).toContainText('3.5 nM')
  await expect(observations).toContainText('Synthetic Target A')
  await expect(observations).toContainText('CHEMBL99991001')
  await expect(page.getByTestId('imported-observation-source')).toContainText(
    'ChEMBL record 99000001',
  )
  await expect(page.getByTestId('imported-observation-source')).toContainText('CC BY-SA 3.0')

  // Nothing was promoted into a model parameter by the import.
  await expect(page.getByTestId('drug-detail')).toContainText('No target entries.')
})

test('imported source data survives a real reload and an ordinary edit', async ({ page }) => {
  await mockChEMBL(page)
  await page.goto('/data-sources')
  await page.getByTestId('source-select').selectOption('chembl')
  await page.getByTestId('scope-targets').click()
  await page.getByTestId('query-input').fill('synthetic target')
  await page.getByTestId('search-button').click()
  await page.getByTestId('target-select-CHEMBL99991001').click()
  await page.getByTestId('fetch-observations-button').click()
  await page.getByTestId('observation-select-chembl:99000001').check()
  await page.getByTestId('confirm-import-button').click()
  await expect(page.getByTestId('import-report')).toContainText('1 new measurement record')
  await page.getByTestId('add-to-library-chembl:CHEMBL99990001').click()
  await expect(page.getByTestId('apply-notice')).toContainText('complete ChEMBL source record')

  await page.goto('/library')
  await page.getByRole('link', { name: 'SYNTHETIC FIXTURE COMPOUND' }).click()
  await expect(page.getByTestId('drug-source-data')).toBeVisible()

  // Edit the record's own fields through the real form.
  await page.getByTestId('edit-drug').click()
  await page.getByTestId('drug-name').fill('Renamed After Import')
  await page.getByTestId('save-drug').click()
  await expect(page.getByTestId('drug-detail')).toContainText('Renamed After Import')

  // A REAL page reload re-reads everything from IndexedDB.
  await page.reload()
  await expect(page.getByTestId('drug-detail')).toContainText('Renamed After Import')
  const section = page.getByTestId('drug-source-data')
  await expect(section).toContainText('FIXTUREKEYSXYZ-UHFFFAOYSA-N')
  await expect(section).toContainText('CC BY-SA 3.0')
  await expect(page.getByTestId('source-observations')).toContainText('3.5 nM')
})

test('the library list shows a source-origin indicator', async ({ page }) => {
  await mockPubChem(page)
  await page.goto('/data-sources')
  await importCompound(page)
  await page.getByTestId('add-to-library-pubchem:90000001').click()
  await expect(page.getByTestId('apply-notice')).toContainText('complete PubChem source record')

  await page.goto('/library')
  const origin = page.getByTestId('list-source-origin')
  await expect(origin).toContainText('PubChem 90000001')
  await expect(origin).toContainText('CID 90000001')
  await expect(origin).toContainText('0 measurements')
  // The list stays scannable — chemical properties live on the detail page.
  await expect(origin).not.toContainText('C12H14N2O')
})
