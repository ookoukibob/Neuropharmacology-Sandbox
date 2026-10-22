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

vi.mock('@/components/charts/ExperimentalFitResidualChart', () => ({
  ExperimentalFitResidualChart: ({
    residuals,
    testId,
  }: {
    residuals: readonly { sourceRow: number }[]
    testId?: string
  }) => (
    // Model-specific instances keep distinct test ids (see the view).
    <div data-testid={testId === undefined ? 'stub-fit-residual-chart' : 'stub-' + testId}>
      {residuals.length} residual points
    </div>
  ),
}))

vi.mock('@/components/charts/ExperimentalFitResidualVsFittedChart', () => ({
  ExperimentalFitResidualVsFittedChart: ({
    residuals,
    testId,
  }: {
    residuals: readonly { fitted: number }[]
    testId?: string
  }) => (
    <div data-testid={testId ?? 'stub-residual-fitted-chart'}>
      {residuals.length} fitted points
    </div>
  ),
}))

vi.mock('@/components/charts/ExperimentalFitProfileChart', () => ({
  ExperimentalFitProfileChart: ({
    points,
    fittedRate,
  }: {
    points: readonly { ok: boolean }[]
    fittedRate: number
  }) => (
    <div data-testid="stub-fit-profile-chart">
      {points.length} candidate rates · fitted k {fittedRate}
    </div>
  ),
}))

// The profile result is real by default; one test forces the unavailable
// branch, which the current bounds make unreachable through the UI.
const profileOverride = vi.hoisted(() => ({ unavailable: false }))

// The comparison is real by default; one test forces a failed baseline
// candidate so the residual section's unavailable branch is exercised.
const comparisonOverride = vi.hoisted(() => ({ baselineUnavailable: false }))
vi.mock('@/domain/experiments/mono-exponential-model-comparison', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/domain/experiments/mono-exponential-model-comparison')>()
  return {
    ...actual,
    compareMonoExponentialModels: (
      ...args: Parameters<typeof actual.compareMonoExponentialModels>
    ) => {
      const result = actual.compareMonoExponentialModels(...args)
      if (!comparisonOverride.baselineUnavailable || !result.ok) return result
      const [m0] = result.models
      return {
        ...result,
        models: [
          m0,
          {
            ok: false as const,
            modelId: 'M1' as const,
            label: 'M1 · mono-exponential decay with additive baseline',
            formula: 'C(t) = B + A · exp(−k · (t − t_ref))',
            meanParameterCount: 3 as const,
            totalParameterCount: 4,
            message: 'The rate optimizer did not converge to a finite value.',
          },
        ],
        baselineFit: {
          ok: false as const,
          code: 'NON_CONVERGED' as const,
          message: 'The rate optimizer did not converge to a finite value.',
        },
      }
    },
  }
})
vi.mock('@/domain/experiments/mono-exponential-profile', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/domain/experiments/mono-exponential-profile')>()
  return {
    ...actual,
    analyzeMonoExponentialProfile: (
      ...args: Parameters<typeof actual.analyzeMonoExponentialProfile>
    ) =>
      profileOverride.unavailable
        ? {
            ok: false as const,
            code: 'NO_VALID_EVALUATION' as const,
            message: 'No candidate decay rate could be evaluated for this dataset.',
          }
        : actual.analyzeMonoExponentialProfile(...args),
  }
})

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
  profileOverride.unavailable = false
  comparisonOverride.baselineUnavailable = false
})

function renderView(): void {
  render(<ExperimentalDatasetsView repository={repository} />)
}

describe('ExperimentalDatasetsView — user-facing copy', () => {
  it('does not expose internal development phase labels', async () => {
    renderView()

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Experimental Datasets' }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/Phase 47[A-C]/i)
    expect(document.body).not.toHaveTextContent(/measured data \+ fit diagnostics/i)
  })
})

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

