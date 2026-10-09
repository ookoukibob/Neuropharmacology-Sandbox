import { expect, test } from '@playwright/test'

/**
 * Settings workflows (phase 9B).
 *
 * The controls are real preferences: theme and calculator display defaults
 * apply immediately, survive a reload (they are persisted per device), and
 * the scoped reset restores only preferences. Every value used here is
 * synthetic test data.
 */

test('settings: theme and calculator display defaults persist across reloads, and reset restores only preferences', async ({
  page,
}) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

  // Theme: pick Dark — applied immediately as the `.dark` class on <html>.
  // The native radio is visually hidden (sr-only chip pattern); the visible
  // label is the click target, exactly as a mouse user would.
  await page.getByTestId('theme-dark').locator('..').click()
  await expect(page.getByTestId('theme-dark')).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/dark/)

  // A valid calculator display default is persisted for that model only.
  const minInput = page.getByTestId('pref-range-min-occupancy.single-site')
  await minInput.fill('5')
  await expect(minInput).toHaveValue('5')

  // Both survive a reload — a fresh session reads the stored record.
  await page.reload()
  await expect(page.getByTestId('theme-dark')).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(
    page.getByTestId('pref-range-min-occupancy.single-site'),
  ).toHaveValue('5')

  // The calculator starts from the saved display default.
  await page.goto('/calculator')
  await expect(page.getByTestId('range-min')).toHaveValue('5')

  // The data-management link navigates to the existing Import / Export page.
  await page.goto('/settings')
  await page.getByTestId('settings-import-export-link').click()
  await expect(page).toHaveURL(/\/import-export$/)
  await expect(page.getByTestId('tab-recovery')).toBeVisible()

  // Reset: acknowledged in a second step, then everything is back to the
  // documented defaults — including after another reload.
  await page.goto('/settings')
  await page.getByTestId('settings-reset').click()
  await expect(page.getByTestId('settings-reset-confirm')).toBeFocused()
  await page.getByTestId('settings-reset-confirm').click()
  await expect(page.getByTestId('theme-system')).toBeChecked()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await expect(
    page.getByTestId('pref-range-min-occupancy.single-site'),
  ).toHaveValue('')
  await expect(page.getByTestId('preferences-reset-done')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('theme-system')).toBeChecked()
  await expect(
    page.getByTestId('pref-range-min-occupancy.single-site'),
  ).toHaveValue('')
})

test('settings: system theme follows the OS preference; manual choices win', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/settings')
  await expect(page.getByTestId('theme-system')).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/dark/)

  // An OS change while the application is open is reflected live.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  // A manual choice is never overridden by later OS changes. The chip label
  // is the click target for the sr-only radio.
  await page.getByTestId('theme-dark').locator('..').click()
  await expect(page.getByTestId('theme-dark')).toBeChecked()
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByTestId('theme-dark')).toBeChecked()
})
