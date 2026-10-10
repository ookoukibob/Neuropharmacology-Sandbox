/**
 * ChEMBL adapter (REST API) — compound identity and experimental
 * observations on demand.
 *
 * What it does (verified against the live API before implementation):
 * - compound/identifier search: CHEMBL ids and InChIKeys resolve through
 *   exact structured filters; anything else tries the preferred-name
 *   filter first and falls back to the synonym filter (so CAS-style and
 *   trade-name queries still find records);
 * - observation retrieval: one page of `activity` records for a compound
 *   (or for a whole target), optionally restricted to the endpoint types
 *   that map onto a model parameter slot (Ki, Kd, IC50, EC50);
 * - target search for discovery, with a batched molecule lookup so target
 *   results can be imported as complete Layer A + Layer B records.
 *
 * Every measurement keeps exactly what the source reports — endpoint,
 * numeric value, unit, relation qualifier (`<`, `>`, `>=`, ...), species,
 * assay context, document reference and data-quality notes. Rows without
 * a usable numeric value or endpoint are counted in `omitted`, never
 * invented into a value. Different rows may disagree; each stays its own
 * observation.
 *
 * HTTP, parsing and normalization are separated (see http.ts / normalize)
 * and every response envelope and row is validated with zod — remote JSON
 * is never trusted because it compiled.
 */
import { z } from 'zod'
import {
  compoundId,
  type CompoundIdentifiers,
  type RemoteCompound,
} from '../../domain/sources/compound'
import {
  observationId,
  parameterKindFor,
  type RemoteObservation,
  type ReportedQualifier,
} from '../../domain/sources/observation'
import { fetchJson, type FetchJsonOptions } from './http'
import { intOf, numberOf, textOf, uniqueStrings } from './normalize'
import {
  SourceRequestError,
  type FetchLike,
  type ObservationPage,
  type ObservationRequestOptions,
  type RemoteTarget,
  type RequestOptions,
  type SourceAdapter,
} from './types'

const CHEMBL_BASE = 'https://www.ebi.ac.uk/chembl/api/data'
const COMPOUND_PAGE_BASE = 'https://www.ebi.ac.uk/chembl/explore/compound/'
const ACTIVITY_RECORD_BASE = 'https://www.ebi.ac.uk/chembl/api/data/activity.json?activity_id='

/** Attribution stamped onto every ChEMBL record (CC BY-SA 3.0 obligation). */
export const CHEMBL_LICENSE_NOTICE =
  'ChEMBL data is licensed under CC BY-SA 3.0 (Attribution-ShareAlike). Attribute ChEMBL and share adaptations under the same license.'
export const CHEMBL_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/3.0/'

/** Endpoints that map onto a model parameter slot (the `parameters` scope). */
export const CHEMBL_PARAMETER_ENDPOINTS: readonly string[] = ['Ki', 'Kd', 'IC50', 'EC50']

const MAX_SEARCH_RESULTS = 8
const MAX_SYNONYMS = 10
const DEFAULT_PAGE_LIMIT = 25
const INCHIKEY_PATTERN = /^[A-Za-z]{14}-[A-Za-z]{10}-[A-Za-z]/

/** Relations ChEMBL uses on `standard_relation` — everything else is raw. */
const KNOWN_RELATIONS = new Set<string>(['=', '>', '<', '>=', '<=', '~'])

// --- Response schemas (validated, never trusted) -------------------------

const pageMetaSchema = z.looseObject({
  total_count: z.number(),
})

const moleculeListSchema = z.looseObject({
  molecules: z.array(z.unknown()),
  page_meta: pageMetaSchema.nullish(),
})

