# Data sources — on-demand external retrieval

Phase 18. The application can fetch compound and measurement data from
external scientific sources **on explicit user request**, store it
locally with full attribution, and let the user promote individual
measurements onto drug-record parameters. The contract below is
enforced by tests at every layer (adapter, repository, store, UI, E2E —
see [testing.md](testing.md)).

---

## 1. Principles (non-negotiable)

1. **No bundled default database.** The app ships no pharmacology data.
   A first run shows an empty stored panel. Synthetic values exist only
   in tests, are labelled as fixtures, and are never presented as real
   pharmacology.
2. **Nothing happens automatically.** No startup download, no
   background sync, no auto-seeding, no unsolicited bulk fetches. A test
   asserts that loading `/data-sources` performs **zero external
   requests**, and an adapter construction test asserts no request fires
   at composition time.
3. **Explicit selection, then explicit confirmation.** A search writes
   nothing. Selecting rows writes nothing. Only "Import N records"
   commits, and the commit re-validates everything atomically.
4. **The preview is advisory; the repository is authoritative.** Counts
   shown before the import are a convenience. Inside one Dexie `rw`
   transaction the repository re-validates every record; a stale
   preview can never smuggle invalid data in (same philosophy as the
   NPSL import boundary, [validation.md](validation.md) §5).
5. **Existing records win.** Import writes only rows whose
   deterministic id does not exist yet; a collision is reported as
   `skipped`, never overwritten — silent data replacement does not
   exist in this codebase.
6. **Missing stays missing; disagreement is preserved.** A field the
   source does not supply is absent, not guessed. Two measurements that
   disagree are stored side by side, never averaged or collapsed into
   one number.
7. **Every record carries its provenance and license.** Source name,
   record id, a working URL, retrieval time, and the license/attribution
   notice the adapter reports.
8. **Local-first.** After an import, everything is usable offline in
   IndexedDB. The app has no backend and no account system.

---

## 2. The three layers

```
Layer A   Compound            identity of a chemical compound
Layer B   Observation         one experimental measurement
Layer C   Drug parameters     model inputs on a Drug record (existing type)
```

### Layer A — `Compound` (`src/domain/sources/compound.ts`)

Identifiers (`pubchemCid?`, `chemblId?`, `casNumber?`, `inchiKey?`,
`inchi?`, `smiles?`), names + synonyms, `molecularFormula?`,
`molecularWeight?` (g/mol), optional structure references, and
`provenance: SourceAttribution`. The record id is
`id = "${source}:${sourceId}"` from the authoritative source identifier —
**never the compound name**, which is absent or ambiguous for many
records (names are display data, not identity).

### Layer B — `ExperimentalObservation` (`src/domain/sources/observation.ts`)

One record per measurement:

| Field | Fidelity rule |
| --- | --- |
| `endpoint` | exactly as reported (`Ki`, `IC50`, `"Log K'"`, …) |
| `parameterKind?` | `kd｜ki｜ec50｜ic50` — set only when the endpoint is canonically one of the four named kinds; absent means "no honest mapping exists" |
| `value` | the reported number (a row without one is omitted, counted and reported — never coerced) |
| `unit?`, `qualifier?` | as reported (`<`, `>`, `<=`, `>=`, `=`, `~`); a missing unit stays missing; unknown relations are kept verbatim in `rawRelation?` |
| `target`, `species?`, `assay?`, `activityComment?` | whatever context the source supplied; absent otherwise |
| `compoundId` / `compoundSourceId` / `compoundName?` | links to Layer A; the import rejects orphan observations |
| `provenance` | source, record id, record URL, retrieval time, license notice |

Observation ids are `chembl:{activity_id}` (ChEMBL's globally unique
activity id) — stable across re-fetches, so re-importing the same page
skips instead of duplicating.

### Layer C — drug-record parameters

Importing Layers A/B **never** creates or modifies a drug record. A
parameter slot (`kd`, `ki`, `ec50`, `ic50` on a `ReceptorTarget`) is
filled only by `applyObservation` (the "Use as parameter…" flow), which
requires, in this order:

1. the observation exists in storage;
2. its `parameterKind` maps onto the same named slot — **no silent
   substitution in either direction** (a Ki measurement never becomes a
   Kd, an IC50 never becomes an EC50, and an endpoint like `"Log K'"` is
   never applied at all);
3. the qualifier is exact (`=` or absent) — a bound ("< 3.5 nM") is
   displayed but refused with the reason;
