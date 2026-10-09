/**
 * `.npsb` recovery archive assembly and validation (ADR-18,
 * docs/recovery-backup.md §4–§9). Pure and synchronous: the Dexie layer
 * supplies raw snapshot rows or archive text; everything here runs on
 * in-memory values with no storage access.
 *
 * - `buildRecoveryArchive` — export pipeline: key policy, entry
 *   validation, fidelity scan, classification, envelope assembly,
 *   serialization and the §6.4 re-parse + deep-compare verification.
 *   Any issue at all → no text is produced.
 * - `parseRecoveryArchive` — restore validation battery (§8.2), in
 *   order: size → duplicate JSON keys → parse → envelope → version →
 *   counts → arrays/limits → entries → duplicates → sidecars → value
 *   domain, all before any write transaction can open.
 * - `buildRecoveryWarnings` — the non-blocking §8.3 preview warnings.
 */
import { fromRecord } from '../mappers/records'
import { libraryMetadataSchema } from '../schemas/npsl'
import { scanDuplicateJsonKeys } from './duplicateKeys'
import {
  exceedsUtf8ByteLimit,
  deepEqualExact,
  describeKeyType,
  describeValue,
  isPlainObject,
  materializeSpecialNumbers,
  scanRowValue,
  hasOwn,
} from './fidelity'
import {
  BACKUP_FORMAT_ID,
  BACKUP_VERSION,
  MAX_ARCHIVE_BYTES,
  MAX_DEPTH,
  MAX_DRUG_ROWS,
  MAX_META_ROWS,
  MAX_SPECIAL_NUMBER_ANNOTATIONS,
  checkBackupVersion,
  type RecoveryArchive,
  type RecoveryCounts,
  type RecoveryEntry,
  type RecoveryIssue,
  type RecoveryStorageInfo,
  type RecoveryStoreName,
  type RecoveryWarning,
} from './format'

/** A raw store row as captured by a cursor: actual key + structured value. */
export interface RawSnapshotRow {
  readonly key: unknown
  readonly value: unknown
}

export interface BuildArchiveInput {
  readonly drugs: readonly RawSnapshotRow[]
  readonly meta: readonly RawSnapshotRow[]
  readonly storage: RecoveryStorageInfo
  readonly exportedAt: string
}

export type BuildArchiveResult =
  | { readonly ok: true; readonly text: string; readonly counts: RecoveryCounts }
  | { readonly ok: false; readonly issues: readonly RecoveryIssue[] }

/** A validated archive row: string key, JSON-domain value, sidecar applied. */
export interface ValidatedRow {
  readonly key: string
  readonly value: Record<string, unknown>
}

export interface ValidatedArchive {
  readonly counts: RecoveryCounts
  readonly storage: RecoveryStorageInfo
  readonly exportedAt: string
  readonly drugs: readonly ValidatedRow[]
  readonly meta: readonly ValidatedRow[]
}

export type ParseArchiveResult =
  | { readonly ok: true; readonly archive: ValidatedArchive }
  | { readonly ok: false; readonly issues: readonly RecoveryIssue[] }

export interface CurrentBuildInfo {
  readonly databaseVersion: number
  readonly persistenceVersion: number
}

