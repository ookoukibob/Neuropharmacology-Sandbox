import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationView } from './SimulationView'
import { FakeScenarioRepository } from './tests/fakeScenarioRepository'
import type { SimulationDraft } from './draft'

/**
 * Saved-scenario workflow (phase 45): save/save-as/load/rename/duplicate/
 * delete, the unsaved-changes guard, stale results, and the hard rule that
 * data-management actions never invoke the simulation engine.
 */

// These tests render the real SimulationView (the real engine runs on demand)
// and are slow under full-suite parallelism; give them an explicit budget
// instead of relying on the 5 s default, which unrelated suites already stretch.
vi.setConfig({ testTimeout: 30000 })

vi.mock('@/components/charts/SimulationChart', () => ({
  SimulationChart: ({ chart }: { chart: { id: string } }) => <div data-testid={`stub-chart-${chart.id}`} />,
}))

// Spy on the REAL simulation entry point at the orchestration boundary.
const control = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/engine/simulation/simulate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/simulation/simulate')>()
  return {
    ...actual,
    simulate: (scenario: Parameters<typeof actual.simulate>[0]) => {
      control.calls += 1
      return actual.simulate(scenario)
    },
  }
})

let repository: FakeScenarioRepository

beforeEach(() => {
  control.calls = 0
  repository = new FakeScenarioRepository()
})

const renderView = () => render(<SimulationView scenarioRepository={repository} />)
const runButton = () => screen.getByTestId('run-simulation')

const nameInput = () => screen.getByTestId('scenario-name-input')

const draftWith = (patch: Partial<SimulationDraft>): SimulationDraft => ({
  ...JSON.parse(JSON.stringify(baseDraft())),
  ...patch,
})

/** Fully populated deterministic test draft for saved-record fixtures. */
function baseDraft(): SimulationDraft {
  return {
    startTime: '0',
    endTime: '24',
    outputInterval: '0.25',
    centralVolume: { value: '10', unit: 'L' },
    peripheralVolume: { value: '20', unit: 'L' },
    clearance: { value: '2', unit: 'L/h' },
    intercompartmentalClearance: { value: '3', unit: 'L/h' },
    initialCentralAmount: '0',
    initialPeripheralAmount: '0',
    events: [
      { kind: 'bolus', key: 1, time: '0', amount: { value: '100', unit: 'mg' } },
      { kind: 'bolus', key: 2, time: '8', amount: { value: '30', unit: 'mg' } },
      { kind: 'infusion', key: 3, startTime: '2', stopTime: '6', rate: { value: '10', unit: 'mg/h' } },
    ],
    solver: {
      absoluteTolerance: '1e-10',
      relativeTolerance: '1e-10',
      initialStep: '0.01',
      minStep: '1e-12',
      maxStep: '0.25',
      maxSteps: '200000',
    },
  }
}

describe('saved scenarios — save', () => {
  it('saves the current draft under a name and lists it', async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(screen.getByTestId('scenarios-empty')).toBeInTheDocument())

    await user.type(nameInput(), '  Kidney example  ')
    await user.click(screen.getByTestId('scenario-save'))

    const list = await screen.findByTestId('scenario-list')
    expect(within(list).getByText('Kidney example')).toBeInTheDocument()
    expect(repository.size).toBe(1)
    // The stored draft is the editor's draft, not a compiled scenario.
    const stored = [...Array.from({ length: repository.size })].length
    expect(stored).toBe(1)
    expect(screen.getByTestId('scenario-feedback')).toHaveTextContent(/Saved as “Kidney example”/)
    expect(control.calls).toBe(0)
  })

  it('rejects an empty name with field-level feedback and saves nothing', async () => {
    const user = userEvent.setup()
    renderView()
    await user.type(nameInput(), '   ')
    await user.click(screen.getByTestId('scenario-save'))

    // The field-level message is associated with the input (the page also has
    // an informational alert, so match by the input's aria-describedby).
    await waitFor(() => expect(nameInput()).toHaveAttribute('aria-invalid', 'true'))
    const describedBy = nameInput().getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent ?? '').toMatch(/name is required/i)
    expect(repository.size).toBe(0)
    expect(control.calls).toBe(0)
  })

  it('allows duplicate names as separate records', async () => {
    const user = userEvent.setup()
    renderView()
    await user.type(nameInput(), 'Twin')
    await user.click(screen.getByTestId('scenario-save'))
    await screen.findByTestId('scenario-list')
    await user.type(nameInput(), 'Twin')
    await user.click(screen.getByTestId('scenario-save'))

    await waitFor(() => expect(repository.size).toBe(2))
    expect(screen.getAllByText('Twin')).toHaveLength(2)
    expect(control.calls).toBe(0)
  })

  it('preserves an incomplete draft faithfully (blank fields are stored as blank)', async () => {
    const user = userEvent.setup()
    renderView()
    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(nameInput(), 'Incomplete')
    await user.click(screen.getByTestId('scenario-save'))

    await screen.findByTestId('scenario-list')
    const id = [...new Set(screen.getAllByTestId(/^scenario-row-/).map((row) => row.getAttribute('data-testid')))]
    expect(id.length).toBeGreaterThan(0)
    const stored = [...Array.from({ length: 1 })].map(() => repository.getRecord(id[0]!.replace('scenario-row-', '')))
    expect(stored[0]?.draft.clearance.value).toBe('')
    expect(control.calls).toBe(0)
  })

  it('does not save when the repository fails, and reports the failure honestly', async () => {
    const user = userEvent.setup()
    renderView()
    repository.failNext = 'storage'
    await user.type(nameInput(), 'Will fail')
    await user.click(screen.getByTestId('scenario-save'))

    expect(await screen.findByTestId('scenario-feedback')).toHaveTextContent(/could not be saved/i)
    expect(screen.getByTestId('scenario-feedback')).toHaveAttribute('role', 'alert')
    expect(repository.size).toBe(0)
    expect(screen.queryByTestId('scenario-list')).not.toBeInTheDocument()
  })
})