describe('one-compartment mono-exponential fit (phase 47B)', () => {
  const decayDataset = (overrides: Partial<ExperimentalDataset> = {}): ExperimentalDataset =>
    storedDataset({
      name: 'Decay study',
      measurements: [
        { id: 'm1', sourceRow: 1, time: 0, concentration: 100 },
        { id: 'm2', sourceRow: 2, time: 1, concentration: 50 },
        { id: 'm3', sourceRow: 3, time: 2, concentration: 25 },
        { id: 'm4', sourceRow: 4, time: 4, concentration: 6.25 },
      ],
      ...overrides,
    })

  /** Select a saved dataset using the shared harness. */
  const select = async (dataset: ExperimentalDataset): Promise<void> => {
    repository.rows.set(dataset.id, dataset)
    renderView()
    const list = await screen.findByRole('list', { name: 'Saved experimental datasets' })
    fireEvent.click(within(list).getByRole('button', { name: new RegExp(dataset.name) }))
    await screen.findByRole('heading', { level: 2, name: dataset.name })
  }

  it('shows the fit action but no results before fitting', async () => {
    await select(decayDataset())
    expect(screen.getByTestId('dataset-fit')).toBeInTheDocument()
    expect(screen.queryByTestId('fit-results')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fit-diagnostics')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fit-profile-diagnostics')).not.toBeInTheDocument()
  })

  it('reports the fitted parameters with the dataset units', async () => {
    await select(decayDataset())
    fireEvent.click(screen.getByTestId('dataset-fit'))
    const results = await screen.findByTestId('fit-results')
    expect(within(results).getByTestId('fit-tref')).toHaveTextContent(/0 h/)
    expect(within(results).getByTestId('fit-cref')).toHaveTextContent(/100 mg\/L/)
    expect(within(results).getByTestId('fit-k')).toHaveTextContent(/h⁻¹/)
    expect(within(results).getByTestId('fit-half-life')).toHaveTextContent(/h/)
    expect(screen.getByTestId('fit-section')).toHaveTextContent(/unweighted least squares/i)
    expect(screen.getByTestId('fit-section')).toHaveTextContent(/not evidence that this decay model suits/i)
    const diagnostics = await screen.findByTestId('fit-diagnostics')
    expect(within(diagnostics).getByTestId('fit-rmse')).toHaveTextContent('mg/L')
    expect(within(diagnostics).getByTestId('fit-residual-df')).toHaveTextContent('2')
    expect(await screen.findByTestId('stub-fit-residual-chart')).toHaveTextContent('4 residual points')
    expect(within(diagnostics).getByTestId('fit-identifiability-screen')).toHaveTextContent(/not a formal .*identifiability test/i)
  })

  it('overlays the fitted curve on the chart without persisting anything', async () => {
    await select(decayDataset())
    fireEvent.click(screen.getByTestId('dataset-fit'))
    await screen.findByTestId('fit-results')
    expect(screen.getByTestId('stub-experimental-chart')).toBeInTheDocument()
    expect(screen.getByText(/fitted mono-exponential curve/i)).toBeInTheDocument()
    // No repository mutation of any kind: a fit is never persisted.
    expect(repository.createCalls).toHaveLength(0)
    expect(repository.updateCalls).toHaveLength(0)
    expect(repository.deleteCalls).toHaveLength(0)
  })

  it('shows the zero-rate boundary warning and no finite half-life', async () => {
    await select(
      storedDataset({
        name: 'Rising study',
        measurements: [
          { id: 'r1', sourceRow: 1, time: 0, concentration: 5 },
          { id: 'r2', sourceRow: 2, time: 1, concentration: 9 },
          { id: 'r3', sourceRow: 3, time: 2, concentration: 20 },
        ],
      }),
    )
    fireEvent.click(screen.getByTestId('dataset-fit'))
    await screen.findByTestId('fit-results')
    expect(screen.getByTestId('fit-warnings')).toHaveTextContent(/no finite half-life/i)
    expect(screen.getByTestId('fit-half-life')).toHaveTextContent(/no finite half-life/i)
  })

  it('presents a structured failure without a fit line', async () => {
    await select(
      storedDataset({
        name: 'Single time',
        measurements: [
          { id: 's1', sourceRow: 1, time: 2, concentration: 10 },
          { id: 's2', sourceRow: 2, time: 2, concentration: 12 },
        ],
      }),
    )
    fireEvent.click(screen.getByTestId('dataset-fit'))
    expect(await screen.findByTestId('fit-error')).toHaveTextContent(/single distinct time/i)
    expect(screen.queryByTestId('fit-results')).not.toBeInTheDocument()
    expect(screen.queryByText(/fitted mono-exponential curve/i)).not.toBeInTheDocument()
  })

  it('invalidates a previous fit when the dataset changes', async () => {
    // Both datasets exist up front so the switch needs no refresh round trip.
    const first = decayDataset()
    const other = storedDataset({ id: 'dataset-2', name: 'Other study' })
    repository.rows.set(first.id, first)
    repository.rows.set(other.id, other)
    renderView()

    const list = await screen.findByRole('list', { name: 'Saved experimental datasets' })
    fireEvent.click(within(list).getByRole('button', { name: /Decay study/ }))
    await screen.findByRole('heading', { level: 2, name: 'Decay study' })
    fireEvent.click(screen.getByTestId('dataset-fit'))
    await screen.findByTestId('fit-results')

    // Select a different dataset: the previous fit must not remain visible.
    fireEvent.click(within(list).getByRole('button', { name: /Other study/ }))
    await screen.findByRole('heading', { level: 2, name: 'Other study' })
    await waitFor(() => expect(screen.queryByTestId('fit-results')).not.toBeInTheDocument())
  })
})

