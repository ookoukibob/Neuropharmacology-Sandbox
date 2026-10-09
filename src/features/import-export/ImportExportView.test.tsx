/**
 * ImportExportView integration tests (jsdom + fake-indexeddb, real Dexie
 * repository): preview never writes before confirmation, invalid input is
 * blocked, replace requires explicit acknowledgement, CSV mapping stays
 * explicit (a `Kd/Ki` column is never inferred), and exports serialize
 * the whole library through the canonical NPSL/CSV paths.
 * All fixture values are synthetic test data — not pharmacological
 * information.
 */
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { libraryRepository, useLibraryStore } from '@/app/libraryStore'
import { SandboxDatabase } from '@/data/db/database'
import { syntheticLibrary, syntheticNpslText, syntheticDrug } from '../../tests/fixtures'
import { ImportExportView } from './ImportExportView'

async function resetStorage(): Promise<void> {
  await new SandboxDatabase().delete()
  useLibraryStore.setState({
    status: 'idle',
    drugs: [],
    metadata: undefined,
    quarantine: [],
    selectedDrugId: null,
    error: null,
    filter: '',
  })
  await useLibraryStore.getState().hydrate()
}

function file(content: string, name: string, type: string): File {
  return new File([content], name, { type })
}

const NPSL_ONE = syntheticNpslText([syntheticDrug()])
const NPSL_REPLACEMENT = syntheticNpslText([
  syntheticDrug({
    id: 'fixture-drug-replacement',
    identifiers: { name: 'Synthetic Replacement', synonyms: [] },
    targets: [],
    pharmacokinetics: {},
  }),
])

beforeEach(async () => {
  await resetStorage()
})

/**
 * Radix Tabs activate a trigger on mouse-down (primary button); jsdom's
 * plain `click` never reaches that handler, so switch tabs like a browser
 * would: mouse-down, then click for the full event sequence.
 */
function activateTab(testId: string): void {
  const trigger = screen.getByTestId(testId)
  fireEvent.mouseDown(trigger)
  fireEvent.click(trigger)
}

