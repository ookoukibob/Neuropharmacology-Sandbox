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
  expect(npex.formatVersion).toBe('1.2.0')
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

test('shows residual structure for both fitted models and keeps duplicates separate', async ({
  page,
}) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await importTwoColumnCsv(page, {
    fileName: 'synthetic-residual-structure.csv',
    csv:
      'time,concentration\n' +
      '0,100\n0.5,89.8\n1,67\n2,44.9\n3,30.1\n5,20.2\n7,13.5\n9,9\n',
    name: 'Synthetic residual structure',
  })

  // Nothing is shown before a fit exists.
  await expect(page.getByTestId('residual-structure')).toHaveCount(0)
  await page.getByTestId('dataset-fit').click()
  await expect(page.getByTestId('fit-results')).toBeVisible()

  const card = page.getByTestId('residual-structure')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('residual-structure-m0')).toBeVisible()
  await expect(page.getByTestId('residual-structure-m1')).toBeVisible()

  // Both views exist per model, with declared units on both axes.
  const m0Time = page.getByTestId('fit-residual-chart')
  const m0Fitted = page.getByTestId('residual-fitted-chart-m0')
  const m1Fitted = page.getByTestId('residual-fitted-chart-m1')
  await expect(m0Time.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
  await expect(m0Fitted.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
  await expect(m1Fitted.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })

  await expect(m0Time.locator('.scatterlayer .points path')).toHaveCount(8)
  await expect(m0Fitted.locator('.scatterlayer .points path')).toHaveCount(8)
  await expect(m1Fitted.locator('.scatterlayer .points path')).toHaveCount(8)
  // Markers only: no line trace joins the observations.
  await expect(m0Fitted.locator('.scatterlayer .lines path')).toHaveCount(0)

  await expect(m0Time.locator('.xtitle')).toContainText('Time (h)')
  await expect(m0Fitted.locator('.xtitle')).toContainText('Fitted concentration (mg/L)')
  await expect(m0Fitted.locator('.ytitle')).toContainText('Residual')
  await expect(m0Fitted.locator('.ytitle')).toContainText('mg/L')

  // The screen states its heuristic and never claims a test result.
  await expect(page.getByTestId('residual-spread-m0')).toContainText(
    /does not establish heteroscedasticity/i,
  )
  await expect(page.getByTestId('residual-ordering-m0')).toContainText(/measured time/i)
  await expect(card).not.toContainText('NaN')

  // Duplicate timestamps stay separate observations in every view.
  await importTwoColumnCsv(page, {
    fileName: 'synthetic-residual-duplicates.csv',
    csv: 'time,concentration\n0,100\n0,98\n1,62\n1,60\n2,40\n2,39\n',
    name: 'Synthetic residual duplicates',
  })
  await page.getByTestId('dataset-fit').click()
  await expect(page.getByTestId('fit-results')).toBeVisible()
  await expect(page.getByTestId('residual-ordering-m0')).toContainText(/sharing a timestamp/i)
  await expect(page.getByTestId('fit-residual-chart').locator('.js-plotly-plot')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByTestId('fit-residual-chart').locator('.scatterlayer .points path')).toHaveCount(6)
  await expect(page.getByTestId('residual-fitted-chart-m0').locator('.scatterlayer .points path')).toHaveCount(6)
})

