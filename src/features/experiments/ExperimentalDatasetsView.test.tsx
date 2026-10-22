import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ExperimentalDataset,
  ExperimentalDatasetInput,
} from '@/domain/experiments/experimental-dataset'
import { toDatasetSummary } from '@/domain/experiments/experimental-dataset'
import type {
  CorruptExperimentalDataset,
  ExperimentalDatasetChanges,
  ExperimentalDatasetDeleteOutcome,
  ExperimentalDatasetListResult,
  ExperimentalDatasetOutcome,
  ExperimentalDatasetRepository,
} from '@/data/repositories/experimentalDatasetRepository'
import { buildNpexFile } from '@/data/npex/npex'
import { ExperimentalDatasetsView } from './ExperimentalDatasetsView'

vi.mock('@/components/charts/ExperimentalDatasetChart', () => ({
  ExperimentalDatasetChart: ({ dataset }: { dataset: ExperimentalDataset }) => (
    <div data-testid="stub-experimental-chart">{dataset.name}</div>
  ),
}))

const BASE_TIME = Date.parse('2026-03-01T00:00:00.000Z')

function storedDataset(overrides: Partial<ExperimentalDataset> = {}): ExperimentalDataset {
  return {
    id: 'dataset-1',
    name: 'Saved study',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    timeUnit: 'h',
    concentrationUnit: 'mg/L',
    notes: 'Preserved notes',
    provenance: {
      source: 'csv',
      fileName: 'saved.csv',
      importedAt: '2026-02-01T00:00:00.000Z',
    },
    measurements: [
      { id: 'measurement-1', sourceRow: 1, time: 0, concentration: 0, sampleId: 'A' },
      { id: 'measurement-2', sourceRow: 2, time: 0, concentration: 0, sampleId: 'A' },
      { id: 'measurement-3', sourceRow: 3, time: 2, concentration: 1.5, sampleId: 'B' },
    ],
    ...overrides,
  }
}

class FakeExperimentalDatasetRepository implements ExperimentalDatasetRepository {
  readonly rows = new Map<string, ExperimentalDataset>()
  corrupt: readonly CorruptExperimentalDataset[] = []
  createCalls: ExperimentalDatasetInput[] = []
  updateCalls: { id: string; changes: ExperimentalDatasetChanges; expectedUpdatedAt: string }[] = []
  deleteCalls: { id: string; expectedUpdatedAt: string }[] = []
  private counter = 0

  private stamp(): string {
    const value = new Date(BASE_TIME + this.counter * 1000).toISOString()
    this.counter += 1
    return value
  }

  async list(): Promise<ExperimentalDatasetListResult> {
    const datasets = [...this.rows.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toDatasetSummary)
    return { datasets, corrupt: this.corrupt }
  }

  async get(id: string): Promise<ExperimentalDatasetOutcome> {
    const row = this.rows.get(id)
    if (row === undefined) return { ok: false, code: 'NOT_FOUND', message: 'not found' }
    return { ok: true, dataset: structuredClone(row) }
  }

  async create(input: ExperimentalDatasetInput): Promise<ExperimentalDatasetOutcome> {
    this.createCalls.push(structuredClone(input))
    const stamp = this.stamp()
    this.counter += input.measurements.length
    const dataset: ExperimentalDataset = {
      ...structuredClone(input),
      id: `dataset-${String(this.rows.size + 1)}`,
      createdAt: stamp,
      updatedAt: stamp,
      measurements: input.measurements.map((measurement, index) => ({
        ...measurement,
        id: `measurement-new-${String(index + 1)}`,
      })),
    }
    this.rows.set(dataset.id, dataset)
    return { ok: true, dataset: structuredClone(dataset) }
  }

  async update(
    id: string,
    changes: ExperimentalDatasetChanges,
    expectedUpdatedAt: string,
  ): Promise<ExperimentalDatasetOutcome> {
    this.updateCalls.push({ id, changes, expectedUpdatedAt })
    const current = this.rows.get(id)
    if (current === undefined) return { ok: false, code: 'NOT_FOUND', message: 'not found' }
    if (current.updatedAt !== expectedUpdatedAt) {
      return { ok: false, code: 'CONFLICT', message: 'changed elsewhere' }
    }
    const nextNotes = Object.prototype.hasOwnProperty.call(changes, 'notes')
      ? changes.notes
      : current.notes
    const next: ExperimentalDataset = {
      id: current.id,
      name: changes.name ?? current.name,
      createdAt: current.createdAt,
      updatedAt: this.stamp(),
      timeUnit: current.timeUnit,
      concentrationUnit: current.concentrationUnit,
      measurements: current.measurements,
      provenance: current.provenance,
      ...(nextNotes === undefined ? {} : { notes: nextNotes }),
    }
    this.rows.set(id, next)
    return { ok: true, dataset: structuredClone(next) }
  }

