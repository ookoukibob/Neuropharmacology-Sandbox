/**
 * Source-record schema tests: attribution URL integrity at the
 * repository boundary (absolute HTTPS only, parsed with the platform URL
 * parser — never fetched or navigated) plus the existing synthetic
 * fixtures continuing to validate. All record content is synthetic test
 * data — not pharmacological information.
 */
import { describe, expect, it } from 'vitest'
import { syntheticCompound, syntheticObservation } from '../../tests/fixtures'
import { compoundRecordSchema, observationRecordSchema, sourceAttributionSchema } from './sources'

const NOW = '2026-10-11T12:00:00.000Z'

function attribution(url: string, licenseUrl?: string): Record<string, unknown> {
  return {
    source: 'pubchem',
    sourceName: 'PubChem',
    recordId: '90000001',
    url,
    retrievedAt: NOW,
    ...(licenseUrl !== undefined ? { licenseUrl } : {}),
  }
}

describe('sourceAttributionSchema — URL integrity', () => {
  it('accepts absolute HTTPS record and license URLs', () => {
    const parsed = sourceAttributionSchema.safeParse(
      attribution(
        'https://pubchem.ncbi.nlm.nih.gov/compound/90000001',
        'https://pubchem.ncbi.nlm.nih.gov/docs/downloads',
      ),
    )
    expect(parsed.success).toBe(true)
  })

  it('keeps a missing licenseUrl missing — nothing is invented', () => {
    const parsed = sourceAttributionSchema.safeParse(attribution('https://example.test/r/1'))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.licenseUrl).toBeUndefined()
  })

  it.each([
    ['malformed URL', 'https://'],
    ['not a URL at all', 'pubchem compound 90000001'],
    ['relative path', '/compound/90000001'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['file: scheme', 'file:///etc/passwd'],
    ['plain http', 'http://pubchem.ncbi.nlm.nih.gov/compound/90000001'],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('rejects a %s as the record URL, naming the field', (_label, url) => {
    const parsed = sourceAttributionSchema.safeParse(attribution(url))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['url'])
      expect(parsed.error.issues[0]?.message).toContain('absolute HTTPS URL')
    }
  })

  it.each([
    ['relative path', '/docs/downloads'],
    ['javascript: scheme', 'javascript:void(0)'],
    ['plain http', 'http://creativecommons.org/licenses/by-sa/3.0/'],
  ])('rejects a %s as the license URL, naming the field', (_label, licenseUrl) => {
    const parsed = sourceAttributionSchema.safeParse(
      attribution('https://example.test/r/1', licenseUrl),
    )
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['licenseUrl'])
    }
  })

  it('still preserves unknown fields (forward compatibility)', () => {
    const parsed = sourceAttributionSchema.safeParse({
      ...attribution('https://example.test/r/1'),
      futureField: 'kept',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['futureField']).toBe('kept')
    }
  })
})

describe('existing valid fixtures still validate', () => {
  it('accepts the synthetic compound fixture (https provenance)', () => {
    expect(compoundRecordSchema.safeParse(syntheticCompound()).success).toBe(true)
  })

  it('accepts the synthetic observation fixture (https provenance)', () => {
    expect(observationRecordSchema.safeParse(syntheticObservation()).success).toBe(true)
  })
})