test('offers a second error model only after its own declaration', async ({ page }) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await importTwoColumnCsv(page, {
    fileName: 'synthetic-proportional-variance.csv',
    csv:
      'time,concentration\n' +
      '0,100\n0.5,83.61\n1,70.32\n2,50.44\n3,37.13\n5,22.24\n7,14.92\n9,11.12\n',
    name: 'Synthetic proportional variance',
  })

  // The section does not exist before a fit.
  await expect(page.getByTestId('proportional-comparison')).toHaveCount(0)
  await page.getByTestId('dataset-fit').click()
  await expect(page.getByTestId('fit-results')).toBeVisible()

  const card = page.getByTestId('proportional-comparison')
  await expect(card).toBeVisible()
  const assumption = page.getByTestId('proportional-assumption')
  await expect(assumption).not.toBeChecked()

  // Nothing is computed or shown before the analyst declares the assumption.
  await expect(page.getByTestId('proportional-table')).toHaveCount(0)
  await expect(page.getByTestId('proportional-gate')).toContainText(
    /stays unavailable until the assumption is declared/i,
  )

  // The existing common-variance comparison keeps its own values.
  await expect(page.getByTestId('comparison-table')).toBeVisible()
  await expect(page.getByTestId('comparison-m0-aicc')).toHaveText('unavailable')

  await assumption.check()

  const table = page.getByTestId('proportional-table')
  await expect(table).toBeVisible()
  await expect(table).toContainText(/Maximum-likelihood comparison/i)
  await expect(table).toContainText(/not comparable with the common-variance criterion/i)
  await expect(page.getByTestId('proportional-m0-dispersion')).toContainText('mg/L')
  await expect(page.getByTestId('proportional-m1-baseline')).toContainText('mg/L')

  // Both criteria are available for this eight-row dataset.
  const m0 = Number(await page.getByTestId('proportional-m0-aicc').textContent())
  const m1 = Number(await page.getByTestId('proportional-m1-aicc').textContent())
  expect(Number.isFinite(m0)).toBe(true)
  expect(Number.isFinite(m1)).toBe(true)
  await expect(table).not.toContainText('NaN')
  await expect(page.getByTestId('proportional-difference-value')).toBeVisible()

  // The common-variance criterion is untouched by this declaration.
  await expect(page.getByTestId('comparison-m0-aicc')).toHaveText('unavailable')

  // Withdrawing the declaration removes the alternative analysis again.
  await assumption.uncheck()
  await expect(page.getByTestId('proportional-table')).toHaveCount(0)

  // Measured rows are unchanged throughout.
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(8)
})

test('runs noncompartmental analysis on the selected dataset', async ({ page }) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await importTwoColumnCsv(page, {
    fileName: 'synthetic-nca.csv',
    csv:
      'time,concentration\n' +
      '0,100\n1,60.653\n2,36.788\n3,22.313\n4,13.534\n5,8.208\n',
    name: 'Synthetic NCA study',
  })

  // The NCA card is present without running a fit.
  const card = page.getByTestId('nca-card')
  await expect(card).toBeVisible()

  await expect(page.getByTestId('nca-cmax')).toContainText('100')
  await expect(page.getByTestId('nca-cmax')).toContainText('mg/L')
  await expect(page.getByTestId('nca-auc-last')).toContainText('mg/L·h')
  await expect(page.getByTestId('nca-lambda-z')).toContainText('h⁻¹')
  await expect(page.getByTestId('nca-terminal')).toContainText(/source rows 4, 5, 6/)
  await expect(page.getByTestId('nca-table')).not.toContainText('NaN')

  // Changing the integration method recomputes the AUC.
  const before = await page.getByTestId('nca-auc-last').textContent()
  await page.getByTestId('nca-integration-method').selectOption('linear-up-log-down')
  const after = await page.getByTestId('nca-auc-last').textContent()
  expect(after).not.toBe(before)

  // The measured rows are untouched by the analysis.
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(6)
})