describe('saved scenarios — load and the unsaved guard', () => {
  it('loads a saved draft into the editor and marks it loaded', async () => {
    const user = userEvent.setup()
    repository.seed('Saved A', draftWith({ clearance: { value: '5', unit: 'L/h' } }))
    renderView()
    const row = await screen.findByTestId('scenario-row-saved-1')
    await user.click(within(row).getByTestId('load-saved-1'))

    await waitFor(() => expect(screen.getByTestId('clearance-value')).toHaveValue('5'))
    expect(screen.getByTestId('scenario-feedback')).toHaveTextContent(/Loaded “Saved A”/)
    // Data management never simulates.
    expect(control.calls).toBe(0)
  })

  it('refuses to replace unsaved edits until confirmed, and keeps them on cancel', async () => {
    const user = userEvent.setup()
    repository.seed('Saved B', draftWith({ clearance: { value: '7', unit: 'L/h' } }))
    renderView()
    // Edit the draft so it is dirty relative to the (unsaved) baseline.
    await user.type(nameInput(), 'Dirty draft')
    await user.click(screen.getByTestId('scenario-save'))
    await screen.findByTestId('scenario-list')
    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(screen.getByTestId('clearance-value'), '9')

    const row = screen.getByTestId('scenario-row-saved-1')
    await user.click(within(row).getByTestId('load-saved-1'))
    const confirm = await screen.findByTestId('scenario-load-confirm')
    expect(confirm).toHaveTextContent(/unsaved changes/i)

    await user.click(screen.getByTestId('scenario-load-confirm-cancel'))
    expect(screen.queryByTestId('scenario-load-confirm')).not.toBeInTheDocument()
    // The edit survives the cancelled load.
    expect(screen.getByTestId('clearance-value')).toHaveValue('9')
    expect(control.calls).toBe(0)

    // Confirming replaces the draft with the saved one.
    await user.click(within(screen.getByTestId('scenario-row-saved-1')).getByTestId('load-saved-1'))
    await user.click(await screen.findByTestId('scenario-load-confirm-accept'))
    await waitFor(() => expect(screen.getByTestId('clearance-value')).toHaveValue('7'))
    expect(control.calls).toBe(0)
  })

  it('guards a never-saved draft once it has been edited (fresh session)', async () => {
    const user = userEvent.setup()
    repository.seed('Saved D', draftWith({ clearance: { value: '4', unit: 'L/h' } }))
    renderView()
    await screen.findByTestId('scenario-row-saved-1')
    // No save, no load: the editor seeded the example, then the user edited it.
    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(screen.getByTestId('clearance-value'), '1')

    await user.click(within(screen.getByTestId('scenario-row-saved-1')).getByTestId('load-saved-1'))
    expect(await screen.findByTestId('scenario-load-confirm')).toBeInTheDocument()
    await user.click(screen.getByTestId('scenario-load-confirm-cancel'))
    expect(screen.getByTestId('clearance-value')).toHaveValue('1')
    expect(control.calls).toBe(0)
  })

  it('cancels the guard with Escape', async () => {
    const user = userEvent.setup()
    repository.seed('Saved C', draftWith({ clearance: { value: '4', unit: 'L/h' } }))
    renderView()
    await user.type(nameInput(), 'Mine')
    await user.click(screen.getByTestId('scenario-save'))
    await screen.findByTestId('scenario-list')
    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(screen.getByTestId('clearance-value'), '3')

    await user.click(within(screen.getByTestId('scenario-row-saved-1')).getByTestId('load-saved-1'))
    await screen.findByTestId('scenario-load-confirm')
    // Focus sits on a real control inside the confirmation (keyboard users
    // reach it by Tab); Escape cancels from there.
    screen.getByTestId('scenario-load-confirm-cancel').focus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('scenario-load-confirm')).not.toBeInTheDocument())
    expect(screen.getByTestId('clearance-value')).toHaveValue('3')
  })
})

