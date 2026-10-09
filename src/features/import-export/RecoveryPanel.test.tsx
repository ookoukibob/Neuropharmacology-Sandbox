/**
 * RecoveryPanel integration tests (jsdom + fake-indexeddb, real Dexie
 * repository): export honesty (structured failure → no file, no success
 * status), preview-before-write gating behind the explicit acknowledgement,
 * the distinct outcome reports (rejected/failed/ok/committed-refresh-failed),
 * mutual rejection with ordinary import, and the post-commit refresh retry
 * that never re-runs the restore transaction.
 *
 * All fixture values are synthetic test data — not pharmacological
 * information.
 */
import 'fake-indexeddb/auto'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { libraryRepository, useLibraryStore } from '@/app/libraryStore'
import { SandboxDatabase } from '@/data/db/database'
import { MAX_ARCHIVE_BYTES } from '@/data/recovery/format'
import { toRecord } from '@/data/mappers/records'
import {
  syntheticDrug,
  syntheticDrugB,
  syntheticLibrary,
  syntheticNpslText,
} from '../../tests/fixtures'
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

/** Export an archive directly through the repository (bypasses the UI). */
async function exportText(): Promise<string> {
  const result = await libraryRepository.exportRecoveryArchive()
  if (!result.ok) throw new Error(JSON.stringify(result.issues))
  return result.text
}

/** Library of one synthetic drug + one quarantined raw row, session hydrated. */
async function seedLibraryWithQuarantine(): Promise<void> {
  await libraryRepository.replaceLibrary(syntheticLibrary([syntheticDrug()]))
  const db = new SandboxDatabase()
  await db.drugs.put({ id: 'quarantined-1', origin: 'bogus' } as never)
  await useLibraryStore.getState().hydrate()
}

beforeEach(async () => {
  await resetStorage()
})

describe('RecoveryPanel — export', () => {
  it('exports a .npsb archive with quarantine-inclusive counts and a no-authenticity note', async () => {
    await seedLibraryWithQuarantine()

    const captured: Blob[] = []
    URL.createObjectURL = vi.fn((blob: Blob): string => {
      captured.push(blob)
      return `blob:mock-${captured.length}`
    })
    URL.revokeObjectURL = vi.fn()

    render(<ImportExportView />)
    activateTab('tab-recovery')

    fireEvent.click(screen.getByTestId('recovery-export'))
    const status = await screen.findByTestId('recovery-export-status')
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveTextContent('Downloaded')
    expect(status).toHaveTextContent('.npsb')
    expect(status).toHaveTextContent('2 stored rows (1 readable, 1 quarantined at export)')
    expect(status).toHaveTextContent('1 metadata row')
    expect(status).toHaveTextContent('no checksum or signature')

    expect(captured).toHaveLength(1)
    const doc = JSON.parse(await captured[0]!.text()) as {
      formatId: string
      counts: { drugRows: number; quarantinedAtExport: number }
      drugs: { key: string }[]
    }
    expect(doc.formatId).toBe('npsb')
    expect(doc.counts).toEqual({
      drugRows: 2,
      readableAtExport: 1,
      quarantinedAtExport: 1,
      metaRows: 1,
    })
    expect(doc.drugs.map((entry) => entry.key)).toContain('quarantined-1')
  })

  it('fails export with structured diagnostics and offers no file', async () => {
    // A stored value outside the JSON domain makes the whole export fail.
    const db = new SandboxDatabase()
    await db.drugs.put({ id: 'poisoned-row', recordedAt: new Date() } as never)
    await useLibraryStore.getState().hydrate()

    const createObjectURL = vi.fn((): string => 'blob:mock-1')
    URL.createObjectURL = createObjectURL

    render(<ImportExportView />)
    activateTab('tab-recovery')

    fireEvent.click(screen.getByTestId('recovery-export'))
    const alert = await screen.findByTestId('recovery-export-status')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent('no file was created')
    const issues = screen.getByTestId('recovery-export-issues')
    expect(issues).toHaveTextContent('BACKUP_UNSUPPORTED_VALUE')
    expect(issues).toHaveTextContent('drugs key "poisoned-row"')
    expect(issues).toHaveTextContent('path /recordedAt')
    expect(issues).toHaveTextContent('type date')

    // Honesty: no download, no success status, no "backup complete" claim.
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/Downloaded/)).not.toBeInTheDocument()
    // Export never mutates storage.
    expect(await db.drugs.count()).toBe(1)
  })
})

