import { expect, test } from '@playwright/test'
import { mockChEMBL, mockPubChem } from './sourceMocks.js'

/**
 * Data sources (on-demand retrieval) end-to-end workflows.
 *
 * All HTTP is intercepted with `page.route` and answered with payloads in
 * the real APIs' shapes (synthetic values, see sourceMocks.ts) — this
 * suite never contacts PubChem or ChEMBL, and one test asserts that
 * merely loading the page performs ZERO external requests (no startup
 * download, no seeding, no bundled default database). Every import and
 * every parameter promotion happens through explicit UI gestures, exactly
 * like a user session.
 */

test('data sources: loading the page performs no external requests and seeds nothing', async ({
  page,
}) => {
  const external: string[] = []
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname
    if (host !== 'localhost' && host !== '127.0.0.1') external.push(request.url())
  })

  await page.goto('/data-sources')
  await expect(page.getByTestId('data-sources-view')).toBeVisible()
  await expect(page).toHaveTitle('Data Sources — Neuropharmacology Sandbox')

  // First run: the stored panel is empty and stays empty — no bundled
  // database, no startup download, no seeding.
  await expect(page.getByTestId('stored-status')).toContainText('0 compound identity records')
  await expect(page.getByTestId('stored-compounds-empty')).toBeVisible()
  await expect(page.getByTestId('on-demand-notice')).toBeVisible()
  expect(external).toEqual([])
})

test('data sources: search, select and import a PubChem compound (explicit confirmation)', async ({
  page,
}) => {
  await mockPubChem(page)
  await page.goto('/data-sources')

  await page.getByTestId('query-input').fill('synthetic')
  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('search-status')).toContainText('1 result')
  await expect(page.getByTestId('compound-results')).toContainText('Synthetic Fixture Compound')
  await expect(page.getByTestId('compound-results')).toContainText('C12H14N2O')
  // An identity-only source is not misrepresented as an activity source.
  await expect(page.getByTestId('observations-unavailable')).toContainText(
    'not presented as an activity source',
  )

  // Selection + preview write nothing; the preview is labelled advisory.
  await page.getByTestId('compound-select-pubchem:90000001').check()
  await expect(page.getByTestId('import-preview-text')).toContainText(
    '1 compound identity record',
  )
  await expect(page.getByText('This preview is advisory')).toBeVisible()
  await expect(page.getByTestId('stored-compounds-empty')).toBeVisible()

  await page.getByTestId('confirm-import-button').click()
  await expect(page.getByTestId('import-report')).toContainText('1 new compound identity record')
  await expect(page.getByTestId('stored-compounds')).toContainText('Synthetic Fixture Compound')
})

test('data sources: measurements keep qualifiers and are imported with resolved identity', async ({
  page,
}) => {
  await mockChEMBL(page)
  await page.goto('/data-sources')

  await page.getByTestId('source-select').selectOption('chembl')
  await page.getByTestId('scope-targets').click()
  await page.getByTestId('query-input').fill('synthetic target')
  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('target-result')).toBeVisible()

  await page.getByTestId('target-select-CHEMBL99991001').click()
  await page.getByTestId('fetch-observations-button').click()

  // 7 supplied rows: the valueless one is counted as omitted (6 listed).
  await expect(page.getByTestId('observation-row')).toHaveCount(6)
  await expect(page.getByTestId('observations-status')).toContainText('1 supplied row')
  // Qualifiers and raw relations survive exactly as reported.
  await expect(page.getByTestId('observation-rows')).toContainText('< 0.9 nM')
  await expect(page.getByTestId('observation-rows')).toContainText('> 12 nM')
  await expect(page.getByTestId('observation-rows')).toContainText('no parameter mapping')
  // Every row links back to its source record.
  await expect(page.getByTestId('observation-rows').locator('a').first()).toHaveAttribute(
    'href',
    /ebi\.ac\.uk/,
  )

  await page.getByTestId('observation-select-chembl:99000001').check()
  await expect(page.getByTestId('import-preview-text')).toContainText('1 measurement record')
  await page.getByTestId('confirm-import-button').click()
  await expect(page.getByTestId('import-report')).toContainText('1 new measurement record')
  await expect(page.getByTestId('stored-observations')).toContainText('3.5 nM')
  // The observation's compound identity was resolved and stored too.
  await expect(page.getByTestId('stored-compounds')).toContainText('SYNTHETIC FIXTURE COMPOUND')
})

test('data sources: an imported measurement can supply a parameter, provenance intact (Layer C)', async ({
  page,
}) => {
  await mockChEMBL(page)

  // 1. An identity-only drug record, created through the real form.
  await page.goto('/library')
  await page.getByTestId('new-drug').click()
  await page.getByTestId('drug-name').fill('Synthetic E2E Drug')
  await page.getByTestId('save-drug').click()
  await expect(page.getByTestId('drug-detail')).toBeVisible()

  // 2. Import one measurement (explicit selection + confirmation).
  await page.goto('/data-sources')
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

  // 3. Promote it onto the drug record — explicitly, through the UI.
  await page.getByTestId('apply-to-parameter-chembl:99000001').click()
  await expect(page.getByTestId('apply-observation-summary')).toContainText('IC50 = 3.5 nM')
  await page.getByTestId('apply-drug-select').selectOption({ label: 'Synthetic E2E Drug' })
  await page.getByTestId('apply-confirm').click()
  await expect(page.getByTestId('apply-notice')).toContainText('Applied IC50')

  // 4. The drug record now carries the value with its provenance badge.
  await page.goto('/library')
  await page.getByRole('link', { name: 'Synthetic E2E Drug' }).click()
  await expect(page.getByTestId('drug-detail')).toContainText('3.5')
  await expect(page.getByTestId('provenance-badge').first()).toHaveAttribute(
    'title',
    /Source: ChEMBL/,
  )
})

test('data sources: a failed search explains itself and writes nothing', async ({ page }) => {
  await page.route('**/pubchem.ncbi.nlm.nih.gov/**', (route) => route.abort('failed'))
  await page.goto('/data-sources')

  await page.getByTestId('query-input').fill('synthetic')
  await page.getByTestId('search-button').click()

  await expect(page.getByTestId('search-error')).toContainText('Network error', { timeout: 15_000 })
  await expect(page.getByTestId('search-status')).toContainText('The search failed')
  // A transport failure never leaves data behind.
  await expect(page.getByTestId('stored-status')).toContainText('0 compound identity records')
})
