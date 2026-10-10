/**
 * PubChem adapter (PUG REST) — compound identity on demand.
 *
 * What it does (verified against the live API before implementation):
 * - resolves a query to CIDs: a numeric query is treated as a CID, an
 *   InChIKey-shaped query goes through the InChIKey resolver, anything
 *   else (names, CAS numbers, synonyms) through the name resolver;
 * - fetches identity/property records for the returned CIDs in one batched
 *   property request (title, IUPAC name, formula, molecular weight,
 *   connectivity SMILES, InChIKey);
 * - fetches synonyms in one batched request — best-effort: if that request
 *   fails the records are still returned with empty synonym lists rather
 *   than losing the whole search (missing stays missing).
 *
 * It offers no experimental-observation endpoint in this version: PubChem
 * bioassay data is not surfaced as Layer B records, and the UI does not
 * pretend otherwise (`capabilities.observations === false`).
 *
 * HTTP, parsing and normalization are separated: `fetchJson` owns the
 * transport policy, zod schemas validate every response envelope and row,
 * and this module only maps validated data onto domain records. Remote
 * JSON is never trusted because it compiled.
 */
import { z } from 'zod'
import { compoundId, type CompoundIdentifiers, type RemoteCompound } from '../../domain/sources/compound'
import { fetchJson, type FetchJsonOptions } from './http'
import { numberOf, textOf, uniqueStrings } from './normalize'
import {
  SourceRequestError,
  type FetchLike,
  type RequestOptions,
  type SourceAdapter,
} from './types'

const PUBCHEM_PUG_BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug'
const COMPOUND_PAGE_BASE = 'https://pubchem.ncbi.nlm.nih.gov/compound/'

/** Attribution shown with every PubChem record (no license assumed). */
export const PUBCHEM_LICENSE_NOTICE =
  'PubChem aggregates contributions from many data providers; record-level terms can differ. Review PubChem and its contributing sources before redistribution.'
export const PUBCHEM_LICENSE_URL = 'https://pubchem.ncbi.nlm.nih.gov/docs/downloads'

/** Identity search caps: enough candidates to choose from, bounded traffic. */
const MAX_QUERY_CIDS = 8
const MAX_SYNONYMS = 10
const PROPERTY_LIST =
  'Title,IUPACName,MolecularFormula,MolecularWeight,ConnectivitySMILES,InChIKey'

const INCHIKEY_PATTERN = /^[A-Za-z]{14}-[A-Za-z]{10}-[A-Za-z]$/

// --- Response schemas (validated, never trusted) -------------------------

const cidListSchema = z.looseObject({
  IdentifierList: z.looseObject({ CID: z.array(z.number()) }),
})

const propertyRowSchema = z.looseObject({
  CID: z.number(),
  Title: z.string().nullish(),
  IUPACName: z.string().nullish(),
  MolecularFormula: z.string().nullish(),
  MolecularWeight: z.string().nullish(),
  ConnectivitySMILES: z.string().nullish(),
  CanonicalSMILES: z.string().nullish(),
  IsomericSMILES: z.string().nullish(),
  InChIKey: z.string().nullish(),
})

const propertyTableSchema = z.looseObject({
  PropertyTable: z.looseObject({ Properties: z.array(z.unknown()) }),
})

const synonymListSchema = z.looseObject({
  InformationList: z.looseObject({
    Information: z.array(
      z.looseObject({
        CID: z.number(),
        Synonym: z.array(z.string()).optional(),
      }),
    ),
  }),
})

// --- Query classification -------------------------------------------------

type QueryKind = 'cid' | 'inchikey' | 'name'

/** How a free-text query maps onto a PUG REST resolver. */
export function classifyQuery(query: string): QueryKind {
  if (/^\d+$/.test(query)) return 'cid'
  if (INCHIKEY_PATTERN.test(query)) return 'inchikey'
  return 'name'
}

// --- Adapter --------------------------------------------------------------

export interface PubChemAdapterOptions {
  readonly fetchFn?: FetchLike
  /** Clock for retrieval/record timestamps (injected for tests). */
  readonly now?: () => string
  /** Transport overrides (timeouts/retries) — defaults are the policy. */
  readonly http?: Omit<FetchJsonOptions, 'fetchFn' | 'signal'>
}

