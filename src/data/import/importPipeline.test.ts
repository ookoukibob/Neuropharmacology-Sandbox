/**
 * NPSL import pipeline tests: parse → schema → semantic → preview.
 * Blocking vs warning classification, path-qualified errors, and the
 * no-invention rule (data is imported exactly as declared).
 */
import { describe, expect, it } from 'vitest'
import {
  syntheticDrug,
  syntheticDrugB,
  syntheticMetadata,
  syntheticNpslText,
  FIXTURE_NOTE,
} from '../../tests/fixtures'
import { fieldAt } from '../../tests/runtimeFields'
import { NPSL_SCHEMA_VERSION } from '../schemas/npsl'
import {
  parseNpsl,
  previewNpslImport,
  resolveLibraryMetadata,
  validateNpslFile,
} from './importPipeline'

function issueCodes(result: { ok: false; errors: readonly { code: string }[] }): string[] {
  return result.errors.map((e) => e.code)
}

describe('parseNpsl — envelope step', () => {
  it('reports malformed JSON as PARSE', () => {
    const result = parseNpsl('{not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(issueCodes(result)).toEqual(['PARSE'])
  })

  it('reports a non-object envelope as SCHEMA', () => {
    for (const text of ['42', '"npsl"', 'null']) {
      const result = parseNpsl(text)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(issueCodes(result)).toEqual(['SCHEMA'])
    }
  })

  it('requires declared versions', () => {
    const result = parseNpsl(JSON.stringify({ drugs: [] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.message).toContain('formatVersion')
  })

  it('rejects an incompatible major version with an explicit reason', () => {
    const result = parseNpsl(
      JSON.stringify({ formatVersion: '2.0.0', schemaVersion: NPSL_SCHEMA_VERSION, drugs: [] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(issueCodes(result)).toEqual(['VERSION'])
      expect(result.errors[0]?.message).toContain('Major version 2')
    }
  })

  it('rejects a newer minor version (update the application)', () => {
    const result = parseNpsl(
      JSON.stringify({
        formatVersion: '1.1.0',
        schemaVersion: '1.0.0',
        drugs: [],
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.message).toContain('Minor version')
  })

  it('accepts a supported envelope', () => {
    const result = parseNpsl(syntheticNpslText([syntheticDrug()]))
    expect(result.ok).toBe(true)
  })
})

describe('validateNpslFile — schema step', () => {
  it('rejects a schema violation with its zod path', () => {
    const drug = syntheticDrug() as unknown as Record<string, unknown>
    delete drug['identifiers']
    const raw = JSON.parse(syntheticNpslText([])) as Record<string, unknown>
    raw['drugs'] = [drug]
    const result = validateNpslFile(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('SCHEMA')
      expect(result.errors[0]?.path).toBe('drugs.0.identifiers')
    }
  })

  it('rejects duplicate drug ids as a blocking DUPLICATE_ID error', () => {
    const result = validateNpslFile(
      JSON.parse(syntheticNpslText([syntheticDrug(), syntheticDrug()])) as unknown,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(issueCodes(result)).toEqual(['DUPLICATE_ID'])
      expect(result.errors[0]?.message).toContain('fixture-drug-1')
    }
  })

  it('warns — but does not block — on duplicate names (names are labels)', () => {
    const second = syntheticDrug({ id: 'fixture-drug-2' })
    const result = validateNpslFile(
      JSON.parse(syntheticNpslText([syntheticDrug(), second])) as unknown,
    )
    expect(result.ok).toBe(true)
    expect(result.warnings.map((w) => w.code)).toContain('DUPLICATE_NAME')
    if (result.ok) expect(result.drugs).toHaveLength(2)
  })

  it('fills legacy missing timestamps with the provided import time', () => {
    const legacy = syntheticDrug() as unknown as Record<string, unknown>
    delete legacy['createdAt']
    delete legacy['updatedAt']
    const raw = JSON.parse(syntheticNpslText([])) as Record<string, unknown>
    raw['drugs'] = [legacy]
    const result = validateNpslFile(raw, '2026-02-03T04:05:06.000Z')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.map((w) => w.code)).toContain('TIMESTAMPS_FILLED')
      expect(result.drugs[0]?.createdAt).toBe('2026-02-03T04:05:06.000Z')
      expect(result.drugs[0]?.updatedAt).toBe('2026-02-03T04:05:06.000Z')
      // Everything else survived untouched.
      expect(result.drugs[0]?.targets[0]?.kd?.value).toBe(12.4)
    }
  })
})

describe('validateNpslFile — target id identity (unique per drug, blocking)', () => {
  /**
   * A spec-violating record: its two targets deliberately share one id —
   * the state audit DI-02 showed imports silently (synthetic fixture
   * values, never pharmacological information). Uniqueness scope is per
   * drug (docs/validation.md §4, docs/domain-model.md §2), so the same id
   * in *different* drugs must stay legal.
   */
  function drugWithDuplicateTargetIds() {
    const drug = syntheticDrug()
    const [first, second] = drug.targets
    return {
      ...drug,
      id: 'fixture-drug-dup-targets',
      identifiers: { ...drug.identifiers, name: 'Fixture Compound Dup Targets' },
      targets: [first!, { ...second!, id: first!.id }],
    }
  }

  it('rejects duplicate target ids inside one drug as a blocking DUPLICATE_ID', () => {
    const result = validateNpslFile(
      JSON.parse(syntheticNpslText([drugWithDuplicateTargetIds()])) as unknown,
    )
    // Regression (audit DI-02 repro R2): this accepted the file with ok:true.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(issueCodes(result)).toEqual(['DUPLICATE_ID'])
      const issue = result.errors[0]
      expect(issue?.message).toContain('fixture-target-1')
      expect(issue?.message).toContain('Fixture Compound Dup Targets')
      expect(issue?.path).toBe('drugs.0.targets')
    }
  })

  it('accepts a drug whose target ids are all distinct', () => {
    const result = validateNpslFile(JSON.parse(syntheticNpslText([syntheticDrug()])) as unknown)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.drugs[0]?.targets.map((t) => t.id)).toEqual([
        'fixture-target-1',
        'fixture-target-2',
      ])
    }
  })

  it('allows the same target id in two different drugs (uniqueness is per drug)', () => {
    const first = syntheticDrug()
    const second = syntheticDrug({
      id: 'fixture-drug-2',
      identifiers: { name: 'Fixture Compound B', synonyms: [], description: FIXTURE_NOTE },
      targets: [first.targets[0]!],
    })
    const result = validateNpslFile(
      JSON.parse(syntheticNpslText([first, second])) as unknown,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.drugs).toHaveLength(2)
  })

  it('leaves missing or empty target ids to the schema — never a duplicate error', () => {
    for (const mode of ['missing', 'empty'] as const) {
      const drug = syntheticDrug() as unknown as Record<string, unknown>
      const targets = drug['targets'] as Record<string, unknown>[]
      if (mode === 'missing') delete targets[0]!['id']
      else targets[0]!['id'] = ''
      const raw = JSON.parse(syntheticNpslText([])) as Record<string, unknown>
      raw['drugs'] = [drug]
      const result = validateNpslFile(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(issueCodes(result)).toEqual(['SCHEMA'])
        expect(result.errors[0]?.path).toBe('drugs.0.targets.0.id')
      }
    }
  })

  it('rejects a mixed document: one drug with duplicate target ids blocks the whole file', () => {
    const result = validateNpslFile(
      JSON.parse(syntheticNpslText([syntheticDrug(), drugWithDuplicateTargetIds()])) as unknown,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(issueCodes(result)).toEqual(['DUPLICATE_ID'])
      expect(result.errors[0]?.path).toBe('drugs.1.targets')
      // The valid drug in the same document is not handed out for writing.
      expect(result).not.toHaveProperty('drugs')
    }
  })

  it('previewNpslImport surfaces the rejection instead of import stats', () => {
    const preview = previewNpslImport(syntheticNpslText([drugWithDuplicateTargetIds()]))
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.errors.map((e) => e.code)).toEqual(['DUPLICATE_ID'])
  })
})

describe('validateNpslFile — semantic unit checks (warn, never rewrite)', () => {
  it('warns on an unknown unit and imports the value exactly as declared', () => {
    const drug = syntheticDrug()
    const withOddUnit = {
      ...drug,
      targets: drug.targets.map((target) =>
        target.id === 'fixture-target-1' && target.kd !== undefined
          ? { ...target, kd: { ...target.kd, unit: 'flibbertigibbits' } }
          : target,
      ),
    }
    const result = validateNpslFile(JSON.parse(syntheticNpslText([withOddUnit])) as unknown)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.map((w) => w.code)).toContain('UNKNOWN_UNIT')
      expect(result.drugs[0]?.targets[0]?.kd?.unit).toBe('flibbertigibbits')
    }
  })

  it('warns when a concentration parameter declares a time unit', () => {
    const drug = syntheticDrug()
    const wrongDimension = {
      ...drug,
      targets: drug.targets.map((target) =>
        target.id === 'fixture-target-1' && target.kd !== undefined
          ? { ...target, kd: { ...target.kd, unit: 'h' } }
          : target,
      ),
    }
    const result = validateNpslFile(JSON.parse(syntheticNpslText([wrongDimension])) as unknown)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.map((w) => w.code)).toContain('UNEXPECTED_DIMENSION')
      expect(result.drugs[0]?.targets[0]?.kd?.unit).toBe('h')
    }
  })

  it('accepts mass-concentration units for target parameters (both are valid)', () => {
    const drug = syntheticDrug()
    const massConcentration = {
      ...drug,
      targets: drug.targets.map((target) =>
        target.id === 'fixture-target-1' && target.kd !== undefined
          ? { ...target, kd: { ...target.kd, unit: 'mg/L' } }
          : target,
      ),
    }
    const result = validateNpslFile(JSON.parse(syntheticNpslText([massConcentration])) as unknown)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toHaveLength(0)
  })
})

