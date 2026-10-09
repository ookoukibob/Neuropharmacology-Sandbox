/**
 * NPSL import pipeline — parse → NPSL schema → semantic validation →
 * preview. Pure and synchronous, so the UI can show a preview before
 * anything is written and the repository can run the *same* validation
 * inside the import transaction (all-or-nothing commit).
 *
 * Blocking errors: malformed JSON, incompatible envelope versions, schema
 * violations (with zod paths), duplicate drug ids inside one file.
 * Non-blocking warnings: duplicate drug names (names are labels, not
 * identities), unknown or unexpected units (data is imported as declared —
 * the application never rewrites a unit), legacy records without
 * bookkeeping timestamps (filled, per the domain contract), and unknown
 * top-level envelope fields (accepted by the loose schema but stored
 * nowhere — reported instead of dropped silently).
 *
 * Extension (unknown-field) contract: unknown keys inside `libraryMetadata`
 * and inside every level of `drugs` survive this validation and the
 * repository write that follows (see `resolveLibraryMetadata` and
 * `toStoredRecord` for the Merge collision policy). Only envelope-level
 * extras cannot be preserved — the warning above is their deliberate,
 * documented fate.
 *
 * No pharmacological content is ever invented, defaulted or dropped here.
 */
import type { Drug, DrugId } from '../../domain/drug/drug'
import {
  DEFAULT_LIBRARY_ID,
  type LibraryMetadata,
} from '../../domain/library/library'
import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import type { DimensionId } from '../../domain/pharmacology/units'
import {
  checkNpslVersions,
  npslFileSchema,
  type NpslLibraryMetadata,
} from '../schemas/npsl'

export type ImportErrorCode = 'PARSE' | 'VERSION' | 'SCHEMA' | 'DUPLICATE_ID'

export interface ImportIssue {
  readonly code: ImportErrorCode
  readonly message: string
  /** Dotted zod path for schema issues, e.g. `drugs.2.identifiers.name`. */
  readonly path?: string
}

export type ImportWarningCode =
  | 'DUPLICATE_NAME'
  | 'UNKNOWN_UNIT'
  | 'UNEXPECTED_DIMENSION'
  | 'TIMESTAMPS_FILLED'
  | 'ENVELOPE_FIELDS_DROPPED'

export interface ImportWarning {
  readonly code: ImportWarningCode
  readonly message: string
}

export type ParsedNpsl =
  | { readonly ok: true; readonly file: unknown }
  | { readonly ok: false; readonly errors: readonly ImportIssue[] }

