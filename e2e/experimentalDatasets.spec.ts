import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

/**
 * Experimental datasets, end to end (phase 47A).
 *
 * These tests use the real app, the real IndexedDB database and the real
 * Plotly chart. They assert only user-visible outcomes:
 *
 * 1  CSV mapping is explicit (no inferred columns or units), a valid file is
 *    previewed and then saved, source order and duplicate timestamps survive,
 *    the chart draws observed markers only, `.npex` export/import round-trips
 *    the exact values, rename/reload/delete persist, and the layout remains
 *    usable at a narrow viewport;
 * 2  qualifier and negative values are rejected by source row with no import
 *    control and nothing written;
 * 3  `.npsb` recovery includes the dataset store and restores it verbatim.
 *
 * All values are synthetic test data — not pharmacological information.
 */

const CSV =
  'time,concentration,sample,note\n' +
  '0,0,A,baseline\n' +
  '0,0,A,exact replicate\n' +
  '2,1.5,B,observed\n' +
  '4,2.25,B,\n'

const EXPECTED_MEASUREMENTS = [
  { sourceRow: 1, time: 0, concentration: 0, sampleId: 'A', note: 'baseline' },
  { sourceRow: 2, time: 0, concentration: 0, sampleId: 'A', note: 'exact replicate' },
  { sourceRow: 3, time: 2, concentration: 1.5, sampleId: 'B', note: 'observed' },
  { sourceRow: 4, time: 4, concentration: 2.25, sampleId: 'B' },
]

