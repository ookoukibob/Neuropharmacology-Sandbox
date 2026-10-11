import { expect, test, type Page } from '@playwright/test'

/**
 * Multi-tab write semantics end-to-end (phase 19 — audit GAP-4/S7).
 *
 * Both pages live in the SAME browser context, so they share one origin
 * and one IndexedDB database — exactly like two tabs of one browser.
 * The scenario is deterministic: both edit forms mount from the same
 * stored snapshot BEFORE either tab saves, then the later save from the
 * still-stale tab is observed against the earlier tab's committed change.
 *
 * This spec records the OBSERVED behavior of the current UI: the edit
 * form submits a full snapshot of its editable field groups
 * (`DrugForm.buildInput`), so a stale tab's save writes its mount-time
 * values of the untouched groups back over newer data. No assertion here
 * treats the overwrite as desirable — it pins the confirmed limitation
 * documented in docs/architecture.md §4.2 and docs/data-integrity-audit.md
 * GAP-4. Every value is synthetic test data; no external request is made.
 */

const PROBE_NAME = 'Synthetic Concurrency Probe'
const PROBE_RENAMED = 'Synthetic Concurrency Probe Renamed'
const PROBE_RETAGGED = 'Synthetic Concurrency Probe B-Edit'
const UNRELATED_NAME = 'Synthetic Unrelated Probe'
const LIBRARY_NAME = 'Synthetic Concurrency Library'
const TARGET_NAME = 'CONC-R1'

/**
 * Synthetic NPSL envelope with two user-origin records: the probe both
 * tabs edit, and an unrelated control record no tab touches. Invented
 * fixture values throughout — never real pharmacological information.
 */
