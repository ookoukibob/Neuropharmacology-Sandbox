import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * Import / Export workflows (phase 5).
 *
 * 1  valid NPSL import — preview is shown, nothing is written before
 *    the explicit confirmation, the committed report shows real counts
 * 2  invalid NPSL — visible parse error, no confirm control, library
 *    unchanged
 * 3  replace — blocked without the explicit acknowledgement; after the
 *    acknowledgement the whole library is replaced
 * 4  export → parse round trip — metadata, scientific values, units and
 *    provenance survive; `.npsl` and `.json` are the same envelope
 * 5  CSV mapping — nothing is inferred (all selects start empty), value
 *    without a unit source is blocked, `Kd/Ki` becomes Kd only by an
 *    explicit user choice, import commits only on confirmation
 * 6  CSV export — stable 57-column header, one row per target, and the
 *    always-visible lossiness warning
 *
 * Every value used here is synthetic test data — no real pharmacological
 * parameter is ever introduced to make a test convenient.
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

/** One drug with a literature-sourced Kd and a user-entered half-life. */
const DRUG_ALPHA = {
  id: 'e2e-drug-a',
  origin: 'user',
  identifiers: { name: 'Synthetic E2E Alpha', synonyms: ['SEA'] },
  tags: ['synthetic-fixture'],
  targets: [
    {
      id: 'e2e-target-1',
      name: 'E2E-R1',
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
  pharmacokinetics: {
    halfLife: {
      value: 8,
      unit: 'h',
      provenance: { type: 'user', recordedAt: '2026-01-01T00:00:00.000Z' },
    },
  },
  notes: 'Synthetic record created by end-to-end tests — not pharmacological information.',
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

const DRUG_GAMMA = {
  id: 'e2e-drug-c',
  origin: 'user',
  identifiers: { name: 'Synthetic E2E Gamma', synonyms: [] },
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

/** Select a native NPSL file and wait for its preview to render. */
async function previewNpslFile(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page
    .getByTestId('npsl-file-input')
    .setInputFiles({ name, mimeType: 'application/json', buffer })
  await expect(page.getByTestId('import-preview')).toBeVisible()
}

/** Import a valid NPSL file through preview + confirmation. */
async function importNpsl(
  page: Page,
  name: string,
  buffer: Buffer,
  mode: 'merge' | 'replace' = 'merge',
): Promise<void> {
  await previewNpslFile(page, name, buffer)
  if (mode === 'replace') {
    // Replace always requires the explicit acknowledgement, even on an
    // empty library — the gate is unconditional.
    await page.getByTestId('import-mode').selectOption('replace')
    await page.getByTestId('replace-acknowledge').check()
  }
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText(
    `Import complete (${mode})`,
  )
}

/** Click an export button and return the downloaded file's text. */
async function downloadText(page: Page, testId: string): Promise<string> {
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId(testId).click()
  const download = await downloadPromise
  const filePath = await download.path()
  if (filePath === null) {
    throw new Error(`download for ${testId} has no file path`)
  }
  return readFileSync(filePath, 'utf8')
}

/** The exported .npsl envelope (structural types only — JSON round trip). */
interface ExportedEnvelope {
  readonly formatVersion: string
  readonly schemaVersion: string
  readonly libraryMetadata: { readonly name: string }
  readonly drugs: readonly {
    readonly origin: string
    readonly identifiers: { readonly name: string }
    readonly targets: readonly {
      readonly name: string
      readonly kd?: {
        readonly value: number
        readonly unit: string
        readonly provenance: unknown
      }
    }[]
    readonly pharmacokinetics: {
      readonly halfLife?: { readonly value: number; readonly unit: string }
    }
  }[]
}

test('import: valid NPSL previews without writing and commits on confirmation', async ({
  page,
}) => {
  await gotoImportExport(page)
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 0 records/,
  )

  await previewNpslFile(page, 'synthetic-e2e.npsl', npslBuffer([DRUG_ALPHA], 'Synthetic E2E Library'))
  await expect(page.getByTestId('preview-stats')).toContainText('1 record')
  await expect(page.getByTestId('preview-stats')).toContainText('1 new id')
  await expect(page.getByTestId('preview-records')).toContainText('Synthetic E2E Alpha')
  await expect(page.getByTestId('preview-records')).toContainText('Kd 4.2 nM')

  // Invariant: selecting a file and previewing it must not write.
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 0 records/,
  )

  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText('1 created, 0 updated')
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )
  // The committed preview is cleared — the report is the source of truth.
  await expect(page.getByTestId('import-preview')).toHaveCount(0)

  // The record is really in the library, with its origin preserved from
  // the file (import does not rewrite origin or provenance).
  await page.goto('/library')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Alpha')
  await expect(page.getByTestId('drug-list').getByTestId('origin-badge')).toContainText(
    'Entered by you',
  )
  await page.getByTestId('drug-list').getByText('Synthetic E2E Alpha').click()
  await expect(page.getByTestId('param-Kd')).toContainText('4.2 nM')
  await expect(
    page.getByTestId('param-Kd').locator('..').getByTestId('provenance-badge'),
  ).toBeVisible()
})

test('import: invalid NPSL is rejected visibly and the library is unchanged', async ({
  page,
}) => {
  await gotoImportExport(page)
  await importNpsl(page, 'synthetic-e2e.npsl', npslBuffer([DRUG_ALPHA], 'Synthetic E2E Library'))
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // A malformed file replaces the preview with a blocking error — no
  // statistics, no confirmation control, no report.
  await page
    .getByTestId('npsl-file-input')
    .setInputFiles({
      name: 'broken.npsl',
      mimeType: 'application/json',
      buffer: Buffer.from('{broken', 'utf8'),
    })
  await expect(page.getByTestId('import-errors')).toBeVisible()
  await expect(page.getByTestId('import-errors')).toContainText('PARSE')
  await expect(page.getByTestId('confirm-import')).toHaveCount(0)
  await expect(page.getByTestId('preview-stats')).toHaveCount(0)
  await expect(page.getByTestId('import-report')).toHaveCount(0)

  // The previously imported library is untouched.
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )
  await page.goto('/library')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Alpha')
})

