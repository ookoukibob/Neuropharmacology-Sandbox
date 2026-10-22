import { test, expect } from '@playwright/test'

/**
 * Effect-site analysis end to end (phase 46).
 *
 * Runs the real application against real IndexedDB in an isolated browser
 * context. Asserts user-visible outcomes only: the opt-in editor, the new
 * views, the diagnostics explanation, stale-result invalidation, and the
 * saved-scenario round trip. No arbitrary screenshot values — the checks are
 * structural (labels, units, view availability, presence of results).
 */

/** The simulation form is intentionally blank; tests enter valid PK inputs explicitly. */
async function fillBaseScenario(page: import('@playwright/test').Page): Promise<void> {
  for (const [testId, value] of [
    ['central-volume-value', '10'],
    ['peripheral-volume-value', '20'],
    ['clearance-value', '2'],
    ['q-value', '3'],
    ['initial-central-value', '100'],
    ['initial-peripheral-value', '0'],
    ['start-time-value', '0'],
    ['end-time-value', '24'],
    ['output-interval-value', '0.25'],
  ] as const) {
    await page.getByTestId(testId).fill(value)
  }
}

const enableEffectSite = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.getByTestId('effect-site-enabled').check()
}

const fillValid = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.getByTestId('effect-site-fu').fill('0.5')
  await page.getByTestId('effect-site-ke0').fill('2')
  await page.getByTestId('effect-site-kd').fill('2')
}

test('PK-only baseline: no effect-site controls and no extra views', async ({ page }) => {
  await page.goto('/simulation')
  await fillBaseScenario(page)
  await expect(page.getByTestId('effect-site-enabled')).not.toBeChecked()
  await expect(page.getByTestId('effect-site-fu')).toHaveCount(0)

  await page.getByTestId('run-simulation').click()
  await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })

  const tabs = page.getByRole('radiogroup', { name: 'Chart view' }).getByRole('radio')
  await expect(tabs).toHaveCount(3)
  await expect(page.getByTestId('view-tab-effect-site')).toHaveCount(0)
  await expect(page.getByTestId('view-tab-occupancy')).toHaveCount(0)
  await expect(page.getByTestId('effect-site-explanation')).toHaveCount(0)
})

test('valid configuration runs and exposes both new views with diagnostics', async ({ page }) => {
  await page.goto('/simulation')
  await fillBaseScenario(page)
  await enableEffectSite(page)
  await fillValid(page)

  await page.getByTestId('run-simulation').click()
  await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })

  const group = page.getByRole('radiogroup', { name: 'Chart view' })
  await expect(group.getByRole('radio')).toHaveCount(5)

  await page.getByTestId('view-tab-effect-site').click()
  await expect(page.getByTestId('simulation-chart-effect-site')).toBeVisible()
  await page.getByTestId('view-tab-occupancy').click()
  await expect(page.getByTestId('simulation-chart-occupancy')).toBeVisible()

  // Diagnostics explain the model with this run's values.
  const explanation = page.getByTestId('effect-site-explanation')
  await expect(explanation).toBeVisible()
  await expect(page.getByTestId('effect-site-parameters')).toContainText('0.5')
  await expect(page.getByTestId('effect-site-parameters')).toContainText('2 mg/L')
  await expect(page.getByTestId('effect-site-method-note')).toContainText(/piecewise linear/i)
  await expect(page.getByTestId('effect-site-assumptions')).toContainText(/NOT a brain or CNS model/i)
})

test('an incomplete enabled configuration never runs the engine', async ({ page }) => {
  await page.goto('/simulation')
  await fillBaseScenario(page)
  await enableEffectSite(page)
  await page.getByTestId('effect-site-ke0').fill('abc')

  await page.getByTestId('run-simulation').click()
  const ke0 = page.getByTestId('effect-site-ke0')
  await expect(ke0).toHaveAttribute('aria-invalid', 'true')
  const describedBy = await ke0.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`#${describedBy}`)).toContainText(/finite number/i)
  // No result was produced for the invalid draft.
  await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
  await expect(page.getByTestId('effect-site-explanation')).toHaveCount(0)
})

test('view switching is presentation-only and edits invalidate the result', async ({ page }) => {
  await page.goto('/simulation')
  await fillBaseScenario(page)
  await enableEffectSite(page)
  await fillValid(page)
  await page.getByTestId('run-simulation').click()
  await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })
  const summary = page.getByTestId('simulation-summary')
  const before = await summary.textContent()

  // Switching views must not produce a new run: the run number is unchanged.
  await page.getByTestId('view-tab-occupancy').click()
  await page.getByTestId('view-tab-concentration').click()
  await expect(summary).toHaveText(before ?? '')

  // Editing a relevant effect-site input clears the stale result.
  await page.getByTestId('effect-site-ke0').fill('3')
  await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
  await expect(page.getByTestId('simulation-idle')).toBeVisible()
})

test('a configured scenario round-trips through save and load', async ({ page }) => {
  await page.goto('/simulation')
  await fillBaseScenario(page)
  await enableEffectSite(page)
  await fillValid(page)
  await page.getByTestId('scenario-name-input').fill('Effect site example')
  await page.getByTestId('scenario-save').click()
  await expect(page.getByTestId('scenario-list')).toContainText('Effect site example')

  // Change the draft, then load the saved record back.
  await page.getByTestId('effect-site-ke0').fill('9')
  const row = page.getByTestId(/^scenario-row-/).first()
  await row.getByRole('button', { name: /^Load “Effect site example”$/ }).click()
  // Unsaved-change guard appears (dirty draft); confirm.
  await page.getByTestId('scenario-load-confirm-accept').click()

  await expect(page.getByTestId('effect-site-ke0')).toHaveValue('2')
  await expect(page.getByTestId('effect-site-fu')).toHaveValue('0.5')
  await expect(page.getByTestId('effect-site-enabled')).toBeChecked()

  // Saving never ran the engine; only an explicit Run does.
  await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
  await page.getByTestId('run-simulation').click()
  await expect(page.getByTestId('view-tab-effect-site')).toBeVisible({ timeout: 30_000 })
})

test('blank effect-site text is saved verbatim without running the engine', async ({ page }) => {
  await page.goto('/simulation')
  await fillBaseScenario(page)
  await enableEffectSite(page)
  await page.getByTestId('effect-site-ke0').fill('not-a-number')
  await page.getByTestId('scenario-name-input').fill('Blank draft')
  await page.getByTestId('scenario-save').click()
  await expect(page.getByTestId('scenario-list')).toContainText('Blank draft')
  await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)

  // Reload the page (real IndexedDB), then load it back.
  await page.reload()
  const row = page.getByTestId(/^scenario-row-/).first()
  await row.getByRole('button', { name: /^Load “Blank draft”$/ }).click()
  await expect(page.getByTestId('effect-site-ke0')).toHaveValue('not-a-number')
  await expect(page.getByTestId('effect-site-enabled')).toBeChecked()
})