describe('ImportExportView — NPSL import', () => {
  it('previews a valid file without writing, then commits on confirmation', async () => {
    render(<ImportExportView />)

    fireEvent.change(screen.getByTestId('npsl-file-input'), {
      target: { files: [file(NPSL_ONE, 'library.npsl', 'application/json')] },
    })
    await screen.findByTestId('import-preview')
    expect(screen.getByTestId('preview-stats')).toHaveTextContent('1 record')
    expect(screen.getByTestId('preview-stats')).toHaveTextContent('1 new id')
    expect(screen.getByTestId('preview-records')).toHaveTextContent('Fixture Compound A')

    // Invariant: preview alone writes nothing.
    expect(screen.getByTestId('library-record-count')).toHaveTextContent(
      'Current library: 0 records',
    )
    expect((await libraryRepository.getAllDrugs()).drugs).toEqual([])

    fireEvent.click(screen.getByTestId('confirm-import'))
    await waitFor(() =>
      expect(screen.getByTestId('library-record-count')).toHaveTextContent(
        'Current library: 1 record',
      ),
    )
    expect(screen.getByTestId('import-report')).toHaveTextContent('1 created, 0 updated')
    // The committed preview is cleared so the report is the source of truth.
    expect(screen.queryByTestId('import-preview')).not.toBeInTheDocument()
    const stored = await libraryRepository.getAllDrugs()
    expect(stored.drugs).toHaveLength(1)
    expect(stored.drugs[0]?.targets[0]?.kd?.provenance).toEqual({
      type: 'literature',
      source: 'Synthetic fixture source',
      citation: 'Invented for tests, 2026',
    })
  })

  it('shows a committed report — not "nothing was written" — when the refresh fails after commit', async () => {
    // Drive the UI branch deterministically: the store returns the
    // committed-but-refresh-failed outcome (the store's own behavior is
    // covered in store.test.ts against the real Dexie repository).
    const originalImportLibrary = useLibraryStore.getState().importLibrary
    let importCalls = 0
    useLibraryStore.setState({
      importLibrary: async () => {
        importCalls += 1
        return {
          status: 'committed-refresh-failed',
          report: {
            ok: true,
            mode: 'merge',
            total: 1,
            created: 1,
            updated: 0,
            warnings: [],
          },
          message: 'post-commit read failure',
        }
      },
    })
    try {
      render(<ImportExportView />)

      fireEvent.change(screen.getByTestId('npsl-file-input'), {
        target: { files: [file(NPSL_ONE, 'library.npsl', 'application/json')] },
      })
      await screen.findByTestId('import-preview')
      fireEvent.click(screen.getByTestId('confirm-import'))

      // The report states the commit explicitly, with counts and the
      // ORIGINAL refresh error as the recovery context.
      const report = await screen.findByTestId('import-report')
      expect(report).toHaveTextContent('Import committed — session refresh failed')
      expect(report).toHaveTextContent('1 created, 0 updated')
      expect(screen.getByTestId('refresh-error')).toHaveTextContent('post-commit read failure')
      expect(screen.getByTestId('retry-refresh')).toBeEnabled()

      // Never the rollback wording for a committed import.
      expect(report).not.toHaveTextContent(/nothing was written/i)
      expect(report).not.toHaveTextContent(/library is unchanged/i)

      // The committed preview is cleared — Confirm cannot be pressed again.
      expect(screen.queryByTestId('import-preview')).not.toBeInTheDocument()
      expect(screen.queryByTestId('confirm-import')).not.toBeInTheDocument()
      expect(importCalls).toBe(1)

      // Retrying refreshes the session — it never re-runs the import.
      fireEvent.click(screen.getByTestId('retry-refresh'))
      await waitFor(() =>
        expect(screen.getByTestId('library-record-count')).toHaveTextContent(
          'Current library: 0 records',
        ),
      )
      expect(importCalls).toBe(1)
    } finally {
      useLibraryStore.setState({ importLibrary: originalImportLibrary })
    }
  })

  it('blocks malformed input with visible errors and writes nothing', async () => {
    render(<ImportExportView />)

    fireEvent.change(screen.getByTestId('npsl-file-input'), {
      target: { files: [file('{broken', 'broken.npsl', 'application/json')] },
    })
    await screen.findByTestId('import-errors')
    expect(screen.getByTestId('import-errors')).toHaveTextContent('PARSE')
    expect(screen.getByTestId('import-errors')).toHaveTextContent('not valid JSON')
    expect(screen.queryByTestId('confirm-import')).not.toBeInTheDocument()
    expect((await libraryRepository.getAllDrugs()).drugs).toEqual([])
  })

  it('blocks duplicate ids inside the file without writing anything', async () => {
    render(<ImportExportView />)
    const duplicate = syntheticNpslText([
      syntheticDrug(),
      syntheticDrug({ identifiers: { name: 'Synthetic duplicate', synonyms: [] } }),
    ])

    fireEvent.change(screen.getByTestId('npsl-file-input'), {
      target: { files: [file(duplicate, 'duplicates.npsl', 'application/json')] },
    })
    await screen.findByTestId('import-errors')
    expect(screen.getByTestId('import-errors')).toHaveTextContent('DUPLICATE_ID')
    expect((await libraryRepository.getAllDrugs()).drugs).toEqual([])
  })

  it('cancelling a preview writes nothing and clears the preview', async () => {
    render(<ImportExportView />)

    fireEvent.change(screen.getByTestId('npsl-file-input'), {
      target: { files: [file(NPSL_ONE, 'library.npsl', 'application/json')] },
    })
    await screen.findByTestId('import-preview')
    fireEvent.click(screen.getByTestId('cancel-import'))

    expect(screen.queryByTestId('import-preview')).not.toBeInTheDocument()
    expect(screen.getByTestId('library-record-count')).toHaveTextContent(
      'Current library: 0 records',
    )
    expect((await libraryRepository.getAllDrugs()).drugs).toEqual([])
  })

  it('requires the explicit acknowledgement before a replace can run', async () => {
    render(<ImportExportView />)

    // Baseline: one committed record.
    fireEvent.change(screen.getByTestId('npsl-file-input'), {
      target: { files: [file(NPSL_ONE, 'library.npsl', 'application/json')] },
    })
    await screen.findByTestId('import-preview')
    fireEvent.click(screen.getByTestId('confirm-import'))
    await waitFor(() =>
      expect(screen.getByTestId('library-record-count')).toHaveTextContent(
        'Current library: 1 record',
      ),
    )

    // Destructive replace of a different library.
    fireEvent.change(screen.getByTestId('npsl-file-input'), {
      target: { files: [file(NPSL_REPLACEMENT, 'other.npsl', 'application/json')] },
    })
    await screen.findByTestId('import-preview')
    fireEvent.change(screen.getByTestId('import-mode'), { target: { value: 'replace' } })
    await screen.findByTestId('replace-warning')

    const confirm = screen.getByTestId('confirm-import')
    expect(confirm).toBeDisabled()

    // Nothing replaced while unacknowledged.
    let stored = await libraryRepository.getAllDrugs()
    expect(stored.drugs[0]?.identifiers.name).toBe('Fixture Compound A')

    fireEvent.click(screen.getByTestId('replace-acknowledge'))
    expect(screen.getByTestId('confirm-import')).toBeEnabled()
    fireEvent.click(screen.getByTestId('confirm-import'))

    await waitFor(() => expect(screen.getByTestId('import-report')).toHaveTextContent('replace'))
    stored = await libraryRepository.getAllDrugs()
    expect(stored.drugs).toHaveLength(1)
    expect(stored.drugs[0]?.identifiers.name).toBe('Synthetic Replacement')
    await waitFor(() =>
      expect(screen.getByTestId('library-record-count')).toHaveTextContent(
        'Current library: 1 record',
      ),
    )
  })
})