test('import: replace stays blocked until the explicit acknowledgement', async ({
  page,
}) => {
  await gotoImportExport(page)
  await importNpsl(page, 'library-a.npsl', npslBuffer([DRUG_ALPHA], 'Synthetic E2E Library'))

  // The replacement file contains TWO records — if a replace leaked
  // through without acknowledgement, the record count would become 2.
  await previewNpslFile(
    page,
    'library-b.npsl',
    npslBuffer([DRUG_BETA, DRUG_GAMMA], 'Synthetic E2E Library B'),
  )
  await page.getByTestId('import-mode').selectOption('replace')
  await expect(page.getByTestId('replace-warning')).toBeVisible()
  await expect(page.getByTestId('replace-acknowledge')).not.toBeChecked()
  await expect(page.getByTestId('confirm-import')).toBeDisabled()
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // Only the explicit acknowledgement enables the destructive import.
  await page.getByTestId('replace-acknowledge').check()
  await expect(page.getByTestId('confirm-import')).toBeEnabled()
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText('(replace)')
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 2 records/,
  )

  // The whole library was replaced: Alpha is gone, Beta and Gamma exist.
  await page.goto('/library')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Beta')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic E2E Gamma')
  await expect(page.getByTestId('drug-list')).not.toContainText('Synthetic E2E Alpha')
})

test('export: .npsl and .json round trip through a parse with provenance intact', async ({
  page,
}) => {
  await gotoImportExport(page)
  // Replace-mode seed so the file's library metadata lands in the store
  // (merge deliberately keeps the current metadata) — then the export must
  // carry that exact metadata back out.
  await importNpsl(
    page,
    'library-a.npsl',
    npslBuffer([DRUG_ALPHA], 'Synthetic E2E Library'),
    'replace',
  )

  await page.getByTestId('tab-export').click()
  const npslText = await downloadText(page, 'export-npsl')
  const jsonText = await downloadText(page, 'export-json')

  // `.npsl` and `.json` are byte-identical versioned envelopes.
  expect(jsonText).toBe(npslText)
  const parsed = JSON.parse(npslText) as ExportedEnvelope
  expect(parsed.formatVersion).toBe('1.0.0')
  expect(parsed.schemaVersion).toBe('1.0.0')
  expect(parsed.libraryMetadata.name).toBe('Synthetic E2E Library')

  const drug = parsed.drugs[0]
  expect(drug?.identifiers.name).toBe('Synthetic E2E Alpha')
  expect(drug?.origin).toBe('user')
  expect(drug?.targets[0]?.name).toBe('E2E-R1')
  expect(drug?.targets[0]?.kd).toEqual({
    value: 4.2,
    unit: 'nM',
    provenance: {
      type: 'literature',
      source: 'Synthetic E2E source',
      citation: 'Invented for E2E, 2026',
    },
  })
  expect(drug?.pharmacokinetics.halfLife).toEqual({
    value: 8,
    unit: 'h',
    provenance: { type: 'user', recordedAt: '2026-01-01T00:00:00.000Z' },
  })

  await expect(page.getByTestId('export-status')).toContainText('Downloaded')
})

