/**
 * `.npsb` recovery archive format — constants, limits, error/warning codes
 * and envelope types (ADR-18, docs/recovery-backup.md).
 *
 * Pure data + pure helpers: no Dexie, no DOM, no schema imports. The UI
 * imports the limits and codes from here without dragging any storage
 * machinery into the feature layer.
 *
 * The version space is INDEPENDENT of NPSL (`formatVersion`/
 * `schemaVersion`): `backupVersion` evolves only with this archive format
 * and the two spaces never read each other's constants (§3 of the spec).
 */

export const BACKUP_FORMAT_ID = 'npsb'
export const BACKUP_VERSION = '1.0.0'
export const BACKUP_EXTENSION = '.npsb'
export const BACKUP_MIME_TYPE = 'application/json;charset=utf-8'

/** Resource limits (docs/recovery-backup.md §12). */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_DRUG_ROWS = 100_000
export const MAX_META_ROWS = 1_000
export const MAX_SPECIAL_NUMBER_ANNOTATIONS = 1_000_000
export const MAX_DEPTH = 100

export type RecoveryStoreName = 'drugs' | 'meta'

/** The four JSON-unrepresentable numeric shapes carried by the sidecar. */
export type SpecialNumberKind = '-0' | 'NaN' | 'Infinity' | '-Infinity'

export const SPECIAL_NUMBER_KINDS: readonly SpecialNumberKind[] = [
  '-0',
  'NaN',
  'Infinity',
  '-Infinity',
]

export function isSpecialNumberKind(value: unknown): value is SpecialNumberKind {
  return SPECIAL_NUMBER_KINDS.some((kind) => kind === value)
}

export interface SpecialNumberAnnotation {
  /** RFC 6901 JSON Pointer relative to the entry's `value`. */
  readonly path: string
  readonly kind: SpecialNumberKind
}

/** Export-time facts of the snapshot (structural assertions, §4.1). */
export interface RecoveryCounts {
  readonly drugRows: number
  readonly readableAtExport: number
  readonly quarantinedAtExport: number
  readonly metaRows: number
}

/** Informational diagnostics recorded by the exporting build (§4.1). */
export interface RecoveryStorageInfo {
  readonly databaseVersion: number
  readonly persistenceVersion: number
}

export interface RecoveryEntry {
  readonly key: string
  readonly value: Record<string, unknown>
  readonly specialNumbers?: readonly SpecialNumberAnnotation[]
}

/** The exact seven-key v1 envelope (§4.1). */
export interface RecoveryArchive {
  readonly formatId: string
  readonly backupVersion: string
  readonly exportedAt: string
  readonly storage: RecoveryStorageInfo
  readonly counts: RecoveryCounts
  readonly drugs: readonly RecoveryEntry[]
  readonly meta: readonly RecoveryEntry[]
}

export type RecoveryErrorCode =
  // Export (BACKUP_*): any occurrence means no file is produced.
  | 'BACKUP_READ_FAILED'
  | 'BACKUP_UNSUPPORTED_VALUE'
  | 'BACKUP_UNSUPPORTED_KEY'
  | 'BACKUP_VERIFY_FAILED'
  | 'BACKUP_LIMIT_EXCEEDED'
  // Restore validation (ARCHIVE_*): no write transaction is opened.
  | 'ARCHIVE_TOO_LARGE'
  | 'ARCHIVE_PARSE'
  | 'ARCHIVE_DUPLICATE_JSON_KEY'
  | 'ARCHIVE_NOT_NPSB'
  | 'ARCHIVE_VERSION'
  | 'ARCHIVE_ENVELOPE_SHAPE'
  | 'ARCHIVE_COUNT_MISMATCH'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'ARCHIVE_ENTRY_SHAPE'
  | 'ARCHIVE_KEY_TYPE'
  | 'ARCHIVE_KEY_MISMATCH'
  | 'ARCHIVE_DUPLICATE_KEY'
  | 'ARCHIVE_ANNOTATION_SHAPE'
  | 'ARCHIVE_ANNOTATION_PATH'
  | 'ARCHIVE_ANNOTATION_DUPLICATE'
  | 'ARCHIVE_ANNOTATION_PLACEHOLDER'
  | 'ARCHIVE_VALUE_DOMAIN'

/**
 * Structured diagnostic. Payload carries the store, row key (or entry
 * index) and property path where applicable — enough to locate the
 * offending data without a debugger (§10).
 */
export interface RecoveryIssue {
  readonly code: RecoveryErrorCode
  readonly message: string
  readonly store?: RecoveryStoreName
  readonly key?: string
  /** Entry index inside the store's array (entry-level problems). */
  readonly index?: number
  /** RFC 6901 pointer (root `""`) of the offending property. */
  readonly path?: string
  /** Runtime type name for unsupported values/keys. */
  readonly valueType?: string
  /** Which §12 limit was exceeded (limit violations only). */
  readonly limit?: string
}

export type RecoveryWarningCode =
  | 'RECLASSIFICATION_DIFFERS'
  | 'STORAGE_VERSION_DIFFERS'
  | 'ARCHIVE_META_UNREADABLE'
  | 'ARCHIVE_EMPTY'

/** Non-blocking preview/restore warning (§8.3) — never gates a restore. */
export interface RecoveryWarning {
  readonly code: RecoveryWarningCode
  readonly message: string
}

export type BackupVersionCompatibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * `backupVersion` compatibility — the NPSL rule (equal major, file minor
 * ≤ reader minor) with a separate implementation, as required by §3: the
 * version spaces are independent and must not share code paths.
 */
export function checkBackupVersion(candidate: string): BackupVersionCompatibility {
  if (!/^\d+\.\d+\.\d+$/.test(candidate)) {
    return { ok: false, reason: `version "${candidate}" is not a valid semantic version` }
  }
  const [cMajor = Number.NaN, cMinor = Number.NaN] = candidate.split('.').map(Number)
  const [rMajor = Number.NaN, rMinor = Number.NaN] = BACKUP_VERSION.split('.').map(Number)
  if (cMajor !== rMajor) {
    return {
      ok: false,
      reason: `Major version ${cMajor} is not supported (this build reads major version ${rMajor}).`,
    }
  }
  if (cMinor > rMinor) {
    return {
      ok: false,
      reason: `Minor version ${candidate} is newer than supported ${BACKUP_VERSION}; update the application to restore this archive.`,
    }
  }
  return { ok: true }
}