/** Step 1 — text → envelope: JSON parse + version compatibility. */
export function parseNpsl(text: string): ParsedNpsl {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: 'PARSE',
          message: `file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }
  }
  if (typeof raw !== 'object' || raw === null) {
    return {
      ok: false,
      errors: [{ code: 'SCHEMA', message: 'file must be a JSON object (NPSL envelope)' }],
    }
  }
  const envelope = raw as { formatVersion?: unknown; schemaVersion?: unknown }
  if (typeof envelope.formatVersion !== 'string' || typeof envelope.schemaVersion !== 'string') {
    return {
      ok: false,
      errors: [
        {
          code: 'SCHEMA',
          message: 'envelope must declare string formatVersion and schemaVersion',
        },
      ],
    }
  }
  const compatibility = checkNpslVersions({
    formatVersion: envelope.formatVersion,
    schemaVersion: envelope.schemaVersion,
  })
  if (!compatibility.ok) {
    return { ok: false, errors: [{ code: 'VERSION', message: compatibility.reason }] }
  }
  return { ok: true, file: raw }
}

export type NpslValidation =
  | {
      readonly ok: true
      readonly metadata: NpslLibraryMetadata
      readonly drugs: readonly Drug[]
      readonly warnings: readonly ImportWarning[]
    }
  | {
      readonly ok: false
      readonly errors: readonly ImportIssue[]
      readonly warnings: readonly ImportWarning[]
    }

/** Dimensions a target affinity parameter may legitimately declare. */
const TARGET_DIMENSIONS: ReadonlySet<DimensionId> = new Set<DimensionId>([
  'molar-concentration',
  'mass-concentration',
])

interface UnitCheck {
  readonly label: string
  readonly value: { readonly unit: string }
  readonly expected: ReadonlySet<DimensionId>
}

function unitChecksFor(drug: Drug): UnitCheck[] {
  const checks: UnitCheck[] = []
  for (const target of drug.targets) {
    for (const kind of ['kd', 'ki', 'ec50', 'ic50'] as const) {
      const value = target[kind]
      if (value !== undefined) {
        checks.push({
          label: `target "${target.name}" ${kind.toUpperCase()}`,
          value,
          expected: TARGET_DIMENSIONS,
        })
      }
    }
  }
  const pk = drug.pharmacokinetics
  if (pk.halfLife !== undefined) {
    checks.push({ label: 'half-life', value: pk.halfLife, expected: new Set(['time']) })
  }
  if (pk.bioavailability !== undefined) {
    checks.push({
      label: 'bioavailability',
      value: pk.bioavailability,
      expected: new Set(['dimensionless']),
    })
  }
  // Clearance and volume of distribution use derived units (e.g. "mL/min",
  // "L") that the engine composes outside the catalog — no catalog check.
  return checks
}

/** Metadata keys this build owns — extensions can never shadow them. */
const KNOWN_METADATA_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'author',
  'description',
  'createdAt',
  'updatedAt',
  'dataStatus',
])

/** Top-level envelope keys of the NPSL file format. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'formatVersion',
  'schemaVersion',
  'libraryMetadata',
  'drugs',
])

/**
 * Resolve a file's metadata against a fallback id (single metadata entry).
 * Extension fields (keys unknown to this build) found on the incoming
 * metadata are carried into the result: known fields are rebuilt strictly
 * from their validated values *after* spreading the extras, so an
 * extension can never overwrite a known field — it is only preserved when
 * this build does not own the key. This is what keeps unknown metadata
 * fields alive through a replace import (replace stores the resolved
 * metadata); merge does not touch library metadata at all.
 */
export function resolveLibraryMetadata(
  metadata: NpslLibraryMetadata | LibraryMetadata,
  fallbackId: string = DEFAULT_LIBRARY_ID,
): LibraryMetadata {
  const extras: Record<string, unknown> = {}
  for (const key of Object.keys(metadata)) {
    if (!KNOWN_METADATA_KEYS.has(key)) extras[key] = Reflect.get(metadata, key)
  }
  return {
    ...extras,
    id: metadata.id ?? fallbackId,
    name: metadata.name,
    ...(metadata.author !== undefined ? { author: metadata.author } : {}),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    dataStatus: metadata.dataStatus,
  }
}

/**
 * Step 2 — envelope → domain: NPSL schema (strict about known fields,
 * loose about unknown ones) plus semantic checks. `now` fills legacy
 * records that carry no bookkeeping timestamps (deterministic in tests).
 */
export function validateNpslFile(file: unknown, now?: string): NpslValidation {
  const parsed = npslFileSchema.safeParse(file)
  if (!parsed.success) {
    return {
      ok: false,
      warnings: [],
      errors: parsed.error.issues.map((issue) => ({
        code: 'SCHEMA' as const,
        message: issue.message,
        ...(issue.path.length > 0 ? { path: issue.path.join('.') } : {}),
      })),
    }
  }

  const stamp = now ?? new Date().toISOString()
  const warnings: ImportWarning[] = []
  const errors: ImportIssue[] = []
  const drugs: Drug[] = []

  // Unknown top-level envelope keys pass the loose schema but have nowhere
  // to live in storage (one metadata entry + the drugs table) — report
  // them instead of dropping them silently. Unknown keys *inside*
  // libraryMetadata and drugs are preserved (see the module comment).
  const envelopeExtras = Object.keys(parsed.data).filter((key) => !ENVELOPE_KEYS.has(key))
  if (envelopeExtras.length > 0) {
    warnings.push({
      code: 'ENVELOPE_FIELDS_DROPPED',
      message: `envelope carries unknown top-level field${envelopeExtras.length === 1 ? '' : 's'} ${envelopeExtras.map((key) => `"${key}"`).join(', ')} — not retained: the library stores only libraryMetadata and drugs, so the exported file will not contain them`,
    })
  }

  // Duplicate ids are identity conflicts — blocking; duplicate names are
  // labels — a warning only (two records may share a name legitimately).
  // Both checks run here, inside the caller's transaction, so a failing
  // import commits nothing.
  const seenIds = new Map<DrugId, number>()
  for (const raw of parsed.data.drugs) {
    seenIds.set(raw.id, (seenIds.get(raw.id) ?? 0) + 1)
    // zod validated the record; its optional-undefined typing is bridged to
    // the domain's exact-optional typing here (see records.ts fromRecord).
    const drug = raw as Drug
    if (raw.createdAt === undefined || raw.updatedAt === undefined) {
      warnings.push({
        code: 'TIMESTAMPS_FILLED',
        message: `drug "${raw.identifiers.name}" has no bookkeeping timestamps; filled with the import time`,
      })
      drugs.push({
        ...drug,
        createdAt: raw.createdAt ?? stamp,
        updatedAt: raw.updatedAt ?? stamp,
      })
    } else {
      drugs.push(drug)
    }
  }
  for (const [id, count] of seenIds) {
    if (count > 1) {
      errors.push({
        code: 'DUPLICATE_ID',
        message: `duplicate drug id "${id}" appears ${count} times — ids must be unique`,
        path: 'drugs',
      })
    }
  }

  const byName = new Map<string, number>()
  for (const drug of drugs) {
    const key = drug.identifiers.name.trim().toLowerCase()
    byName.set(key, (byName.get(key) ?? 0) + 1)
  }
  for (const [key, count] of byName) {
    if (count > 1) {
      warnings.push({
        code: 'DUPLICATE_NAME',
        message: `the name "${key}" appears ${count} times — kept as separate records (names are labels, not identities)`,
      })
    }
  }

  for (const drug of drugs) {
    for (const check of unitChecksFor(drug)) {
      const dimension = unitCatalog.dimensionOf(check.value.unit)
      if (dimension === undefined) {
        warnings.push({
          code: 'UNKNOWN_UNIT',
          message: `"${drug.identifiers.name}": ${check.label} uses unit "${check.value.unit}" which is not in the unit catalog — imported exactly as declared`,
        })
      } else if (!check.expected.has(dimension)) {
        warnings.push({
          code: 'UNEXPECTED_DIMENSION',
          message: `"${drug.identifiers.name}": ${check.label} declares unit "${check.value.unit}" (${dimension}), which does not match the expected dimension — imported exactly as declared`,
        })
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings }
  return { ok: true, metadata: parsed.data.libraryMetadata, drugs, warnings }
}

export interface ImportPreviewStats {
  readonly total: number
  /** Ids not present in the current library. */
  readonly newIds: number
  /** Ids already in the current library (merge would update them). */
  readonly conflictingIds: number
}

export type ImportPreview =
  | {
      readonly ok: true
      readonly metadata: LibraryMetadata
      readonly drugs: readonly Drug[]
      readonly warnings: readonly ImportWarning[]
      readonly stats: ImportPreviewStats
    }
  | {
      readonly ok: false
      readonly errors: readonly ImportIssue[]
      readonly warnings: readonly ImportWarning[]
    }

/**
 * Full preview for the UI: parse + validate + statistics against the
 * current library. Nothing is written; committing happens later through
 * `importLibrary`, which re-runs the same validation inside its
 * transaction.
 */
export function previewNpslImport(
  text: string,
  existingIds: readonly DrugId[] = [],
  now?: string,
): ImportPreview {
  const parsed = parseNpsl(text)
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] }

  const validation = validateNpslFile(parsed.file, now)
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings }
  }

  const existing = new Set(existingIds)
  let newIds = 0
  let conflictingIds = 0
  for (const drug of validation.drugs) {
    if (existing.has(drug.id)) conflictingIds += 1
    else newIds += 1
  }

  return {
    ok: true,
    metadata: resolveLibraryMetadata(validation.metadata),
    drugs: validation.drugs,
    warnings: validation.warnings,
    stats: { total: validation.drugs.length, newIds, conflictingIds },
  }
}