test('import: CSV mapping is explicit, Kd/Ki resolves only by user choice', async ({
  page,
}) => {
  await gotoImportExport(page)
  const csv =
    'compound,target_name,Kd/Ki,units\r\nSynthetic CSV Compound,E2E-T,4.2,nM\r\n'
  await page
    .getByTestId('csv-file-input')
    .setInputFiles({
      name: 'synthetic.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    })
  await expect(page.getByTestId('csv-mapping')).toBeVisible()

  // Inference invariant: every column starts unmapped, including `Kd/Ki`.
  await expect(page.getByTestId('map-0')).toHaveValue('')
  await expect(page.getByTestId('map-1')).toHaveValue('')
  await expect(page.getByTestId('map-2')).toHaveValue('')
  await expect(page.getByTestId('map-3')).toHaveValue('')

  // Preview without a drug name mapping is blocked with a visible reason.
  await page.getByTestId('csv-preview-btn').click()
  await expect(page.getByTestId('mapping-errors')).toContainText(
    'Drug name must be mapped',
  )

  await page.getByTestId('map-0').selectOption('drug.name')
  await page.getByTestId('map-1').selectOption('target.name')
  await page.getByTestId('map-2').selectOption('kd.value')

  // A value without a unit source cannot reach the preview.
  await page.getByTestId('csv-preview-btn').click()
  await expect(page.getByTestId('mapping-errors')).toContainText(
    'Kd has no unit source',
  )

  await page.getByTestId('map-3').selectOption('kd.unit')
  await page.getByTestId('csv-preview-btn').click()
  await expect(page.getByTestId('import-preview')).toBeVisible()
  await expect(page.getByTestId('preview-records')).toContainText('Kd 4.2 nM')
  await expect(page.getByTestId('csv-declarations')).toContainText(
    'from column "units"',
  )

  // Still nothing written before the confirmation.
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 0 records/,
  )

  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText('1 created')
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 1 record/,
  )

  // The record carries the explicitly chosen Kd (with unit), no Ki, and
  // the CSV builder's storage origin.
  await page.goto('/library')
  await expect(page.getByTestId('drug-list')).toContainText('Synthetic CSV Compound')
  await expect(page.getByTestId('drug-list').getByTestId('origin-badge')).toContainText(
    'Imported',
  )
  await page.getByTestId('drug-list').getByText('Synthetic CSV Compound').click()
  await expect(page.getByTestId('param-Kd')).toContainText('4.2 nM')
  await expect(page.getByTestId('param-Ki')).toHaveCount(0)
})

test('export: CSV has the stable header schema and a visible lossiness warning', async ({
  page,
}) => {
  await gotoImportExport(page)
  await importNpsl(page, 'library-a.npsl', npslBuffer([DRUG_ALPHA], 'Synthetic E2E Library'))

  await page.getByTestId('tab-export').click()
  // The warning is visible before any CSV is produced.
  await expect(page.getByTestId('csv-lossiness')).toContainText('lossy projection')
  await expect(page.getByTestId('csv-lossiness')).toContainText('not a substitute')

  const csvText = await downloadText(page, 'export-csv')
  const lines = csvText.split('\r\n').filter((line) => line !== '')

  // Stable header: 57 unique columns, canonical identity columns first.
  const header = lines[0]!.split(',')
  expect(header).toHaveLength(57)
  expect(header.slice(0, 4)).toEqual(['drug_id', 'origin', 'name', 'synonyms'])
  expect(header).toContain('target_name')
  expect(header).toContain('kd_unit')
  expect(header).toContain('kd_provenance_type')
  expect(header).toContain('kd_provenance_source')
  expect(header).toContain('half_life_unit')

  // One row per target: this drug has exactly one target → one data row.
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('Synthetic E2E Alpha')
  expect(lines[1]).toContain('E2E-R1')
  expect(lines[1]).toContain('4.2')
  expect(lines[1]).toContain('nM')
  expect(lines[1]).toContain('literature')

  await expect(page.getByTestId('export-status')).toContainText('Downloaded')
})