describe('practical identifiability screen (phase 47C)', () => {
  const row = (id: string, sourceRow: number, time: number, concentration: number) => ({
    id,
    sourceRow,
    time,
    concentration,
  })

  // Scatter around a clear decay: the objective has a measurable minimum, so
  // the near-minimum band is a rate interval rather than a single grid point.
  const decaying = (): ExperimentalDataset =>
    storedDataset({
      name: 'Identifiability study',
      measurements: [
        row('m1', 1, 0, 100),
        row('m2', 2, 1, 80),
        row('m3', 3, 2, 75),
        row('m4', 4, 3, 45),
      ],
    })

  const select = async (dataset: ExperimentalDataset): Promise<void> => {
    repository.rows.set(dataset.id, dataset)
    renderView()
    const list = await screen.findByRole('list', { name: 'Saved experimental datasets' })
    fireEvent.click(within(list).getByRole('button', { name: new RegExp(dataset.name) }))
    await screen.findByRole('heading', { level: 2, name: dataset.name })
  }

  it('reports a localized objective with a measured band after a fit', async () => {
    await select(decaying())
    expect(screen.queryByTestId('fit-profile-diagnostics')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-profile-diagnostics')

    expect(card).toHaveTextContent(/residual sum of squares/i)
    expect(card).toHaveTextContent(/not a likelihood/i)
    expect(within(card).getByTestId('fit-profile-localization')).toHaveTextContent(
      /narrow minimum/i,
    )
    expect(within(card).getByTestId('fit-profile-band')).toHaveTextContent('h⁻¹')
    expect(within(card).getByTestId('fit-profile-boundary')).toHaveTextContent(
      /interior to the evaluated range/i,
    )
    // Candidate data reaches the chart component, and the fit itself is shown
    // separately from the diagnostics.
    expect(await within(card).findByTestId('stub-fit-profile-chart')).toHaveTextContent(
      /candidate rates/,
    )
    expect(screen.getByTestId('fit-results')).toBeInTheDocument()
    expect(screen.getByTestId('fit-diagnostics')).toBeInTheDocument()

    // Standing limitations are always stated in plain language.
    const limitations = within(card).getByTestId('fit-profile-limitations')
    expect(limitations).toHaveTextContent(/not a structural or formal practical-identifiability proof/i)
    expect(limitations).toHaveTextContent(/not a confidence interval/i)
    expect(limitations).toHaveTextContent(/alternative models/i)

    // Still a derived view: nothing is written.
    expect(repository.createCalls).toHaveLength(0)
    expect(repository.updateCalls).toHaveLength(0)
    expect(repository.deleteCalls).toHaveLength(0)
  })

  it('reports the zero-rate boundary without inventing a band', async () => {
    await select(
      storedDataset({
        name: 'Rising identifiability study',
        measurements: [row('r1', 1, 0, 5), row('r2', 2, 1, 9), row('r3', 3, 2, 20)],
      }),
    )
    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-profile-diagnostics')
    expect(within(card).getByTestId('fit-profile-localization')).toHaveTextContent(
      /zero-rate boundary/i,
    )
    expect(within(card).getByTestId('fit-profile-boundary')).toHaveTextContent(/k = 0 boundary/i)
    expect(within(card).getByTestId('fit-profile-band')).toHaveTextContent(
      /not defined for this dataset/i,
    )
  })

  it('degrades safely for sparse time coverage', async () => {
    await select(
      storedDataset({
        name: 'Sparse identifiability study',
        measurements: [row('s1', 1, 0, 100), row('s2', 2, 0, 98), row('s3', 3, 1, 50), row('s4', 4, 1, 49)],
      }),
    )
    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-profile-diagnostics')
    expect(within(card).getByTestId('fit-profile-localization')).toHaveTextContent(
      /does not support a shape classification/i,
    )
    expect(within(card).getByTestId('fit-profile-warnings')).toHaveTextContent(
      /2 distinct time points/i,
    )
    // The chart still renders: measurement data is never withheld.
    expect(await within(card).findByTestId('stub-fit-profile-chart')).toBeInTheDocument()
  })

  it('renders an unavailable analysis as a state rather than a number', async () => {
    profileOverride.unavailable = true
    await select(decaying())
    fireEvent.click(screen.getByTestId('dataset-fit'))

    const card = await screen.findByTestId('fit-profile-diagnostics')
    expect(within(card).getByTestId('fit-profile-error')).toHaveTextContent(
      /no candidate decay rate could be evaluated/i,
    )
    expect(within(card).getByTestId('fit-profile-error')).toHaveTextContent(/fit itself is unaffected/i)
    expect(within(card).queryByTestId('fit-profile-localization')).not.toBeInTheDocument()
    expect(within(card).queryByTestId('stub-fit-profile-chart')).not.toBeInTheDocument()
    // The fit result remains visible and usable.
    expect(screen.getByTestId('fit-results')).toBeInTheDocument()
  })
})

describe('model comparison and conditional AICc (phase 47C)', () => {
  const row = (id: string, sourceRow: number, time: number, concentration: number) => ({
    id,
    sourceRow,
    time,
    concentration,
  })

  /**
   * Synthetic decay with a persistent baseline, rounded to two decimals so the
   * residuals are non-zero (AICc is refused for an exact fit).
   */
  const baselineStudy = (): ExperimentalDataset => {
    const times = [0, 0.5, 1, 2, 3, 5, 7, 9]
    return storedDataset({
      name: 'Baseline study',
      measurements: times.map((time, index) =>
        row(`b${String(index + 1)}`, index + 1, time, Math.round((10 + 90 * Math.exp(-0.4 * time)) * 100) / 100),
      ),
    })
  }

  const select = async (dataset: ExperimentalDataset): Promise<void> => {
    repository.rows.set(dataset.id, dataset)
    renderView()
    const list = await screen.findByRole('list', { name: 'Saved experimental datasets' })
    fireEvent.click(within(list).getByRole('button', { name: new RegExp(dataset.name) }))
    await screen.findByRole('heading', { level: 2, name: dataset.name })
  }

  const comparisonCell = (testId: string): string =>
    screen.getByTestId(testId).textContent ?? ''

  it('appears only after a fit and reports both models with their own parameter counts', async () => {
    await select(baselineStudy())
    expect(screen.queryByTestId('fit-model-comparison')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-model-comparison')

    // A named table: the caption is its accessible name.
    const table = within(card).getByRole('table', { name: /Descriptive comparison of M0 and M1/ })
    expect(within(card).getByText(/M0 · mono-exponential decay/)).toBeInTheDocument()
    expect(within(card).getByText(/M1 · mono-exponential decay with additive baseline/)).toBeInTheDocument()

    // Mean-model parameters and the variance-inclusive total are both shown.
    const meanRow = within(table).getByRole('row', { name: /Mean-model parameters/ })
    expect(meanRow).toHaveTextContent(/2/)
    expect(meanRow).toHaveTextContent(/3/)
    const totalRow = within(table).getByRole('row', { name: /Total parameters K/ })
    expect(totalRow).toHaveTextContent(/3/)
    expect(totalRow).toHaveTextContent(/4/)

    // M1 carries a baseline parameter; M0 does not.
    expect(comparisonCell('comparison-m1-baseline')).toMatch(/mg\/L/)
    expect(comparisonCell('comparison-m0-amplitude')).toMatch(/mg\/L/)
    expect(comparisonCell('comparison-m0-sse')).toMatch(/mg\/L/)

    // The baseline model explains this shape better, and the UI says that a
    // lower SSE is not by itself evidence of superiority.
    const sse0 = Number(comparisonCell('comparison-m0-sse').split(' ')[0])
    const sse1 = Number(comparisonCell('comparison-m1-sse').split(' ')[0])
    expect(sse1).toBeLessThan(sse0)
    expect(card).toHaveTextContent(/not evidence that M1 is the better description/i)
  })

  it('keeps AICc unavailable until the error assumption is declared', async () => {
    await select(baselineStudy())
    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-model-comparison')

    const assumption = within(card).getByTestId('comparison-assumption')
    expect(assumption).not.toBeChecked()
    expect(comparisonCell('comparison-m0-aicc')).toBe('unavailable')
    expect(comparisonCell('comparison-m1-aicc')).toBe('unavailable')
    expect(within(card).queryByTestId('comparison-difference')).not.toBeInTheDocument()
    expect(within(card).getByTestId('comparison-aicc-gate')).toHaveTextContent(
      /stays unavailable until this assumption is declared/i,
    )
    expect(within(card).getByTestId('comparison-aicc-reasons')).toHaveTextContent(
      /requires an explicitly declared error model/i,
    )
    expect(card).not.toHaveTextContent(/NaN/)
    expect(within(card).getByTestId('comparison-caveat')).toHaveTextContent(
      /assumption, not evidence/i,
    )
  })

  it('reports both criteria once the assumption is declared', async () => {
    await select(baselineStudy())
    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-model-comparison')

    fireEvent.click(within(card).getByTestId('comparison-assumption'))

    const m0 = Number(comparisonCell('comparison-m0-aicc'))
    const m1 = Number(comparisonCell('comparison-m1-aicc'))
    expect(Number.isFinite(m0)).toBe(true)
    expect(Number.isFinite(m1)).toBe(true)
    expect(comparisonCell('comparison-m0-aicc')).not.toMatch(/NaN|Infinity/)
    expect(comparisonCell('comparison-m1-aicc')).not.toMatch(/NaN|Infinity/)

    const difference = within(card).getByTestId('comparison-difference')
    expect(difference).toHaveTextContent(/no threshold/i)
    expect(difference).toHaveTextContent(/arithmetic/i)
    const differenceValue = Number(
      within(card).getByTestId('comparison-difference-value').textContent,
    )
    expect(Number.isFinite(differenceValue)).toBe(true)
    expect(differenceValue).toBeCloseTo(m1 - m0, 3)

    // Withdrawing the declaration removes the criterion again.
    fireEvent.click(within(card).getByTestId('comparison-assumption'))
    expect(comparisonCell('comparison-m0-aicc')).toBe('unavailable')
  })

  it('reports AICc as unavailable when the sample is too small for M1', async () => {
    // Five rows: M0 (K = 3) leaves one residual degree of freedom for the
    // correction; M1 (K = 4) does not.
    const five = storedDataset({
      name: 'Five point study',
      measurements: [
        row('f1', 1, 0, 100),
        row('f2', 2, 0.5, 83),
        row('f3', 3, 1, 70),
        row('f4', 4, 2, 51),
        row('f5', 5, 3, 39),
      ],
    })
    await select(five)
    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-model-comparison')
    fireEvent.click(within(card).getByTestId('comparison-assumption'))

    expect(comparisonCell('comparison-m0-aicc')).not.toBe('unavailable')
    expect(comparisonCell('comparison-m1-aicc')).toBe('unavailable')
    expect(within(card).getByTestId('comparison-aicc-reasons')).toHaveTextContent(
      /n − K − 1 must be positive/i,
    )
    expect(within(card).queryByTestId('comparison-difference')).not.toBeInTheDocument()
  })

  it('warns about boundary estimates without hiding the comparison', async () => {
    const flat = storedDataset({
      name: 'Flat study',
      measurements: [
        row('c1', 1, 0, 50),
        row('c2', 2, 1, 50),
        row('c3', 3, 2, 50),
        row('c4', 4, 4, 50),
        row('c5', 5, 6, 50),
      ],
    })
    await select(flat)
    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-model-comparison')

    expect(within(card).getByTestId('comparison-warnings')).toHaveTextContent(/zero-rate boundary/i)
    expect(within(card).getByTestId('comparison-boundary-note')).toHaveTextContent(
      /less reliable than the numbers suggest/i,
    )
    // The exact fit has no residual variance, so AICc is refused rather than
    // computed from a substituted epsilon.
    fireEvent.click(within(card).getByTestId('comparison-assumption'))
    expect(comparisonCell('comparison-m0-aicc')).toBe('unavailable')
    expect(within(card).getByTestId('comparison-aicc-reasons')).toHaveTextContent(
      /residual sum of squares is zero/i,
    )
  })

  it('does not write anything to the repository', async () => {
    await select(baselineStudy())
    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('fit-model-comparison')
    fireEvent.click(within(card).getByTestId('comparison-assumption'))
    expect(repository.createCalls).toHaveLength(0)
    expect(repository.updateCalls).toHaveLength(0)
    expect(repository.deleteCalls).toHaveLength(0)
  })
})

describe('residual structure diagnostics (phase 47C)', () => {
  const row = (id: string, sourceRow: number, time: number, concentration: number) => ({
    id,
    sourceRow,
    time,
    concentration,
  })

  /** Decay with scatter that grows with the fitted level. */
  const proportionalStudy = (): ExperimentalDataset => {
    const times = [0, 0.5, 1, 2, 3, 5, 7, 9]
    const signs = [1, -1, 1, -1, 1, -1, 1, -1]
    return storedDataset({
      name: 'Proportional scatter study',
      measurements: times.map((time, index) =>
        row(
          `p${String(index + 1)}`,
          index + 1,
          time,
          Math.round(100 * Math.exp(-0.4 * time) * (1 + 0.1 * (signs[index] ?? 1)) * 100) / 100,
        ),
      ),
    })
  }

  const select = async (dataset: ExperimentalDataset): Promise<void> => {
    repository.rows.set(dataset.id, dataset)
    renderView()
    const list = await screen.findByRole('list', { name: 'Saved experimental datasets' })
    fireEvent.click(within(list).getByRole('button', { name: new RegExp(dataset.name) }))
    await screen.findByRole('heading', { level: 2, name: dataset.name })
  }

  it('is absent before a fit and shows both models afterwards', async () => {
    await select(proportionalStudy())
    expect(screen.queryByTestId('residual-structure')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('dataset-fit'))
    const card = await screen.findByTestId('residual-structure')

    // One block per candidate, each with both views.
    const m0 = within(card).getByTestId('residual-structure-m0')
    const m1 = within(card).getByTestId('residual-structure-m1')
    expect(within(m0).getByText(/^Decay model$/)).toBeInTheDocument()
    expect(within(m1).getByText(/^Decay with additive baseline$/)).toBeInTheDocument()
    expect(within(m0).getByTestId('stub-fit-residual-chart')).toHaveTextContent('8 residual points')
    expect(within(m1).getByTestId('stub-fit-residual-chart-m1')).toHaveTextContent('8 residual points')
    expect(within(m0).getByTestId('residual-fitted-chart-m0')).toHaveTextContent('8 fitted points')
    expect(within(m1).getByTestId('residual-fitted-chart-m1')).toHaveTextContent('8 fitted points')

    // Named sections: each block is labelled by its own heading.
    expect(within(card).getAllByRole('region', { name: /decay/i }).length).toBeGreaterThanOrEqual(2)
  })

  it('reports the spread screen with units and a visible pattern', async () => {
    await select(proportionalStudy())
    fireEvent.click(screen.getByTestId('dataset-fit'))
    await screen.findByTestId('residual-structure')

    expect(screen.getByTestId('residual-spread-status-m0')).toHaveTextContent(
      /visible spread pattern/i,
    )
    const block = screen.getByTestId('residual-spread-m0')
    expect(block).toHaveTextContent('mg/L')
    expect(block).toHaveTextContent(/lower fitted half/)
    expect(block).toHaveTextContent(/upper fitted half/)
    expect(block).toHaveTextContent(/not a heteroscedasticity test/i)
    const ratio = Number(screen.getByTestId('residual-spread-ratio-m0').textContent)
    expect(Number.isFinite(ratio)).toBe(true)
    expect(ratio).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('residual-spread-message-m0')).toHaveTextContent(
      /not a test result/i,
    )

    // The criterion's interpretation is caveated, never rewritten.
    const caveat = screen.getByTestId('comparison-spread-caveat')
    expect(caveat).toHaveTextContent(/visible pattern/i)
    expect(caveat).toHaveTextContent(/unchanged/i)
    expect(caveat).toHaveTextContent(/no different assumption has been substituted/i)
  })

  it('reports the screen as unavailable for a small sample without hiding the residuals', async () => {
    await select(
      storedDataset({
        name: 'Small residual study',
        measurements: [
          row('s1', 1, 0, 100),
          row('s2', 2, 0.5, 83),
          row('s3', 3, 1, 70),
          row('s4', 4, 2, 51),
          row('s5', 5, 3, 39),
        ],
      }),
    )
    fireEvent.click(screen.getByTestId('dataset-fit'))
    await screen.findByTestId('residual-structure')

    expect(screen.getByTestId('residual-spread-status-m0')).toHaveTextContent(/unavailable/i)
    expect(screen.getByTestId('residual-spread-message-m0')).toHaveTextContent(
      /at least 6 observations/i,
    )
    // The residual plots are still available: only the screen is withheld.
    expect(screen.getByTestId('stub-fit-residual-chart')).toHaveTextContent('5 residual points')
    // Without a visible pattern there is no spread caveat on the comparison.
    expect(screen.queryByTestId('comparison-spread-caveat')).not.toBeInTheDocument()
  })

  it('discloses duplicate timestamps and keeps every row separate', async () => {
    await select(
      storedDataset({
        name: 'Duplicate time study',
        measurements: [
          row('d1', 1, 0, 100),
          row('d2', 2, 0, 98),
          row('d3', 3, 1, 62),
          row('d4', 4, 1, 60),
          row('d5', 5, 2, 40),
          row('d6', 6, 2, 39),
        ],
      }),
    )
    fireEvent.click(screen.getByTestId('dataset-fit'))
    await screen.findByTestId('residual-structure')

    const ordering = screen.getByTestId('residual-ordering-m0')
    expect(ordering).toHaveTextContent(/sharing a timestamp/i)
    expect(ordering).toHaveTextContent(/6/)
    expect(screen.getByTestId('stub-fit-residual-chart')).toHaveTextContent('6 residual points')
    expect(screen.getByTestId('residual-fitted-chart-m0')).toHaveTextContent('6 fitted points')
  })

  it('renders the baseline model as unavailable when its fit failed', async () => {
    comparisonOverride.baselineUnavailable = true
    await select(proportionalStudy())
    fireEvent.click(screen.getByTestId('dataset-fit'))
    await screen.findByTestId('residual-structure')

    expect(screen.getByTestId('residual-structure-m1-unavailable')).toHaveTextContent(
      /unavailable for this model/i,
    )
    expect(screen.queryByTestId('stub-fit-residual-chart-m1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('residual-fitted-chart-m1')).not.toBeInTheDocument()
    // The decay model's diagnostics are unaffected.
    expect(screen.getByTestId('stub-fit-residual-chart')).toHaveTextContent('8 residual points')
  })

  it('never writes to the repository', async () => {
    await select(proportionalStudy())
    fireEvent.click(screen.getByTestId('dataset-fit'))
    await screen.findByTestId('residual-structure')
    expect(repository.createCalls).toHaveLength(0)
    expect(repository.updateCalls).toHaveLength(0)
    expect(repository.deleteCalls).toHaveLength(0)
  })
})
