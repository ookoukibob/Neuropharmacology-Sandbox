import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * Recovery backup / restore workflows (phase 8B, docs/recovery-backup.md).
 *
 * 1  export → replace → restore round trip: the `.npsb` archive carries
 *    BOTH object stores (readable + quarantined + metadata rows), a
 *    replace import clears the quarantined row, and restoring brings it
 *    back verbatim — surviving a full reload;
 * 2  malformed archive — visible structured rejection, no confirm
 *    control, library unchanged now and after a reload;
 * 3  mutual rejection — a `.npsb` archive is refused by the ordinary
 *    Import tab and an ordinary `.npsl` document is refused by the
 *    restore path, with import guidance, writing nothing;
 * 4  export failure honesty — stored data outside the JSON domain fails
 *    the whole export with store/key/path/type diagnostics, offers NO
 *    download and shows no success status.
 *
 * Isolation: each Playwright test gets a fresh browser context with its
 * own IndexedDB; quarantine rows are seeded through narrowly-scoped raw
 * `indexedDB` access (validation-derived quarantine needs an invalid row
 * that the repository would never write). Every value used here is
 * synthetic test data — no real pharmacological parameter is ever
 * introduced to make a test convenient.
 */

/** Minimal versioned NPSL envelope with synthetic library metadata. */
function npslBuffer(drugs: unknown[], name: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: {
        id: 'e2e-library',
        name,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        dataStatus: 'example',
      },
      drugs,
    }),
    'utf8',
  )
}

const DRUG_ALPHA = {
  id: 'e2e-drug-a',
  origin: 'user',
  identifiers: { name: 'Synthetic E2E Alpha', synonyms: ['SEA'] },
  tags: ['synthetic-fixture'],
  targets: [],
  pharmacokinetics: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const DRUG_BETA = {
  id: 'e2e-drug-b',
  origin: 'user',
  identifiers: { name: 'Synthetic E2E Beta', synonyms: [] },
  tags: ['synthetic-fixture'],
  targets: [],
  pharmacokinetics: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

async function gotoImportExport(page: Page): Promise<void> {
  await page.goto('/import-export')
  await expect(page.getByTestId('library-record-count')).toBeVisible()
}

/** Import a valid NPSL file through preview + confirmation. */
async function importNpsl(
  page: Page,
  name: string,
  buffer: Buffer,
  mode: 'merge' | 'replace' = 'merge',
): Promise<void> {
  await page.getByTestId('npsl-file-input').setInputFiles({ name, mimeType: 'application/json', buffer })
  await expect(page.getByTestId('import-preview')).toBeVisible()
  if (mode === 'replace') {
    await page.getByTestId('import-mode').selectOption('replace')
    await page.getByTestId('replace-acknowledge').check()
  }
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText(`Import complete (${mode})`)
}

/**
 * Write ONE raw row into `drugs` through narrowly-scoped direct
 * IndexedDB access. This is the only sanctioned raw-storage touch in the
 * e2e suite: the quarantine report is derived from validation at
 * hydration, so a quarantined row must be planted as-is (the repository
 * refuses to write invalid records by design).
 */
async function seedRawRow(page: Page, row: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (value) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('neuropharmacology-sandbox')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const txn = db.transaction('drugs', 'readwrite')
      txn.objectStore('drugs').put(value)
      txn.oncomplete = () => resolve()
      txn.onerror = () => reject(txn.error)
      txn.onabort = () => reject(txn.error)
    })
    db.close()
  }, row)
}

/**
 * Plant a stored value outside the archive's JSON domain (a Date, which
 * structured clone preserves but JSON cannot represent). Built inside
 * the page so the Date is created by structured clone, not serialized.
 */
async function seedPoisonedRow(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('neuropharmacology-sandbox')
        request.onsuccess = () => {
          const db = request.result
          const txn = db.transaction('drugs', 'readwrite')
          txn.objectStore('drugs').put({
            id: 'e2e-poisoned-row',
            origin: 'user',
            recordedAt: new Date(0),
          })
          txn.oncomplete = () => {
            db.close()
            resolve()
          }
          txn.onerror = () => {
            db.close()
            reject(txn.error)
          }
          txn.onabort = () => {
            db.close()
            reject(txn.error)
          }
        }
        request.onerror = () => reject(request.error)
      }),
  )
}

/** Click the recovery export button and return the downloaded file's path. */
async function downloadRecoveryArchive(page: Page): Promise<string> {
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('recovery-export').click()
  const download = await downloadPromise
  const filePath = await download.path()
  if (filePath === null) {
    throw new Error('recovery export produced no file path')
  }
  return filePath
}