export interface ReclassificationSummary {
  readonly readable: number
  readonly quarantined: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Export pipeline (§6.4, §7)
// ---------------------------------------------------------------------------

/**
 * Build verified `.npsb` text from one storage snapshot. Read-only with
 * respect to storage: classification and serialization run on the copies
 * the caller already read. Failure of ANY step returns issues and no
 * text — an incomplete snapshot is never labeled a backup.
 */
export function buildRecoveryArchive(input: BuildArchiveInput): BuildArchiveResult {
  const issues: RecoveryIssue[] = []

  // Export-side limits: the export must never emit an archive the restore
  // path would reject on its own caps (§12) — that would be a "backup"
  // that cannot be restored.
  if (input.drugs.length > MAX_DRUG_ROWS) {
    issues.push({
      code: 'BACKUP_LIMIT_EXCEEDED',
      limit: 'drug rows',
      message: `the drugs store holds ${input.drugs.length} rows, above the archive limit of ${MAX_DRUG_ROWS}`,
    })
  }
  if (input.meta.length > MAX_META_ROWS) {
    issues.push({
      code: 'BACKUP_LIMIT_EXCEEDED',
      limit: 'meta rows',
      message: `the meta store holds ${input.meta.length} rows, above the archive limit of ${MAX_META_ROWS}`,
    })
  }

  let readableAtExport = 0
  let quarantinedAtExport = 0
  let annotationTotal = 0
  const drugEntries: RecoveryEntry[] = []
  const metaEntries: RecoveryEntry[] = []

  const buildEntry = (
    row: RawSnapshotRow,
    store: RecoveryStoreName,
    index: number,
  ): RecoveryEntry | null => {
    const { key, value } = row
    if (typeof key !== 'string') {
      issues.push({
        code: 'BACKUP_UNSUPPORTED_KEY',
        store,
        index,
        valueType: describeKeyType(key),
        message: `row ${index} in ${store} has a non-string primary key (${describeKeyType(key)}); only string keys are supported — resolve the row deliberately before exporting`,
      })
      return null
    }
    if (!isPlainObject(value)) {
      issues.push({
        code: 'BACKUP_UNSUPPORTED_VALUE',
        store,
        key,
        path: '',
        valueType: describeValue(value),
        message: `stored row "${key}" in ${store} is not a plain object (found ${describeValue(value)})`,
      })
      return null
    }
    if (!hasOwn(value, 'id') || value['id'] !== key) {
      issues.push({
        code: 'BACKUP_UNSUPPORTED_VALUE',
        store,
        key,
        path: '/id',
        valueType: 'key-mismatch',
        message: `stored row "${key}" in ${store} does not carry its own "id" equal to its primary key — the snapshot is inconsistent with the in-line key path`,
      })
      return null
    }
    const scan = scanRowValue(value, { store, key })
    for (const issue of scan.issues) issues.push(issue)
    annotationTotal += scan.annotations.length
    return scan.annotations.length > 0
      ? { key, value, specialNumbers: scan.annotations }
      : { key, value }
  }

  input.drugs.forEach((row, index) => {
    const entry = buildEntry(row, 'drugs', index)
    if (entry === null) return
    drugEntries.push(entry)
    if (fromRecord(entry.value).ok) readableAtExport += 1
    else quarantinedAtExport += 1
  })
  input.meta.forEach((row, index) => {
    const entry = buildEntry(row, 'meta', index)
    if (entry !== null) metaEntries.push(entry)
  })

  if (annotationTotal > MAX_SPECIAL_NUMBER_ANNOTATIONS) {
    issues.push({
      code: 'BACKUP_LIMIT_EXCEEDED',
      limit: 'special numbers',
      message: `the snapshot produces ${annotationTotal} special-number annotations, above the archive limit of ${MAX_SPECIAL_NUMBER_ANNOTATIONS}`,
    })
  }
  if (issues.length > 0) return { ok: false, issues }

  const counts: RecoveryCounts = {
    drugRows: drugEntries.length,
    readableAtExport,
    quarantinedAtExport,
    metaRows: metaEntries.length,
  }
  const archive: RecoveryArchive = {
    formatId: BACKUP_FORMAT_ID,
    backupVersion: BACKUP_VERSION,
    exportedAt: input.exportedAt,
    storage: input.storage,
    counts,
    drugs: drugEntries,
    meta: metaEntries,
  }

  let text: string
  try {
    text = JSON.stringify(archive, null, 2)
  } catch (error) {
    /* c8 ignore next 4 -- the scan already rejected every stringify hazard */
    return {
      ok: false,
      issues: [
        {
          code: 'BACKUP_VERIFY_FAILED',
          message: `serialization threw after a clean fidelity scan (internal defect): ${messageOf(error)}`,
        },
      ],
    }
  }

  // §6.4 verification: re-parse the serialized text, re-apply the sidecar
  // through the SAME materialization routine restore uses, deep-compare
  // every entry against the in-memory source under E. Any mismatch is an
  // internal consistency failure — no download is offered.
  const verifyFailure = (message: string): BuildArchiveResult => ({
    ok: false,
    issues: [{ code: 'BACKUP_VERIFY_FAILED', message }],
  })
  let parsedText: unknown
  try {
    parsedText = JSON.parse(text)
  } catch (error) {
    /* c8 ignore next -- our own output always parses */
    return verifyFailure(`serialized archive failed to re-parse: ${messageOf(error)}`)
  }
  if (!isPlainObject(parsedText)) return verifyFailure('serialized archive root is not an object')
  const parsedCounts = parsedText['counts']
  if (
    !isPlainObject(parsedCounts) ||
    parsedCounts['drugRows'] !== drugEntries.length ||
    parsedCounts['metaRows'] !== metaEntries.length ||
    parsedCounts['readableAtExport'] !== readableAtExport ||
    parsedCounts['quarantinedAtExport'] !== quarantinedAtExport ||
    readableAtExport + quarantinedAtExport !== drugEntries.length
  ) {
    return verifyFailure('archive counts do not match the assembled arrays (§4.1)')
  }
  const verifyEntries = (
    parsed: unknown,
    source: readonly RecoveryEntry[],
    store: RecoveryStoreName,
  ): string | null => {
    if (!Array.isArray(parsed)) return `${store} is not an array after re-parse`
    if (parsed.length !== source.length) return `${store} length changed across serialization`
    for (let index = 0; index < source.length; index += 1) {
      const sourceEntry = source[index]
      if (sourceEntry === undefined) return `${store}[${index}] is missing from the source snapshot`
      const entry: unknown = parsed[index]
      if (!isPlainObject(entry)) return `${store}[${index}] is not an object after re-parse`
      const value = entry['value']
      if (!isPlainObject(value)) return `${store}[${index}].value is not an object after re-parse`
      const materialized = materializeSpecialNumbers(value, entry['specialNumbers'], {
        store,
        key: sourceEntry.key,
      })
      if (!materialized.ok) {
        return `${store}[${index}] sidecar failed to re-apply on verification: ${materialized.issues[0]?.message ?? 'unknown'}`
      }
      if (!deepEqualExact(sourceEntry.value, materialized.value)) {
        return `${store}[${index}] (key "${sourceEntry.key}") differs from the source snapshot after the serialize → parse → materialize round trip`
      }
    }
    return null
  }
  const drugsFailure = verifyEntries(parsedText['drugs'], drugEntries, 'drugs')
  if (drugsFailure !== null) return verifyFailure(drugsFailure)
  const metaFailure = verifyEntries(parsedText['meta'], metaEntries, 'meta')
  if (metaFailure !== null) return verifyFailure(metaFailure)

  return { ok: true, text, counts }
}

// ---------------------------------------------------------------------------
// Restore validation battery (§8.2)
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = [
  'formatId',
  'backupVersion',
  'exportedAt',
  'storage',
  'counts',
  'drugs',
  'meta',
] as const

function fail(issues: readonly RecoveryIssue[]): ParseArchiveResult {
  return { ok: false, issues }
}

function oneIssue(issue: RecoveryIssue): ParseArchiveResult {
  return fail([issue])
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isIsoDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && /T\d{2}:\d{2}:\d{2}/.test(value)
}

/** Pre-collected entry awaiting sidecar materialization (steps 11–12). */
interface PendingRow {
  readonly key: string
  readonly value: Record<string, unknown>
  readonly specialNumbers: unknown
}

/**
 * Full §8.2 validation of archive text, read-only. `ok: true` carries the
 * materialized rows (sidecar applied, specials restored) ready for the
 * restore transaction; `ok: false` carries every located issue and
 * guarantees no write path was reached.
 */
export function parseRecoveryArchive(text: string): ParseArchiveResult {
  // 1. Size — UTF-8 bytes, not string length (§12).
  if (exceedsUtf8ByteLimit(text, MAX_ARCHIVE_BYTES)) {
    return oneIssue({
      code: 'ARCHIVE_TOO_LARGE',
      message: `archive text exceeds the limit of ${MAX_ARCHIVE_BYTES} UTF-8 bytes (64 MiB)`,
    })
  }
  // 2. Duplicate JSON keys — string-aware textual scan before parsing.
  const duplicateScan = scanDuplicateJsonKeys(text, MAX_DEPTH)
  if (!duplicateScan.ok) {
    if (duplicateScan.reason === 'duplicate') {
      return oneIssue({
        code: 'ARCHIVE_DUPLICATE_JSON_KEY',
        message: `duplicate JSON object key "${duplicateScan.key}" at line ${duplicateScan.line}, column ${duplicateScan.column} — JSON.parse would silently keep only the last value`,
      })
    }
    if (duplicateScan.reason === 'depth') {
      return oneIssue({
        code: 'ARCHIVE_LIMIT_EXCEEDED',
        limit: 'depth',
        message: `the JSON structure nests deeper than the archive limit of ${MAX_DEPTH}`,
      })
    }
    // malformed → fall through; JSON.parse reports ARCHIVE_PARSE below.
  }
  // 3. Parse (catching every throwable, including RangeError).
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    return oneIssue({ code: 'ARCHIVE_PARSE', message: `not valid JSON: ${messageOf(error)}` })
  }
  // 4. Root shape.
  if (!isPlainObject(root)) {
    return oneIssue({
      code: 'ARCHIVE_ENVELOPE_SHAPE',
      message: `the archive root must be a JSON object (found ${describeValue(root)})`,
    })
  }
  // 5. Format discriminator.
  if (root['formatId'] !== BACKUP_FORMAT_ID) {
    return oneIssue({
      code: 'ARCHIVE_NOT_NPSB',
      message: `this file does not declare formatId "npsb" — it is not a recovery archive. Use the Import tab for .npsl/.json library files.`,
    })
  }
  // 6. Version rule (§3).
  const version = root['backupVersion']
  if (typeof version !== 'string') {
    return oneIssue({
      code: 'ARCHIVE_VERSION',
      message: 'backupVersion must be a semantic version string like "1.0.0"',
    })
  }
  const compatibility = checkBackupVersion(version)
  if (!compatibility.ok) {
    return oneIssue({ code: 'ARCHIVE_VERSION', message: compatibility.reason })
  }
  // 7. Envelope key set and field types.
  const unknownKeys = Object.keys(root).filter((key) => !(ENVELOPE_KEYS as readonly string[]).includes(key))
  const missingKeys = ENVELOPE_KEYS.filter((key) => !hasOwn(root, key))
  if (unknownKeys.length > 0 || missingKeys.length > 0) {
    return oneIssue({
      code: 'ARCHIVE_ENVELOPE_SHAPE',
      message: `the v1 envelope must have exactly the seven documented keys — missing: [${missingKeys.join(', ')}], unknown: [${unknownKeys.join(', ')}]`,
    })
  }
  const exportedAt = root['exportedAt']
  if (typeof exportedAt !== 'string' || !isIsoDateTime(exportedAt)) {
    return oneIssue({
      code: 'ARCHIVE_ENVELOPE_SHAPE',
      message: 'exportedAt must be an ISO 8601 date-time string',
    })
  }
  const storage = root['storage']
  if (
    !isPlainObject(storage) ||
    Object.keys(storage).length !== 2 ||
    !isNonNegativeSafeInteger(storage['databaseVersion']) ||
    !isNonNegativeSafeInteger(storage['persistenceVersion'])
  ) {
    return oneIssue({
      code: 'ARCHIVE_ENVELOPE_SHAPE',
      message: 'storage must be exactly {databaseVersion, persistenceVersion} with non-negative integer fields',
    })
  }
  const counts = root['counts']
  if (
    !isPlainObject(counts) ||
    Object.keys(counts).length !== 4 ||
    !isNonNegativeSafeInteger(counts['drugRows']) ||
    !isNonNegativeSafeInteger(counts['readableAtExport']) ||
    !isNonNegativeSafeInteger(counts['quarantinedAtExport']) ||
    !isNonNegativeSafeInteger(counts['metaRows'])
  ) {
    return oneIssue({
      code: 'ARCHIVE_COUNT_MISMATCH',
      message: 'counts must be exactly {drugRows, readableAtExport, quarantinedAtExport, metaRows} with non-negative integer fields',
    })
  }
  // 8. Arrays within limits.
  const drugsArray = root['drugs']
  const metaArray = root['meta']
  if (!Array.isArray(drugsArray) || !Array.isArray(metaArray)) {
    return oneIssue({
      code: 'ARCHIVE_ENVELOPE_SHAPE',
      message: 'drugs and meta must be arrays of {key, value, specialNumbers?} entries',
    })
  }
  if (drugsArray.length > MAX_DRUG_ROWS || metaArray.length > MAX_META_ROWS) {
    return oneIssue({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      limit: drugsArray.length > MAX_DRUG_ROWS ? 'drug rows' : 'meta rows',
      message: `the archive declares ${drugsArray.length} drug rows and ${metaArray.length} meta rows; limits are ${MAX_DRUG_ROWS} and ${MAX_META_ROWS}`,
    })
  }
  // Counts invariants (§4.1) — structural assertions of THIS text.
  const archivedCounts: RecoveryCounts = {
    drugRows: counts['drugRows'],
    readableAtExport: counts['readableAtExport'],
    quarantinedAtExport: counts['quarantinedAtExport'],
    metaRows: counts['metaRows'],
  }
  if (archivedCounts.drugRows !== drugsArray.length || archivedCounts.metaRows !== metaArray.length) {
    return oneIssue({
      code: 'ARCHIVE_COUNT_MISMATCH',
      message: `counts declare ${archivedCounts.drugRows} drug rows and ${archivedCounts.metaRows} meta rows, but the arrays hold ${drugsArray.length} and ${metaArray.length} entries`,
    })
  }
  if (
    archivedCounts.readableAtExport + archivedCounts.quarantinedAtExport !==
    archivedCounts.drugRows
  ) {
    return oneIssue({
      code: 'ARCHIVE_COUNT_MISMATCH',
      message: `readableAtExport (${archivedCounts.readableAtExport}) + quarantinedAtExport (${archivedCounts.quarantinedAtExport}) must equal drugRows (${archivedCounts.drugRows})`,
    })
  }
  // 9–10. Entries, keys and duplicates — per store.
  const issues: RecoveryIssue[] = []
  const collectEntries = (
    array: readonly unknown[],
    store: RecoveryStoreName,
  ): PendingRow[] | null => {
    const rows: PendingRow[] = []
    const seen = new Map<string, number>()
    for (let index = 0; index < array.length; index += 1) {
      const entry: unknown = array[index]
      if (!isPlainObject(entry)) {
        issues.push({
          code: 'ARCHIVE_ENTRY_SHAPE',
          store,
          index,
          message: `${store}[${index}] must be an object {key, value, specialNumbers?}`,
        })
        continue
      }
      const keys = Object.keys(entry)
      const extra = keys.filter(
        (key) => key !== 'key' && key !== 'value' && key !== 'specialNumbers',
      )
      if (extra.length > 0 || !hasOwn(entry, 'key') || !hasOwn(entry, 'value')) {
        issues.push({
          code: 'ARCHIVE_ENTRY_SHAPE',
          store,
          index,
          message: `${store}[${index}] must have exactly the keys key and value (specialNumbers optional); unknown: [${extra.join(', ')}]`,
        })
        continue
      }
      const key = entry['key']
      if (typeof key !== 'string') {
        issues.push({
          code: 'ARCHIVE_KEY_TYPE',
          store,
          index,
          valueType: describeValue(key),
          message: `${store}[${index}].key must be a string (found ${describeValue(key)})`,
        })
        continue
      }
      const value = entry['value']
      if (!isPlainObject(value)) {
        issues.push({
          code: 'ARCHIVE_ENTRY_SHAPE',
          store,
          index,
          key,
          message: `${store}[${index}].value must be a plain JSON object (found ${describeValue(value)})`,
        })
        continue
      }
      if (!hasOwn(value, 'id') || typeof value['id'] !== 'string' || value['id'] !== key) {
        issues.push({
          code: 'ARCHIVE_KEY_MISMATCH',
          store,
          index,
          key,
          message: `${store}[${index}]: key "${key}" must equal the value's own string id (${describeValue(value['id'])})`,
        })
        continue
      }
      const previousIndex = seen.get(key)
      if (previousIndex !== undefined) {
        issues.push({
          code: 'ARCHIVE_DUPLICATE_KEY',
          store,
          key,
          index,
          message: `${store}[${index}] repeats key "${key}" already declared at ${store}[${previousIndex}] — IndexedDB put would silently overwrite it`,
        })
        continue
      }
      seen.set(key, index)
      rows.push({ key, value, specialNumbers: entry['specialNumbers'] })
    }
    return issues.some((issue) => issue.store === store) ? null : rows
  }
  const drugRows = collectEntries(drugsArray, 'drugs')
  const metaRows = collectEntries(metaArray, 'meta')
  if (drugRows === null || metaRows === null) return fail(issues)

