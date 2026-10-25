/**
 * Dexie implementation of the experimental-dataset repository (phase 47A).
 *
 * Guarantees:
 * - every write is validated with the storage schema inside the repository;
 * - every read is validated too — an unreadable row is reported as corrupt and
 *   is never offered as an editable dataset;
 * - create/update/delete run in single transactions, and update/delete compare
 *   the caller's `updatedAt` token inside that transaction so a stale view can
 *   never silently overwrite or delete a newer version;
 * - database and measurement identities are local only. `.npex` import never
 *   supplies them.
 */
import type { SandboxDatabase } from '../db/database'
import { newId } from '../id'
import {
  experimentalDatasetRecordSchema,
  type ExperimentalDatasetRecord,
} from '../schemas/experimentalDatasets'
import {
  declaredUnit,
  isCensoredMeasurementInput,
  measurementContractIssues,
  normalizeDatasetName,
  normalizeDatasetNotes,
  normalizeMeasurementNote,
  normalizeSampleId,
  timeUnitIssue,
  concentrationUnitIssue,
  validateAdministration,
  toDatasetSummary,
  type AdministrationMetadata,
  type ExperimentalDataset,
  type ExperimentalDatasetInput,
  type ExperimentalMeasurement,
} from '../../domain/experiments/experimental-dataset'
import type {
  ExperimentalDatasetChanges,
  ExperimentalDatasetDeleteOutcome,
  ExperimentalDatasetListResult,
  ExperimentalDatasetOutcome,
  ExperimentalDatasetRepository,
} from './experimentalDatasetRepository'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failure(
  code: 'NOT_FOUND' | 'VALIDATION' | 'STORAGE' | 'CORRUPT' | 'CONFLICT',
  message: string,
): ExperimentalDatasetOutcome {
  return { ok: false, code, message }
}

