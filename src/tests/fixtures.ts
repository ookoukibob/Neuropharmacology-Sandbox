/**
 * Synthetic test fixtures — NOT pharmacological information.
 *
 * Every value in this file is invented for automated tests. Fixture records
 * carry this label in their own fields (description/dataStatus) so they can
 * never be mistaken for sourced drug data if they leak into a view.
 */
import type { Drug } from '../domain/drug/drug'
import type { DrugLibrary, LibraryMetadata } from '../domain/library/library'

export const FIXTURE_NOTE = 'Synthetic test fixture — not pharmacological information.'

export const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z'

/** A fully-populated, deterministic drug record for mapper/repository tests. */
export function syntheticDrug(overrides: Partial<Drug> = {}): Drug {
  const base: Drug = {
    id: 'fixture-drug-1',
    origin: 'user',
    identifiers: {
      name: 'Fixture Compound A',
      synonyms: ['FCA'],
      description: FIXTURE_NOTE,
    },
    tags: ['fixture'],
    targets: [
      {
        id: 'fixture-target-1',
        name: 'TEST-R',
        action: 'antagonist',
        kd: {
          value: 12.4,
          unit: 'nM',
          provenance: {
            type: 'literature',
            source: 'Synthetic fixture source',
            citation: 'Invented for tests, 2026',
          },
        },
        notes: FIXTURE_NOTE,
      },
      {
        id: 'fixture-target-2',
        name: 'TEST-S',
        ic50: {
          value: 88,
          unit: 'nM',
          provenance: { type: 'user', recordedAt: FIXTURE_TIMESTAMP },
        },
      },
    ],
    pharmacokinetics: {
      halfLife: {
        value: 8,
        unit: 'h',
        provenance: { type: 'user', recordedAt: FIXTURE_TIMESTAMP },
      },
      notes: FIXTURE_NOTE,
    },
    notes: FIXTURE_NOTE,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  }
  return { ...base, ...overrides }
}

/** Second deterministic record (distinct id/name) for multi-record tests. */
export function syntheticDrugB(): Drug {
  return syntheticDrug({
    id: 'fixture-drug-2',
    identifiers: {
      name: 'Fixture Compound B',
      synonyms: [],
      description: FIXTURE_NOTE,
    },
    tags: ['fixture', 'second'],
    targets: [],
    pharmacokinetics: {},
  })
}

export function syntheticMetadata(overrides: Partial<LibraryMetadata> = {}): LibraryMetadata {
  return {
    id: 'fixture-library',
    name: 'Synthetic fixture library',
    description: FIXTURE_NOTE,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    // Example data by construction — never "sourced".
    dataStatus: 'example',
    ...overrides,
  }
}

/** NPSL file text for import tests (hand-built envelope, fixed versions). */
export function syntheticNpslText(
  drugs: readonly Drug[],
  overrides: Partial<LibraryMetadata> = {},
): string {
  return JSON.stringify({
    formatVersion: '1.0.0',
    schemaVersion: '1.0.0',
    libraryMetadata: syntheticMetadata(overrides),
    drugs,
  })
}

export function syntheticLibrary(drugs: readonly Drug[]): DrugLibrary {
  return { metadata: syntheticMetadata(), drugs }
}