4. a unit is present and its dimension is `molar-concentration`;
5. the target drug exists; attaching to an existing target requires its
   id, a new target is created from the observation's reported target
   name (refused when the source reported none);
6. an occupied slot requires the explicit overwrite acknowledgement.

The written `ScientificValue` keeps a `literature` provenance with
`observationId` — the parameter stays permanently traceable back to the
stored measurement, through `.npsl` round trips included. Backward
compatible: no change to the `Drug` shape beyond the optional
`provenance.observationId` field on `literature` provenance
(serialization-tested; older files load unchanged).

"Add to drug library" on a stored compound is deliberately weaker: it
creates an identity-only drug record (name, synonyms, CAS) whose notes
carry the full attribution — no pharmacological value is invented.

---

## 3. Workflow

```
pick source + scope + query        (nothing fetched yet)
→ Search / Fetch measurements      (one bounded request, cancellable)
→ results with per-row selection   (still nothing written)
→ advisory preview                 (exact selection, "already stored" hints)
→ "Import N records"               (one atomic, re-validated transaction)
→ stored panel (usable offline)    (imported rows list with attribution)
→ optional: "Use as parameter…"    (explicit Layer C promotion)
```

- **Cancellation**: Cancel aborts the in-flight request (AbortSignal);
  a late answer from a superseded search or fetch is dropped via
  monotonic sequence guards — it can never overwrite newer state.
- **Paging**: measurement pages append under a snapshot of the query
  that produced them; paging continues the original query even if the
  on-screen selection changed.
- **Endpoint scope**: ChEMBL observation requests default to the four
  model-parameter endpoints (`Ki, Kd, IC50, EC50`), filter sent to the
  server (`standard_type__in`), and can be switched to "all reported
  endpoints" — the choice is sent to the source (only the chosen scope
  is downloaded), fetched rows are cleared when it changes, and the
  fetched list always shows the scope the data was fetched under.

---

## 4. Sources, licensing, attribution

| Source | Offers | Notes |
| --- | --- | --- |
| PubChem (PUG REST) | compound identity only (name/CAS/InChIKey → CID → properties + synonyms) | CORS-open; **not** presented as an activity source — the UI says so on its measurement panel. Attribution: "PubChem aggregates contributions from many data providers; record-level terms can differ" + link to <https://pubchem.ncbi.nlm.nih.gov/docs/downloads> |
| ChEMBL (web services) | compound identity, target search, activity measurements | Data under **CC BY-SA 3.0** with link to <https://chembl.gitbook.io/documentation/>; every imported record keeps this notice and its compound page URL |

License notices are stored **per record** (they travel with exports)
and shown per source in the picker. No complete dataset is bundled or
mirrored; only individually requested records are stored.

---

## 5. Transport, validation and failure handling

- One shared `fetchJson` (`src/data/sources/http.ts`): 10 s timeout,
  one retry on network failure/5xx (never on 4xx), typed
  `SourceRequestError` codes (`network`, `timeout`, `http`, `invalid-response`,
  `aborted`) that the UI maps to human-readable, code-specific messages.
- Responses are validated with strict Zod schemas at the network edge;
  unmapped rows are counted (`omitted`) and reported, never silently
  dropped or partially mapped.
- Deterministic ids make re-fetching idempotent; the repository import
  is a single transaction: **any** invalid record rejects the whole
  batch and nothing is written (report names the failing record index).
- Invalid stored rows found on later reads are quarantined, reported,
  and kept byte-identical for recovery — the established repository rule.

---

## 6. Storage

Dexie v3 adds two stores to the existing database
(`src/data/db/database.ts`): `compounds` (key `id`) and `observations`
(key `id`, index `compoundId`). The migration is additive (no upgrade
rewrite); existing drug rows are byte-identical through it
(`database.test.ts`). `PERSISTENCE_VERSION` stays 2 — the drug record
format did not change.

Both stores share the single database instance with the drug library
(one connection, one composition root in `src/app/dataSourcesStore.ts`).

What is deliberately **not** stored: search result lists (transient
session state), target search rows (discovery only), and any form of
automatic cache invalidation — records are point-in-time retrievals
with their retrieval timestamp, not a live mirror.

---

## 7. Out of scope (explicitly)

- No background refresh, scheduled sync or "keep up to date" feature.
- No bulk dataset downloads (PubChem/ChEMBL dumps) and no mirroring.
- No automatic dedup by name, no automatic parameter selection, no
  "best value" ranking.
- No backend, no accounts, no cross-device sync, no LLM involvement.
- No new calculation models — retrieved values feed the existing models
  through the existing explicit parameter inputs.
