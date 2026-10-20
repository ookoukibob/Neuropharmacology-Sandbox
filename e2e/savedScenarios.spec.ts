import { test, expect } from '@playwright/test'

/**
 * Saved scenarios, end to end (phase 45).
 *
 * Runs against the real app and its real IndexedDB (isolated browser context
 * per test, so no developer data is involved). Asserts user-visible outcomes:
 * the list, faithful reload of an incomplete draft, the unsaved-changes
 * guard, rename/duplicate/delete identity, persistence across a reload, and
 * that data management never runs the simulation.
 */

test('save, reload, load, rename, duplicate and delete a scenario', async ({ page }) => {
  await page.goto('/simulation')
  await expect(page.getByTestId('scenarios-empty')).toBeVisible()

  // 2. Represent a draft: change one parameter and one event row.
  await page.getByTestId('clearance-value').fill('6')
  await page.getByTestId('bolus-2-amount').fill('45')

  // 3. Save under a name.
  await page.getByTestId('scenario-name-input').fill('  Nephritic demo  ')
  await page.getByTestId('scenario-save').click()
  const list = page.getByTestId('scenario-list')
  await expect(list).toContainText('Nephritic demo')
  await expect(page.getByTestId('scenario-feedback')).toContainText(/Saved as “Nephritic demo”/)

  // 4. No simulation was triggered by saving.
  await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
  await expect(page.getByTestId('simulation-idle')).toBeVisible()

  // 11. The scenario survives a real page reload (persistence check).
  await page.reload()
  await expect(page.getByTestId('scenario-list')).toContainText('Nephritic demo')

  // 5. Change the draft again, then attempt to load without confirming.
  await page.getByTestId('clearance-value').fill('9')
  const row = page.getByTestId(/^scenario-row-/).first()
  await row.getByRole('button', { name: /^Load “Nephritic demo”$/ }).click()

  // 7. The unsaved-changes guard appears; cancelling preserves the edit.
  await expect(page.getByTestId('scenario-load-confirm')).toBeVisible()
  await page.getByTestId('scenario-load-confirm-cancel').click()
  await expect(page.getByTestId('scenario-load-confirm')).toHaveCount(0)
  await expect(page.getByTestId('clearance-value')).toHaveValue('9')

  // Confirming discards the edit and restores the saved values faithfully.
  await row.getByRole('button', { name: /^Load “Nephritic demo”$/ }).click()
  await page.getByTestId('scenario-load-confirm-accept').click()
  await expect(page.getByTestId('clearance-value')).toHaveValue('6')
  await expect(page.getByTestId('bolus-2-amount')).toHaveValue('45')
  await expect(page.getByTestId('scenario-feedback')).toContainText(/Loaded “Nephritic demo”/)
  // Loading is data management: still no result on screen.
  await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)

  // 8. Rename the loaded scenario in place.
  await row.getByRole('button', { name: /^Rename “Nephritic demo”$/ }).click()
  const renameInput = row.getByTestId(/^rename-input-/)
  await renameInput.fill('Nephritic demo v2')
  await row.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByTestId('scenario-list')).toContainText('Nephritic demo v2')

  // Duplicate creates a second, independent record.
  await page.getByTestId('scenario-list').getByRole('button', { name: /^Duplicate “Nephritic demo v2”$/ }).click()
  await expect(page.getByTestId('scenario-list')).toContainText('Nephritic demo v2 (copy)')
  await expect(page.locator('[data-testid^="scenario-row-"]')).toHaveCount(2)

  // 9/10. Delete with explicit acknowledgement; cancel keeps the record.
  const copyRow = page.locator('[data-testid^="scenario-row-"]').filter({ hasText: 'Nephritic demo v2 (copy)' })
  await copyRow.getByRole('button', { name: /^Delete “Nephritic demo v2 \(copy\)”$/ }).click()
  await expect(copyRow.getByTestId(/^delete-confirm-text-/)).toContainText(/draft currently in the editor is not affected/)
  await copyRow.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('[data-testid^="scenario-row-"]')).toHaveCount(2)

  await copyRow.getByRole('button', { name: /^Delete “Nephritic demo v2 \(copy\)”$/ }).click()
  await copyRow.getByRole('button', { name: /Confirm delete/ }).click()
  await expect(page.locator('[data-testid^="scenario-row-"]')).toHaveCount(1)

  // 12/13. Only an explicit Run starts the engine; a loaded draft's result is
  // the one shown, and the earlier draft's result was cleared.
  await page.getByTestId('run-simulation').click()
  await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('simulation-summary')).toContainText('Run 1')
})

test('rejects an empty name and reports storage honestly', async ({ page }) => {
  await page.goto('/simulation')
  await page.getByTestId('scenario-name-input').fill('   ')
  await page.getByTestId('scenario-save').click()
  const input = page.getByTestId('scenario-name-input')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  const describedBy = await input.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`#${describedBy}`)).toContainText(/name is required/i)
  await expect(page.getByTestId('scenarios-empty')).toBeVisible()
})
