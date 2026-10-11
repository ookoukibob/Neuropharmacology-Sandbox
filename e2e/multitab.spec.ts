import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Multi-tab write safety end-to-end (phase 20 — audit GAP-4 remediation).
 *
 * Both pages live in the SAME browser context, so they share one origin
 * and one IndexedDB database — exactly like two tabs of one browser. The
 * interleaving is deterministic: both edit forms mount from the same
 * stored snapshot BEFORE either tab saves, then the later save from the
 * still-stale tab is observed against the earlier tab's committed change.
 *
 * Phase 20 expectation: that stale save is REJECTED atomically with a
 * typed conflict instead of silently overwriting newer data — the stored
 * record keeps the committing tab's state, the rejecting tab's form stays
 * open with its draft intact, and recovery (review the latest record in a
 * new tab without losing the draft, or reload and re-apply) is always an
 * explicit user choice. Each scenario also proves that a fresh session can
 * edit normally afterwards, that the unrelated control record and the
 * library metadata are untouched, and that conflict recovery never
 * replaces target identity, provenance or source references. Every value
 * is synthetic test data; no external request is made.
 */

const PROBE_NAME = 'Synthetic Concurrency Probe'
const PROBE_RENAMED = 'Synthetic Concurrency Probe Renamed'
const PROBE_RETAGGED = 'Synthetic Concurrency Probe B-Edit'
const UNRELATED_NAME = 'Synthetic Unrelated Probe'
const LIBRARY_NAME = 'Synthetic Concurrency Library'
const TARGET_NAME = 'CONC-R1'
const TARGET_ID = 'e2e-conc-target-1'
const SOURCE_TARGET_ID = 'CHEMBL99991001'

/**
 * Synthetic NPSL envelope with two user-origin records: the probe both
 * tabs edit, and an unrelated control record no tab touches. Invented
 * fixture values throughout — never real pharmacological information.
 * The probe target carries an external source identity (phase 18I) so
 * conflict recovery can be shown to preserve it verbatim.
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
              id: TARGET_ID,
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
              sourceReferences: [
                {
                  source: 'chembl',
                  sourceName: 'ChEMBL',
                  sourceTargetId: SOURCE_TARGET_ID,
                  name: TARGET_NAME,
                  organism: 'synthetic',
                  url: 'https://www.ebi.ac.uk/chembl/explore/target/CHEMBL99991001',
                  licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
                  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
                },
              ],
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

/** A brand-new tab reading the probe record with a fresh hydration. */
async function openProbeFresh(context: BrowserContext): Promise<Page> {
  const fresh = await context.newPage()
  await openProbe(fresh)
  return fresh
}

/** Enter edit mode and wait for the form to be mounted and interactive. */
async function openEditForm(page: Page, expectedName: string): Promise<void> {
  await page.getByTestId('edit-drug').click()
  await expect(page.getByTestId('drug-form')).toBeVisible()
  // The form is a snapshot of the record as it was when the form mounted.
  await expect(page.getByTestId('drug-name')).toHaveValue(expectedName)
}

/**
 * The provenance badge shown for the probe target's Kd: `param-Kd` holds
 * the value, the badge sits beside it in the same parameter row.
 */