test('records and displays administration metadata without touching measurements', async ({ page }) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await importTwoColumnCsv(page, {
    fileName: 'synthetic-admin.csv',
    csv:
      'time,concentration\n' +
      '0,100\n1,60.653\n2,36.788\n3,22.313\n4,13.534\n5,8.208\n',
    name: 'Synthetic administration study',
  })

  // A freshly imported CSV dataset has no administration metadata, shown as unknown.
  await expect(page.getByTestId('administration-unknown')).toContainText(/unknown/i)

  // Add an explicit IV-bolus context.
  await page.getByTestId('administration-edit').click()
  await page.getByTestId('administration-route').selectOption('iv-bolus')
  await page.getByTestId('administration-regimen').selectOption('single-dose')
  await page.getByTestId('administration-time-reference').selectOption('dose-time')
  await page.getByTestId('administration-dose').fill('100')
  await page.getByTestId('administration-save').click()

  // The summary shows the known context, and the measurement rows are untouched.
  const summary = page.getByTestId('administration-summary')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('IV bolus')
  await expect(summary).toContainText('100 mg')
  await expect(summary).toContainText('Dose administration time')
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(6)

  // The dose-dependent NCA now has what it needs: an IV bolus with an explicit
  // dose, a single-dose regimen, a matching time origin and a complete AUC(0→∞).
  await expect(page.getByTestId('dose-dependent-cl')).toContainText('L/h')
  await expect(page.getByTestId('dose-dependent-cl-status')).toContainText('available')
  await expect(page.getByTestId('dose-dependent-vz')).toContainText(/L$/)
  // F = 1 by the IV route, so the apparent twins are explicitly not applicable.
  await expect(page.getByTestId('dose-dependent-cl-f-status')).toContainText('not applicable')
  // The audit block names the dose and the AUC interval that were used.
  await expect(page.getByTestId('dose-dependent-inputs')).toContainText('100 mg')
})

test('analyses a selected steady-state interval only after it is confirmed', async ({ page }) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  // C = 100 − 5t over one 12 h dosing interval: AUCτ = (100 + 40)/2 · 12 = 840.
  await importTwoColumnCsv(page, {
    fileName: 'synthetic-steady-state.csv',
    csv:
      'time,concentration\n' +
      '0,100\n2,90\n4,80\n6,70\n8,60\n10,50\n12,40\n',
    name: 'Synthetic steady-state study',
  })

  // A single-dose regimen offers no interval analysis.
  await expect(page.getByTestId('repeated-dose-nca')).toHaveCount(0)

  // Record a repeated regimen that the analyst declares to be at steady state,
  // with a per-administration dose and a 12 h interval.
  await page.getByTestId('administration-edit').click()
  await page.getByTestId('administration-route').selectOption('iv-bolus')
  await page.getByTestId('administration-regimen').selectOption('repeated-dose-steady-state')
  await page.getByTestId('administration-time-reference').selectOption('dose-time')
  await page.getByTestId('administration-dose').fill('84')
  await page.getByTestId('administration-dose-unit').selectOption('mg')
  await page.getByTestId('administration-dose-basis').selectOption('per-administration')
  await page.getByTestId('administration-interval').fill('12')
  await page.getByTestId('administration-interval-unit').selectOption('h')
  await page.getByTestId('administration-save').click()

  await expect(page.getByTestId('administration-summary')).toContainText('Per administration')
  await expect(page.getByTestId('administration-summary')).toContainText('12 h')

  // The interval analysis exists but refuses to guess which window to use.
  await expect(page.getByTestId('repeated-dose-nca')).toBeVisible()
  await expect(page.getByTestId('repeated-dose-tau')).toContainText('12 h')
  await expect(page.getByTestId('interval-auc-unavailable')).toContainText('INTERVAL_NOT_SELECTED')
  await expect(page.getByTestId('steady-state-cl-status')).toContainText('unavailable')

  // An interval that is not one τ wide is refused, not silently accepted.
  await page.getByTestId('repeated-interval-start').selectOption('0')
  await page.getByTestId('repeated-interval-end').selectOption('8')
  await expect(page.getByTestId('interval-auc-unavailable')).toContainText('INTERVAL_LENGTH_MISMATCH')

  // The τ-wide interval integrates to the hand-checkable 840 mg/L·h.
  await page.getByTestId('repeated-interval-end').selectOption('12')
  const intervalBlock = page.getByTestId('interval-auc')
  await expect(intervalBlock).toContainText('840')
  await expect(intervalBlock).toContainText('mg/L·h')
  await expect(intervalBlock).toContainText('1, 2, 3, 4, 5, 6, 7')

  // Interval exposure: the observed peak/trough and the interval mean are
  // reported from the same selected interval, before any steady-state claim.
  await expect(page.getByTestId('exposure-cmax-obs')).toContainText('100 mg/L')
  await expect(page.getByTestId('exposure-tmax-obs')).toContainText('0 h')
  await expect(page.getByTestId('exposure-cmin-obs')).toContainText('40 mg/L')
  await expect(page.getByTestId('exposure-tmin-obs')).toContainText('12 h')
  await expect(page.getByTestId('exposure-cavg-interval')).toContainText('70 mg/L')
  await expect(page.getByTestId('exposure-peak-observations')).toContainText('source row 1')
  await expect(page.getByTestId('exposure-trough-observations')).toContainText('source row 7')
  // The steady-state mean stays withheld until the alignment is confirmed.
  await expect(page.getByTestId('exposure-cavg-ss-status')).toContainText('unavailable')

  // Without the analyst's confirmation the steady-state parameters stay refused.
  await expect(page.getByTestId('steady-state-unavailable')).toContainText('INTERVAL_NOT_ALIGNED')

  // Confirming that the interval starts at a dose unlocks CL = 84 / 840 = 0.1 L/h.
  await page.getByTestId('interval-aligned').check()
  await expect(page.getByTestId('steady-state-cl-status')).toContainText('available')
  await expect(page.getByTestId('steady-state-cl')).toContainText('0.1 L/h')
  await expect(page.getByTestId('steady-state-cl-f-status')).toContainText('not applicable')
  await expect(page.getByTestId('steady-state-inputs')).toContainText('per-administration')

  // With the confirmation, the steady-state mean and the fluctuation follow:
  // 840 / 12 = 70 mg/L and 100 · (100 − 40) / 70 = 85.714… %.
  await expect(page.getByTestId('exposure-cavg-ss-status')).toContainText('available')
  await expect(page.getByTestId('exposure-cavg-ss')).toContainText('70 mg/L')
  await expect(page.getByTestId('exposure-fluctuation')).toContainText('85.714')
  await expect(page.getByTestId('exposure-fluctuation')).toContainText('%')

  // The recorded measurements are untouched by any of the analysis.
  await expect(page.locator('[data-testid="dataset-measurement-row"]')).toHaveCount(7)
})