describe('saved scenarios — rename, duplicate, delete, save over', () => {
  it('renames only the target record', async () => {
    const user = userEvent.setup()
    repository.seed('First', baseDraft())
    repository.seed('Second', baseDraft())
    renderView()
    const row = await screen.findByTestId('scenario-row-saved-1')
    await user.click(within(row).getByTestId('rename-saved-1'))
    const input = within(row).getByTestId('rename-input-saved-1')
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.click(within(row).getByTestId('rename-save-saved-1'))

    await waitFor(() => expect(screen.getByText('Renamed')).toBeInTheDocument())
    expect(repository.getRecord('saved-1')?.name).toBe('Renamed')
    expect(repository.getRecord('saved-2')?.name).toBe('Second')
    expect(repository.size).toBe(2)
    expect(control.calls).toBe(0)
  })

  it('duplicates into an independent record', async () => {
    const user = userEvent.setup()
    repository.seed('Original', draftWith({ clearance: { value: '6', unit: 'L/h' } }))
    renderView()
    const row = await screen.findByTestId('scenario-row-saved-1')
    await user.click(within(row).getByTestId('duplicate-saved-1'))

    await waitFor(() => expect(repository.size).toBe(2))
    expect(repository.getRecord('saved-2')?.name).toBe('Original (copy)')
    expect(repository.getRecord('saved-2')?.draft.clearance.value).toBe('6')
    expect(await screen.findByTestId('scenario-row-saved-2')).toBeInTheDocument()
    expect(control.calls).toBe(0)
  })

  it('requires acknowledgement before deleting, and cancelling keeps the record', async () => {
    const user = userEvent.setup()
    repository.seed('Doomed', baseDraft())
    renderView()
    const row = await screen.findByTestId('scenario-row-saved-1')
    await user.click(within(row).getByTestId('delete-saved-1'))
    const panel = await within(row).findByTestId('delete-confirm-panel-saved-1')
    expect(panel).toHaveTextContent(/Delete the saved scenario “Doomed”/)
    expect(panel).toHaveTextContent(/the draft currently in the editor is not affected/i)
    expect(repository.size).toBe(1)

    await user.click(within(row).getByTestId('delete-cancel-saved-1'))
    expect(screen.queryByTestId('delete-confirm-panel-saved-1')).not.toBeInTheDocument()
    expect(repository.size).toBe(1)

    await user.click(within(screen.getByTestId('scenario-row-saved-1')).getByTestId('delete-saved-1'))
    await user.click(await screen.findByTestId('delete-confirm-saved-1'))
    await waitFor(() => expect(repository.size).toBe(0))
    expect(await screen.findByTestId('scenarios-empty')).toBeInTheDocument()
    expect(control.calls).toBe(0)
  })

  it('save as with a duplicate name adopts the newly created record, not a same-name one', async () => {
    const user = userEvent.setup()

    // Two same-name records already exist and are pushed to a LATER
    // timestamp than the record Save As creates, so a newest-first name
    // lookup would resolve to one of them instead of the created record.
    repository.seed('Twin', draftWith({ clearance: { value: '1', unit: 'L/h' } }))
    repository.seed('Twin', draftWith({ clearance: { value: '2', unit: 'L/h' } }))
    repository.touch('saved-1', new Date(Date.UTC(2030, 0, 1)).toISOString())

    renderView()
    await screen.findByTestId('scenario-row-saved-1')
    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(screen.getByTestId('clearance-value'), '7')
    await user.type(nameInput(), 'Twin')
    await user.click(screen.getByTestId('scenario-save'))
    await waitFor(() => expect(repository.size).toBe(3))
    expect(repository.getRecord('saved-3')?.draft.clearance.value).toBe('7')

    // Save over must target the record Save As created (saved-3).
    await waitFor(() => expect(screen.getByTestId('scenario-save-over')).toBeEnabled())

    // Edit and save over: ONLY the record Save As created (saved-3) changes;
    // both same-name twins keep their own drafts.
    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(screen.getByTestId('clearance-value'), '8')
    await user.click(screen.getByTestId('scenario-save-over'))
    await waitFor(() => expect(repository.getRecord('saved-3')?.draft.clearance.value).toBe('8'))
    expect(repository.getRecord('saved-1')?.draft.clearance.value).toBe('1')
    expect(repository.getRecord('saved-2')?.draft.clearance.value).toBe('2')
    expect(repository.size).toBe(3)
    expect(control.calls).toBe(0)
  })
  it('saves over the loaded record by id without creating a new record', async () => {
    const user = userEvent.setup()
    repository.seed('Over me', baseDraft())
    renderView()
    const row = await screen.findByTestId('scenario-row-saved-1')
    await user.click(within(row).getByTestId('load-saved-1'))
    await waitFor(() => expect(screen.getByTestId('scenario-save-over')).toBeEnabled())

    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(screen.getByTestId('clearance-value'), '8')
    await user.click(screen.getByTestId('scenario-save-over'))

    await waitFor(() => expect(repository.getRecord('saved-1')?.draft.clearance.value).toBe('8'))
    expect(repository.size).toBe(1)
    expect(control.calls).toBe(0)
  })
})