interface ArchiveEnvelope {
  readonly formatId: string
  readonly backupVersion: string
  readonly counts: {
    readonly drugRows: number
    readonly readableAtExport: number
    readonly quarantinedAtExport: number
    readonly metaRows: number
  }
  readonly drugs: readonly { readonly key: string }[]
  readonly meta: readonly { readonly key: string; readonly value: Record<string, unknown> }[]
}

test('recovery: export → replace → restore round trip preserves quarantined rows verbatim', async ({
  page,
}) => {
  // 1. Import one synthetic record through the ordinary Import tab.
  await gotoImportExport(page)
  await importNpsl(
    page,
    'synthetic-recovery.npsl',
    npslBuffer([DRUG_ALPHA], 'Synthetic E2E Library'),
  )
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // 2. Plant a quarantined row (raw storage — validation would reject it)
  //    and reload so hydration derives the quarantine report.
  await seedRawRow(page, { id: 'e2e-quarantined-1', origin: 'bogus' })
  await page.reload()
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // 3. Export the recovery archive and check the file itself.
  await page.getByTestId('tab-recovery').click()
  await expect(page.getByTestId('recovery-export')).toBeVisible()
  const archivePath = await downloadRecoveryArchive(page)
  await expect(page.getByTestId('recovery-export-status')).toHaveText(/Downloaded/)
  await expect(page.getByTestId('recovery-export-status')).toHaveText(
    /2 stored rows \(1 readable, 1 quarantined at export\)/,
  )
  await expect(page.getByTestId('recovery-export-status')).toHaveText(/no checksum or signature/)

  const archive = JSON.parse(readFileSync(archivePath, 'utf8')) as ArchiveEnvelope
  expect(archive.formatId).toBe('npsb')
  expect(archive.backupVersion).toBe('1.0.0')
  expect(archive.counts).toEqual({
    drugRows: 2,
    readableAtExport: 1,
    quarantinedAtExport: 1,
    metaRows: 1,
  })
  expect(archive.drugs.map((entry) => entry.key).sort()).toEqual([
    'e2e-drug-a',
    'e2e-quarantined-1',
  ])
  // Merge imports never touch library metadata (ADR contract), so the
  // archive carries the canonical default metadata row — key AND value
  // verbatim.
  expect(archive.meta.map((entry) => entry.key)).toEqual(['local-library'])
  expect(archive.meta[0]?.value).toMatchObject({
    id: 'local-library',
    name: 'Local library',
  })

  // Export is read-only: the record count is unchanged.
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // 4. Replace the library with different content — replace import clears
  //    the whole drugs store, so the quarantined row is gone now.
  await page.getByTestId('tab-import').click()
  await importNpsl(
    page,
    'synthetic-replacement.npsl',
    npslBuffer([DRUG_BETA], 'Synthetic E2E Replacement Library'),
    'replace',
  )
  // Replace replaces the metadata too — the record count line proves it.
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record.*Synthetic E2E Replacement Library/,
  )
  await page.goto('/library')
  await expect(page.getByTestId('quarantine-banner')).toHaveCount(0)
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Beta')

  // 5. Restore the archive: preview (read-only), gated confirmation,
  //    committed report.
  await page.goto('/import-export')
  await page.getByTestId('tab-recovery').click()
  await page.getByTestId('recovery-restore-file').setInputFiles(archivePath)
  await expect(page.getByTestId('recovery-preview')).toBeVisible()
  await expect(page.getByTestId('recovery-preview-counts')).toContainText(
    'Recorded at export',
  )
  await expect(page.getByTestId('recovery-preview-counts')).toContainText(
    '2 stored rows (1 readable, 1 quarantined)',
  )
  await expect(page.getByTestId('recovery-preview-counts')).toContainText('1 metadata row')
  await expect(page.getByTestId('recovery-preview-counts')).toContainText(
    'Current library that will be replaced: 1 record and 0 quarantined rows.',
  )
  // Same build, same storage versions: no spurious warnings.
  await expect(page.getByTestId('recovery-warnings')).toHaveCount(0)
  // Selecting a file wrote nothing.
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // Confirmation stays disabled until the explicit acknowledgement.
  await expect(page.getByTestId('recovery-restore-confirm')).toBeDisabled()
  await page.getByTestId('recovery-acknowledge').check()
  await expect(page.getByTestId('recovery-restore-confirm')).toBeEnabled()
  await page.getByTestId('recovery-restore-confirm').click()
  await expect(page.getByTestId('recovery-restore-report')).toContainText('Restore complete')
  // Committed: the preview (and with it the confirm control) is cleared.
  await expect(page.getByTestId('recovery-preview')).toHaveCount(0)

  // Session refreshed from storage: the metadata row is the ARCHIVED one
  // again (the replace import's name was replaced by the default row).
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record.*Local library/,
  )

  // 6. The quarantined row is back verbatim — in the derived quarantine
  //    report, and still there after a full reload.
  await page.goto('/library')
  const banner = page.getByTestId('quarantine-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('1 stored record failed validation')
  await expect(banner).toContainText('e2e-quarantined-1')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Alpha')
  await expect(page.getByTestId('drug-list')).not.toContainText('Synthetic E2E Beta')

  await page.reload()
  await expect(page.getByTestId('quarantine-banner')).toBeVisible()
  await expect(page.getByTestId('quarantine-banner')).toContainText('e2e-quarantined-1')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Alpha')
})

