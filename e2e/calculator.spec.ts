import { expect, test, type Page } from '@playwright/test'

/**
 * Critical calculator workflows (phase 4 closure pass).
 *
 * A  occupancy calculation: result, formula, calculation trace
 * B  PK parameterization switching (regression for the discriminated-union bug)
 * C  drug record → calculator with provenance, explicit candidate loading only
 * D  stale-state semantics (input edits and library loads mark stale)
 * E  curve workflow: explicit range → chart, settings-stale indication
 *
 * Every value used here is synthetic. Records created by these tests are
 * tagged `synthetic-fixture` and carry an explicit note — no real
 * pharmacological parameter is ever introduced to make a test convenient.
 */

/**
 * Create a synthetic drug record through the real UI (library → new →
 * target → Kd parameter → save) and land on its detail page.
 */
async function createSyntheticDrug(
  page: Page,
  name: string,
  targetName: string,
  kd: string,
): Promise<void> {
  await page.goto('/library')
  await page.getByTestId('new-drug').click()
  await expect(page.getByRole('heading', { name: 'New Drug Record' })).toBeVisible()

  await page.getByTestId('drug-name').fill(name)
  await page.locator('#drug-tags').fill('synthetic-fixture')
  await page
    .locator('#drug-notes')
    .fill('Synthetic record created by end-to-end tests — not pharmacological information.')

  await page.getByTestId('add-target').click()
  await page.locator('#target-name-1').fill(targetName)
  await page.getByTestId('add-param').click()
  await page.locator('#param-kind-1-0').selectOption('kd')
  await page.locator('#param-value-1-0').fill(kd)
  await page.locator('#param-unit-1-0').selectOption('nM')

  await page.getByTestId('save-drug').click()
  await expect(page.getByRole('heading', { name: 'Drug Detail' })).toBeVisible()
  await expect(page.getByTestId('param-Kd')).toContainText(`${kd} nM`)
}

/** Fill the occupancy model with synthetic [D] and Kd values (units in nM). */
async function fillOccupancy(page: Page, concentration: string, kd: string): Promise<void> {
  await page.getByTestId('input-concentration-value').fill(concentration)
  await page.getByTestId('input-concentration-unit').selectOption('nM')
  await page.getByTestId('input-kd-value').fill(kd)
  await page.getByTestId('input-kd-unit').selectOption('nM')
}

test('occupancy: calculates [D]/([D]+Kd) and shows result, formula and trace', async ({
  page,
}) => {
  await page.goto('/calculator')
  await expect(page.getByTestId('calculator-view')).toBeVisible()
  await page.getByTestId('model-select').selectOption('occupancy.single-site')

  // Synthetic inputs: [D] = 10 nM, Kd = 10 nM → fractional occupancy 0.5.
  await fillOccupancy(page, '10', '10')
  await page.getByTestId('calculate-btn').click()

  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('calculation-errors')).toBeHidden()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('0.5')
  await expect(page.getByTestId('result-outputs')).toContainText('50')
  await expect(page.getByTestId('result-formula')).toContainText(
    'Occupancy = [D] / ([D] + Kd)',
  )
  await expect(page.getByTestId('result-inputs')).toContainText('10 nM')

  // Structured calculation trace with at least one step.
  await expect(page.getByTestId('calculation-trace')).toBeVisible()
  await expect(page.getByTestId(/^trace-step-/).first()).toBeVisible()

  // Typed values make an explicit "no source claim".
  await expect(page.getByTestId('source-concentration')).toContainText(
    'no source claim',
  )
  await expect(page.getByTestId('source-kd')).toContainText('no source claim')
})

test('pk: half-life ↔ rate-constant switching preserves inputs and recalculates', async ({
  page,
}) => {
  await page.goto('/calculator')
  await page.getByTestId('model-select').selectOption('pk.first-order-one-compartment')

  // Half-life parameterization is active; k has no field at all.
  await expect(page.getByTestId('pk-mode-toggle')).toBeVisible()
  await expect(page.getByTestId('pk-mode-halfLife')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByTestId('field-halfLife')).toBeVisible()
  await expect(page.getByTestId('field-k')).toBeHidden()

  // Synthetic inputs: C0 = 100 nM, t = 8 h, t½ = 8 h → C(t) = 50 nM.
  await page.getByTestId('input-c0-value').fill('100')
  await page.getByTestId('input-c0-unit').selectOption('nM')
  await page.getByTestId('input-time-value').fill('8')
  await page.getByTestId('input-time-unit').selectOption('h')
  await page.getByTestId('input-halfLife-value').fill('8')
  await page.getByTestId('input-halfLife-unit').selectOption('h')
  await page.getByTestId('calculate-btn').click()

  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('C(t)')
  await expect(page.getByTestId('result-outputs')).toContainText('50')

  // Switch to the rate-constant parameterization (union-discriminant regression).
  await page.getByTestId('pk-mode-k').click()
  await expect(page.getByTestId('pk-mode-k')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('pk-mode-halfLife')).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(page.getByTestId('field-k')).toBeVisible()
  await expect(page.getByTestId('field-halfLife')).toBeHidden()
  // A mode change invalidates the previous result.
  await expect(page.getByTestId('result-stale')).toBeVisible()

  await page.getByTestId('input-k-value').fill('0.08664339757') // ≈ ln(2) / 8 h
  await page.getByTestId('input-k-unit').selectOption('1/h')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('calculation-errors')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('C(t)')

  // Switch back: the t½ parameterization still works and typed input survived.
  await page.getByTestId('pk-mode-halfLife').click()
  await expect(page.getByTestId('field-halfLife')).toBeVisible()
  await expect(page.getByTestId('field-k')).toBeHidden()
  await expect(page.getByTestId('input-halfLife-value')).toHaveValue('8')
  await expect(page.getByTestId('input-c0-value')).toHaveValue('100')
  await expect(page.getByTestId('input-time-value')).toHaveValue('8')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('50')
})

