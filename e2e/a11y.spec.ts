// Named import — the form @axe-core/playwright documents. Its single
// shared .d.ts has no `"type": "module"`, so under `module: nodenext` a
// default import resolves to the module namespace (unconstructable) even
// though the runtime ESM build does export a default.
import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * Automated accessibility scans (phase 6).
 *
 * Every stable, user-reachable state listed in the testing documentation is
 * scanned with axe-core under the WCAG 2.x A/AA rule tags. The scans run
 * against the real application in a real browser: no rules are disabled and
 * no violations are suppressed — a violation fails this spec and has to be
 * fixed in the application, not silenced here.
 *
 * Every value used here is synthetic test data — no real pharmacological
 * parameter is ever introduced to make a test convenient.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

interface Violation {
  readonly id: string
  readonly impact: string
  readonly help: string
  readonly nodes: readonly string[]
}

/**
 * Wait for the transitions that are actually running on the page to finish.
 *
 * Several controls fade their colours (`transition-colors`, 150 ms) — the
 * curve-scale chips even swap checked state when the model changes, because
 * each model has its own default x-axis scale. Sampling axe during that
 * window measures an interpolated colour pair whose contrast can fall below
 * AA although both end colours pass, so the scan would report a violation
 * that does not exist in the settled UI. This waits on animation state
 * rather than on wall-clock time: if nothing is running it returns at once.
 */
async function settleTransitions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document.getAnimations().filter((animation) => animation instanceof CSSTransition)
    await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)))
  })
}

/** Run axe over the current page and fail with a readable violation list. */
async function scan(page: Page, state: string): Promise<void> {
  await settleTransitions(page)
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const violations: Violation[] = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? 'unknown',
    help: violation.help,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  }))
  expect(violations, `axe violations on ${state}`).toEqual([])
}

/** Create one synthetic record through the real form (library → detail). */
async function createSyntheticRecord(page: Page): Promise<void> {
  await page.goto('/library')
  await page.getByTestId('new-drug').click()
  await page.getByTestId('drug-name').fill('Synthetic A11y Probe')
  await page.locator('#drug-tags').fill('synthetic-fixture')
  await page.getByTestId('add-target').click()
  await page.locator('#target-name-1').fill('A11Y-R1')
  await page.getByTestId('add-param').click()
  await page.locator('#param-kind-1-0').selectOption('kd')
  await page.locator('#param-value-1-0').fill('6.3')
  await page.locator('#param-unit-1-0').selectOption('nM')
  await page.getByTestId('save-drug').click()
  await expect(page.getByTestId('drug-detail')).toBeVisible()
}

test('a11y: the drug library and the create form pass the axe scan', async ({ page }) => {
  await page.goto('/library')
  await expect(page.getByTestId('library-count')).toBeVisible()
  await scan(page, 'drug library')

  await page.goto('/library/new')
  await expect(page.getByTestId('drug-form')).toBeVisible()
  await scan(page, 'create drug form')
})

test('a11y: the detail view and the edit form pass the axe scan', async ({ page }) => {
  await createSyntheticRecord(page)
  await scan(page, 'drug detail')

  await page.getByTestId('edit-drug').click()
  await expect(page.getByTestId('drug-form')).toBeVisible()
  await scan(page, 'edit drug form')
})

test('a11y: the calculator passes the axe scan with input, PK mode and result states', async ({
  page,
}) => {
  await page.goto('/calculator')
  await expect(page.getByTestId('calculator-view')).toBeVisible()
  await scan(page, 'calculator (initial)')

  // PK parameterization with the half-life mode selected.
  await page.locator('#model-select').selectOption('pk.first-order-one-compartment')
  await expect(page.getByTestId('pk-mode-toggle')).toBeVisible()
  await scan(page, 'calculator (PK half-life mode)')

  // A completed calculation: result panel, inputs used, assumptions.
  await page.locator('#calc-c0-value').fill('100')
  await page.locator('#calc-c0-unit').selectOption('nM')
  await page.locator('#calc-time-value').fill('8')
  await page.locator('#calc-time-unit').selectOption('h')
  await page.locator('#calc-halfLife-value').fill('8')
  await page.locator('#calc-halfLife-unit').selectOption('h')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await scan(page, 'calculator (with result)')
})