function concurrencyNpslBuffer(): Buffer {
  return Buffer.from(
    JSON.stringify({
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: {
        id: 'e2e-conc-library',
        name: LIBRARY_NAME,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dataStatus: 'example',
      },
      drugs: [
        {
          id: 'e2e-conc-drug',
          origin: 'user',
          identifiers: { name: PROBE_NAME, synonyms: ['SCP'] },
          tags: ['synthetic-fixture'],
          targets: [
            {
              id: 'e2e-conc-target-1',
              name: TARGET_NAME,
              kd: {
                value: 4.2,
                unit: 'nM',
                provenance: {
                  type: 'literature',
                  source: 'Synthetic E2E source',
                  citation: 'Invented for E2E, 2026',
                },
              },
            },
          ],
          pharmacokinetics: {},
          notes: 'Synthetic concurrency fixture — not pharmacological information.',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'e2e-conc-unrelated',
          origin: 'user',
          identifiers: { name: UNRELATED_NAME, synonyms: [] },
          tags: ['synthetic-control'],
          targets: [
            {
              id: 'e2e-conc-target-2',
              name: 'CTRL-R1',
              kd: {
                value: 7.5,
                unit: 'nM',
                provenance: {
                  type: 'literature',
                  source: 'Synthetic E2E source',
                  citation: 'Invented for E2E, 2026',
                },
              },
            },
          ],
          pharmacokinetics: {},
          notes: 'Synthetic control fixture — not pharmacological information.',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    'utf8',
  )
}

/** Import the two synthetic records through preview + confirmation. */
async function importSeed(page: Page): Promise<void> {
  await page.goto('/import-export')
  await expect(page.getByTestId('library-record-count')).toBeVisible()
  await page
    .getByTestId('npsl-file-input')
    .setInputFiles({
      name: 'synthetic-concurrency.npsl',
      mimeType: 'application/json',
      buffer: concurrencyNpslBuffer(),
    })
  await expect(page.getByTestId('import-preview')).toBeVisible()
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText('Import complete (merge)')
}

/** Open the probe record's detail view from the library list. */
async function openProbe(page: Page): Promise<void> {
  await page.goto('/library')
  await page.getByTestId('drug-list').getByText(PROBE_NAME).click()
  await expect(page.getByTestId('drug-detail')).toBeVisible()
}

/** Enter edit mode and wait for the form to be mounted and interactive. */
async function openEditForm(page: Page, expectedName: string): Promise<void> {
  await page.getByTestId('edit-drug').click()
  await expect(page.getByTestId('drug-form')).toBeVisible()
  // The form is a snapshot of the record as it was when the form mounted.
  await expect(page.getByTestId('drug-name')).toHaveValue(expectedName)
}

/**
 * The unrelated control record must be untouched by the concurrent saves
 * of the probe record: same name, tags, parameter value and notes.
 */
async function expectUnrelatedUnchanged(page: Page): Promise<void> {
  await page.goto('/library')
  await page.getByTestId('drug-list').getByText(UNRELATED_NAME).click()
  await expect(page.getByTestId('drug-detail')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: UNRELATED_NAME })).toBeVisible()
  await expect(page.locator('span').filter({ hasText: '#synthetic-control' })).toBeVisible()
  await expect(page.getByText('CTRL-R1', { exact: true })).toBeVisible()
  await expect(page.getByTestId('param-Kd')).toContainText('7.5 nM')
  await expect(
    page.getByText('Synthetic control fixture — not pharmacological information.'),
  ).toBeVisible()
}

test('library: two stale tabs on one record — the later save reverts the other tab\'s name change (audit GAP-4)', async ({
  page,
  context,
}) => {
  const pageB = await context.newPage()
  await test.step('import two synthetic user-origin records', async () => {
    await importSeed(page)
  })

  await test.step('both tabs open the same record and enter edit mode before either saves', async () => {
    await openProbe(page)
    await expect(page.getByRole('heading', { level: 2, name: PROBE_NAME })).toBeVisible()
    await openProbe(pageB)
    await expect(pageB.getByRole('heading', { level: 2, name: PROBE_NAME })).toBeVisible()

    // Both forms mount from the same stored snapshot.
    await openEditForm(page, PROBE_NAME)
    await openEditForm(pageB, PROBE_NAME)
  })

  await test.step('tab A renames the record and saves', async () => {
    await page.getByTestId('drug-name').fill(PROBE_RENAMED)
    await page.getByTestId('save-drug').click()
    await expect(page.getByRole('heading', { level: 2, name: PROBE_RENAMED })).toBeVisible()

    // Tab B has no cross-tab refresh: its OPEN FORM still shows the
    // pre-save name (confirmed stale display, audit GAP-4).
    await expect(pageB.getByTestId('drug-name')).toHaveValue(PROBE_NAME)
  })

  await test.step('tab B changes only the tags and saves its still-stale form', async () => {
    await pageB.locator('#drug-tags').fill('synthetic-fixture, second-tab')
    await pageB.getByTestId('save-drug').click()
    // The save reports success: edit mode closes with no error — nothing
    // warns that the stale snapshot reverted another tab's field.
    await expect(pageB.getByTestId('drug-detail')).toBeVisible()
    await expect(pageB.getByTestId('detail-error')).toHaveCount(0)
    // B's own session refreshed from storage after its save: it now shows
    // the tags it wrote AND the reverted (old) name.
    await expect(pageB.getByRole('heading', { level: 2, name: PROBE_NAME })).toBeVisible()
    await expect(pageB.getByText('#second-tab')).toBeVisible()
  })

  await test.step('a fresh hydration pins the final stored state: the name change is reverted', async () => {
    await pageB.reload()
    await expect(pageB.getByRole('heading', { name: 'Drug Detail' })).toBeVisible()
    await expect(pageB.getByRole('heading', { level: 2, name: PROBE_NAME })).toBeVisible()
    await expect(pageB.getByText('#second-tab')).toBeVisible()
    // Tab B's tags-only save silently reverted tab A's committed rename:
    // the UI never merges at the repository's granularity because the
    // form always supplies the full identifiers group.
    await expect(pageB.getByText(PROBE_RENAMED)).toHaveCount(0)

    // Tab A (still not reloaded) keeps displaying its own stale view —
    // the overwrite is invisible from both directions.
    await expect(page.getByRole('heading', { level: 2, name: PROBE_RENAMED })).toBeVisible()
  })

  await test.step('the unrelated record and the library metadata are unchanged', async () => {
    await expectUnrelatedUnchanged(pageB)
    // A merge import never adopts the file's libraryMetadata (only replace
    // mode writes it), so the stored metadata name is the pre-existing
    // 'Local library' before AND after the concurrent saves — unchanged.
    await pageB.goto('/import-export')
    await expect(pageB.getByTestId('library-record-count')).toContainText('2 records')
    await expect(pageB.getByTestId('library-record-count')).toContainText('Local library')
  })

  await pageB.close()
})

test('library: a stale tab\'s targets snapshot reverts the other tab\'s parameter edit wholesale (audit GAP-4)', async ({
  page,
  context,
}) => {
  const pageB = await context.newPage()
  await test.step('import two synthetic user-origin records', async () => {
    await importSeed(page)
  })

  await test.step('both tabs open the same record and enter edit mode before either saves', async () => {
    await openProbe(page)
    await openProbe(pageB)
    await openEditForm(page, PROBE_NAME)
    await openEditForm(pageB, PROBE_NAME)
  })

  await test.step('tab A changes the Kd parameter and saves', async () => {
    await page.locator('#param-value-1-0').fill('9.9')
    await page.getByTestId('save-drug').click()
    await expect(page.getByTestId('param-Kd')).toContainText('9.9 nM')
  })

  await test.step('tab B renames the record in its stale form and saves', async () => {
    // B never touched the targets draft — it still holds the mount-time
    // value, which the form submits verbatim as the full targets group.
    await expect(pageB.locator('#param-value-1-0')).toHaveValue('4.2')
    await pageB.getByTestId('drug-name').fill(PROBE_RETAGGED)
    await pageB.getByTestId('save-drug').click()
    await expect(pageB.getByTestId('drug-detail')).toBeVisible()
    await expect(pageB.getByTestId('detail-error')).toHaveCount(0)
  })

  await test.step('a fresh hydration pins the final stored state: the parameter edit is reverted', async () => {
    await pageB.reload()
    await expect(pageB.getByRole('heading', { level: 2, name: PROBE_RETAGGED })).toBeVisible()
    // B's rename persisted, but its stale targets snapshot replaced the
    // whole group — A's committed 9.9 nM edit is silently back to 4.2 nM.
    await expect(pageB.getByTestId('param-Kd')).toContainText('4.2 nM')
    await expect(pageB.getByTestId('param-Kd')).not.toContainText('9.9')
    await expect(pageB.getByText(TARGET_NAME, { exact: true })).toBeVisible()
  })

  await test.step('the unrelated record and the library metadata are unchanged', async () => {
    await expectUnrelatedUnchanged(pageB)
    // Merge import never adopts the file's metadata: 'Local library' is
    // the unchanged stored name before and after the concurrent saves.
    await pageB.goto('/import-export')
    await expect(pageB.getByTestId('library-record-count')).toContainText('2 records')
    await expect(pageB.getByTestId('library-record-count')).toContainText('Local library')
  })

  await pageB.close()
})