describe('resolveLibraryMetadata', () => {
  it('keeps a declared id and fills a missing one', () => {
    const declared = syntheticMetadata()
    expect(resolveLibraryMetadata(declared).id).toBe('fixture-library')
    const { id: _declared, ...withoutId } = declared
    expect(resolveLibraryMetadata(withoutId).id).toBe('local-library')
    expect(resolveLibraryMetadata(withoutId, 'other').id).toBe('other')
  })

  it('carries unknown extension fields forward without letting them shadow known ones', () => {
    const metadata = {
      ...syntheticMetadata(),
      customMetadataField: { nested: 'meta-ext' },
    }
    const resolved = resolveLibraryMetadata(metadata)
    expect(fieldAt(resolved, 'customMetadataField')).toEqual({ nested: 'meta-ext' })
    expect(resolved.id).toBe('fixture-library')
    expect(resolved.name).toBe(syntheticMetadata().name)
    expect(resolved.dataStatus).toBe(syntheticMetadata().dataStatus)

    // Even an extension sitting on a *missing-id* input cannot take over
    // `id`: the fallback still wins because known fields are rebuilt.
    const { id: _noId, ...withoutId } = metadata
    const filled = resolveLibraryMetadata(withoutId, 'local-library')
    expect(fieldAt(filled, 'customMetadataField')).toEqual({ nested: 'meta-ext' })
    expect(filled.id).toBe('local-library')
  })
})

