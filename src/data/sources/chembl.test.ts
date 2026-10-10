/**
 * ChEMBL adapter tests: structured search filters and their fallback,
 * activity-row mapping (endpoint, value, unit, qualifier, assay/target/
 * document context), honest omission of unusable rows, pagination
 * bookkeeping, target search and batch compound resolution. HTTP is a
 * scripted fake — normal CI never touches the live API, and every
 * payload is a checked-in synthetic fixture (not pharmacological
 * information).
 */
import { describe, expect, it } from 'vitest'
import activitiesFixture from '../../tests/fixtures/sources/chembl-activities.json'
import moleculesFixture from '../../tests/fixtures/sources/chembl-molecules.json'
import targetsFixture from '../../tests/fixtures/sources/chembl-targets.json'
import { CHEMBL_LICENSE_URL, createChEMBLAdapter } from './chembl'
import { SourceRequestError, type FetchLike } from './types'

const NOW = '2026-10-11T12:00:00.000Z'
const ACCEPT_JSON = { Accept: 'application/json' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface Recorded {
  readonly url: string
  readonly headers: HeadersInit | undefined
}

function scriptedFetch(
  routes: readonly { readonly match: string; readonly respond: () => Response }[],
): { readonly fetchFn: FetchLike; readonly calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    const route = routes.find((candidate) => url.includes(candidate.match))
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return route.respond()
  }
  return { fetchFn, calls }
}

function adapterWith(routes: Parameters<typeof scriptedFetch>[0]) {
  const { fetchFn, calls } = scriptedFetch(routes)
  return { adapter: createChEMBLAdapter({ fetchFn, now: () => NOW }), calls }
}

const MOLECULES = [{ match: 'molecule.json', respond: () => json(moleculesFixture) }]
const ACTIVITIES = [{ match: 'activity.json', respond: () => json(activitiesFixture) }]

