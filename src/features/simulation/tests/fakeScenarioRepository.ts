/**
 * In-memory ScenarioRepository double for component tests (phase 45).
 *
 * Implements the same typed outcomes as the Dexie repository so tests
 * exercise the real UI paths (success, VALIDATION, NOT_FOUND, STORAGE,
 * CORRUPT) without touching IndexedDB. Deterministic ids and timestamps.
 */
import type {
  ScenarioDeleteOutcome,
  ScenarioListResult,
  ScenarioOperationOutcome,
  ScenarioRawRow,
  ScenarioRepository,
} from '@/data/repositories/scenarioRepository'
import { normalizeScenarioName, toScenarioSummary, type SavedScenario } from '@/domain/simulation/saved-scenario'
import type { SimulationDraft } from '@/features/simulation/draft'

export type FailureMode = 'none' | 'storage' | 'list-error'

export class FakeScenarioRepository implements ScenarioRepository {
  private readonly rows = new Map<string, SavedScenario>()
  private counter = 0
  private tick = 0
  /** Injected failure mode for the next write (storage errors). */
  failNext: 'none' | 'storage' = 'none'
  /** When true, list() throws (storage unavailable). */
  failList = false
  /** Rows that exist in storage but cannot be read. */
  corrupt: { id: string; message: string }[] = []

  seed(name: string, draft: SimulationDraft): SavedScenario {
    this.counter += 1
    const stamp = this.stamp()
    const scenario: SavedScenario = { id: `saved-${this.counter}`, name, createdAt: stamp, updatedAt: stamp, draft }
    this.rows.set(scenario.id, scenario)
    return scenario
  }

  get size(): number {
    return this.rows.size
  }

  getRecord(id: string): SavedScenario | undefined {
    return this.rows.get(id)
  }

  private stamp(): string {
    this.tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString()
  }

  async list(): Promise<ScenarioListResult> {
    if (this.failList) throw new Error('IndexedDB unavailable')
    const scenarios = [...this.rows.values()]
      .sort((a, b) => (a.updatedAt === b.updatedAt ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt)))
      .map(toScenarioSummary)
    return { scenarios, corrupt: this.corrupt }
  }

  async get(id: string): Promise<ScenarioOperationOutcome> {
    const row = this.rows.get(id)
    if (row === undefined) return { ok: false, code: 'NOT_FOUND', message: `Scenario "${id}" does not exist.` }
    return { ok: true, scenario: structuredClone(row) }
  }

  async create(name: string, draft: SimulationDraft): Promise<ScenarioOperationOutcome> {
    if (this.failNext === 'storage') {
      this.failNext = 'none'
      return { ok: false, code: 'STORAGE', message: 'The scenario could not be saved: quota exceeded' }
    }
    const normalized = normalizeScenarioName(name)
    if (!normalized.ok) return { ok: false, code: 'VALIDATION', message: normalized.message }
    return { ok: true, scenario: this.seed(normalized.name, structuredClone(draft)) }
  }

  async rename(id: string, name: string): Promise<ScenarioOperationOutcome> {
    const normalized = normalizeScenarioName(name)
    if (!normalized.ok) return { ok: false, code: 'VALIDATION', message: normalized.message }
    const row = this.rows.get(id)
    if (row === undefined) return { ok: false, code: 'NOT_FOUND', message: 'missing' }
    const next: SavedScenario = { ...row, name: normalized.name, updatedAt: this.stamp() }
    this.rows.set(id, next)
    return { ok: true, scenario: structuredClone(next) }
  }

  async duplicate(id: string, name?: string): Promise<ScenarioOperationOutcome> {
    const row = this.rows.get(id)
    if (row === undefined) return { ok: false, code: 'NOT_FOUND', message: 'missing' }
    return this.create(name ?? `${row.name} (copy)`, structuredClone(row.draft))
  }

  async saveOver(id: string, draft: SimulationDraft): Promise<ScenarioOperationOutcome> {
    const row = this.rows.get(id)
    if (row === undefined) return { ok: false, code: 'NOT_FOUND', message: 'missing' }
    const next: SavedScenario = { ...row, draft: structuredClone(draft), updatedAt: this.stamp() }
    this.rows.set(id, next)
    return { ok: true, scenario: structuredClone(next) }
  }

  async delete(id: string): Promise<ScenarioDeleteOutcome> {
    if (!this.rows.delete(id)) return { ok: false, code: 'NOT_FOUND', message: 'missing' }
    return { ok: true }
  }

  async exportRows(): Promise<readonly ScenarioRawRow[]> {
    return [...this.rows.values()].map((row) => ({ key: row.id, value: row }))
  }

  async replaceAll(rows: readonly { readonly key: string; readonly value: Record<string, unknown> }[]): Promise<void> {
    this.rows.clear()
    for (const row of rows) this.rows.set(row.key, row.value as unknown as SavedScenario)
  }
}
