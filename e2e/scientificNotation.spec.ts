import { expect, test, type Page } from '@playwright/test'
import { mockPubChem } from './sourceMocks.js'

/**
 * Scientific notation regression coverage (issue #36).
 *
 * These tests use the real application in Chromium. They assert the rendered
 * DOM (native <sub>/<sup>), not just source strings, at both desktop and
 * narrow viewport widths, and they fail if the page logs a console error or
 * throws during the interaction.
 */

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

test('calculator: formulas, field symbols, results and traces use sub/sup', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/calculator')
  await page.getByTestId('model-select').selectOption('dose-response.hill')

  const formula = page.getByTestId('model-formula')
  await expect(formula).toBeVisible()
  await expect(formula.locator('sub')).toHaveCount(3)
  await expect(formula.locator('sup')).toHaveCount(3)
  await expect(formula.locator('sub').nth(0)).toHaveText('0')
  await expect(formula.locator('sub').nth(1)).toHaveText('max')
  await expect(formula.locator('sub').nth(2)).toHaveText('50')

  await expect(page.getByTestId('field-emax').locator('label sub')).toHaveText('max')
  await expect(page.getByTestId('field-ec50').locator('label sub')).toHaveText('50')
  await expect(page.getByTestId('field-e0').locator('label sub')).toHaveText('0')
  await expect(page.getByTestId('field-emax').locator('label').first()).toContainText('Emax')

  await page.getByTestId('input-concentration-value').fill('10')
  await page.getByTestId('input-concentration-unit').selectOption('nM')
  await page.getByTestId('input-ec50-value').fill('10')
  await page.getByTestId('input-ec50-unit').selectOption('nM')
  await page.getByTestId('input-e0-value').fill('0')
  await page.getByTestId('input-e0-unit').fill('%')
  await page.getByTestId('input-emax-value').fill('100')
  await page.getByTestId('input-emax-unit').fill('%')
  await page.getByTestId('input-hillCoefficient-value').fill('1')
  await page.getByTestId('calculate-btn').click()

  const resultFormula = page.getByTestId('result-formula')
  await expect(resultFormula).toBeVisible()
  await expect(resultFormula.locator('sub')).toHaveCount(3)
  await expect(resultFormula.locator('sup')).toHaveCount(3)
  await expect(page.getByTestId('result-inputs').locator('sub')).toHaveCount(3)
  await expect(page.getByTestId('calculation-trace').locator('sub').first()).toBeVisible()
  await expect(page.getByTestId('calculation-trace').locator('sup').first()).toBeVisible()

  // Narrow viewport: notation still renders and does not overflow or clip.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(formula.locator('sub').first()).toBeVisible()
  await expect(resultFormula.locator('sup').first()).toBeVisible()
  const formulaBox = await formula.boundingBox()
  expect(formulaBox).not.toBeNull()
  expect((formulaBox?.x ?? 0) + (formulaBox?.width ?? 0)).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )

  expect(errors).toEqual([])
})

test('simulation: effect-site fields and equations use sub/sup and the chart legend is safe', async ({
  page,
}) => {
  const errors = watchErrors(page)
  await page.goto('/simulation')
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
  await page.getByTestId('effect-site-enabled').check()
  await page.getByTestId('effect-site-fu').fill('0.5')
  await page.getByTestId('effect-site-ke0').fill('2')
  await page.getByTestId('effect-site-kd').fill('2')

  await expect(page.getByTestId('effect-site-fu').locator('xpath=ancestor::div[@data-field-path]').locator('label sub')).toHaveText('u')
  await expect(page.getByTestId('effect-site-ke0').locator('xpath=ancestor::div[@data-field-path]').locator('label sub')).toHaveText('e0')
  await expect(page.getByTestId('effect-site-kd').locator('xpath=ancestor::div[@data-field-path]').locator('label sub')).toHaveText('d')

  await page.getByTestId('run-simulation').click()
  await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })

  const equations = page.getByTestId('effect-site-equations')
  await expect(equations).toContainText(/dCe\/dt/)
  await expect(equations.locator('sub')).toHaveCount(8)
  await expect(page.getByTestId('effect-site-parameters').locator('sub')).toHaveCount(4)
  await expect(page.getByTestId('effect-site-event-note')).toContainText(/pre-event/i)

  // Plotly labels are plain strings. The chart and its caption must not carry
  // raw notation; the full formula is rendered as React markup in the
  // explanation above.
  await page.getByTestId('view-tab-occupancy').click()
  const occupancyChart = page.getByTestId('simulation-chart-occupancy')
  await expect(occupancyChart).toBeVisible()
  await expect(occupancyChart).not.toContainText('Kd')
  await expect(occupancyChart).not.toContainText('Ce/')
  const figure = page.getByTestId('chart-figure')
  await expect(figure).toContainText('Occupancy (fraction of receptors)')
  await expect(figure).not.toContainText('K_d')
  await expect(page.getByTestId('effect-site-equations')).toContainText('Occupancy(t)')

  // Narrow viewport: the controls and equations remain readable.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(equations.locator('sub').first()).toBeVisible()
  await expect(
    page
      .getByTestId('effect-site-fu')
      .locator('xpath=ancestor::div[@data-field-path]')
      .locator('label sub'),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )

  expect(errors).toEqual([])
})

test('data sources: molecular-formula element counts render as subscripts', async ({ page }) => {
  const errors = watchErrors(page)
  await mockPubChem(page)
  await page.goto('/data-sources')

  await page.getByTestId('query-input').fill('synthetic')
  await page.getByTestId('search-button').click()
  const results = page.getByTestId('compound-results')
  await expect(results).toBeVisible()
  await expect(results).toContainText('C12H14N2O')
  await expect(results.locator('sub')).toHaveCount(3)
  await expect(results.locator('sub').nth(0)).toHaveText('12')
  await expect(results.locator('sub').nth(1)).toHaveText('14')
  await expect(results.locator('sub').nth(2)).toHaveText('2')

  await page.getByTestId('compound-select-pubchem:90000001').check()
  await page.getByTestId('confirm-import-button').click()
  const stored = page.getByTestId('stored-compounds')
  await expect(stored).toContainText('Synthetic Fixture Compound')
  await expect(stored.locator('sub')).toHaveCount(3)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(results.locator('sub').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )

  expect(errors).toEqual([])
})