test('library: drug record reaches the calculator only via explicit load', async ({
  page,
}) => {
  await createSyntheticDrug(page, 'E2E Synthetic Example', 'E2E-R1', '4')

  await page.getByTestId('calculate-from-detail').click()
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible()
  await expect(page.getByText('Using parameters from:')).toBeVisible()

  // The candidate is visible but nothing is selected automatically.
  await expect(page.getByTestId('input-kd-load')).toBeVisible()
  await expect(page.getByTestId('input-kd-value')).toHaveValue('')
  await expect(page.getByTestId('source-kd')).toBeHidden()

  // Explicit selection loads value + provenance indicator.
  await page.getByTestId('input-kd-load').selectOption({ index: 1 })
  await expect(page.getByTestId('input-kd-value')).toHaveValue('4')
  await expect(page.getByTestId('source-kd')).toContainText('From library')
  await expect(page.getByTestId('source-kd')).toContainText('E2E-R1 · Kd')
  await expect(
    page.getByTestId('source-kd').getByTestId('provenance-badge'),
  ).toBeVisible()

  // Synthetic concentration only — the Kd stays loaded from the library.
  await page.getByTestId('input-concentration-value').fill('10')
  await page.getByTestId('input-concentration-unit').selectOption('nM')
  await page.getByTestId('calculate-btn').click()

  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  // 10 / (10 + 4) = 0.714…
  await expect(page.getByTestId('result-outputs')).toContainText('0.714')
  // The library value keeps its provenance inside the report's inputs.
  await expect(page.getByTestId('result-inputs')).toContainText('4 nM')
  await expect(
    page.getByTestId('result-inputs').getByTestId('provenance-badge'),
  ).toBeVisible()
})

test('stale: input edits and library loads mark the result stale until recalculated', async ({
  page,
}) => {
  await createSyntheticDrug(page, 'E2E Stale Example', 'E2E-R1', '4')
  await page.getByTestId('calculate-from-detail').click()
  await expect(page.getByTestId('calculator-view')).toBeVisible()

  await fillOccupancy(page, '10', '10')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()

  // 1. Editing a calculation input marks the result stale.
  await page.getByTestId('input-concentration-value').fill('20')
  await expect(page.getByTestId('result-stale')).toBeVisible()
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-stale')).toBeHidden()

  // 2. Loading a different value from the library marks the result stale.
  await page.getByTestId('input-kd-load').selectOption({ index: 1 })
  await expect(page.getByTestId('input-kd-value')).toHaveValue('4')
  await expect(page.getByTestId('result-stale')).toBeVisible()
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('source-kd')).toContainText('From library')
})

test('curve: explicit range generates the chart and settings changes are flagged', async ({
  page,
}) => {
  await page.goto('/calculator')
  await page.getByTestId('model-select').selectOption('occupancy.single-site')
  await fillOccupancy(page, '10', '10')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()

  // A successful calculation without an explicit range never draws a chart.
  await expect(page.getByTestId('range-not-configured')).toBeVisible()
  await expect(page.getByTestId('no-curve')).toBeVisible()
  await expect(page.getByTestId('curve-chart')).toBeHidden()
  await expect(page.getByTestId('x-scale-log')).toBeChecked()

  await page.getByTestId('range-min').fill('0.1')
  await page.getByTestId('range-max').fill('100')
  await page.getByTestId('apply-curve').click()

  await expect(page.getByTestId('curve-chart')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('range-not-configured')).toBeHidden()
  await expect(page.getByTestId('curve-settings-stale')).toBeHidden()

  // Changing the range flags the settings as changed until the curve is updated.
  await page.getByTestId('range-max').fill('200')
  await expect(page.getByTestId('curve-settings-stale')).toBeVisible()
  await page.getByTestId('apply-curve').click()
  await expect(page.getByTestId('curve-settings-stale')).toBeHidden()
  await expect(page.getByTestId('curve-chart')).toBeVisible()
})