describe('RecoveryPanel — restore preview', () => {
  it('shows the three count groups and gates confirm behind the acknowledgement', async () => {
    await seedLibraryWithQuarantine()
    const archive = await exportText()

    render(<ImportExportView />)
    activateTab('tab-recovery')

    fireEvent.change(screen.getByTestId('recovery-restore-file'), {
      target: { files: [file(archive, 'backup.npsb', 'application/json')] },
    })
    await screen.findByTestId('recovery-preview')
    expect(screen.getByTestId('recovery-preview-file')).toHaveTextContent('backup.npsb')
    expect(screen.getByTestId('recovery-preview-counts')).toHaveTextContent(
      'Recorded at export',
    )
    expect(screen.getByTestId('recovery-preview-counts')).toHaveTextContent(
      '2 stored rows (1 readable, 1 quarantined)',
    )
    expect(screen.getByTestId('recovery-preview-counts')).toHaveTextContent('1 metadata row')
    expect(screen.getByTestId('recovery-preview-counts')).toHaveTextContent(
      'This build classifies the archive rows as: 1 readable, 1 quarantined',
    )
    expect(screen.getByTestId('recovery-preview-counts')).toHaveTextContent(
      'Current library that will be replaced: 1 record and 1 quarantined row.',
    )

    // Confirmation is gated behind the explicit acknowledgement, and the
    // label embeds the exact counts being acknowledged.
    const confirm = screen.getByTestId('recovery-restore-confirm')
    expect(confirm).toBeDisabled()
    const ack = screen.getByTestId('recovery-acknowledge')
    fireEvent.click(ack)
    expect(confirm).not.toBeDisabled()
    expect(ack.closest('label')).toHaveTextContent(
      'I understand this will permanently replace my current library',
    )
    expect(ack.closest('label')).toHaveTextContent('2 rows')
    // Selecting a file never writes anything.
    expect(screen.getByTestId('library-record-count')).toHaveTextContent('1 record')
  })

  it('rejects an invalid archive with structured issues and never shows the confirm control', async () => {
    await seedLibraryWithQuarantine()

    render(<ImportExportView />)
    activateTab('tab-recovery')

    const bad = '{"formatId":"npsb","backupVersion":"1.0.0","formatId":"npsb"}'
    fireEvent.change(screen.getByTestId('recovery-restore-file'), {
      target: { files: [file(bad, 'bad.npsb', 'application/json')] },
    })
    const rejected = await screen.findByTestId('recovery-rejected')
    expect(rejected).toHaveAttribute('role', 'alert')
    expect(rejected).toHaveTextContent('the current library was not modified')
    expect(screen.getByTestId('recovery-issues')).toHaveTextContent(
      'ARCHIVE_DUPLICATE_JSON_KEY',
    )
    expect(screen.queryByTestId('recovery-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recovery-restore-confirm')).not.toBeInTheDocument()
    expect(screen.getByTestId('library-record-count')).toHaveTextContent('1 record')
  })

  it('rejects an oversized file before reading it', async () => {
    render(<ImportExportView />)
    activateTab('tab-recovery')

    const huge = file('x', 'huge.npsb', 'application/json')
    Object.defineProperty(huge, 'size', { value: MAX_ARCHIVE_BYTES + 1 })
    fireEvent.change(screen.getByTestId('recovery-restore-file'), {
      target: { files: [huge] },
    })
    const rejected = await screen.findByTestId('recovery-rejected')
    expect(rejected).toHaveTextContent('ARCHIVE_TOO_LARGE')
    expect(rejected).toHaveTextContent(String(MAX_ARCHIVE_BYTES))
    expect(screen.queryByTestId('recovery-read-error')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recovery-preview')).not.toBeInTheDocument()
  })

  it('cancelling the preview clears it and leaves the library untouched', async () => {
    await seedLibraryWithQuarantine()
    const archive = await exportText()

    render(<ImportExportView />)
    activateTab('tab-recovery')
    fireEvent.change(screen.getByTestId('recovery-restore-file'), {
      target: { files: [file(archive, 'backup.npsb', 'application/json')] },
    })
    await screen.findByTestId('recovery-preview')

    fireEvent.click(screen.getByTestId('recovery-cancel'))
    expect(screen.queryByTestId('recovery-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recovery-restore-confirm')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recovery-rejected')).not.toBeInTheDocument()
    expect(screen.getByTestId('library-record-count')).toHaveTextContent('1 record')
  })
})

describe('RecoveryPanel — restore outcomes', () => {
  it('restores after acknowledgement, reports the outcome and clears the preview', async () => {
    await seedLibraryWithQuarantine()
    const archive = await exportText()

    // Current library becomes different content (one other record).
    await libraryRepository.replaceLibrary(
      syntheticLibrary([
        syntheticDrug({
          id: 'fixture-drug-replacement',
          identifiers: { name: 'Synthetic Replacement', synonyms: [] },
          targets: [],
          pharmacokinetics: {},
        }),
      ]),
    )
    await useLibraryStore.getState().hydrate()

    render(<ImportExportView />)
    activateTab('tab-recovery')
    expect(useLibraryStore.getState().drugs[0]?.identifiers.name).toBe('Synthetic Replacement')

    fireEvent.change(screen.getByTestId('recovery-restore-file'), {
      target: { files: [file(archive, 'backup.npsb', 'application/json')] },
    })
    await screen.findByTestId('recovery-preview')
    fireEvent.click(screen.getByTestId('recovery-acknowledge'))
    fireEvent.click(screen.getByTestId('recovery-restore-confirm'))

    const report = await screen.findByTestId('recovery-restore-report')
    expect(report).toHaveTextContent('Restore complete')
    expect(report).toHaveTextContent('2 stored rows and 1 metadata row were restored verbatim')
    expect(report).toHaveTextContent('1 readable and 1 quarantined')
    expect(report).toHaveTextContent('quarantined rows remain stored')

    // Committed outcome: preview cleared, session refreshed from storage.
    expect(screen.queryByTestId('recovery-preview')).not.toBeInTheDocument()
    expect(useLibraryStore.getState().drugs[0]?.identifiers.name).toBe('Fixture Compound A')
    expect(useLibraryStore.getState().quarantine.map((q) => q.id)).toEqual(['quarantined-1'])
    expect(screen.getByTestId('library-record-count')).toHaveTextContent('1 record')
    expect(await new SandboxDatabase().drugs.count()).toBe(2)
  })

  it('reports a committed restore whose session refresh failed — and retries only the refresh', async () => {
    await libraryRepository.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    await useLibraryStore.getState().hydrate()
    const archive = await exportText()

    // Component-level injection (the pattern used by the import panel
    // tests): the store action reports the committed-but-refresh-failed
    // branch; the real repository/store behavior is covered in
    // store.test.ts and the repository tests.
    let restoreCalls = 0
    useLibraryStore.setState({
      restoreArchive: async () => {
        restoreCalls += 1
        return {
          status: 'committed-refresh-failed',
          report: {
            counts: {
              drugRows: 1,
              readableAtExport: 1,
              quarantinedAtExport: 0,
              metaRows: 1,
            },
            currentBuild: { readable: 1, quarantined: 0 },
            warnings: [],
          },
          message: 'refresh exploded',
        }
      },
    })

    render(<ImportExportView />)
    activateTab('tab-recovery')
    fireEvent.change(screen.getByTestId('recovery-restore-file'), {
      target: { files: [file(archive, 'backup.npsb', 'application/json')] },
    })
    await screen.findByTestId('recovery-preview')
    fireEvent.click(screen.getByTestId('recovery-acknowledge'))
    fireEvent.click(screen.getByTestId('recovery-restore-confirm'))

    const report = await screen.findByTestId('recovery-restore-report')
    expect(report).toHaveTextContent('Restore committed — session refresh failed')
    expect(report).toHaveTextContent('the restore WAS written to storage')
    expect(report).toHaveTextContent('never re-run automatically')
    expect(screen.getByTestId('recovery-refresh-error')).toHaveTextContent('refresh exploded')
    // Never presented as a rollback.
    expect(screen.getByTestId('recovery-restore-report')).toHaveTextContent(
      'Nothing was rolled back',
    )
    // The committed preview is cleared so the restore cannot double-submit.
    expect(screen.queryByTestId('recovery-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recovery-restore-confirm')).not.toBeInTheDocument()
    expect(restoreCalls).toBe(1)

    // Storage gains a row outside the stale session; the retry button
    // refreshes ONLY the session (hydrate) and never re-runs the restore.
    const db = new SandboxDatabase()
    await db.drugs.put(toRecord(syntheticDrugB()))
    expect(screen.getByTestId('library-record-count')).toHaveTextContent('1 record')
    fireEvent.click(screen.getByTestId('recovery-refresh-retry'))
    await screen.findByText(/2 records/)
    expect(restoreCalls).toBe(1)
  })
})

describe('RecoveryPanel — mutual rejection with ordinary import', () => {
  it('rejects .npsl text in the restore path and .npsb text in the import path', async () => {
    await libraryRepository.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    await useLibraryStore.getState().hydrate()
    const archive = await exportText()

    render(<ImportExportView />)
    activateTab('tab-recovery')

    // Ordinary NPSL document → restore refuses with import guidance.
    fireEvent.change(screen.getByTestId('recovery-restore-file'), {
      target: {
        files: [file(syntheticNpslText([syntheticDrug()]), 'lib.npsl', 'application/json')],
      },
    })
    const rejected = await screen.findByTestId('recovery-rejected')
    expect(rejected).toHaveTextContent('ARCHIVE_NOT_NPSB')
    expect(rejected).toHaveTextContent('not a recovery archive')
    expect(rejected).toHaveTextContent('Import tab')
    expect(screen.getByTestId('library-record-count')).toHaveTextContent('1 record')

    // Recovery archive → ordinary import refuses it (wrong envelope).
    activateTab('tab-import')
    fireEvent.change(screen.getByTestId('npsl-file-input'), {
      target: { files: [file(archive, 'backup.npsb', 'application/json')] },
    })
    await screen.findByTestId('import-errors')
    expect(screen.getByTestId('import-errors')).toHaveTextContent('formatVersion')
    // The preview card may show the rejection, but no confirm control —
    // nothing can be written from an invalid file.
    expect(screen.queryByTestId('confirm-import')).not.toBeInTheDocument()
    expect(screen.getByTestId('library-record-count')).toHaveTextContent('1 record')
  })
})
