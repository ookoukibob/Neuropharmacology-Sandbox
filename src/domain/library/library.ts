import type { Drug } from '../drug/drug'

/**
 * Library-level metadata for a drug collection (the live IndexedDB library
 * and the portable .npsl file share this shape).
 *
 * `dataStatus` makes example/demo data explicit — required by the spec:
 * built-in demo libraries must never be mistaken for sourced data.
 */
export type LibraryDataStatus =
  /** Synthetic example data — not pharmacological information. */
  | 'example'
  /** Sourced from documented references (see per-parameter provenance). */
  | 'sourced'
  /** Mix of sourced and unsourced entries. */
  | 'mixed'
  /** Entered by the user. */
  | 'user'
  /** Not declared by the file/library. */
  | 'unspecified'

export interface LibraryMetadata {
  readonly id: string
  readonly name: string
  readonly author?: string
  readonly description?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly dataStatus: LibraryDataStatus
}

/** The application's in-memory representation of a drug collection. */
export interface DrugLibrary {
  readonly metadata: LibraryMetadata
  readonly drugs: readonly Drug[]
}
