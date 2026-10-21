/**
 * Dexie implementation of the scenario repository (phase 45).
 *
 * Same guarantees as the drug repository: the storage schema is validated on
 * every read (an unreadable row is reported, never trusted), writes happen
 * inside single transactions, and every failure is a typed outcome. The
 * record's `id` is the address for rename, duplicate, save-over and delete —
 * names are display text only.
 */
import type { SandboxDatabase } from '../db/database'
import { savedScenarioSchema, type SavedScenarioRecord } from '../schemas/scenarios'
import { newId } from '../id'
import {
  normalizeScenarioName,
  toScenarioSummary,
  type SavedScenario,
} from '../../domain/simulation/saved-scenario'
import type { SimulationDraft } from '../../features/simulation/draft'
import type {
  ScenarioDeleteOutcome,
  ScenarioListResult,
  ScenarioOperationOutcome,
  ScenarioRawRow,
  ScenarioRepository,
} from './scenarioRepository'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failure(code: 'NOT_FOUND' | 'VALIDATION' | 'STORAGE' | 'CORRUPT', message: string): ScenarioOperationOutcome {
  return { ok: false, code, message }
}

/** Deep clone so a stored record never aliases caller-owned objects. */
function cloneDraft(draft: SimulationDraft): SimulationDraft {
  return structuredClone(draft)
}

export class DexieScenarioRepository implements ScenarioRepository {
  private readonly db: SandboxDatabase
  private readonly now: () => string
  private readonly idFactory: () => string

  constructor(
    db: SandboxDatabase,
    now: () => string = () => new Date().toISOString(),
    idFactory: () => string = newId,
  ) {
    this.db = db
    this.now = now
    this.idFactory = idFactory
  }

  /**
   * Convert a schema-validated record into the domain type.
   *
   * The stored schema is structurally permissive (it exists to validate
   * STORAGE shape); this narrows the parsed output to `SavedScenario`.
   * `effectSite` is preserved exactly as stored — absent stays absent, which
   * is what makes pre-phase-46 records load with effect-site analysis
   * disabled, and no parameter value is ever invented here.
   */
  private static toScenario(record: SavedScenarioRecord): SavedScenario {
    return record as unknown as SavedScenario
  }