describe('saved scenarios — results and failures', () => {
  it('loading a different scenario clears a previous result (never shown as current)', async () => {
    const user = userEvent.setup()
    repository.seed('Current', draftWith({ clearance: { value: '3', unit: 'L/h' } }))
    repository.seed('Other', draftWith({ clearance: { value: '4', unit: 'L/h' } }))
    renderView()

    // Load the first saved record while the initial blank draft is still clean.
    await user.click(within(await screen.findByTestId('scenario-row-saved-1')).getByTestId('load-saved-1'))
    await waitFor(() => expect(screen.getByTestId('clearance-value')).toHaveValue('3'))
    await user.click(runButton())
    expect(await screen.findByTestId('stub-chart-concentration')).toBeInTheDocument()
    expect(control.calls).toBe(1)

    // Loading a different clean saved draft clears the result without re-running.
    await user.click(within(screen.getByTestId('scenario-row-saved-2')).getByTestId('load-saved-2'))
    await waitFor(() => expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument())
    expect(screen.getByTestId('simulation-idle')).toBeInTheDocument()
    expect(screen.getByTestId('clearance-value')).toHaveValue('4')
    expect(control.calls).toBe(1)
  })

  it('shows the loading state, never an empty library, before the first read resolves', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const list = repository.list.bind(repository)
    repository.list = async () => {
      await gate
      return list()
    }
    renderView()
    // While the initial read is pending the library is unknown: the panel
    // must not claim there are no saved scenarios.
    expect(screen.getByTestId('scenarios-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('scenarios-empty')).not.toBeInTheDocument()

    release()
    await gate
    // A real, successfully read empty library then gets its empty message.
    expect(await screen.findByTestId('scenarios-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('scenarios-loading')).not.toBeInTheDocument()
  })

  it('reports a list failure instead of an empty library', async () => {
    repository.failList = true
    renderView()
    expect(await screen.findByTestId('scenarios-error')).toHaveTextContent(/could not be read/i)
    expect(screen.queryByTestId('scenarios-empty')).not.toBeInTheDocument()
    expect(control.calls).toBe(0)
  })

  it('reports unreadable stored rows and never lists them as scenarios', async () => {
    repository.corrupt = [{ id: 'broken', message: 'draft is not an object' }]
    renderView()
    expect(await screen.findByTestId('scenarios-corrupt')).toHaveTextContent(/1 stored scenario record/)
    expect(screen.queryByTestId('scenario-row-broken')).not.toBeInTheDocument()
    expect(screen.getByTestId('scenarios-empty')).toBeInTheDocument()
  })

  it('reports a delete failure honestly and keeps the row', async () => {
    const user = userEvent.setup()
    repository.seed('Sticky', baseDraft())
    renderView()
    const row = await screen.findByTestId('scenario-row-saved-1')
    await user.click(within(row).getByTestId('delete-saved-1'))
    vi.spyOn(repository, 'delete').mockResolvedValueOnce({
      ok: false,
      code: 'STORAGE',
      message: 'The scenario could not be deleted: storage error',
    })
    await user.click(within(row).getByTestId('delete-confirm-saved-1'))
    expect(await screen.findByTestId('scenario-feedback')).toHaveTextContent(/could not be deleted/i)
    expect(screen.getByTestId('scenario-row-saved-1')).toBeInTheDocument()
    expect(repository.size).toBe(1)
  })
})