function schemaProblem(error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

/** Never alias a caller-owned object; stored rows are local copies. */
function cloneDataset(dataset: ExperimentalDataset): ExperimentalDataset {
  return structuredClone(dataset)
}

export class DexieExperimentalDatasetRepository implements ExperimentalDatasetRepository {
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

  private static toDataset(record: ExperimentalDatasetRecord): ExperimentalDataset {
    // Zod's optional-undefined typing differs from the domain's exact-optional
    // typing; both describe the same stored JSON shape. Unknown keys survive.
    return record as unknown as ExperimentalDataset
  }

  async list(): Promise<ExperimentalDatasetListResult> {
    const rows = await this.db.experimentDatasets.toArray()
    const datasets: ExperimentalDataset[] = []
    const corrupt: { id: string; message: string }[] = []
    for (const row of rows) {
      const parsed = experimentalDatasetRecordSchema.safeParse(row)
      if (parsed.success) datasets.push(DexieExperimentalDatasetRepository.toDataset(parsed.data))
      else {
        const id =
          typeof (row as { id?: unknown }).id === 'string'
            ? (row as { id: string }).id
            : '(missing id)'
        corrupt.push({ id, message: schemaProblem(parsed.error) })
      }
    }
    datasets.sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? a.name.localeCompare(b.name)
        : b.updatedAt.localeCompare(a.updatedAt),
    )
    return { datasets: datasets.map(toDatasetSummary), corrupt }
  }

  async get(id: string): Promise<ExperimentalDatasetOutcome> {
    const row = await this.db.experimentDatasets.get(id)
    if (row === undefined) {
      return failure(
        'NOT_FOUND',
        `Dataset "${id}" does not exist (it may have been deleted in another tab).`,
      )
    }
    const parsed = experimentalDatasetRecordSchema.safeParse(row)
    if (!parsed.success) {
      return failure('CORRUPT', `Dataset "${id}" is stored in an unreadable form and was not loaded.`)
    }
    return { ok: true, dataset: cloneDataset(DexieExperimentalDatasetRepository.toDataset(parsed.data)) }
  }

  async create(input: ExperimentalDatasetInput): Promise<ExperimentalDatasetOutcome> {
    const name = normalizeDatasetName(input.name)
    if (!name.ok) return failure('VALIDATION', name.message)
    const notes = normalizeDatasetNotes(input.notes)
    if (!notes.ok) return failure('VALIDATION', notes.message)
    const timeUnit = declaredUnit(input.timeUnit)
    const timeIssue = timeUnitIssue(timeUnit)
    if (timeIssue !== null) return failure('VALIDATION', timeIssue)
    const concentrationUnit = declaredUnit(input.concentrationUnit)
    const concentrationIssue = concentrationUnitIssue(concentrationUnit)
    if (concentrationIssue !== null) return failure('VALIDATION', concentrationIssue)
    if (input.administration !== undefined) {
      const issues = validateAdministration(input.administration)
      if (issues.length > 0) {
        return failure(
          'VALIDATION',
          `Administration metadata is invalid: ${issues.map((entry) => `${entry.field}: ${entry.message}`).join(' ')}`,
        )
      }
    }
    if (input.measurements.length === 0) {
      return failure('VALIDATION', 'A dataset must contain at least one measurement.')
    }

    const measurements: ExperimentalMeasurement[] = []
    const datasetId = this.idFactory()
    for (const [index, measurement] of input.measurements.entries()) {
      // Untrusted runtime input: a record that is partly quantified and partly
      // censored is rejected rather than silently reduced to one shape.
      const contract = measurementContractIssues(measurement)
      if (contract.length > 0) {
        return failure(
          'VALIDATION',
          `Measurement ${index + 1} (source row ${measurement.sourceRow}): ${contract.map((entry) => entry.message).join(' ')}`,
        )
      }
      const sample = normalizeSampleId(measurement.sampleId)
      if (!sample.ok) {
        return failure(
          'VALIDATION',
          `Measurement ${index + 1} (source row ${measurement.sourceRow}): ${sample.message}`,
        )
      }
      const note = normalizeMeasurementNote(measurement.note)
      if (!note.ok) {
        return failure(
          'VALIDATION',
          `Measurement ${index + 1} (source row ${measurement.sourceRow}): ${note.message}`,
        )
      }
      const base = {
        id: this.idFactory(),
        sourceRow: measurement.sourceRow,
        time: measurement.time,
        ...(sample.sampleId === undefined ? {} : { sampleId: sample.sampleId }),
        ...(note.note === undefined ? {} : { note: note.note }),
      }
      measurements.push(
        isCensoredMeasurementInput(measurement)
          ? {
              ...base,
              censored: true,
              censoring: measurement.censoring,
              rawText: measurement.rawText,
              limit: measurement.limit,
            }
          : { ...base, concentration: measurement.concentration },
      )
    }

    const stamp = this.now()
    const candidate = {
      id: datasetId,
      name: name.name,
      createdAt: stamp,
      updatedAt: stamp,
      timeUnit,
      concentrationUnit,
      measurements,
      provenance: input.provenance,
      ...(notes.notes === undefined ? {} : { notes: notes.notes }),
      ...(input.administration === undefined ? {} : { administration: input.administration }),
    }
    const validated = experimentalDatasetRecordSchema.safeParse(candidate)
    if (!validated.success) {
      return failure('VALIDATION', `The dataset could not be stored: ${schemaProblem(validated.error)}`)
    }

    try {
      await this.db.transaction('rw', this.db.experimentDatasets, async () => {
        await this.db.experimentDatasets.add(validated.data as ExperimentalDataset)
      })
    } catch (error) {
      return failure('STORAGE', `The dataset could not be saved: ${messageOf(error)}`)
    }
    return { ok: true, dataset: cloneDataset(DexieExperimentalDatasetRepository.toDataset(validated.data)) }
  }

  async update(
    id: string,
    changes: ExperimentalDatasetChanges,
    expectedUpdatedAt: string,
  ): Promise<ExperimentalDatasetOutcome> {
    const hasName = changes.name !== undefined
    const hasNotes = hasOwn(changes, 'notes')
    const hasAdministration = hasOwn(changes, 'administration')
    if (!hasName && !hasNotes && !hasAdministration) {
      return failure('VALIDATION', 'Choose a name, notes or administration value to update.')
    }
    let nextName: string | undefined
    if (hasName) {
      const normalized = normalizeDatasetName(changes.name ?? '')
      if (!normalized.ok) return failure('VALIDATION', normalized.message)
      nextName = normalized.name
    }
    let nextNotes: string | undefined | null = null
    if (hasNotes) {
      const normalized = normalizeDatasetNotes(changes.notes)
      if (!normalized.ok) return failure('VALIDATION', normalized.message)
      nextNotes = normalized.notes
    }
    let nextAdministration: AdministrationMetadata | undefined | null = null
    if (hasAdministration) {
      if (changes.administration === undefined) {
        // explicit clear
        nextAdministration = undefined
      } else {
        const issues = validateAdministration(changes.administration)
        if (issues.length > 0) {
          return failure(
            'VALIDATION',
            `Administration metadata is invalid: ${issues.map((entry) => `${entry.field}: ${entry.message}`).join(' ')}`,
          )
        }
        nextAdministration = changes.administration
      }
    }

    try {
      const result = await this.db.transaction('rw', this.db.experimentDatasets, async () => {
        const current = await this.db.experimentDatasets.get(id)
        if (current === undefined) return { kind: 'missing' as const }
        const parsed = experimentalDatasetRecordSchema.safeParse(current)
        if (!parsed.success) return { kind: 'corrupt' as const }
        if (parsed.data.updatedAt !== expectedUpdatedAt) {
          return { kind: 'conflict' as const, updatedAt: parsed.data.updatedAt }
        }
        const candidate = {
          ...parsed.data,
          updatedAt: this.nextTimestamp(parsed.data.updatedAt),
          ...(nextName === undefined ? {} : { name: nextName }),
        } as ExperimentalDatasetRecord
        if (nextNotes === null) {
          // keep the stored notes untouched
        } else if (nextNotes === undefined) {
          delete candidate.notes
        } else {
          candidate.notes = nextNotes
        }
        if (nextAdministration === null) {
          // keep the stored administration untouched
        } else if (nextAdministration === undefined) {
          delete candidate.administration
        } else {
          candidate.administration = nextAdministration as unknown as ExperimentalDatasetRecord['administration']
        }
        const validated = experimentalDatasetRecordSchema.safeParse(candidate)
        if (!validated.success) return { kind: 'invalid' as const, error: validated.error }
        await this.db.experimentDatasets.put(validated.data as ExperimentalDataset)
        return { kind: 'ok' as const, dataset: validated.data }
      })

      if (result.kind === 'missing') {
        return failure(
          'NOT_FOUND',
          `Dataset "${id}" does not exist (it may have been deleted in another tab).`,
        )
      }
      if (result.kind === 'corrupt') {
        return failure('CORRUPT', `Dataset "${id}" is stored in an unreadable form; it was not modified.`)
      }
      if (result.kind === 'conflict') {
        return failure(
          'CONFLICT',
          `Dataset "${id}" changed after you opened it (stored updatedAt ${result.updatedAt}). Reload the list and try again; nothing was overwritten.`,
        )
      }
      if (result.kind === 'invalid') {
        return failure('VALIDATION', `The updated dataset is invalid: ${schemaProblem(result.error)}`)
      }
      return {
        ok: true,
        dataset: cloneDataset(DexieExperimentalDatasetRepository.toDataset(result.dataset)),
      }
    } catch (error) {
      return failure('STORAGE', `The dataset could not be updated: ${messageOf(error)}`)
    }
  }

  async delete(id: string, expectedUpdatedAt: string): Promise<ExperimentalDatasetDeleteOutcome> {
    try {
      const result = await this.db.transaction('rw', this.db.experimentDatasets, async () => {
        const current = await this.db.experimentDatasets.get(id)
        if (current === undefined) return { kind: 'missing' as const }
        const parsed = experimentalDatasetRecordSchema.safeParse(current)
        if (!parsed.success) return { kind: 'corrupt' as const }
        if (parsed.data.updatedAt !== expectedUpdatedAt) {
          return { kind: 'conflict' as const, updatedAt: parsed.data.updatedAt }
        }
        await this.db.experimentDatasets.delete(id)
        return { kind: 'ok' as const }
      })
      if (result.kind === 'missing') {
        return {
          ok: false,
          code: 'NOT_FOUND',
          message: `Dataset "${id}" does not exist (it may have been deleted in another tab).`,
        }
      }
      if (result.kind === 'corrupt') {
        return {
          ok: false,
          code: 'CORRUPT',
          message: `Dataset "${id}" is stored in an unreadable form; it was not deleted.`,
        }
      }
      if (result.kind === 'conflict') {
        return {
          ok: false,
          code: 'CONFLICT',
          message: `Dataset "${id}" changed after you opened it (stored updatedAt ${result.updatedAt}). Reload the list and try again; nothing was deleted.`,
        }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, code: 'STORAGE', message: `The dataset could not be deleted: ${messageOf(error)}` }
    }
  }

  /**
   * Keep tokens strictly increasing per record even when the clock has
   * millisecond resolution and two updates land in the same tick. The token is
   * an ISO string; lexical order is chronological for valid UTC timestamps.
   */
  private nextTimestamp(previous: string): string {
    const candidate = this.now()
    if (candidate > previous) return candidate
    const previousMs = Date.parse(previous)
    /* c8 ignore next -- a stored previous timestamp is schema-validated */
    if (Number.isNaN(previousMs)) return candidate
    return new Date(previousMs + 1).toISOString()
  }
}
