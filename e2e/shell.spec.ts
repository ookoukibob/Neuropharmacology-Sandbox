import { expect, test } from '@playwright/test'

/**
 * Smoke test: the application shell loads, navigation works, and the
 * scientific boundary notice is visible.
 */
test('application shell renders and navigates between placeholder views', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page).toHaveTitle(/Neuropharmacology Sandbox/)
  await expect(
    page.getByRole('navigation', { name: 'Primary' }),
  ).toBeVisible()

  // Redirects to the drug library by default.
  await expect(page.getByRole('heading', { name: 'Drug Library' })).toBeVisible()

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Calculator' })
    .click()
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible()
  expect(await page.locator('body').innerText()).toContain(
    'Not a clinical decision-support system',
  )
})