describe('ImportExportView — CSV mapping', () => {
  it('maps columns explicitly, resolves Kd/Ki by user choice, previews, imports', async () => {
    render(<ImportExportView />)
    const csv =
      'compound,target,Kd/Ki,ki,unit\nSynthetic CSV Drug,SITE-1,4.2,9.9,nM\n'

    fireEvent.change(screen.getByTestId('csv-file-input'), {
      target: { files: [file(csv, 'synthetic.csv', 'text/csv')] },
    })
    await screen.findByTestId('csv-mapping')

    // Invariant: nothing is inferred — every select starts unmapped.
    expect(screen.getByTestId('map-0')).toHaveValue('')
    expect(screen.getByTestId('map-1')).toHaveValue('')
    expect(screen.getByTestId('map-2')).toHaveValue('')
    expect(screen.getByTestId('map-3')).toHaveValue('')
    expect(screen.getByTestId('map-4')).toHaveValue('')
    expect(screen.queryByTestId('mapping-warnings')).not.toBeInTheDocument()

    // Preview before mapping reports the missing drug name mapping.
    fireEvent.click(screen.getByTestId('csv-preview-btn'))
    expect(screen.getByTestId('mapping-errors')).toHaveTextContent('Drug name must be mapped')

    fireEvent.change(screen.getByTestId('map-0'), { target: { value: 'drug.name' } })
    fireEvent.change(screen.getByTestId('map-1'), { target: { value: 'target.name' } })
    fireEvent.change(screen.getByTestId('map-2'), { target: { value: 'kd.value' } })

    // A value without a unit source is blocked with a visible reason.
    fireEvent.click(screen.getByTestId('csv-preview-btn'))
    expect(screen.getByTestId('mapping-errors')).toHaveTextContent('Kd has no unit source')

    // Mapping Ki next to Kd raises the cross-parameter consistency warning
    // (non-blocking); unmapping Ki clears it again.
    fireEvent.change(screen.getByTestId('map-3'), { target: { value: 'ki.value' } })
    expect(screen.getByTestId('mapping-warnings')).toHaveTextContent('never substituted')
    fireEvent.change(screen.getByTestId('map-3'), { target: { value: '' } })
    expect(screen.queryByTestId('mapping-warnings')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('map-4'), { target: { value: 'kd.unit' } })
    fireEvent.click(screen.getByTestId('csv-preview-btn'))
    await screen.findByTestId('import-preview')
    // The `Kd/Ki` column was mapped by explicit user choice above (the
    // selects all start empty — asserted earlier), and the unit policy is
    // declared from the mapped column.
    expect(screen.getByTestId('csv-declarations')).toHaveTextContent('from column "unit"')
    expect(screen.getByTestId('preview-stats')).toHaveTextContent('1 record')

    // Still unwritten before confirmation.
    expect((await libraryRepository.getAllDrugs()).drugs).toEqual([])

    fireEvent.click(screen.getByTestId('confirm-import'))
    await waitFor(() =>
      expect(screen.getByTestId('library-record-count')).toHaveTextContent(
        'Current library: 1 record',
      ),
    )

    const drugs = (await libraryRepository.getAllDrugs()).drugs
    expect(drugs).toHaveLength(1)
    expect(drugs[0]?.identifiers.name).toBe('Synthetic CSV Drug')
    expect(drugs[0]?.targets[0]?.kd).toEqual({
      value: 4.2,
      unit: 'nM',
      provenance: { type: 'user', recordedAt: expect.any(String) },
    })
    // Explicit Kd selection must not materialize Ki/EC50/IC50.
    expect(drugs[0]?.targets[0]?.ki).toBeUndefined()
    expect(drugs[0]?.targets[0]?.ec50).toBeUndefined()
    expect(drugs[0]?.targets[0]?.ic50).toBeUndefined()
  })

  it('reports CSV parse errors visibly without touching the library', async () => {
    render(<ImportExportView />)
    fireEvent.change(screen.getByTestId('csv-file-input'), {
      target: { files: [file('a,b\n"broken\n', 'broken.csv', 'text/csv')] },
    })
    await screen.findByTestId('import-read-error')
    expect(screen.getByTestId('import-read-error')).toHaveTextContent('unterminated quoted field')
    expect(screen.queryByTestId('csv-mapping')).not.toBeInTheDocument()
    expect((await libraryRepository.getAllDrugs()).drugs).toEqual([])
  })
})