  // 11. Sidecar cap, then per-entry materialization (shape, pointer
  // syntax, own-only resolution, duplicates, placeholders, unannotated
  // specials, depth — §6.3/§8.2/12).
  let annotationTotal = 0
  for (const row of [...drugRows, ...metaRows]) {
    if (Array.isArray(row.specialNumbers)) annotationTotal += row.specialNumbers.length
  }
  if (annotationTotal > MAX_SPECIAL_NUMBER_ANNOTATIONS) {
    return oneIssue({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      limit: 'special numbers',
      message: `the archive declares ${annotationTotal} special-number annotations, above the limit of ${MAX_SPECIAL_NUMBER_ANNOTATIONS}`,
    })
  }
  const drugs: ValidatedRow[] = []
  const meta: ValidatedRow[] = []
  const materializeStore = (
    rows: readonly PendingRow[],
    store: RecoveryStoreName,
    target: ValidatedRow[],
  ): void => {
    for (const row of rows) {
      const materialized = materializeSpecialNumbers(row.value, row.specialNumbers, {
        store,
        key: row.key,
      })
      if (!materialized.ok) {
        for (const issue of materialized.issues) issues.push(issue)
        continue
      }
      target.push({ key: row.key, value: materialized.value })
    }
  }
  materializeStore(drugRows, 'drugs', drugs)
  materializeStore(metaRows, 'meta', meta)
  if (issues.length > 0) return fail(issues)

