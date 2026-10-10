/**
 * PubChem adapter tests: query classification, response validation,
 * field mapping, missing-field honesty, best-effort synonyms and the
 * "no match is empty, not an error" rule. HTTP is a scripted fake —
 * normal CI never touches the live API, and every payload is a
 * checked-in synthetic fixture (not pharmacological information).
 */
import { describe, expect, it } from 'vitest'
import cidsFixture from '../../tests/fixtures/sources/pubchem-cids.json'
import propertiesFixture from '../../tests/fixtures/sources/pubchem-properties.json'
import synonymsFixture from '../../tests/fixtures/sources/pubchem-synonyms.json'
import { createPubChemAdapter, classifyQuery } from './pubchem'
import { SourceRequestError, type FetchLike } from './types'

const NOW = '2026-10-11T12:00:00.000Z'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Route by URL fragment; unhandled URLs fail loudly in the test. */
function scriptedFetch(
  routes: readonly { readonly match: string; readonly respond: () => Response }[],
): { readonly fetchFn: FetchLike; readonly urls: string[] } {
  const urls: string[] = []
  const fetchFn: FetchLike = async (url) => {
    urls.push(url)
    const route = routes.find((candidate) => url.includes(candidate.match))
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return route.respond()
  }
  return { fetchFn, urls }
}

function adapterWith(routes: Parameters<typeof scriptedFetch>[0]) {
  const { fetchFn, urls } = scriptedFetch(routes)
  return { adapter: createPubChemAdapter({ fetchFn, now: () => NOW }), urls }
}

/** The full happy-path routing for a name/CID search. */
const HAPPY_ROUTES = [
  { match: '/cids/JSON', respond: () => json(cidsFixture) },
  { match: '/property/', respond: () => json(propertiesFixture) },
  { match: '/synonyms/JSON', respond: () => json(synonymsFixture) },
]

describe('classifyQuery', () => {
  it('classifies numeric, InChIKey and name queries', () => {
    expect(classifyQuery('90000001')).toBe('cid')
    expect(classifyQuery('FIXTUREKEYSXYZ-UHFFFAOYSA-N')).toBe('inchikey')
    expect(classifyQuery('50-78-2')).toBe('name') // CAS goes through the name resolver
    expect(classifyQuery('synthetic fixture compound')).toBe('name')
  })
})

describe('PubChem adapter — search', () => {
  it('resolves a name query to validated identity records with provenance', async () => {
    const { adapter, urls } = adapterWith(HAPPY_ROUTES)
    const results = await adapter.searchCompounds('synthetic fixture compound', {})

    expect(urls[0]).toContain('compound/name/synthetic%20fixture%20compound/cids/JSON')
    expect(urls[1]).toContain('compound/cid/90000001/property/')
    expect(urls[2]).toContain('compound/cid/90000001/synonyms/JSON')
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      id: 'pubchem:90000001',
      source: 'pubchem',
      sourceId: '90000001',
      name: 'Synthetic Fixture Compound',
      synonyms: [
        'Synthetic Fixture Compound',
        'SFC-1',
        'Fixture synonym 3',
        'Fixture synonym 4',
        'Fixture synonym 5',
        'Fixture synonym 6',
        'Fixture synonym 7',
        'Fixture synonym 8',
        'Fixture synonym 9',
        'Fixture synonym 10',
      ],
      identifiers: {
        pubchemCid: '90000001',
        molecularFormula: 'C12H14N2O',
        molecularWeight: 202.25,
        smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
        inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      },
      provenance: {
        source: 'pubchem',
        sourceName: 'PubChem',
        recordId: '90000001',
        url: 'https://pubchem.ncbi.nlm.nih.gov/compound/90000001',
        retrievedAt: NOW,
        licenseNotice: expect.stringContaining('PubChem aggregates'),
        licenseUrl: 'https://pubchem.ncbi.nlm.nih.gov/docs/downloads',
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  it('treats a numeric query as a direct CID (no identifier lookup)', async () => {
    const { adapter, urls } = adapterWith(HAPPY_ROUTES)
    const results = await adapter.searchCompounds('90000001', {})
    expect(urls.some((url) => url.includes('/cids/JSON'))).toBe(false)
    expect(urls[0]).toContain('compound/cid/90000001/property/')
    expect(results).toHaveLength(1)
  })

  it('resolves an InChIKey query through the InChIKey endpoint', async () => {
    const { adapter, urls } = adapterWith(HAPPY_ROUTES)
    await adapter.searchCompounds('FIXTUREKEYSXYZ-UHFFFAOYSA-N', {})
    expect(urls[0]).toContain('compound/inchikey/FIXTUREKEYSXYZ-UHFFFAOYSA-N/cids/JSON')
  })

  it('returns an empty result when the source reports no match (404 fault)', async () => {
    const { adapter, urls } = adapterWith([
      {
        match: '/cids/JSON',
        respond: () =>
          json({ Fault: { Code: 'PUGREST.NotFound', Message: 'No CID found' } }, 404),
      },
    ])
    await expect(adapter.searchCompounds('zzz not a compound', {})).resolves.toEqual([])
    expect(urls).toHaveLength(1)
  })

  it('rejects a malformed identifier envelope as invalid-response', async () => {
    const { adapter } = adapterWith([{ match: '/cids/JSON', respond: () => json({ nope: true }) }])
    await expect(adapter.searchCompounds('synthetic', {})).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })

  it('skips malformed property rows instead of fabricating records', async () => {
    const { adapter } = adapterWith([
      { match: '/cids/JSON', respond: () => json(cidsFixture) },
      {
        match: '/property/',
        respond: () =>
          json({
            PropertyTable: {
              Properties: [{ totally: 'wrong' }, { CID: 90000001, Title: 'Kept Record' }],
            },
          }),
      },
      { match: '/synonyms/JSON', respond: () => json(synonymsFixture) },
    ])
    const results = await adapter.searchCompounds('synthetic fixture compound', {})
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('Kept Record')
    // Missing fields stay missing — no invented identifiers.
    expect(results[0]?.identifiers).toEqual({ pubchemCid: '90000001' })
  })

  it('keeps the search working when only the synonym lookup fails', async () => {
    const { adapter } = adapterWith([
      { match: '/cids/JSON', respond: () => json(cidsFixture) },
      { match: '/property/', respond: () => json(propertiesFixture) },
      { match: '/synonyms/JSON', respond: () => json({}, 500) },
    ])
    const results = await adapter.searchCompounds('synthetic fixture compound', {})
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('Synthetic Fixture Compound')
    expect(results[0]?.synonyms).toEqual([])
  })

  it('makes no request for an empty or whitespace-only query', async () => {
    const { adapter, urls } = adapterWith([])
    await expect(adapter.searchCompounds('   ', {})).resolves.toEqual([])
    expect(urls).toEqual([])
  })

  it('propagates cancellation as an aborted error', async () => {
    const controller = new AbortController()
    controller.abort()
    const { adapter } = adapterWith(HAPPY_ROUTES)
    try {
      await adapter.searchCompounds('synthetic', { signal: controller.signal })
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(SourceRequestError)
      expect((error as SourceRequestError).code).toBe('aborted')
    }
  })
})