async function importCsv(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/experiments')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Experimental Datasets' }),
  ).toBeVisible()
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await page.getByTestId('csv-dataset-file').setInputFiles({
    name: 'synthetic-47a.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  })
  await expect(page.getByTestId('csv-dataset-mapping')).toBeVisible()

  // Nothing is inferred from the headers: every mapping and unit starts empty.
  await expect(page.getByTestId('csv-dataset-time-column')).toHaveValue('')
  await expect(page.getByTestId('csv-dataset-concentration-column')).toHaveValue('')
  await expect(page.getByTestId('csv-dataset-time-unit')).toHaveValue('')
  await expect(page.getByTestId('csv-dataset-concentration-unit')).toHaveValue('')

  await page.getByTestId('csv-dataset-name').fill('Synthetic 47A measured study')
  await page.getByTestId('csv-dataset-time-column').selectOption('0')
  await page.getByTestId('csv-dataset-time-unit').selectOption('h')
  await page.getByTestId('csv-dataset-concentration-column').selectOption('1')
  await page.getByTestId('csv-dataset-concentration-unit').selectOption('mg/L')
  await page.getByTestId('csv-dataset-sample-column').selectOption('2')
  await page.getByTestId('csv-dataset-note-column').selectOption('3')
  await page.getByTestId('csv-dataset-preview').click()

  const counts = page.getByTestId('csv-dataset-preview-counts')
  await expect(counts).toContainText('4 source rows')
  await expect(counts).toContainText('4 valid')
  await expect(counts).toContainText('0 invalid')
  await page.getByTestId('csv-dataset-confirm').click()

  await expect(page.getByTestId('dataset-feedback')).toContainText(
    'Imported "Synthetic 47A measured study" with 4 measurements.',
  )
  await expect(
    page.getByRole('heading', { level: 2, name: 'Synthetic 47A measured study' }),
  ).toBeVisible()
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(4)
}

test('CSV → chart → .npex round trip, rename, reload, delete and narrow layout', async ({
  page,
}) => {
  await importCsv(page)

  // Source order, duplicate timestamps and sample ids are all visible.
  const rows = page.locator('[data-testid="dataset-measurement-row"]')
  await expect(rows.nth(0)).toContainText('1')
  await expect(rows.nth(0)).toContainText('baseline')
  await expect(rows.nth(1)).toContainText('exact replicate')
  await expect(rows.nth(1)).toContainText('A')
  await expect(rows.nth(2)).toContainText('1.5')
  await expect(rows.nth(3)).toContainText('2.25')

  // The real Plotly chart: one marker-only trace with one point per row, the
  // declared units on both axes, and no fitted line.
  const chart = page.getByTestId('experimental-dataset-chart')
  await expect(chart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
  await expect(chart.locator('.scatterlayer .points path')).toHaveCount(4)
  await expect(chart.locator('.scatterlayer .lines path')).toHaveCount(0)
  await expect(chart.locator('.xtitle')).toContainText('Time (h)')
  await expect(chart.locator('.ytitle')).toContainText('Measured concentration (mg/L)')

  // Export the versioned single-dataset interchange file.
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('dataset-export').click()
  const download = await downloadPromise
  const npexPath = await download.path()
  if (npexPath === null) throw new Error('.npex export produced no file path')
  const text = readFileSync(npexPath, 'utf8')
  const npex = JSON.parse(text) as {
    formatId: string
    formatVersion: string
    dataset: {
      name: string
      timeUnit: string
      concentrationUnit: string
      provenance: { source: string; fileName?: string; importedAt: string }
      measurements: typeof EXPECTED_MEASUREMENTS
    }
  }
  expect(npex.formatId).toBe('npex')
  expect(npex.formatVersion).toBe('1.0.0')
  expect(npex.dataset.name).toBe('Synthetic 47A measured study')
  expect(npex.dataset.timeUnit).toBe('h')
  expect(npex.dataset.concentrationUnit).toBe('mg/L')
  expect(npex.dataset.provenance).toMatchObject({
    source: 'csv',
    fileName: 'synthetic-47a.csv',
  })
  expect(npex.dataset.measurements).toEqual(EXPECTED_MEASUREMENTS)

  // Re-import the exact file: a new local identity, the same scientific values.
  await page.getByTestId('npex-dataset-file').setInputFiles(npexPath)
  const preview = page.getByTestId('npex-dataset-preview')
  await expect(preview).toContainText('Synthetic 47A measured study')
  await expect(preview).toContainText('Time unit h')
  await expect(preview).toContainText('concentration unit mg/L')
  await page.getByTestId('npex-dataset-confirm').click()
  await expect(page.getByText('2 datasets', { exact: true })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Saved experimental datasets' })).toContainText(
    'Synthetic 47A measured study',
  )
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(4)

  // Rename the selected (re-imported) dataset and prove it survives a reload.
  await page.getByTestId('dataset-rename').click()
  await page.getByTestId('dataset-rename-name').fill('Renamed measured study')
  await page.getByTestId('dataset-rename-save').click()
  await expect(page.getByRole('heading', { level: 2, name: 'Renamed measured study' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('list', { name: 'Saved experimental datasets' })).toContainText(
    'Renamed measured study',
  )
  const saved = page.getByRole('list', { name: 'Saved experimental datasets' }).getByRole('button')
  await expect(saved).toHaveCount(2)
  await saved.filter({ hasText: 'Renamed measured study' }).click()
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(4)
  await expect(page.getByText('Time unit', { exact: true })).toBeVisible()
  await expect(page.getByText('Concentration unit', { exact: true })).toBeVisible()
  await expect(page.locator('dl dd').filter({ hasText: /^h$/ })).toHaveCount(1)
  await expect(page.locator('dl dd').filter({ hasText: /^mg\/L$/ })).toHaveCount(1)

  // Delete requires the explicit acknowledgement; cancel does nothing.
  await page.getByTestId('dataset-delete').click()
  const confirmDelete = page.getByTestId('dataset-delete-confirm')
  await expect(confirmDelete).toBeDisabled()
  await page.getByTestId('dataset-delete-cancel').click()
  await expect(page.getByRole('list', { name: 'Saved experimental datasets' }).getByRole('button')).toHaveCount(2)

  await page.getByTestId('dataset-delete').click()
  await page.getByTestId('dataset-delete-ack').check()
  await expect(confirmDelete).toBeEnabled()
  await confirmDelete.click()
  await expect(page.getByTestId('dataset-feedback')).toContainText('Dataset deleted.')
  await expect(page.getByRole('list', { name: 'Saved experimental datasets' }).getByRole('button')).toHaveCount(1)

  // Narrow viewport: the page does not overflow horizontally, the chart
  // re-lays out inside its card, and the measurement table stays available.
  await page.getByRole('list', { name: 'Saved experimental datasets' }).getByRole('button').click()
  await page.setViewportSize({ width: 420, height: 900 })
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(4)
  await expect(chart.locator('.js-plotly-plot')).toBeVisible()
  await expect
    .poll(async () => (await chart.boundingBox())?.height ?? 0)
    .toBe(260)
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(pageOverflow).toBeLessThanOrEqual(1)
  const chartBox = await chart.boundingBox()
  expect(chartBox).not.toBeNull()
  expect(chartBox?.width ?? 0).toBeLessThanOrEqual(420)
})

test('rejects qualifier and negative concentrations by source row without writing', async ({
  page,
}) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await page.getByTestId('csv-dataset-file').setInputFiles({
    name: 'invalid-47a.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('time,conc\n0,<0.1\n1,BLQ\n2,-1\n3,N/A\n', 'utf8'),
  })
  await expect(page.getByTestId('csv-dataset-mapping')).toBeVisible()
  await page.getByTestId('csv-dataset-time-column').selectOption('0')
  await page.getByTestId('csv-dataset-time-unit').selectOption('h')
  await page.getByTestId('csv-dataset-concentration-column').selectOption('1')
  await page.getByTestId('csv-dataset-concentration-unit').selectOption('mg/L')
  await page.getByTestId('csv-dataset-preview').click()

  const issues = page.getByTestId('csv-dataset-issues')
  await expect(issues).toContainText('data row 1')
  await expect(issues).toContainText('<0.1')
  await expect(issues).toContainText('data row 2')
  await expect(issues).toContainText('BLQ')
  await expect(issues).toContainText('data row 3')
  await expect(issues).toContainText('data row 4')
  await expect(issues).toContainText('N/A')
  await expect(page.getByTestId('csv-dataset-preview-counts')).toContainText('0 valid')
  await expect(page.getByTestId('csv-dataset-preview-counts')).toContainText('4 invalid')
  await expect(page.getByTestId('csv-dataset-confirm')).toHaveCount(0)
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('datasets-empty')).toBeVisible()
})

test('.npsb recovery carries and restores the experimental dataset store', async ({ page }) => {
  await importCsv(page)

  await page.goto('/import-export')
  await page.getByTestId('tab-recovery').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('recovery-export').click()
  const download = await downloadPromise
  const archivePath = await download.path()
  if (archivePath === null) throw new Error('recovery export produced no file path')
  const archive = JSON.parse(readFileSync(archivePath, 'utf8')) as {
    backupVersion: string
    counts: Record<string, number>
    experimentDatasets?: { value: { measurements: unknown[] } }[]
  }
  expect(archive.backupVersion).toBe('1.1.0')
  expect(archive.counts['experimentDatasetRows']).toBe(1)
  expect(archive.experimentDatasets).toHaveLength(1)
  expect(archive.experimentDatasets?.[0]?.value.measurements).toHaveLength(4)

  // Remove the dataset locally, then restore the full archive.
  await page.goto('/experiments')
  const saved = page.getByRole('list', { name: 'Saved experimental datasets' }).getByRole('button')
  await saved.first().click()
  await page.getByTestId('dataset-delete').click()
  await page.getByTestId('dataset-delete-ack').check()
  await page.getByTestId('dataset-delete-confirm').click()
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await page.goto('/import-export')
  await page.getByTestId('tab-recovery').click()
  await page.getByTestId('recovery-restore-file').setInputFiles(archivePath)
  await expect(page.getByTestId('recovery-preview')).toBeVisible()
  await expect(page.getByTestId('recovery-store-counts')).toContainText(
    'Experimental datasets: 1 row',
  )
  await page.getByTestId('recovery-acknowledge').check()
  await page.getByTestId('recovery-restore-confirm').click()
  await expect(page.getByTestId('recovery-restore-report')).toContainText('Restore complete')

  await page.goto('/experiments')
  await expect(
    page.getByRole('list', { name: 'Saved experimental datasets' }),
  ).toContainText('Synthetic 47A measured study')
  await page.getByRole('list', { name: 'Saved experimental datasets' }).getByRole('button').click()
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(4)
  const restoredRows = page.locator('[data-testid="dataset-measurement-row"]')
  await expect(restoredRows.nth(1)).toContainText('exact replicate')
  await expect(restoredRows.nth(3)).toContainText('2.25')
})

test('fits a mono-exponential decay and overlays the curve', async ({ page }) => {
  await importCsv(page)

  // Select the imported dataset and run the fit.
  const list = page.getByRole('list', { name: 'Saved experimental datasets' })
  await list.getByRole('button', { name: /Synthetic 47A measured study/ }).click()
  await page.getByTestId('dataset-fit').click()

  const results = page.getByTestId('fit-results')
  await expect(results).toBeVisible()
  // Parameters carry the dataset's declared units.
  await expect(page.getByTestId('fit-tref')).toContainText('h')
  await expect(page.getByTestId('fit-cref')).toContainText('mg/L')
  await expect(page.getByTestId('fit-k')).toContainText('h⁻¹')
  await expect(page.getByTestId('fit-half-life')).toContainText('h')

  // The chart draws a separate fitted line beside the observed markers, and
  // the accessible measurement table still holds the observed values.
  await expect(page.getByText('Fitted mono-exponential curve')).toBeVisible()
  await expect(page.getByTestId('dataset-measurements')).toBeVisible()
  await expect(page.getByTestId('fit-diagnostics')).toBeVisible()
  await expect(page.getByTestId('fit-rmse')).toContainText('mg/L')
  await expect(page.getByTestId('fit-residual-df')).toContainText('2')
  await expect(page.getByTestId('fit-residual-chart').locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('fit-identifiability-screen')).toContainText(/not a formal .*identifiability test/i)

  // Phase 47C: the objective profile is derived from the same fit. This
  // synthetic series rises, so the fit sits on the zero-rate boundary.
  await expect(page.getByTestId('fit-profile-diagnostics')).toBeVisible()
  await expect(page.getByTestId('fit-profile-localization')).toContainText(/zero-rate boundary/i)
  await expect(page.getByTestId('fit-profile-chart').locator('.js-plotly-plot')).toBeVisible({
    timeout: 30_000,
  })

  // The fit is derived only: reloading the page loses it and the stored
  // measurements are unchanged.
  await page.reload()
  await list.getByRole('button', { name: /Synthetic 47A measured study/ }).click()
  await expect(page.getByTestId('fit-results')).toHaveCount(0)
  await expect(page.getByTestId('fit-profile-diagnostics')).toHaveCount(0)
  await expect(page.getByTestId('dataset-measurements')).toContainText('4')
})

/** Import one synthetic two-column CSV with explicit columns and units. */
async function importTwoColumnCsv(
  page: import('@playwright/test').Page,
  spec: { fileName: string; csv: string; name: string },
): Promise<void> {
  await page.getByTestId('csv-dataset-file').setInputFiles({
    name: spec.fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(spec.csv, 'utf8'),
  })
  await expect(page.getByTestId('csv-dataset-mapping')).toBeVisible()
  await page.getByTestId('csv-dataset-name').fill(spec.name)
  await page.getByTestId('csv-dataset-time-column').selectOption('0')
  await page.getByTestId('csv-dataset-time-unit').selectOption('h')
  await page.getByTestId('csv-dataset-concentration-column').selectOption('1')
  await page.getByTestId('csv-dataset-concentration-unit').selectOption('mg/L')
  await page.getByTestId('csv-dataset-preview').click()
  await expect(page.getByTestId('csv-dataset-confirm')).toBeVisible()
  await page.getByTestId('csv-dataset-confirm').click()
  await expect(page.getByRole('heading', { level: 2, name: spec.name })).toBeVisible()
}

test('profiles the objective after fitting and degrades safely for sparse data', async ({
  page,
}) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await importTwoColumnCsv(page, {
    fileName: 'synthetic-47c-decay.csv',
    csv: 'time,concentration\n0,100\n1,80\n2,75\n3,45\n',
    name: 'Synthetic 47C decay',
  })

  // No diagnostic is shown before a valid fit exists.
  await expect(page.getByTestId('fit-profile-diagnostics')).toHaveCount(0)

  await page.getByTestId('dataset-fit').click()
  await expect(page.getByTestId('fit-results')).toBeVisible()

  const profile = page.getByTestId('fit-profile-diagnostics')
  await expect(profile).toBeVisible()
  await expect(page.getByTestId('fit-profile-localization')).toContainText(/narrow minimum/i)
  await expect(page.getByTestId('fit-profile-band')).toContainText('h⁻¹')
  await expect(page.getByTestId('fit-profile-points')).toContainText(/\d+/)

  // The chart identifies the plotted objective, both axes and their units.
  const chart = page.getByTestId('fit-profile-chart')
  await expect(chart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
  await expect(chart.locator('.xtitle')).toContainText('Decay rate k (h⁻¹)')
  await expect(chart.locator('.ytitle')).toContainText(/Residual sum of squares/i)
  await expect(chart.locator('.ytitle')).toContainText('mg/L')
  // Residual sum of squares is never presented as a likelihood.
  await expect(profile).toContainText(/not a likelihood/i)
  await expect(page.getByTestId('fit-profile-limitations')).toContainText(
    /not a confidence interval/i,
  )

  // Measured rows are untouched by the screen.
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(4)

  // Sparse time coverage: the screen states that it cannot classify the shape,
  // and the chart still renders instead of silently disappearing.
  await importTwoColumnCsv(page, {
    fileName: 'synthetic-47c-sparse.csv',
    csv: 'time,concentration\n0,100\n0,98\n1,50\n1,49\n',
    name: 'Synthetic 47C sparse',
  })
  // The previous dataset's fit is not carried over to the newly selected one.
  await expect(page.getByTestId('fit-results')).toHaveCount(0)
  await expect(page.getByTestId('fit-profile-diagnostics')).toHaveCount(0)

  await page.getByTestId('dataset-fit').click()
  await expect(page.getByTestId('fit-results')).toBeVisible()
  await expect(page.getByTestId('fit-profile-localization')).toContainText(
    /does not support a shape classification/i,
  )
  await expect(page.getByTestId('fit-profile-warnings')).toContainText(/2 distinct time points/i)
  await expect(page.getByTestId('fit-profile-chart').locator('.js-plotly-plot')).toBeVisible({
    timeout: 30_000,
  })
})

test('compares M0 with a baseline model and gates AICc on the declared assumption', async ({
  page,
}) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  // Synthetic decay onto a persistent baseline, rounded to two decimals so the
  // residuals are non-zero and the criterion is defined.
  await importTwoColumnCsv(page, {
    fileName: 'synthetic-47c-baseline.csv',
    csv:
      'time,concentration\n' +
      '0,100\n0.5,83.61\n1,70.32\n2,50.44\n3,37.13\n5,22.24\n7,14.92\n9,11.12\n',
    name: 'Synthetic 47C baseline',
  })

  // Nothing is compared before a fit exists.
  await expect(page.getByTestId('fit-model-comparison')).toHaveCount(0)
  await page.getByTestId('dataset-fit').click()
  await expect(page.getByTestId('fit-results')).toBeVisible()

  const card = page.getByTestId('fit-model-comparison')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('comparison-table')).toBeVisible()

  // Both candidates report their own parameters, units and counts.
  await expect(page.getByTestId('comparison-m1-baseline')).toContainText('mg/L')
  await expect(page.getByTestId('comparison-m0-aicc')).toHaveText('unavailable')
  await expect(page.getByTestId('comparison-m1-aicc')).toHaveText('unavailable')
  await expect(page.getByTestId('comparison-aicc-gate')).toContainText(
    /until this assumption is declared/i,
  )
  // No fabricated score anywhere before the declaration.
  await expect(page.getByTestId('comparison-table')).not.toContainText('NaN')

  // Declaring the assumption makes the criterion available for both models.
  await page.getByTestId('comparison-assumption').check()
  const m0Text = (await page.getByTestId('comparison-m0-aicc').textContent()) ?? ''
  const m1Text = (await page.getByTestId('comparison-m1-aicc').textContent()) ?? ''
  expect(m0Text).not.toBe('unavailable')
  expect(m1Text).not.toBe('unavailable')
  expect(Number.isFinite(Number(m0Text))).toBe(true)
  expect(Number.isFinite(Number(m1Text))).toBe(true)
  await expect(page.getByTestId('comparison-difference-value')).toBeVisible()
  await expect(page.getByTestId('comparison-table')).not.toContainText('NaN')

  // The measurement table is unchanged by the comparison.
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(8)
})

test('reports AICc as unavailable when the baseline model has too few observations', async ({
  page,
}) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  // Five rows: M0 (K = 3) leaves room for the correction, M1 (K = 4) does not.
  await importTwoColumnCsv(page, {
    fileName: 'synthetic-47c-small.csv',
    csv: 'time,concentration\n0,100\n0.5,83\n1,70\n2,51\n3,39\n',
    name: 'Synthetic 47C small sample',
  })

  await page.getByTestId('dataset-fit').click()
  await expect(page.getByTestId('fit-model-comparison')).toBeVisible()
  await page.getByTestId('comparison-assumption').check()

  await expect(page.getByTestId('comparison-m0-aicc')).not.toHaveText('unavailable')
  await expect(page.getByTestId('comparison-m1-aicc')).toHaveText('unavailable')
  await expect(page.getByTestId('comparison-aicc-reasons')).toContainText(
    /n − K − 1 must be positive/i,
  )
  await expect(page.getByTestId('comparison-difference')).toHaveCount(0)
})