  async list(): Promise<ScenarioListResult> {
    const rows = await this.db.scenarios.toArray()
    const scenarios: SavedScenario[] = []
    const corrupt: { id: string; message: string }[] = []
    for (const row of rows) {
      const parsed = savedScenarioSchema.safeParse(row)
      if (parsed.success) scenarios.push(DexieScenarioRepository.toScenario(parsed.data))
      else {
        const id = typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : '(missing id)'
        corrupt.push({ id, message: parsed.error.issues.map((issue) => issue.message).join('; ') })
      }
    }
    scenarios.sort((a, b) => (a.updatedAt === b.updatedAt ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt)))
    return { scenarios: scenarios.map(toScenarioSummary), corrupt }
  }

  async get(id: string): Promise<ScenarioOperationOutcome> {
    const row = await this.db.scenarios.get(id)
    if (row === undefined) return failure('NOT_FOUND', `Scenario "${id}" does not exist (it may have been deleted in another tab).`)
    const parsed = savedScenarioSchema.safeParse(row)
    if (!parsed.success) {
      return failure('CORRUPT', `Scenario "${id}" is stored in an unreadable form and was not loaded.`)
    }
    return { ok: true, scenario: DexieScenarioRepository.toScenario(parsed.data) }
  }

  async create(name: string, draft: SimulationDraft): Promise<ScenarioOperationOutcome> {
    const normalized = normalizeScenarioName(name)
    if (!normalized.ok) return failure('VALIDATION', normalized.message)
    const validated = savedScenarioSchema.safeParse({
      id: this.idFactory(),
      name: normalized.name,
      createdAt: this.now(),
      updatedAt: this.now(),
      draft,
    })
    if (!validated.success) {
      return failure('VALIDATION', 'The scenario draft could not be stored: ' + validated.error.issues[0]?.message)
    }
    try {
      await this.db.scenarios.add(validated.data as SavedScenario)
    } catch (error) {
      return failure('STORAGE', `The scenario could not be saved: ${messageOf(error)}`)
    }
    return { ok: true, scenario: validated.data as SavedScenario }
  }

  async rename(id: string, name: string): Promise<ScenarioOperationOutcome> {
    const normalized = normalizeScenarioName(name)
    if (!normalized.ok) return failure('VALIDATION', normalized.message)
    return this.mutate(id, (record) => ({ ...record, name: normalized.name, updatedAt: this.now() }))
  }

  async duplicate(id: string, name?: string): Promise<ScenarioOperationOutcome> {
    const existing = await this.get(id)
    if (!existing.ok) return existing
    const base = name === undefined ? `${existing.scenario.name} (copy)` : name
    return this.create(base, cloneDraft(existing.scenario.draft))
  }

  async saveOver(id: string, draft: SimulationDraft, name?: string): Promise<ScenarioOperationOutcome> {
    let nextName: string | undefined
    if (name !== undefined) {
      const normalized = normalizeScenarioName(name)
      if (!normalized.ok) return failure('VALIDATION', normalized.message)
      nextName = normalized.name
    }
    return this.mutate(id, (record) => {
      const updatedAt = this.now()
      const candidate = { ...record, draft: cloneDraft(draft), updatedAt, ...(nextName === undefined ? {} : { name: nextName }) }
      const validated = savedScenarioSchema.safeParse(candidate)
      if (!validated.success) throw new Error(validated.error.issues[0]?.message ?? 'invalid draft')
      return DexieScenarioRepository.toScenario(validated.data)
    })
  }

  async delete(id: string): Promise<ScenarioDeleteOutcome> {
    try {
      const removed = await this.db.transaction('rw', this.db.scenarios, async () => {
        const existing = await this.db.scenarios.get(id)
        if (existing === undefined) return false
        await this.db.scenarios.delete(id)
        return true
      })
      return removed ? { ok: true } : { ok: false, code: 'NOT_FOUND', message: `Scenario "${id}" does not exist.` }
    } catch (error) {
      return { ok: false, code: 'STORAGE', message: `The scenario could not be deleted: ${messageOf(error)}` }
    }
  }

  async exportRows(): Promise<readonly ScenarioRawRow[]> {
    const rows: ScenarioRawRow[] = []
    await this.db.scenarios.each((value, cursor) => {
      rows.push({ key: String(cursor.primaryKey), value })
    })
    return rows
  }

  async replaceAll(rows: readonly { readonly key: string; readonly value: Record<string, unknown> }[]): Promise<void> {
    await this.db.transaction('rw', this.db.scenarios, async () => {
      await this.db.scenarios.clear()
      for (const row of rows) {
        await this.db.scenarios.put(row.value as unknown as SavedScenario)
      }
    })
  }

  /**
   * Read-modify-write inside ONE transaction: the record is re-read, checked
   * to still exist (NOT_FOUND rather than creating a phantom row) and
   * written back atomically, so a concurrent delete cannot be resurrected.
   */
  private async mutate(
    id: string,
    update: (record: SavedScenario) => SavedScenario,
  ): Promise<ScenarioOperationOutcome> {
    try {
      const result = await this.db.transaction('rw', this.db.scenarios, async () => {
        const current = await this.db.scenarios.get(id)
        if (current === undefined) return { missing: true as const }
        const parsed = savedScenarioSchema.safeParse(current)
        if (!parsed.success) return { corrupt: true as const }
        const next = update(DexieScenarioRepository.toScenario(parsed.data))
        await this.db.scenarios.put(next as SavedScenario)
        return { scenario: next }
      })
      if ('missing' in result) {
        return failure('NOT_FOUND', `Scenario "${id}" does not exist (it may have been deleted in another tab).`)
      }
      if ('corrupt' in result) {
        return failure('CORRUPT', `Scenario "${id}" is stored in an unreadable form; it was not modified.`)
      }
      return { ok: true, scenario: result.scenario }
    } catch (error) {
      return failure('STORAGE', `The scenario could not be updated: ${messageOf(error)}`)
    }
  }
}