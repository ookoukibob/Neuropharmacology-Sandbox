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

/**
 * Negative-zero placeholder used during serialization (data-integrity
 * audit DI-04): `JSON.stringify` canonicalizes the number `-0` to `0`,
 * silently flipping the stored sign. The serializer tags every
 * negative-zero number — inside recognized scientific values and unknown
 * extension fields alike — with this placeholder *string* and rewrites
 * exactly those positions back to the valid JSON number token `-0`.
 * NUL-delimited so no realistic value can collide, and
 * `serializeNpslDocument` proves the exact JSON literal absent from the
 * document before any replacement happens.
 */
const NEGATIVE_ZERO_PLACEHOLDER = '\u0000npsl-negative-zero\u0000'

/**
 * Pretty-printed NPSL file content (stable key order = envelope order).
 *
 * Negative zero is emitted as the numeric JSON token `-0` — exact
 * preservation of the stored sign (audit DI-04); every other value
 * serializes exactly as `JSON.stringify` would, and no source value,
 * string or extension field is ever rewritten.
 */
export function serializeNpslDocument(document: NpslDocument): string {
  // Collision proof: serialize once WITHOUT tagging; if the placeholder's
  // exact JSON literal already occurs anywhere in that text, a user string
  // coincides with it and replacement could corrupt that string — extend
  // the placeholder until its literal is provably absent. The untagged
  // text is fixed for a given document and has finite length, so the loop
  // terminates.
  const plain = JSON.stringify(document, null, 2)
  let placeholder = NEGATIVE_ZERO_PLACEHOLDER
  let literal = JSON.stringify(placeholder)
  while (plain.includes(literal)) {
    placeholder += '-extended'
    literal = JSON.stringify(placeholder)
  }
  const tagged = JSON.stringify(
    document,
    (_key: string, value: unknown) =>
      typeof value === 'number' && Object.is(value, -0) ? placeholder : value,
    2,
  )
  // Restore every tagged position to the numeric token `-0`; untagged
  // occurrences of the literal (none, by the proof above) can never match,
  // and strings that merely look like the tokens stay strings.
  return tagged.split(literal).join('-0')
}
