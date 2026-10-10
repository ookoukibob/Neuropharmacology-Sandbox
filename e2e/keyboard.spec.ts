import { expect, test, type Page } from '@playwright/test'

/**
 * Keyboard and focus workflows (phase 6).
 *
 * Everything below is driven from the keyboard only — no clicks. The file
 * picker for imports is the one exception (it opens an OS dialog that no
 * browser automation can drive); there the file is handed to the already
 * reachable input and every subsequent control — mode, acknowledgement,
 * confirmation — is operated from the keyboard.
 *
 * Every value used here is synthetic test data — no real pharmacological
 * parameter is ever introduced to make a test convenient.
 */

/**
 * Press Tab until the wanted element owns focus. The target may be a DOM id
 * (`drug-name`, `calc-c0-value`), a test id (`save-drug`) or an
 * accessible name (`Remove target 2`), whichever the control carries —
 * all three are stable hooks into the real markup.
 */
async function tabUntil(page: Page, target: string, maxTabs = 80): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    const reached = await page.evaluate((wanted) => {
      const el = document.activeElement
      if (el === null) return false
      return (
        el.id === wanted ||
        el.getAttribute('data-testid') === wanted ||
        el.getAttribute('aria-label') === wanted
      )
    }, target)
    if (reached) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`"${target}" was not reachable with Tab`)
}

/**
 * Operate a focused native select with the arrow keys until it holds the
 * value. Desktop Chromium does not wrap the arrow keys at the end of an
 * option list, so the walk first moves up to the first option and then
 * down — every option is reachable from either end, without a mouse.
 */
async function selectByKeyboard(page: Page, elementId: string, value: string): Promise<void> {
  const locator = page.locator(`#${elementId}`)
  const read = (): Promise<string> => locator.evaluate((el) => (el as HTMLSelectElement).value)
  const optionCount = await locator.evaluate((el) => (el as HTMLSelectElement).options.length)

  if ((await read()) === value) return

  for (let i = 0; i < optionCount; i++) {
    const before = await read()
    if (before === value) return
    await page.keyboard.press('ArrowUp')
    const after = await read()
    if (after === value) return
    if (after === before) break // already on the first option
  }

  for (let i = 0; i < optionCount; i++) {
    if ((await read()) === value) return
    await page.keyboard.press('ArrowDown')
  }
  if ((await read()) === value) return
  throw new Error(`option "${value}" was not reachable with the arrow keys in #${elementId}`)
}

test('keyboard: the skip link is the first stop and moves focus to the main region', async ({
  page,
}) => {
  await page.goto('/library')
  await expect(page.getByRole('heading', { name: 'Drug Library' })).toBeVisible()

  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to main content' })
  await expect(skip).toBeFocused()
  await expect(skip).toBeVisible()

  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()
})

test('keyboard: primary navigation is reachable and activates routes without a mouse', async ({
  page,
}) => {
  await page.goto('/library')
  await expect(page.getByRole('heading', { name: 'Drug Library' })).toBeVisible()

  // Tab past the skip link and the brand link to the Calculator entry.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Calculator' }),
  ).toBeFocused()
  // The active route is exposed semantically, not only visually.
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Drug Library' }),
  ).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/calculator/)
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible()
  // Predictable focus placement after a route change.
  await expect(page.locator('#main-content')).toBeFocused()

  // The document title follows the route.
  await expect(page).toHaveTitle('Calculator — Neuropharmacology Sandbox')
})

test('keyboard: a drug can be created, corrected after a validation error, without a mouse', async ({
  page,
}) => {
  await page.goto('/library')
  await tabUntil(page, 'new-drug')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'New Drug Record' })).toBeVisible()

  // Name → synonyms → tags → notes → "Add target".
  await tabUntil(page, 'drug-name')
  await page.keyboard.type('Synthetic Keyboard Probe')
  await tabUntil(page, 'drug-tags')
  await page.keyboard.type('synthetic-fixture')
  await tabUntil(page, 'add-target')
  await page.keyboard.press('Enter')

  await tabUntil(page, 'target-name-1')
  await page.keyboard.type('KEY-R1')
  await tabUntil(page, 'add-param')
  await page.keyboard.press('Enter')

  // Native selects are operated with the arrow keys.
  await tabUntil(page, 'param-kind-1-0')
  await selectByKeyboard(page, 'param-kind-1-0', 'kd')
  await tabUntil(page, 'param-value-1-0')
  await page.keyboard.type('5.2')
  await tabUntil(page, 'param-unit-1-0')
  await selectByKeyboard(page, 'param-unit-1-0', 'nM')

  // Rows are added and removed without a mouse, and focus stays inside the
  // form instead of dropping back to the top of the document.
  await tabUntil(page, 'add-target')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('target-row')).toHaveCount(2)
  await tabUntil(page, 'Remove target 2')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('target-row')).toHaveCount(1)
  await expect(page.getByTestId('add-target')).toBeFocused()

  // Trigger validation with an empty name: the error is announced and the
  // focus lands on the offending control.
  await tabUntil(page, 'drug-name')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await tabUntil(page, 'save-drug')
  await page.keyboard.press('Enter')

  const errors = page.getByTestId('form-errors')
  await expect(errors).toBeVisible()
  await expect(errors).toContainText('Name is required.')
  await expect(page.locator('#drug-name')).toBeFocused()
  await expect(page.locator('#drug-name')).toHaveAttribute('aria-invalid', 'true')

  // Correct the error and submit again — still without a mouse.
  await page.keyboard.type('Synthetic Keyboard Probe')
  await tabUntil(page, 'save-drug')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('heading', { name: 'Drug Detail' })).toBeVisible()
  await expect(page.getByTestId('param-Kd')).toContainText('5.2 nM')
})