const moleculeRowSchema = z.looseObject({
  molecule_chembl_id: z.string(),
  pref_name: z.string().nullish(),
  molecule_structures: z
    .looseObject({
      canonical_smiles: z.string().nullish(),
      standard_inchi_key: z.string().nullish(),
    })
    .nullish(),
  molecule_properties: z
    .looseObject({
      full_molformula: z.string().nullish(),
      full_mwt: z.union([z.string(), z.number()]).nullish(),
      mw_freebase: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish(),
  molecule_synonyms: z
    .array(
      z.looseObject({
        molecule_synonym: z.string().nullish(),
        syn_type: z.string().nullish(),
      }),
    )
    .nullish(),
})

const activityListSchema = z.looseObject({
  activities: z.array(z.unknown()),
  page_meta: pageMetaSchema.nullish(),
})

const activityRowSchema = z.looseObject({
  activity_id: z.union([z.number(), z.string()]),
  molecule_chembl_id: z.string().nullish(),
  molecule_pref_name: z.string().nullish(),
  standard_type: z.string().nullish(),
  standard_relation: z.string().nullish(),
  standard_value: z.union([z.string(), z.number()]).nullish(),
  standard_units: z.string().nullish(),
  target_chembl_id: z.string().nullish(),
  target_pref_name: z.string().nullish(),
  target_organism: z.string().nullish(),
  assay_chembl_id: z.string().nullish(),
  assay_type: z.string().nullish(),
  assay_description: z.string().nullish(),
  document_chembl_id: z.string().nullish(),
  document_journal: z.string().nullish(),
  document_year: z.number().nullish(),
  activity_comment: z.string().nullish(),
  data_validity_description: z.string().nullish(),
  data_validity_comment: z.string().nullish(),
})

const targetListSchema = z.looseObject({
  targets: z.array(z.unknown()),
  page_meta: pageMetaSchema.nullish(),
})

const targetRowSchema = z.looseObject({
  target_chembl_id: z.string(),
  pref_name: z.string().nullish(),
  organism: z.string().nullish(),
  target_type: z.string().nullish(),
})

// --- Mapping (validated JSON → domain) -----------------------------------

function mapMolecule(raw: unknown, stamp: string): RemoteCompound | null {
  const parsed = moleculeRowSchema.safeParse(raw)
  if (!parsed.success) return null
  const row = parsed.data
  const sourceId = row.molecule_chembl_id
  const name = textOf(row.pref_name)
  const structures = row.molecule_structures ?? undefined
  const properties = row.molecule_properties ?? undefined
  const inchiKey = textOf(structures?.standard_inchi_key)
  const smiles = textOf(structures?.canonical_smiles)
  const formula = textOf(properties?.full_molformula)
  const weight = numberOf(properties?.full_mwt) ?? numberOf(properties?.mw_freebase)
  const synonyms = uniqueStrings(
    (row.molecule_synonyms ?? [])
      .map((synonym) => textOf(synonym.molecule_synonym))
      .filter((value): value is string => value !== undefined),
    MAX_SYNONYMS,
  )
  const identifiers: CompoundIdentifiers = {
    chemblId: sourceId,
    ...(inchiKey !== undefined ? { inchiKey } : {}),
    ...(smiles !== undefined ? { smiles } : {}),
    ...(formula !== undefined ? { molecularFormula: formula } : {}),
    ...(weight !== undefined ? { molecularWeight: weight } : {}),
  }
  return {
    id: compoundId('chembl', sourceId),
    source: 'chembl',
    sourceId,
    ...(name !== undefined ? { name } : {}),
    synonyms,
    identifiers,
    provenance: {
      source: 'chembl',
      sourceName: 'ChEMBL',
      recordId: sourceId,
      url: `${COMPOUND_PAGE_BASE}${sourceId}`,
      retrievedAt: stamp,
      licenseNotice: CHEMBL_LICENSE_NOTICE,
      licenseUrl: CHEMBL_LICENSE_URL,
    },
    createdAt: stamp,
    updatedAt: stamp,
  }
}

function mapActivity(raw: unknown, stamp: string): RemoteObservation | null {
  const parsed = activityRowSchema.safeParse(raw)
  if (!parsed.success) return null
  const row = parsed.data
  const compoundSourceId = textOf(row.molecule_chembl_id)
  const endpoint = textOf(row.standard_type)
  const value = numberOf(row.standard_value)
  // A row without compound, endpoint or numeric value is not a usable
  // measurement — it is counted as omitted, never converted into one.
  if (compoundSourceId === undefined || endpoint === undefined || value === undefined) return null

  const relation = textOf(row.standard_relation)
  const qualifier: ReportedQualifier | undefined =
    relation !== undefined && KNOWN_RELATIONS.has(relation)
      ? (relation as ReportedQualifier)
      : undefined
  const rawRelation =
    relation !== undefined && qualifier === undefined ? relation : undefined

  const activityId = String(row.activity_id)
  const compoundName = textOf(row.molecule_pref_name)
  const assayId = textOf(row.assay_chembl_id)
  const assayType = textOf(row.assay_type)
  const assayDescription = textOf(row.assay_description)
  const referenceId = textOf(row.document_chembl_id)
  const journal = textOf(row.document_journal)
  const year = intOf(row.document_year)
  const targetName = textOf(row.target_pref_name)
  const targetId = textOf(row.target_chembl_id)
  const organism = textOf(row.target_organism)
  const comment = textOf(row.activity_comment)
  const validity = textOf(row.data_validity_description) ?? textOf(row.data_validity_comment)
  const unit = textOf(row.standard_units)
  const species = organism
  const parameterKind = parameterKindFor(endpoint)
  const recordUrl = `${ACTIVITY_RECORD_BASE}${encodeURIComponent(activityId)}`

  return {
    id: observationId('chembl', activityId),
    compoundId: compoundId('chembl', compoundSourceId),
    compoundSourceId,
    ...(compoundName !== undefined ? { compoundName } : {}),
    target: {
      ...(targetName !== undefined ? { name: targetName } : {}),
      ...(targetId !== undefined ? { sourceTargetId: targetId } : {}),
      ...(organism !== undefined ? { organism } : {}),
    },
    endpoint,
    ...(parameterKind !== undefined ? { parameterKind } : {}),
    value,
    ...(unit !== undefined ? { unit } : {}),
    ...(qualifier !== undefined ? { qualifier } : {}),
    ...(rawRelation !== undefined ? { rawRelation } : {}),
    ...(species !== undefined ? { species } : {}),
    ...(assayId !== undefined || assayType !== undefined || assayDescription !== undefined
      ? {
          assay: {
            ...(assayId !== undefined ? { assayId } : {}),
            ...(assayType !== undefined ? { assayType } : {}),
            ...(assayDescription !== undefined ? { description: assayDescription } : {}),
          },
        }
      : {}),
    ...(referenceId !== undefined || journal !== undefined || year !== undefined
      ? {
          reference: {
            ...(referenceId !== undefined ? { referenceId } : {}),
            ...(journal !== undefined ? { journal } : {}),
            ...(year !== undefined ? { year } : {}),
          },
        }
      : {}),
    ...(comment !== undefined ? { activityComment: comment } : {}),
    ...(validity !== undefined ? { dataValidityNote: validity } : {}),
    provenance: {
      source: 'chembl',
      sourceName: 'ChEMBL',
      recordId: activityId,
      url: recordUrl,
      retrievedAt: stamp,
      licenseNotice: CHEMBL_LICENSE_NOTICE,
      licenseUrl: CHEMBL_LICENSE_URL,
    },
    createdAt: stamp,
    updatedAt: stamp,
  }
}

function mapTarget(raw: unknown): RemoteTarget | null {
  const parsed = targetRowSchema.safeParse(raw)
  if (!parsed.success) return null
  const name = textOf(parsed.data.pref_name)
  const organism = textOf(parsed.data.organism)
  const targetType = textOf(parsed.data.target_type)
  return {
    sourceTargetId: parsed.data.target_chembl_id,
    ...(name !== undefined ? { name } : {}),
    ...(organism !== undefined ? { organism } : {}),
    ...(targetType !== undefined ? { targetType } : {}),
  }
}

// --- Adapter --------------------------------------------------------------

export interface ChEMBLAdapterOptions {
  readonly fetchFn?: FetchLike
  /** Clock for retrieval/record timestamps (injected for tests). */
  readonly now?: () => string
  /** Transport overrides (timeouts/retries) — defaults are the policy. */
  readonly http?: Omit<FetchJsonOptions, 'fetchFn' | 'signal'>
}

export function createChEMBLAdapter(options: ChEMBLAdapterOptions = {}): SourceAdapter {
  const fetchFn = options.fetchFn
  const now = options.now ?? (() => new Date().toISOString())
  const http = options.http ?? {}

  async function request(path: string, signal?: AbortSignal): Promise<unknown> {
    // `Accept: application/json` is a CORS-safelisted request header (no
    // preflight) and is what makes the target-search endpoint answer JSON.
    return await fetchJson(`${CHEMBL_BASE}/${path}`, {
      headers: { Accept: 'application/json' },
      ...http,
      ...(fetchFn !== undefined ? { fetchFn } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
  }

  /** One page of activity records → validated, honestly counted page. */
  async function readActivityPage(
    path: string,
    options: ObservationRequestOptions | undefined,
  ): Promise<ObservationPage> {
    const limit = options?.limit ?? DEFAULT_PAGE_LIMIT
    const offset = options?.offset ?? 0
    const scope = options?.endpointScope ?? 'parameters'
    const scopeFilter =
      scope === 'parameters' && CHEMBL_PARAMETER_ENDPOINTS.length > 0
        ? `&standard_type__in=${encodeURIComponent(CHEMBL_PARAMETER_ENDPOINTS.join(','))}`
        : ''
    const body = await request(
      `${path}&limit=${limit}&offset=${offset}${scopeFilter}`,
      options?.signal,
    )
    const page = activityListSchema.safeParse(body)
    if (!page.success) {
      throw new SourceRequestError(
        'invalid-response',
        'ChEMBL activity response did not match the expected shape',
      )
    }
    const stamp = now()
    const items: RemoteObservation[] = []
    let omitted = 0
    for (const raw of page.data.activities) {
      const observation = mapActivity(raw, stamp)
      if (observation === null) omitted += 1
      else items.push(observation)
    }
    const total = page.data.page_meta?.total_count ?? null
    const advanced = offset + page.data.activities.length
    const nextOffset = total !== null && advanced < total ? advanced : null
    return { items, total, nextOffset, omitted }
  }

  return {
    id: 'chembl',
    name: 'ChEMBL',
    description: 'Open bioactivity data: compounds, targets and measured records (REST API).',
    capabilities: {
      searchScopes: ['compounds', 'targets'],
      observations: true,
    },
    licenseNotice: CHEMBL_LICENSE_NOTICE,
    licenseUrl: CHEMBL_LICENSE_URL,

    async searchCompounds(query: string, requestOptions: RequestOptions): Promise<readonly RemoteCompound[]> {
      const trimmed = query.trim()
      if (trimmed.length === 0) return []
      const limit = `limit=${MAX_SEARCH_RESULTS}`
      let path: string
      if (/^CHEMBL\d+$/i.test(trimmed)) {
        path = `molecule.json?molecule_chembl_id__iexact=${encodeURIComponent(trimmed.toUpperCase())}&${limit}`
      } else if (INCHIKEY_PATTERN.test(trimmed)) {
        path = `molecule.json?molecule_structures__standard_inchi_key__iexact=${encodeURIComponent(trimmed.toUpperCase())}&${limit}`
      } else {
        path = `molecule.json?pref_name__icontains=${encodeURIComponent(trimmed)}&${limit}`
      }
      let body = await request(path, requestOptions.signal)
      let list = moleculeListSchema.safeParse(body)
      if (!list.success) {
        throw new SourceRequestError(
          'invalid-response',
          'ChEMBL molecule response did not match the expected shape',
        )
      }
      // Name queries fall back to the synonym index when the preferred
      // name index finds nothing — identifiers and trade names both land.
      if (list.data.molecules.length === 0 && !/^CHEMBL\d+$/i.test(trimmed) && !INCHIKEY_PATTERN.test(trimmed)) {
        body = await request(
          `molecule.json?molecule_synonyms__molecule_synonym__icontains=${encodeURIComponent(trimmed)}&${limit}`,
          requestOptions.signal,
        )
        list = moleculeListSchema.safeParse(body)
        if (!list.success) {
          throw new SourceRequestError(
            'invalid-response',
            'ChEMBL molecule response did not match the expected shape',
          )
        }
      }
      const stamp = now()
      const records: RemoteCompound[] = []
      for (const raw of list.data.molecules) {
        const compound = mapMolecule(raw, stamp)
        if (compound !== null) records.push(compound)
      }
      return records
    },

    async searchTargets(query: string, requestOptions: RequestOptions): Promise<readonly RemoteTarget[]> {
      const trimmed = query.trim()
      if (trimmed.length === 0) return []
      const body = await request(
        `target/search?q=${encodeURIComponent(trimmed)}&limit=${MAX_SEARCH_RESULTS}`,
        requestOptions.signal,
      )
      const list = targetListSchema.safeParse(body)
      if (!list.success) {
        throw new SourceRequestError(
          'invalid-response',
          'ChEMBL target response did not match the expected shape',
        )
      }
      const targets: RemoteTarget[] = []
      for (const raw of list.data.targets) {
        const target = mapTarget(raw)
        if (target !== null) targets.push(target)
      }
      return targets
    },

    async fetchObservations(
      compoundSourceId: string,
      observationOptions?: ObservationRequestOptions,
    ): Promise<ObservationPage> {
      const trimmed = compoundSourceId.trim()
      if (trimmed.length === 0) {
        return { items: [], total: 0, nextOffset: null, omitted: 0 }
      }
      if (observationOptions?.signal?.aborted === true) {
        throw new SourceRequestError('aborted', 'request was cancelled')
      }
      return await readActivityPage(
        `activity.json?molecule_chembl_id=${encodeURIComponent(trimmed)}`,
        observationOptions,
      )
    },

    async fetchObservationsByTarget(
      targetSourceId: string,
      observationOptions?: ObservationRequestOptions,
    ): Promise<ObservationPage> {
      const trimmed = targetSourceId.trim()
      if (trimmed.length === 0) {
        return { items: [], total: 0, nextOffset: null, omitted: 0 }
      }
      if (observationOptions?.signal?.aborted === true) {
        throw new SourceRequestError('aborted', 'request was cancelled')
      }
      return await readActivityPage(
        `activity.json?target_chembl_id=${encodeURIComponent(trimmed)}`,
        observationOptions,
      )
    },

    async fetchCompounds(
      sourceIds: readonly string[],
      requestOptions?: RequestOptions,
    ): Promise<readonly RemoteCompound[]> {
      if (sourceIds.length === 0) return []
      const unique = [...new Set(sourceIds.map((id) => id.trim()).filter((id) => id.length > 0))]
      if (unique.length === 0) return []
      const body = await request(
        `molecule.json?molecule_chembl_id__in=${encodeURIComponent(unique.join(','))}&limit=${Math.max(unique.length, MAX_SEARCH_RESULTS)}`,
        requestOptions?.signal,
      )
      const list = moleculeListSchema.safeParse(body)
      if (!list.success) {
        throw new SourceRequestError(
          'invalid-response',
          'ChEMBL molecule response did not match the expected shape',
        )
      }
      const stamp = now()
      const records: RemoteCompound[] = []
      for (const raw of list.data.molecules) {
        const compound = mapMolecule(raw, stamp)
        if (compound !== null) records.push(compound)
      }
      return records
    },
  }
}