export function createPubChemAdapter(options: PubChemAdapterOptions = {}): SourceAdapter {
  const fetchFn = options.fetchFn
  const now = options.now ?? (() => new Date().toISOString())
  const http = options.http ?? {}

  function request(url: string, signal?: AbortSignal): Promise<unknown> {
    return fetchJson(url, {
      ...http,
      ...(fetchFn !== undefined ? { fetchFn } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
  }

  /** Identifier lookup → CID list. A source "no match" answer is empty. */
  async function resolveCids(query: string, signal?: AbortSignal): Promise<readonly number[]> {
    const kind = classifyQuery(query)
    // A numeric query already IS a CID — no lookup request needed.
    if (kind === 'cid') {
      const cid = Number(query)
      return Number.isSafeInteger(cid) && cid > 0 ? [cid] : []
    }
    const encoded = encodeURIComponent(query)
    const path = kind === 'inchikey' ? `compound/inchikey/${encoded}` : `compound/name/${encoded}`
    let body: unknown
    try {
      body = await request(`${PUBCHEM_PUG_BASE}/${path}/cids/JSON`, signal)
    } catch (error) {
      if (error instanceof SourceRequestError && error.code === 'http' && error.status === 404) {
        return [] // PUG REST reports "no CID matches" as 404 NotFound.
      }
      throw error
    }
    const parsed = cidListSchema.safeParse(body)
    if (!parsed.success) {
      throw new SourceRequestError(
        'invalid-response',
        'PubChem identifier response did not match the expected shape',
      )
    }
    return parsed.data.IdentifierList.CID.slice(0, MAX_QUERY_CIDS)
  }

  /** Identity properties for a CID batch; rows that do not validate are skipped. */
  async function fetchProperties(
    cids: readonly number[],
    signal?: AbortSignal,
  ): Promise<readonly RemoteCompound[]> {
    const body = await request(
      `${PUBCHEM_PUG_BASE}/compound/cid/${cids.join(',')}/property/${PROPERTY_LIST}/JSON`,
      signal,
    )
    const table = propertyTableSchema.safeParse(body)
    if (!table.success) {
      throw new SourceRequestError(
        'invalid-response',
        'PubChem property response did not match the expected shape',
      )
    }
    const stamp = now()
    const requested = new Set(cids.map((cid) => String(cid)))
    const records: RemoteCompound[] = []
    for (const raw of table.data.PropertyTable.Properties) {
      const row = propertyRowSchema.safeParse(raw)
      if (!row.success) continue // malformed identity row — never fabricated
      const cid = String(row.data.CID)
      // Only the requested identifiers become records: an unexpected row
      // in the response is ignored rather than silently imported.
      if (!requested.has(cid)) continue
      const name = textOf(row.data.Title) ?? textOf(row.data.IUPACName)
      const formula = textOf(row.data.MolecularFormula)
      const weight = numberOf(row.data.MolecularWeight)
      const smiles =
        textOf(row.data.ConnectivitySMILES) ??
        textOf(row.data.CanonicalSMILES) ??
        textOf(row.data.IsomericSMILES)
      const inchiKey = textOf(row.data.InChIKey)
      const identifiers: CompoundIdentifiers = {
        pubchemCid: cid,
        ...(formula !== undefined ? { molecularFormula: formula } : {}),
        ...(weight !== undefined ? { molecularWeight: weight } : {}),
        ...(smiles !== undefined ? { smiles } : {}),
        ...(inchiKey !== undefined ? { inchiKey } : {}),
      }
      records.push({
        id: compoundId('pubchem', cid),
        source: 'pubchem',
        sourceId: cid,
        ...(name !== undefined ? { name } : {}),
        synonyms: [],
        identifiers,
        provenance: {
          source: 'pubchem',
          sourceName: 'PubChem',
          recordId: cid,
          url: `${COMPOUND_PAGE_BASE}${cid}`,
          retrievedAt: stamp,
          licenseNotice: PUBCHEM_LICENSE_NOTICE,
          licenseUrl: PUBCHEM_LICENSE_URL,
        },
        createdAt: stamp,
        updatedAt: stamp,
      })
    }
    return records
  }

  /** Synonym lookup — best-effort; failure never fails the search. */
  async function fetchSynonyms(
    cids: readonly number[],
    signal?: AbortSignal,
  ): Promise<Map<string, readonly string[]>> {
    const byId = new Map<string, readonly string[]>()
    if (cids.length === 0) return byId
    let body: unknown
    try {
      body = await request(`${PUBCHEM_PUG_BASE}/compound/cid/${cids.join(',')}/synonyms/JSON`, signal)
    } catch {
      return byId // best-effort: empty synonyms, identity records still delivered
    }
    const parsed = synonymListSchema.safeParse(body)
    if (!parsed.success) return byId
    for (const info of parsed.data.InformationList.Information) {
      const synonyms = info.Synonym ?? []
      byId.set(String(info.CID), uniqueStrings(synonyms, MAX_SYNONYMS))
    }
    return byId
  }

  return {
    id: 'pubchem',
    name: 'PubChem',
    description: 'Compound identity, identifiers and structure references (PUG REST).',
    capabilities: {
      searchScopes: ['compounds'],
      // This version supplies identity records only — no bioactivity
      // records are offered, so the UI never shows an observation flow.
      observations: false,
    },
    licenseNotice: PUBCHEM_LICENSE_NOTICE,
    licenseUrl: PUBCHEM_LICENSE_URL,

    async searchCompounds(query: string, requestOptions: RequestOptions): Promise<readonly RemoteCompound[]> {
      const trimmed = query.trim()
      if (trimmed.length === 0) return []
      const cids = await resolveCids(trimmed, requestOptions.signal)
      if (cids.length === 0) return []
      const compounds = await fetchProperties(cids, requestOptions.signal)
      const synonyms = await fetchSynonyms(cids, requestOptions.signal)
      return compounds.map((compound) => {
        const list = synonyms.get(compound.sourceId)
        return list !== undefined && list.length > 0 ? { ...compound, synonyms: list } : compound
      })
    },
  }
}