describe('previewNpslImport — preview step', () => {
  it('returns domain drugs, warnings, and stats against the current library', () => {
    const text = syntheticNpslText([syntheticDrug(), syntheticDrugB()])
    const preview = previewNpslImport(text, ['fixture-drug-1'])
    expect(preview.ok).toBe(true)
    if (preview.ok) {
      expect(preview.stats).toEqual({ total: 2, newIds: 1, conflictingIds: 1 })
      expect(preview.metadata.name).toBe('Synthetic fixture library')
      expect(preview.metadata.dataStatus).toBe('example')
      expect(preview.drugs[0]?.identifiers.description).toBe(FIXTURE_NOTE)
      // Provenance rides whole through the preview.
      expect(preview.drugs[0]?.targets[0]?.kd?.provenance).toEqual({
        type: 'literature',
        source: 'Synthetic fixture source',
        citation: 'Invented for tests, 2026',
      })
    }
  })

  it('aggregates parse failures without any stats', () => {
    const preview = previewNpslImport('{broken')
    expect(preview.ok).toBe(false)
    if (!preview.ok) {
      expect(preview.errors[0]?.code).toBe('PARSE')
      expect(preview.warnings).toEqual([])
    }
  })

  it('reports schema errors and semantic warnings together', () => {
    const bad = syntheticDrug() as unknown as Record<string, unknown>
    delete bad['id']
    const raw = JSON.parse(syntheticNpslText([syntheticDrugB()])) as Record<string, unknown>
    raw['drugs'] = [bad, syntheticDrugB()]
    const preview = previewNpslImport(JSON.stringify(raw))
    expect(preview.ok).toBe(false)
    if (!preview.ok) {
      expect(preview.errors.map((e) => e.code)).toContain('SCHEMA')
    }
  })
})

