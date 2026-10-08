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