test('recovery: a malformed archive is rejected visibly and the library is unchanged', async ({
  page,
}) => {
  await gotoImportExport(page)
  await importNpsl(
    page,
    'synthetic-recovery.npsl',
    npslBuffer([DRUG_ALPHA], 'Synthetic E2E Library'),
  )

  await page.getByTestId('tab-recovery').click()
  await page.getByTestId('recovery-restore-file').setInputFiles({
    name: 'broken.npsb',
    mimeType: 'application/json',
    buffer: Buffer.from('{"formatId": "npsb",', 'utf8'),
  })
  const rejected = page.getByTestId('recovery-rejected')
  await expect(rejected).toBeVisible()
  await expect(rejected).toContainText('ARCHIVE_PARSE')
  await expect(rejected).toContainText('the current library was not modified')
  // No preview, therefore no confirm control.
  await expect(page.getByTestId('recovery-preview')).toHaveCount(0)
  await expect(page.getByTestId('recovery-restore-confirm')).toHaveCount(0)

  // Nothing was written — unchanged now and after a full reload.
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )
  await page.reload()
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )
  await page.goto('/library')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Alpha')
})

test('recovery: .npsb and .npsl are mutually exclusive across import and restore', async ({
  page,
}) => {
  await gotoImportExport(page)
  await importNpsl(
    page,
    'synthetic-recovery.npsl',
    npslBuffer([DRUG_ALPHA], 'Synthetic E2E Library'),
  )

  // Export a real archive for the reverse direction.
  await page.getByTestId('tab-recovery').click()
  const archivePath = await downloadRecoveryArchive(page)

  // Direction 1: the .npsb archive into the ordinary Import tab.
  await page.getByTestId('tab-import').click()
  await page.getByTestId('npsl-file-input').setInputFiles(archivePath)
  await expect(page.getByTestId('import-errors')).toBeVisible()
  await expect(page.getByTestId('import-errors')).toContainText('formatVersion')
  await expect(page.getByTestId('confirm-import')).toHaveCount(0)
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // Direction 2: an ordinary .npsl document into the restore path.
  await page.getByTestId('tab-recovery').click()
  await page.getByTestId('recovery-restore-file').setInputFiles({
    name: 'synthetic-library.npsl',
    mimeType: 'application/json',
    buffer: npslBuffer([DRUG_BETA], 'Synthetic E2E Other Library'),
  })
  const rejected = page.getByTestId('recovery-rejected')
  await expect(rejected).toBeVisible()
  await expect(rejected).toContainText('ARCHIVE_NOT_NPSB')
  await expect(rejected).toContainText('not a recovery archive')
  await expect(rejected).toContainText('Import tab')
  await expect(page.getByTestId('recovery-preview')).toHaveCount(0)
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // Reload: neither direction wrote anything.
  await page.reload()
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )
  await page.goto('/library')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Alpha')
  await expect(page.getByTestId('drug-list')).not.toContainText('Synthetic E2E Beta')
})

test('recovery: an export blocked by unsupported stored data fails with diagnostics and no download', async ({
  page,
}) => {
  await gotoImportExport(page)
  await seedPoisonedRow(page)

  await page.getByTestId('tab-recovery').click()
  await expect(page.getByTestId('recovery-export')).toBeVisible()

  // Race the download event against the failure announcement: a failed
  // export must never offer a file (bounded event wait, not a sleep).
  const downloadPromise = page
    .waitForEvent('download', { timeout: 3000 })
    .catch(() => null)
  await page.getByTestId('recovery-export').click()

  const alert = page.getByTestId('recovery-export-status')
  await expect(alert).toBeVisible()
  await expect(alert).toHaveAttribute('role', 'alert')
  await expect(alert).toContainText('no file was created')
  const issues = page.getByTestId('recovery-export-issues')
  await expect(issues).toContainText('BACKUP_UNSUPPORTED_VALUE')
  await expect(issues).toContainText('drugs key "e2e-poisoned-row"')
  await expect(issues).toContainText('path /recordedAt')
  await expect(issues).toContainText('type date')

  // Honesty: no success status anywhere and no download event at all.
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.getByText(/Downloaded/)).toHaveCount(0)
  expect(await downloadPromise).toBeNull()
})
