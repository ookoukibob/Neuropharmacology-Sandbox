/**
 * NPSL document builder — the export direction of the interchange mapping.
 *
 * NPSL is the *only* interchange format (ADR-14): a library export is a
 * plain JSON envelope `{ formatVersion, schemaVersion, libraryMetadata,
 * drugs }` validated on read by `previewNpslImport`. The document type is
 * declared locally (with readonly fields) instead of reusing zod's inferred
 * `NpslFile`, because the domain arrays are readonly; the runtime shape is
 * identical and the round trip is proven by parsing the serialized document
 * back through the NPSL schema in the tests.
 */
import type { Drug } from '../../domain/drug/drug'
import type { DrugLibrary, LibraryMetadata } from '../../domain/library/library'
import { NPSL_FORMAT_VERSION, NPSL_SCHEMA_VERSION } from '../schemas/npsl'

export interface NpslDocument {
  readonly formatVersion: string
  readonly schemaVersion: string
  readonly libraryMetadata: LibraryMetadata
  readonly drugs: readonly Drug[]
}

/**
 * Build the portable document for a library. No field is invented or
 * rewritten: metadata, drug records, origin tags and provenance triples are
 * carried through exactly as stored (storage origin and scientific
 * provenance are distinct concepts and both survive the round trip).
 */
export function toNpslDocument(library: DrugLibrary): NpslDocument {
  return {
    formatVersion: NPSL_FORMAT_VERSION,
    schemaVersion: NPSL_SCHEMA_VERSION,
    libraryMetadata: library.metadata,
    drugs: library.drugs,
  }
}

/** Pretty-printed NPSL file content (stable key order = envelope order). */
export function serializeNpslDocument(document: NpslDocument): string {
  return JSON.stringify(document, null, 2)
}