  return {
    ok: true,
    archive: {
      counts: archivedCounts,
      storage: {
        databaseVersion: storage['databaseVersion'],
        persistenceVersion: storage['persistenceVersion'],
      },
      exportedAt,
      drugs,
      meta,
    },
  }
}

// ---------------------------------------------------------------------------
// Preview classification and warnings (§8.3, §8.6)
// ---------------------------------------------------------------------------

/** This build's classification of the archive's drug rows (`fromRecord`). */
export function classifyArchiveDrugs(rows: readonly ValidatedRow[]): ReclassificationSummary {
  let readable = 0
  for (const row of rows) {
    if (fromRecord(row.value).ok) readable += 1
  }
  return { readable, quarantined: rows.length - readable }
}

/** Non-blocking §8.3 warnings — computed, never gating. */
export function buildRecoveryWarnings(
  archive: ValidatedArchive,
  current: CurrentBuildInfo,
  currentBuild: ReclassificationSummary,
): RecoveryWarning[] {
  const warnings: RecoveryWarning[] = []
  if (
    archive.counts.readableAtExport !== currentBuild.readable ||
    archive.counts.quarantinedAtExport !== currentBuild.quarantined
  ) {
    warnings.push({
      code: 'RECLASSIFICATION_DIFFERS',
      message: `the archive recorded ${archive.counts.readableAtExport} readable / ${archive.counts.quarantinedAtExport} quarantined at export; this build classifies ${currentBuild.readable} / ${currentBuild.quarantined}. Rows are restored verbatim either way — classification is derived, never stored.`,
    })
  }
  if (
    archive.storage.databaseVersion !== current.databaseVersion ||
    archive.storage.persistenceVersion !== current.persistenceVersion
  ) {
    warnings.push({
      code: 'STORAGE_VERSION_DIFFERS',
      message: `the archive was written by storage database version ${archive.storage.databaseVersion} / record version ${archive.storage.persistenceVersion}; this build uses ${current.databaseVersion} / ${current.persistenceVersion}. Rows keep the archive's record version — no migration is applied by restore.`,
    })
  }
  let unreadableMeta = 0
  for (const row of archive.meta) {
    if (!libraryMetadataSchema.safeParse(row.value).success) unreadableMeta += 1
  }
  if (unreadableMeta > 0) {
    warnings.push({
      code: 'ARCHIVE_META_UNREADABLE',
      message: `${unreadableMeta} of ${archive.meta.length} metadata row(s) do not validate under this build's metadata schema; they will still be restored exactly as stored.`,
    })
  }
  if (archive.counts.drugRows === 0) {
    warnings.push({
      code: 'ARCHIVE_EMPTY',
      message: 'the archive contains 0 drug rows — restoring it empties the library.',
    })
  }
  return warnings
}