function kdProvenanceBadge(page: Page) {
  return page.getByTestId('param-Kd').locator('..').getByTestId('provenance-badge')
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

test('library: a stale tabs-tag save conflicts instead of reverting a newer rename (audit GAP-4, phase 20)', async ({
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

    // Both forms mount from the same stored snapshot — same revision
    // token for each session.
    await openEditForm(page, PROBE_NAME)
    await openEditForm(pageB, PROBE_NAME)
  })

  await test.step('tab A renames the record and saves', async () => {
    await page.getByTestId('drug-name').fill(PROBE_RENAMED)
    await page.getByTestId('save-drug').click()
    await expect(page.getByRole('heading', { level: 2, name: PROBE_RENAMED })).toBeVisible()

    // Tab B has no cross-tab refresh: its OPEN FORM still shows the
    // pre-save name — its session token is now stale.
    await expect(pageB.getByTestId('drug-name')).toHaveValue(PROBE_NAME)
  })

  await test.step('tab B saves its still-stale tags-only change: typed conflict, form and draft preserved', async () => {
    await pageB.locator('#drug-tags').fill('synthetic-fixture, second-tab')
    await pageB.getByTestId('save-drug').click()

    // The conflict is named distinctly and shown inside the edit session.
    const conflict = pageB.getByTestId('save-conflict')
    await expect(conflict).toBeVisible()
    await expect(conflict).toContainText('Record changed elsewhere')
    await expect(pageB.getByTestId('drug-form')).toBeVisible()
    await expect(pageB.getByTestId('drug-detail')).toHaveCount(0)
    // No generic error leaked elsewhere: the conflict is per-session.
    await expect(pageB.getByTestId('detail-error')).toHaveCount(0)
    // The draft is fully preserved — the tags the user typed AND the
    // mount-time name.
    await expect(pageB.locator('#drug-tags')).toHaveValue('synthetic-fixture, second-tab')
    await expect(pageB.getByTestId('drug-name')).toHaveValue(PROBE_NAME)
    // Both recovery paths are offered, the destructive one labeled.
    await expect(pageB.getByTestId('conflict-open-latest')).toBeVisible()
    await expect(pageB.getByTestId('conflict-reload')).toContainText('discards this draft')
  })

  await test.step('a fresh tab pins the stored state: the rename stands, the stale tags were never written', async () => {
    const fresh = await openProbeFresh(context)
    await expect(fresh.getByRole('heading', { level: 2, name: PROBE_RENAMED })).toBeVisible()
    await expect(fresh.locator('span').filter({ hasText: '#synthetic-fixture' })).toBeVisible()
    await expect(fresh.getByText('#second-tab')).toHaveCount(0)
    // Target identity and the external source reference survived the
    // rejected write untouched.
    await expect(fresh.getByText(TARGET_NAME, { exact: true })).toBeVisible()
    await expect(fresh.getByTestId(`target-source-references-${TARGET_ID}`)).toContainText(
      SOURCE_TARGET_ID,
    )
    await fresh.close()

    // Tab A (not reloaded) keeps displaying its own committed view.
    await expect(page.getByRole('heading', { level: 2, name: PROBE_RENAMED })).toBeVisible()
  })

  await test.step('recovery: review the latest in a new tab without losing the draft; dismissal keeps the draft; a re-save still conflicts', async () => {
    const popupPromise = context.waitForEvent('page')
    await pageB.getByTestId('conflict-open-latest').click()
    const reviewTab = await popupPromise
    await expect(reviewTab.getByRole('heading', { level: 2, name: PROBE_RENAMED })).toBeVisible()
    await expect(reviewTab.getByTestId('drug-detail')).toBeVisible()
    await reviewTab.close()

    // Dismissing the alert never discards the draft.
    await pageB.getByTestId('save-failure-dismiss').click()
    await expect(pageB.getByTestId('save-conflict')).toHaveCount(0)
    await expect(pageB.getByTestId('drug-form')).toBeVisible()
    await expect(pageB.locator('#drug-tags')).toHaveValue('synthetic-fixture, second-tab')

    // Re-saving the same stale draft conflicts AGAIN — the session token
    // is never silently refreshed to turn the full-snapshot write into a
    // successful overwrite.
    await pageB.getByTestId('save-drug').click()
    await expect(pageB.getByTestId('save-conflict')).toBeVisible()
    await expect(pageB.getByTestId('drug-form')).toBeVisible()
  })

  await test.step('reload recovery: a fresh session edits successfully and keeps tab A\'s rename', async () => {
    await pageB.getByTestId('conflict-reload').click()
    await expect(pageB.getByRole('heading', { level: 2, name: PROBE_RENAMED })).toBeVisible()

    await openEditForm(pageB, PROBE_RENAMED)
    await pageB.locator('#drug-tags').fill('synthetic-fixture, second-tab')
    await pageB.getByTestId('save-drug').click()
    await expect(pageB.getByTestId('drug-detail')).toBeVisible()
    await expect(pageB.getByTestId('detail-error')).toHaveCount(0)
    // A's committed rename is not lost: B's fresh full snapshot carries it.
    await expect(pageB.getByRole('heading', { level: 2, name: PROBE_RENAMED })).toBeVisible()
    await expect(pageB.getByText('#second-tab')).toBeVisible()
    await expect(pageB.getByText(PROBE_NAME, { exact: true })).toHaveCount(0)
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

test('library: a stale rename conflicts instead of reverting a newer parameter edit (audit GAP-4, phase 20)', async ({
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

  await test.step('tab A changes the Kd parameter to 9.9 nM and saves', async () => {
    await page.locator('#param-value-1-0').fill('9.9')
    await page.getByTestId('save-drug').click()
    await expect(page.getByTestId('param-Kd')).toContainText('9.9 nM')
    // A's commit stamps user provenance on the changed parameter — the
    // exact display the stored record must keep through B's conflict.
    await expect(kdProvenanceBadge(page)).toHaveAttribute(
      'title',
      /^Recorded by the user at /,
    )
  })

  const committedProvenance = await kdProvenanceBadge(page).getAttribute('title')

  await test.step('tab B renames in its stale form: typed conflict, form and draft preserved', async () => {
    // B never touched the targets draft — it still holds the mount-time
    // value, which its save would have submitted as the full group.
    await expect(pageB.locator('#param-value-1-0')).toHaveValue('4.2')
    await pageB.getByTestId('drug-name').fill(PROBE_RETAGGED)
    await pageB.getByTestId('save-drug').click()

    await expect(pageB.getByTestId('save-conflict')).toBeVisible()
    await expect(pageB.getByTestId('save-conflict')).toContainText('Record changed elsewhere')
    await expect(pageB.getByTestId('drug-form')).toBeVisible()
    await expect(pageB.getByTestId('drug-detail')).toHaveCount(0)
    await expect(pageB.getByTestId('detail-error')).toHaveCount(0)
    // The draft — rename AND untouched stale targets snapshot — survives.
    await expect(pageB.getByTestId('drug-name')).toHaveValue(PROBE_RETAGGED)
    await expect(pageB.locator('#param-value-1-0')).toHaveValue('4.2')
  })

  await test.step('a fresh tab pins the stored state: A\'s parameter and provenance exactly as committed, identity and source references intact', async () => {
    const fresh = await openProbeFresh(context)
    // The committed scientific value stands, with nothing of the stale
    // snapshot written over it…
    await expect(fresh.getByTestId('param-Kd')).toContainText('9.9 nM')
    await expect(fresh.getByTestId('param-Kd')).not.toContainText('4.2')
    // …and the provenance is EXACTLY what A committed (same badge title).
    const freshProvenance = await kdProvenanceBadge(fresh).getAttribute('title')
    expect(freshProvenance).toBe(committedProvenance)
    // B's rename was rejected: the stored name is still A's record.
    await expect(fresh.getByRole('heading', { level: 2, name: PROBE_NAME })).toBeVisible()
    // Target identity and the external source reference are untouched.
    await expect(fresh.getByText(TARGET_NAME, { exact: true })).toBeVisible()
    await expect(fresh.getByTestId(`target-source-references-${TARGET_ID}`)).toContainText(
      SOURCE_TARGET_ID,
    )
    await fresh.close()

    // Tab A (not reloaded) keeps displaying its own committed edit.
    await expect(page.getByTestId('param-Kd')).toContainText('9.9 nM')
  })

  await test.step('reload recovery: a fresh session re-applies the rename without touching A\'s parameter', async () => {
    await pageB.getByTestId('conflict-reload').click()
    // The recovered view shows A's committed record in full: value,
    // provenance and source identity.
    await expect(pageB.getByRole('heading', { level: 2, name: PROBE_NAME })).toBeVisible()
    await expect(pageB.getByTestId('param-Kd')).toContainText('9.9 nM')
    await expect(pageB.getByTestId(`target-source-references-${TARGET_ID}`)).toContainText(
      SOURCE_TARGET_ID,
    )

    await openEditForm(pageB, PROBE_NAME)
    await pageB.getByTestId('drug-name').fill(PROBE_RETAGGED)
    await pageB.getByTestId('save-drug').click()
    await expect(pageB.getByTestId('drug-detail')).toBeVisible()
    await expect(pageB.getByRole('heading', { level: 2, name: PROBE_RETAGGED })).toBeVisible()

    // A's committed parameter, its provenance and the source reference
    // are all still exactly as committed — the recovery edit replaced the
    // name only.
    await expect(pageB.getByTestId('param-Kd')).toContainText('9.9 nM')
    const afterRecovery = await kdProvenanceBadge(pageB).getAttribute('title')
    expect(afterRecovery).toBe(committedProvenance)
    await expect(pageB.getByTestId(`target-source-references-${TARGET_ID}`)).toContainText(
      SOURCE_TARGET_ID,
    )
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