describe('extension fields — preview and envelope reporting', () => {
  it('carries unknown drug and metadata fields into the preview objects', () => {
    const raw = JSON.parse(syntheticNpslText([syntheticDrug()])) as Record<string, unknown>
    const metadata = raw['libraryMetadata'] as Record<string, unknown>
    metadata['customMetadataField'] = 'meta-ext'
    const drugs = raw['drugs'] as Record<string, unknown>[]
    const drug = drugs[0]
    if (drug === undefined) throw new Error('fixture needs a drug')
    drug['rootExtension'] = 'root-ext'
    ;(drug['identifiers'] as Record<string, unknown>)['identifierExtension'] = 'id-ext'
    const targets = drug['targets'] as Record<string, unknown>[]
    const target = targets[0]
    if (target === undefined) throw new Error('fixture needs a target')
    target['targetExtension'] = 'target-ext'
    const kd = target['kd'] as Record<string, unknown>
    kd['parameterExtension'] = 'param-ext'
    ;(kd['provenance'] as Record<string, unknown>)['provenanceExtension'] = 'prov-ext'
    ;(drug['pharmacokinetics'] as Record<string, unknown>)['pkExtension'] = 'pk-ext'

    const preview = previewNpslImport(JSON.stringify(raw))
    expect(preview.ok).toBe(true)
    if (preview.ok) {
      expect(fieldAt(preview.metadata, 'customMetadataField')).toBe('meta-ext')
      expect(fieldAt(preview.drugs[0], 'rootExtension')).toBe('root-ext')
      expect(fieldAt(preview.drugs[0], 'identifiers', 'identifierExtension')).toBe('id-ext')
      expect(fieldAt(preview.drugs[0], 'targets', '0', 'targetExtension')).toBe('target-ext')
      expect(fieldAt(preview.drugs[0], 'targets', '0', 'kd', 'parameterExtension')).toBe('param-ext')
      expect(fieldAt(preview.drugs[0], 'targets', '0', 'kd', 'provenance', 'provenanceExtension')).toBe('prov-ext')
      expect(fieldAt(preview.drugs[0], 'pharmacokinetics', 'pkExtension')).toBe('pk-ext')
      // A clean envelope produces no envelope warning.
      expect(preview.warnings.map((w) => w.code)).not.toContain('ENVELOPE_FIELDS_DROPPED')
      // Known values still validate and preview normally.
      expect(preview.drugs[0]?.targets[0]?.kd?.value).toBe(12.4)
    }
  })

  it('warns about unknown top-level envelope fields without blocking the import', () => {
    const raw = JSON.parse(syntheticNpslText([syntheticDrug()])) as Record<string, unknown>
    raw['futureEnvelopeField'] = { x: 1 }
    const preview = previewNpslImport(JSON.stringify(raw))
    expect(preview.ok).toBe(true)
    if (preview.ok) {
      const warning = preview.warnings.find((w) => w.code === 'ENVELOPE_FIELDS_DROPPED')
      expect(warning).toBeDefined()
      expect(warning?.message).toContain('futureEnvelopeField')
      // The warning is non-blocking: drugs still preview normally.
      expect(preview.drugs).toHaveLength(1)
      expect(preview.stats.total).toBe(1)
    }
  })
})
