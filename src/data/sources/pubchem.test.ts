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
import { createPubChemAdapter, classifyQuery, PUBCHEM_MIN_INTERVAL_MS } from './pubchem'
import { createRateLimiter } from './limiter'
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
  // Fresh immediate limiter per adapter: non-pacing tests must neither
  // wait on real intervals nor see queue state from other tests.
  const limiter = createRateLimiter({ minIntervalMs: 0 })
  return { adapter: createPubChemAdapter({ fetchFn, now: () => NOW, limiter }), urls }
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

  it('rejects with aborted when cancelled during the synonym lookup (never downgraded)', async () => {
    const controller = new AbortController()
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('/synonyms/JSON')) {
        controller.abort() // the cancel lands while the synonym request is in flight
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      if (url.includes('/property/')) return json(propertiesFixture)
      return json(cidsFixture)
    }
    const limiter = createRateLimiter({ minIntervalMs: 0 })
    const adapter = createPubChemAdapter({ fetchFn, now: () => NOW, limiter })
    // A cancellation is not a "best-effort synonym failure": the search
    // must reject as cancelled, not resolve with partial results.
    await expect(adapter.searchCompounds('90000001', { signal: controller.signal })).rejects
      .toMatchObject({ code: 'aborted' })
  })
})

describe('PubChem adapter — request pacing', () => {
  it('keeps the default spacing below the PubChem 5-requests-per-second line', () => {
    // Official policy: no more than 5 requests per second. 1000/5 = 200 ms
    // minimum spacing; the adapter defaults to a stricter 250 ms (4/s).
    expect(PUBCHEM_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(200)
  })

  it('paces request starts across adapter instances that share one limiter', async () => {
    const clock = { value: 0 }
    const waits: number[] = []
    const limiter = createRateLimiter({
      minIntervalMs: 250,
      now: () => clock.value,
      delay: async (ms) => {
        waits.push(ms)
        clock.value += ms
      },
    })
    const urls: string[] = []
    const fetchFn: FetchLike = async (url) => {
      urls.push(url)
      if (url.includes('/property/')) return json(propertiesFixture)
      if (url.includes('/synonyms/JSON')) return json(synonymsFixture)
      return json(cidsFixture)
    }
    const a = createPubChemAdapter({ fetchFn, now: () => NOW, limiter })
    const b = createPubChemAdapter({ fetchFn, now: () => NOW, limiter })

    const [first, second] = await Promise.all([
      a.searchCompounds('90000001', {}), // direct CID: property + synonyms
      b.searchCompounds('90000001', {}),
    ])
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(urls).toHaveLength(4) // two searches × two requests each
    expect(waits).toEqual([250, 250, 250]) // three of four starts were paced
  })

  it('a request cancelled while queued behind another never reaches the network', async () => {
    const urls: string[] = []
    let release: (() => void) | undefined
    const blocked = new Promise<Response>((resolve) => {
      release = () => resolve(json(propertiesFixture))
    })
    const fetchFn: FetchLike = async (url) => {
      urls.push(url)
      if (url.includes('/property/')) return await blocked // first search stalls here
      return json(synonymsFixture)
    }
    const clock = { value: 0 }
    const limiter = createRateLimiter({
      minIntervalMs: 250,
      now: () => clock.value,
      delay: async (ms) => {
        clock.value += ms
      },
    })
    const a = createPubChemAdapter({ fetchFn, now: () => NOW, limiter })
    const b = createPubChemAdapter({ fetchFn, now: () => NOW, limiter })

    const first = a.searchCompounds('90000001', {}) // granted — fetch in flight
    const controller = new AbortController()
    const queued = b.searchCompounds('90000001', { signal: controller.signal })
    controller.abort() // cancelled while waiting for its slot
    await expect(queued).rejects.toMatchObject({ code: 'aborted' })
    expect(urls).toEqual([expect.stringContaining('/property/')]) // only the first request
    release?.()
    await first
    expect(urls).toHaveLength(2) // the first search's own two requests — no third
  })
})