test('reports observed exposure without inventing a steady-state mean', async ({ page }) => {
  await page.goto('/experiments')
  await expect(page.getByTestId('datasets-empty')).toBeVisible()

  await importTwoColumnCsv(page, {
    fileName: 'synthetic-repeated.csv',
    csv:
      'time,concentration\n' +
      '0,100\n2,90\n4,80\n6,70\n8,60\n10,50\n12,40\n',
    name: 'Synthetic repeated-dose study',
  })

  // Repeated dosing NOT at steady state, with τ recorded so an interval exists.
  await page.getByTestId('administration-edit').click()
  await page.getByTestId('administration-route').selectOption('iv-bolus')
  await page.getByTestId('administration-regimen').selectOption('repeated-dose')
  await page.getByTestId('administration-time-reference').selectOption('dose-time')
  await page.getByTestId('administration-dose').fill('84')
  await page.getByTestId('administration-dose-basis').selectOption('per-administration')
  await page.getByTestId('administration-interval').fill('12')
  await page.getByTestId('administration-save').click()

  await page.getByTestId('repeated-interval-start').selectOption('0')
  await page.getByTestId('repeated-interval-end').selectOption('12')
  await page.getByTestId('interval-aligned').check()

  // The observed metrics are descriptive and available...
  await expect(page.getByTestId('exposure-cmax-obs')).toContainText('100 mg/L')
  await expect(page.getByTestId('exposure-cavg-interval')).toContainText('70 mg/L')
  // ...but nothing is published as a steady-state conclusion.
  await expect(page.getByTestId('exposure-cavg-ss-status')).toContainText('not applicable')
  await expect(page.getByTestId('exposure-fluctuation-status')).toContainText('not applicable')
  await expect(page.getByTestId('exposure-unavailable')).toContainText('REGIMEN_NOT_STEADY_STATE')
  await expect(page.getByTestId('exposure-scope')).toContainText('not the true extremes between samples')
})