test('keyboard: the calculator can be driven from model selection to result', async ({ page }) => {
  await page.goto('/calculator')
  await expect(page.getByTestId('calculator-view')).toBeVisible()

  // Model select is operated with the arrow keys.
  await tabUntil(page, 'model-select')
  await selectByKeyboard(page, 'model-select', 'pk.first-order-one-compartment')

  // The parameterization radio group is a single tab stop with arrow keys.
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('pk-mode-halfLife')).toBeFocused()
  await expect(page.getByTestId('pk-mode-halfLife')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('pk-mode-k')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('field-k')).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('field-halfLife')).toBeVisible()

  // Calculating with empty inputs surfaces announced, blocking errors on
  // every invalid field: the inline alert is tied to the input with
  // aria-invalid / aria-describedby instead of the press failing silently.
  await tabUntil(page, 'calculate-btn')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('error-c0')).toBeVisible()
  await expect(page.getByTestId('error-c0')).toHaveAttribute('role', 'alert')
  await expect(page.getByTestId('error-time')).toBeVisible()
  await expect(page.getByTestId('error-halfLife')).toBeVisible()
  await expect(page.locator('#calc-c0-value')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#calc-c0-value')).toHaveAttribute(
    'aria-describedby',
    'calc-c0-error',
  )

  // c0 = 100 nM, t = −8 h (rejected by the engine), t½ = 8 h.
  await tabUntil(page, 'calc-c0-value')
  await page.keyboard.type('100')
  await tabUntil(page, 'calc-c0-unit')
  await selectByKeyboard(page, 'calc-c0-unit', 'nM')
  await tabUntil(page, 'calc-time-value')
  await page.keyboard.type('-8')
  await tabUntil(page, 'calc-time-unit')
  await selectByKeyboard(page, 'calc-time-unit', 'h')
  await tabUntil(page, 'calc-halfLife-value')
  await page.keyboard.type('8')
  await tabUntil(page, 'calc-halfLife-unit')
  await selectByKeyboard(page, 'calc-halfLife-unit', 'h')

  await tabUntil(page, 'calculate-btn')
  await page.keyboard.press('Enter')

  // A structurally valid but scientifically invalid input is rejected by
  // the engine with a blocking, announced error panel.
  await expect(page.getByTestId('calculation-errors')).toBeVisible()
  await expect(page.getByTestId('calculation-errors')).toHaveAttribute('role', 'alert')
  await expect(page.getByTestId('calculation-errors')).toContainText('got -8')

  // Correcting the value and recalculating — still keyboard only.
  await tabUntil(page, 'calc-time-value')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('8')
  await tabUntil(page, 'calculate-btn')
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-outputs')).toContainText('50')

  // Curve scale radios form one tab stop (native radio group): the checked
  // option takes focus, arrow keys move inside the group, and the visually
  // hidden input keeps a visible focus indicator on its label.
  await tabUntil(page, 'x-scale-linear')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('x-scale-log')).toBeFocused()
  const ring = await page
    .getByTestId('x-scale-log')
    .evaluate((el) => getComputedStyle(el.nextElementSibling as Element).boxShadow)
  expect(ring).not.toBe('none')
})

test('keyboard: import confirmation keeps the acknowledgement sequence', async ({ page }) => {
  const npsl = Buffer.from(
    JSON.stringify({
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: {
        id: 'keyboard-library',
        name: 'Synthetic Keyboard Library',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dataStatus: 'user',
      },
      drugs: [
        {
          id: 'keyboard-drug-1',
          origin: 'user',
          identifiers: { name: 'Synthetic Keyboard Import', synonyms: [] },
          tags: ['synthetic-fixture'],
          targets: [],
          pharmacokinetics: {},
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    'utf8',
  )

  await page.goto('/import-export')
  await expect(page.getByTestId('library-record-count')).toBeVisible()

  // Tabs support their keyboard interaction (Tab to focus, Enter/Space to
  // activate, arrow keys to move between tabs).
  await tabUntil(page, 'tab-import')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('tab-export')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('tab-import')).toHaveAttribute('aria-selected', 'true')

  // The OS file dialog cannot be driven by automation, so the file is
  // handed to the already reachable input.
  await page
    .getByTestId('npsl-file-input')
    .setInputFiles({ name: 'synthetic-keyboard.npsl', mimeType: 'application/json', buffer: npsl })
  await expect(page.getByTestId('import-preview')).toBeVisible()

  // Replace stays blocked until it is explicitly acknowledged — by keyboard.
  await tabUntil(page, 'import-mode')
  await selectByKeyboard(page, 'import-mode', 'replace')
  await expect(page.getByTestId('replace-warning')).toBeVisible()
  await expect(page.getByTestId('replace-acknowledge')).not.toBeChecked()
  await expect(page.getByTestId('confirm-import')).toBeDisabled()

  await tabUntil(page, 'replace-acknowledge')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('replace-acknowledge')).toBeChecked()
  await expect(page.getByTestId('confirm-import')).toBeEnabled()

  await tabUntil(page, 'confirm-import')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('import-report')).toContainText('Import complete (replace)')
})

test('responsive: navigation and core forms stay operable at a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 })

  for (const path of ['/library', '/library/new', '/calculator', '/data-sources', '/import-export']) {
    await page.goto(path)
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()

    // No unintended horizontal overflow: the page fits the viewport width.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    expect(overflow.scrollWidth, `horizontal overflow on ${path}`).toBeLessThanOrEqual(
      overflow.innerWidth,
    )

    // Every primary navigation entry is still reachable and visible.
    for (const label of ['Drug Library', 'Calculator', 'Data Sources', 'Import / Export', 'Settings']) {
      await expect(
        page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: label }),
      ).toBeVisible()
    }
  }
})