describe('ImportExportView — export', () => {
  let captured: Blob[] = []

  beforeEach(() => {
    captured = []
    URL.createObjectURL = vi.fn((blob: Blob): string => {
      captured.push(blob)
      return `blob:mock-${captured.length}`
    })
    URL.revokeObjectURL = vi.fn()
  })

  it('exports the whole library as .npsl, .json and .csv with lossiness warning', async () => {
    await libraryRepository.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    render(<ImportExportView />)

    activateTab('tab-export')
    expect(screen.getByTestId('csv-lossiness')).toHaveTextContent('lossy projection')
    expect(screen.getByTestId('csv-lossiness')).toHaveTextContent('not a substitute')

    // .npsl — canonical envelope with provenance intact.
    fireEvent.click(screen.getByTestId('export-npsl'))
    await screen.findByTestId('export-status')
    expect(screen.getByTestId('export-status')).toHaveTextContent('Downloaded')
    expect(screen.getByTestId('export-status')).toHaveTextContent('.npsl')
    const npsl = JSON.parse(await captured[0]!.text()) as {
      formatVersion: string
      drugs: { targets: { kd?: { provenance?: unknown } }[] }[]
    }
    expect(npsl.formatVersion).toBe('1.0.0')
    expect(npsl.drugs[0]?.targets[0]?.kd?.provenance).toEqual({
      type: 'literature',
      source: 'Synthetic fixture source',
      citation: 'Invented for tests, 2026',
    })

    // .json — the same envelope.
    fireEvent.click(screen.getByTestId('export-json'))
    await waitFor(() => expect(captured).toHaveLength(2))
    const json = JSON.parse(await captured[1]!.text()) as { drugs: unknown[] }
    expect(json.drugs).toHaveLength(1)

    // .csv — stable header + record, and the previous object URL was revoked.
    fireEvent.click(screen.getByTestId('export-csv'))
    await waitFor(() => expect(captured).toHaveLength(3))
    const csvText = await captured[2]!.text()
    expect(csvText.split('\r\n')[0]?.startsWith('drug_id,origin,name,')).toBe(true)
    expect(csvText).toContain('Fixture Compound A')
    expect(csvText).toContain('Synthetic fixture source')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-2')
  })

  it('warns about quarantined records during export — and stays quiet when quarantine is empty', async () => {
    await libraryRepository.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    render(<ImportExportView />)
    activateTab('tab-export')

    // Empty quarantine: no noisy warning.
    expect(screen.queryByTestId('export-quarantine-warning')).not.toBeInTheDocument()

    // Seed an invalid stored record (quarantine = invalid rows reported on
    // hydration, never deleted) and re-hydrate the session.
    const db = new SandboxDatabase()
    await db.drugs.put({ id: 'quarantined-1', origin: 'bogus' } as never)
    await useLibraryStore.getState().hydrate()

    const warning = await screen.findByTestId('export-quarantine-warning')
    expect(warning).toHaveTextContent('1 stored record failed validation')
    expect(warning).toHaveTextContent('NOT included')
    expect(warning).toHaveTextContent('not a complete backup')

    // Exports exclude the quarantined record — never silently inserted,
    // and the exported count is the validated record count.
    fireEvent.click(screen.getByTestId('export-npsl'))
    await screen.findByTestId('export-status')
    expect(screen.getByTestId('export-status')).toHaveTextContent('1 record')
    const exported = JSON.parse(await captured[0]!.text()) as { drugs: { id: string }[] }
    expect(exported.drugs).toHaveLength(1)
    expect(exported.drugs[0]?.id).toBe('fixture-drug-1')
  })

  it('surfaces an export failure as an error status', async () => {
    render(<ImportExportView />)
    activateTab('tab-export')
    URL.createObjectURL = vi.fn(() => {
      throw new Error('object URL unavailable')
    })
    fireEvent.click(screen.getByTestId('export-npsl'))
    await screen.findByTestId('export-status')
    expect(screen.getByTestId('export-status')).toHaveTextContent('Export failed')
    expect(screen.getByTestId('export-status')).toHaveAttribute('role', 'alert')
  })
})