  async delete(id: string, expectedUpdatedAt: string): Promise<ExperimentalDatasetDeleteOutcome> {
    this.deleteCalls.push({ id, expectedUpdatedAt })
    const current = this.rows.get(id)
    if (current === undefined) return { ok: false, code: 'NOT_FOUND', message: 'not found' }
    if (current.updatedAt !== expectedUpdatedAt) {
      return { ok: false, code: 'CONFLICT', message: 'changed elsewhere' }
    }
    this.rows.delete(id)
    return { ok: true }
  }
}

function file(content: string, name: string, type = 'text/csv'): File {
  return new File([content], name, { type })
}

function upload(testId: string, selected: File): void {
  fireEvent.change(screen.getByTestId(testId), { target: { files: [selected] } })
}

function choose(id: string, value: string): void {
  fireEvent.change(screen.getByTestId(id), { target: { value } })
}

let repository: FakeExperimentalDatasetRepository

beforeEach(() => {
  repository = new FakeExperimentalDatasetRepository()
})

function renderView(): void {
  render(<ExperimentalDatasetsView repository={repository} />)
}

describe('ExperimentalDatasetsView — CSV import and management', () => {
  it('previews CSV values, imports all rows, renders the ordered table and supports rename/delete', async () => {
    renderView()
    await screen.findByTestId('datasets-empty')

    upload(
      'csv-dataset-file',
      file('time,conc\n0,0\n0,0\n2,1.5\n', 'study.csv'),
    )
    await screen.findByTestId('csv-dataset-mapping')
    expect(screen.getByTestId('csv-dataset-time-column')).toHaveValue('')
    expect(screen.getByTestId('csv-dataset-concentration-unit')).toHaveValue('')

    choose('csv-dataset-time-column', '0')
    choose('csv-dataset-concentration-column', '1')
    choose('csv-dataset-time-unit', 'h')
    choose('csv-dataset-concentration-unit', 'mg/L')
    fireEvent.click(screen.getByTestId('csv-dataset-preview'))

    const counts = await screen.findByTestId('csv-dataset-preview-counts')
    expect(counts).toHaveTextContent('3 source rows')
    expect(counts).toHaveTextContent('3 valid')
    expect(counts).toHaveTextContent('0 invalid')
    expect(screen.getByTestId('csv-dataset-preview-result')).toHaveTextContent('Time unit h')
    expect(screen.getByTestId('csv-dataset-preview-result')).toHaveTextContent(
      'concentration unit mg/L',
    )

    fireEvent.click(screen.getByTestId('csv-dataset-confirm'))
    await waitFor(() => expect(repository.rows.size).toBe(1))
    expect(repository.createCalls).toHaveLength(1)
    expect(repository.createCalls[0]?.measurements).toEqual([
      { sourceRow: 1, time: 0, concentration: 0 },
      { sourceRow: 2, time: 0, concentration: 0 },
      { sourceRow: 3, time: 2, concentration: 1.5 },
    ])
    expect(repository.createCalls[0]?.provenance).toMatchObject({
      source: 'csv',
      fileName: 'study.csv',
    })
    expect(repository.createCalls[0]?.timeUnit).toBe('h')
    expect(repository.createCalls[0]?.concentrationUnit).toBe('mg/L')

    const rows = await screen.findAllByTestId('dataset-measurement-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('1')
    expect(rows[1]).toHaveTextContent('0')
    expect(rows[2]).toHaveTextContent('1.5')
    expect(await screen.findByTestId('stub-experimental-chart')).toHaveTextContent('study')

    // Renaming uses the token of the currently loaded record.
    const detailHeading = screen.getByRole('heading', { level: 2, name: 'study' })
    expect(detailHeading).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dataset-rename'))
    fireEvent.change(screen.getByTestId('dataset-rename-name'), {
      target: { value: 'Renamed study' },
    })
    fireEvent.click(screen.getByTestId('dataset-rename-save'))
    await screen.findByRole('heading', { level: 2, name: 'Renamed study' })
    expect(repository.updateCalls).toHaveLength(1)
    expect(repository.updateCalls[0]?.changes).toEqual({ name: 'Renamed study' })

    fireEvent.click(screen.getByTestId('dataset-delete'))
    const confirm = await screen.findByTestId('dataset-delete-confirm')
    expect(confirm).toBeDisabled()
    fireEvent.click(screen.getByTestId('dataset-delete-ack'))
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await screen.findByTestId('datasets-empty')
    expect(repository.rows.size).toBe(0)
    expect(repository.deleteCalls).toHaveLength(1)
  })

  it('reports qualifier rows precisely and offers no way to import', async () => {
    renderView()
    upload('csv-dataset-file', file('time,conc\n0,1\n0,BLQ\n2,3\n', 'bad.csv'))
    await screen.findByTestId('csv-dataset-mapping')
    choose('csv-dataset-time-column', '0')
    choose('csv-dataset-concentration-column', '1')
    choose('csv-dataset-time-unit', 'h')
    choose('csv-dataset-concentration-unit', 'mg/L')
    fireEvent.click(screen.getByTestId('csv-dataset-preview'))

    const issues = await screen.findByTestId('csv-dataset-issues')
    expect(issues).toHaveTextContent('data row 2')
    expect(issues).toHaveTextContent('BLQ')
    expect(screen.getByTestId('csv-dataset-preview-counts')).toHaveTextContent('2 valid')
    expect(screen.getByTestId('csv-dataset-preview-counts')).toHaveTextContent('1 invalid')
    expect(screen.queryByTestId('csv-dataset-confirm')).not.toBeInTheDocument()
    expect(repository.createCalls).toHaveLength(0)

    // Editing the mapping invalidates the previous preview: stale values can
    // never be confirmed.
    choose('csv-dataset-time-unit', 'min')
    expect(screen.queryByTestId('csv-dataset-preview-result')).not.toBeInTheDocument()
  })
})

describe('ExperimentalDatasetsView — .npex import', () => {
  it('previews a versioned .npex file and imports it only after confirmation', async () => {
    const source = storedDataset()
    const built = buildNpexFile(source, '2026-03-02T00:00:00.000Z')
    if (!built.ok) throw new Error('setup')
    renderView()

    upload('npex-dataset-file', file(built.text, 'saved.npex', 'application/json'))
    const preview = await screen.findByTestId('npex-dataset-preview')
    expect(preview).toHaveTextContent('Saved study')
    expect(preview).toHaveTextContent('Time unit h')
    expect(preview).toHaveTextContent('concentration unit mg/L')
    expect(preview).toHaveTextContent('Original import time')
    expect(screen.getByTestId('npex-dataset-preview-summary')).toHaveTextContent('3 measurements')
    expect(repository.createCalls).toHaveLength(0)

    fireEvent.click(screen.getByTestId('npex-dataset-confirm'))
    await waitFor(() => expect(repository.rows.size).toBe(1))
    expect(repository.createCalls[0]).toMatchObject({
      name: 'Saved study',
      timeUnit: 'h',
      concentrationUnit: 'mg/L',
      provenance: {
        source: 'csv',
        fileName: 'saved.csv',
        importedAt: '2026-02-01T00:00:00.000Z',
      },
    })
    expect(repository.createCalls[0]?.measurements.map((entry) => entry.sourceRow)).toEqual([
      1, 2, 3,
    ])
  })

  it('rejects an unsupported .npex version before any write', async () => {
    const built = buildNpexFile(storedDataset(), '2026-03-02T00:00:00.000Z')
    if (!built.ok) throw new Error('setup')
    const doc = JSON.parse(built.text) as Record<string, unknown>
    doc['formatVersion'] = '1.1.0'
    renderView()
    upload('npex-dataset-file', file(JSON.stringify(doc), 'newer.npex', 'application/json'))

    const issues = await screen.findByTestId('npex-dataset-issues')
    expect(issues).toHaveTextContent('newer than supported')
    expect(screen.queryByTestId('npex-dataset-confirm')).not.toBeInTheDocument()
    expect(repository.createCalls).toHaveLength(0)
  })
})

describe('ExperimentalDatasetsView — saved list', () => {
  it('reports corrupt rows separately and never offers them for editing', async () => {
    repository.corrupt = [{ id: 'broken-row', message: 'measurements.0.time: must be zero or greater' }]
    renderView()
    const corrupt = await screen.findByTestId('datasets-corrupt')
    expect(corrupt).toHaveTextContent('broken-row')
    expect(corrupt).toHaveTextContent('must be zero or greater')
    expect(screen.queryByRole('button', { name: /broken-row/ })).not.toBeInTheDocument()
  })

  it('selects a saved dataset and shows all measurements and metadata', async () => {
    const saved = storedDataset()
    repository.rows.set(saved.id, saved)
    renderView()
    const list = await screen.findByRole('list', { name: 'Saved experimental datasets' })
    fireEvent.click(within(list).getByRole('button', { name: /Saved study/ }))

    await screen.findByRole('heading', { level: 2, name: 'Saved study' })
    expect(screen.getByText('Preserved notes')).toBeInTheDocument()
    expect(screen.getByText(/saved\.csv/)).toBeInTheDocument()
    const rows = screen.getAllByTestId('dataset-measurement-row')
    expect(rows).toHaveLength(3)
    // Source order and duplicate zero-time points are visible, not merged.
    expect(rows[0]).toHaveTextContent('A')
    expect(rows[1]).toHaveTextContent('A')
    expect(rows[2]).toHaveTextContent('B')
    expect(await screen.findByTestId('stub-experimental-chart')).toBeInTheDocument()
  })
})