describe('ChEMBL adapter — compound search', () => {
  it('searches by preferred name and maps identity with attribution', async () => {
    const { adapter, calls } = adapterWith(MOLECULES)
    const results = await adapter.searchCompounds('synthetic fixture', {})

    expect(calls[0]?.url).toContain('molecule.json?pref_name__icontains=synthetic%20fixture')
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      id: 'chembl:CHEMBL99990001',
      source: 'chembl',
      sourceId: 'CHEMBL99990001',
      name: 'SYNTHETIC FIXTURE COMPOUND',
      synonyms: ['Synthetic Fixture Compound', 'SFC-1'],
      identifiers: {
        chemblId: 'CHEMBL99990001',
        inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
        smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
        molecularFormula: 'C12H14N2O',
        molecularWeight: 202.25,
      },
      provenance: {
        source: 'chembl',
        sourceName: 'ChEMBL',
        recordId: 'CHEMBL99990001',
        url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
        retrievedAt: NOW,
        licenseNotice: expect.stringContaining('CC BY-SA 3.0'),
        licenseUrl: CHEMBL_LICENSE_URL,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
    // A record without a preferred name or structures keeps every absent
    // field absent instead of borrowing the id as a fake name.
    expect(results[1]?.name).toBeUndefined()
    expect(results[1]?.synonyms).toEqual([])
    expect(results[1]?.identifiers).toEqual({ chemblId: 'CHEMBL99990002' })
  })

  it('falls back to the synonym index when the preferred-name index is empty', async () => {
    const { adapter, calls } = adapterWith([
      { match: 'pref_name__icontains', respond: () => json({ molecules: [], page_meta: null }) },
      {
        match: 'molecule_synonyms__molecule_synonym__icontains',
        respond: () => json(moleculesFixture),
      },
    ])
    const results = await adapter.searchCompounds('SFC-1', {})
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toContain('molecule_synonyms__molecule_synonym__icontains=SFC-1')
    expect(results).toHaveLength(2)
  })

  it('uses the exact CHEMBL-id filter for id queries (uppercased)', async () => {
    const { adapter, calls } = adapterWith(MOLECULES)
    await adapter.searchCompounds('chembl99990001', {})
    expect(calls[0]?.url).toContain('molecule_chembl_id__iexact=CHEMBL99990001')
    expect(calls).toHaveLength(1) // no fallback for structured queries
  })

  it('uses the exact InChIKey filter for structure queries', async () => {
    const { adapter, calls } = adapterWith(MOLECULES)
    await adapter.searchCompounds('fixturekeysxyz-uhfffaoyra-n', {})
    expect(calls[0]?.url).toContain(
      'molecule_structures__standard_inchi_key__iexact=FIXTUREKEYSXYZ-UHFFFAOYRA-N',
    )
  })

  it('rejects a malformed molecule envelope as invalid-response', async () => {
    const { adapter } = adapterWith([
      { match: 'molecule.json', respond: () => json({ unexpected: [] }) },
    ])
    await expect(adapter.searchCompounds('synthetic', {})).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })

  it('makes no request for an empty query', async () => {
    const { adapter, calls } = adapterWith([])
    await expect(adapter.searchCompounds('  ', {})).resolves.toEqual([])
    expect(calls).toEqual([])
  })
})

describe('ChEMBL adapter — observations', () => {
  it('maps a full activity page: endpoints, qualifiers, context and provenance', async () => {
    const { adapter, calls } = adapterWith(ACTIVITIES)
    const page = await adapter.fetchObservations?.('CHEMBL99990001')

    expect(calls[0]?.url).toContain('activity.json?molecule_chembl_id=CHEMBL99990001')
    expect(calls[0]?.url).toContain('limit=25')
    expect(calls[0]?.url).toContain('offset=0')
    expect(calls[0]?.url).toContain('standard_type__in=Ki%2CKd%2CIC50%2CEC50')
    expect(calls[0]?.headers).toMatchObject(ACCEPT_JSON)

    expect(page?.items).toHaveLength(6)
    expect(page?.omitted).toBe(1) // the row with no numeric value
    expect(page?.total).toBe(7)
    expect(page?.nextOffset).toBeNull() // last page

    const [ic50, ki, ec50] = page?.items ?? []
    expect(ic50).toEqual({
      id: 'chembl:99000001',
      compoundId: 'chembl:CHEMBL99990001',
      compoundSourceId: 'CHEMBL99990001',
      compoundName: 'SYNTHETIC FIXTURE COMPOUND',
      target: {
        name: 'Synthetic Target A',
        sourceTargetId: 'CHEMBL99991001',
        organism: 'Homo sapiens',
      },
      endpoint: 'IC50',
      parameterKind: 'ic50',
      value: 3.5,
      unit: 'nM',
      qualifier: '=',
      species: 'Homo sapiens',
      assay: {
        assayId: 'CHEMBL99992001',
        assayType: 'B',
        description: 'Synthetic fixture binding assay (test data)',
      },
      reference: {
        referenceId: 'CHEMBL99993001',
        journal: 'Synthetic Journal of Fixtures',
        year: 2020,
      },
      provenance: {
        source: 'chembl',
        sourceName: 'ChEMBL',
        recordId: '99000001',
        url: 'https://www.ebi.ac.uk/chembl/api/data/activity.json?activity_id=99000001',
        retrievedAt: NOW,
        licenseNotice: expect.stringContaining('CC BY-SA 3.0'),
        licenseUrl: CHEMBL_LICENSE_URL,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
    // A reported '>' qualifier is kept and the Ki endpoint maps to `ki`
    // (never to IC50 or any other slot).
    expect(ki?.qualifier).toBe('>')
    expect(ki?.parameterKind).toBe('ki')
    expect(ki?.activityComment).toBe('Synthetic fixture comment')
    expect(ec50?.parameterKind).toBe('ec50')
    expect(ec50?.unit).toBe('uM')
    expect(ec50?.species).toBe('Mus musculus')
    expect(ec50?.reference).toBeUndefined() // document fields were null → absent
  })

  it('keeps unmapped endpoints, unknown relations and missing units honest', async () => {
    const { adapter } = adapterWith(ACTIVITIES)
    const page = await adapter.fetchObservations?.('CHEMBL99990001')
    const items = page?.items ?? []

    const unmapped = items.find((item) => item.id === 'chembl:99000005')
    expect(unmapped?.endpoint).toBe("Log K'")
    expect(unmapped?.parameterKind).toBeUndefined() // never forced into a slot
    expect(unmapped?.unit).toBeUndefined() // source reported none

    const unknownRelation = items.find((item) => item.id === 'chembl:99000006')
    expect(unknownRelation?.qualifier).toBeUndefined()
    // The unrecognized relation is preserved verbatim, not coerced.
    expect(unknownRelation?.rawRelation).toBe('>>')

    const limited = items.find((item) => item.id === 'chembl:99000007')
    expect(limited?.qualifier).toBe('<')
    expect(limited?.parameterKind).toBe('ic50')
    expect(limited?.dataValidityNote).toBe('Potentially invalid (synthetic marker)')
    expect(limited?.compoundName).toBeUndefined()
    expect(limited?.compoundId).toBe('chembl:CHEMBL99990002')
  })

  it('drops the parameter-endpoint filter for the "all" scope', async () => {
    const { adapter, calls } = adapterWith(ACTIVITIES)
    await adapter.fetchObservations?.('CHEMBL99990001', { endpointScope: 'all' })
    expect(calls[0]?.url).not.toContain('standard_type__in')
  })

  it('computes the next offset from page metadata', async () => {
    const { adapter } = adapterWith([
      {
        match: 'activity.json',
        respond: () =>
          json({
            activities: activitiesFixture.activities.slice(0, 3),
            page_meta: { total_count: 10, limit: 3, offset: 0 },
          }),
      },
    ])
    const page = await adapter.fetchObservations?.('CHEMBL99990001', { limit: 3 })
    expect(page?.items).toHaveLength(3)
    expect(page?.total).toBe(10)
    expect(page?.nextOffset).toBe(3)
  })

  it('rejects a malformed activity envelope as invalid-response', async () => {
    const { adapter } = adapterWith([
      { match: 'activity.json', respond: () => json({ activities: 'not-an-array' }) },
    ])
    await expect(adapter.fetchObservations?.('CHEMBL99990001')).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })

  it('queries activities by target when asked', async () => {
    const { adapter, calls } = adapterWith(ACTIVITIES)
    await adapter.fetchObservationsByTarget?.('CHEMBL99991001', { limit: 5 })
    expect(calls[0]?.url).toContain('activity.json?target_chembl_id=CHEMBL99991001')
    expect(calls[0]?.url).toContain('limit=5')
  })

  it('returns an empty page without any request for an empty id', async () => {
    const { adapter, calls } = adapterWith([])
    const page = await adapter.fetchObservations?.('   ')
    expect(page).toEqual({ items: [], total: 0, nextOffset: null, omitted: 0 })
    expect(calls).toEqual([])
  })

  it('rejects with aborted when the caller already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { adapter } = adapterWith(ACTIVITIES)
    await expect(
      adapter.fetchObservations?.('CHEMBL99990001', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' })
  })
})

describe('ChEMBL adapter — targets and batch compounds', () => {
  it('searches targets with JSON negotiation and maps the supplied fields', async () => {
    const { adapter, calls } = adapterWith([
      { match: 'target/search', respond: () => json(targetsFixture) },
    ])
    const results = await adapter.searchTargets?.('synthetic target', {})
    expect(calls[0]?.url).toContain('target/search?q=synthetic%20target')
    expect(calls[0]?.headers).toMatchObject(ACCEPT_JSON)
    expect(results).toEqual([
      {
        sourceTargetId: 'CHEMBL99991001',
        name: 'Synthetic Target A',
        organism: 'Homo sapiens',
        targetType: 'SINGLE PROTEIN',
      },
    ])
  })

  it('rejects a malformed target envelope as invalid-response', async () => {
    const { adapter } = adapterWith([
      { match: 'target/search', respond: () => json({ targets: 7 }) },
    ])
    await expect(adapter.searchTargets?.('synthetic', {})).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })

  it('batch-resolves full compound records by their source ids', async () => {
    const { adapter, calls } = adapterWith(MOLECULES)
    const results = await adapter.fetchCompounds?.(['CHEMBL99990001', 'CHEMBL99990002'])
    expect(calls[0]?.url).toContain('molecule.json?molecule_chembl_id__in=')
    expect(results).toHaveLength(2)
    expect(results?.[0]?.sourceId).toBe('CHEMBL99990001')
  })

  it('returns nothing without a request when no ids are given', async () => {
    const { adapter, calls } = adapterWith([])
    await expect(adapter.fetchCompounds?.([])).resolves.toEqual([])
    expect(calls).toEqual([])
  })
})

describe('ChEMBL adapter — transport errors surface as source errors', () => {
  it('propagates HTTP failures with their status', async () => {
    const { adapter } = adapterWith([
      { match: 'molecule.json', respond: () => json({}, 500) },
    ])
    try {
      await adapter.searchCompounds('synthetic', {})
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(SourceRequestError)
      expect((error as SourceRequestError).code).toBe('http')
      expect((error as SourceRequestError).status).toBe(500)
    }
  })
})