test('a11y: import mapping, import preview and the export view pass the axe scan', async ({
  page,
}) => {
  await page.goto('/import-export')
  await expect(page.getByTestId('library-record-count')).toBeVisible()
  await scan(page, 'import / export (empty import state)')

  // CSV column mapping: every destination select is visible and unmapped.
  const csv = 'compound,target_name,Kd/Ki,units\r\nSynthetic CSV Probe,A11Y-T,4.2,nM\r\n'
  await page
    .getByTestId('csv-file-input')
    .setInputFiles({
      name: 'synthetic-a11y.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    })
  await expect(page.getByTestId('csv-mapping')).toBeVisible()
  await scan(page, 'import (CSV column mapping)')

  // NPSL preview with the confirmation controls.
  const npsl = Buffer.from(
    JSON.stringify({
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: {
        id: 'a11y-library',
        name: 'Synthetic A11y Library',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dataStatus: 'example',
      },
      drugs: [
        {
          id: 'a11y-drug-1',
          origin: 'user',
          identifiers: { name: 'Synthetic A11y Import', synonyms: [] },
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
  await page
    .getByTestId('npsl-file-input')
    .setInputFiles({
      name: 'synthetic-a11y.npsl',
      mimeType: 'application/json',
      buffer: npsl,
    })
  await expect(page.getByTestId('import-preview')).toBeVisible()
  await scan(page, 'import (preview and confirmation)')

  // Replace acknowledgement state — the destructive gate itself.
  await page.getByTestId('import-mode').selectOption('replace')
  await expect(page.getByTestId('replace-warning')).toBeVisible()
  await scan(page, 'import (replace acknowledgement)')

  // Export view.
  await page.getByTestId('tab-export').click()
  await expect(page.getByTestId('export-npsl')).toBeVisible()
  await scan(page, 'export view')
})

test('a11y: the recovery backup states pass the axe scan', async ({ page }) => {
  await page.goto('/import-export')
  await expect(page.getByTestId('library-record-count')).toBeVisible()

  // Initial recovery state on an empty library.
  await page.getByTestId('tab-recovery').click()
  await expect(page.getByTestId('recovery-export')).toBeVisible()
  await scan(page, 'recovery (initial, empty library)')

  // Rejected archive — the structured refusal state.
  await page.getByTestId('recovery-restore-file').setInputFiles({
    name: 'broken.npsb',
    mimeType: 'application/json',
    buffer: Buffer.from('{"formatId": "npsb",', 'utf8'),
  })
  await expect(page.getByTestId('recovery-rejected')).toBeVisible()
  await scan(page, 'recovery (rejected archive)')

  // Import one synthetic record so the preview counts are non-empty.
  await page.getByTestId('tab-import').click()
  const npsl = Buffer.from(
    JSON.stringify({
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: {
        id: 'a11y-library',
        name: 'Synthetic A11y Library',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dataStatus: 'example',
      },
      drugs: [
        {
          id: 'a11y-recovery-1',
          origin: 'user',
          identifiers: { name: 'Synthetic A11y Recovery', synonyms: [] },
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
  await page
    .getByTestId('npsl-file-input')
    .setInputFiles({
      name: 'synthetic-a11y-recovery.npsl',
      mimeType: 'application/json',
      buffer: npsl,
    })
  await expect(page.getByTestId('import-preview')).toBeVisible()
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText('Import complete (merge)')

  // Preview + explicit acknowledgement — the destructive gate itself.
  await page.getByTestId('tab-recovery').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('recovery-export').click()
  const download = await downloadPromise
  const archivePath = await download.path()
  if (archivePath === null) {
    throw new Error('recovery export produced no file path')
  }
  await page.getByTestId('recovery-restore-file').setInputFiles(archivePath)
  await expect(page.getByTestId('recovery-preview')).toBeVisible()
  await page.getByTestId('recovery-acknowledge').check()
  await expect(page.getByTestId('recovery-restore-confirm')).toBeEnabled()
  await scan(page, 'recovery (preview and acknowledgement)')

  // Committed restore outcome — the success report state.
  await page.getByTestId('recovery-restore-confirm').click()
  await expect(page.getByTestId('recovery-restore-report')).toContainText('Restore complete')
  await scan(page, 'recovery (restore outcome report)')
})

test('a11y: the settings page passes the axe scan in its default and confirm states', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await scan(page, 'settings (defaults)')

  // The reset acknowledgement step is a stable, user-reachable state.
  await page.getByTestId('settings-reset').click()
  await expect(page.getByTestId('settings-reset-confirm')).toBeVisible()
  await scan(page, 'settings (reset confirmation)')
})
