# Architecture decision records

Each record: context → decision → consequences. These are the "why" behind
the stack and the design; when you disagree with one, change this file in the
same PR that changes the code.

---

## ADR-1 · TypeScript-first, strict, no `any` at boundaries

**Context.** Scientific data silently corrupted by loose typing is worse than
a build failure.
**Decision.** `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `erasableSyntaxOnly` (no enums — union string
literals instead). Types compile-checked via `tsc -b` in the build.
**Consequences.** Slightly more verbose code; unrepresentable states fail at
compile time. JSON/Zod boundaries are explicitly mapped into domain types —
`any` never crosses them.

---

## ADR-2 · React + Vite + Tailwind + shadcn/ui, lucide icons, no emoji

**Context.** Spec-mandated professional scientific aesthetic with accessible,
consistent controls.
**Decision.** React 19 + Vite 8 for UI/build; Tailwind CSS 4 + shadcn/ui
(radix base) for components; `lucide-react` for all iconography; emoji are
forbidden as UI, buttons, status indicators or decoration (enforced by a
component test).
**Consequences.** shadcn components are vendored into `src/components/ui`
(treat as vendor code: don't restyle ad hoc). Upgrades come from the shadcn
registry, not from refactoring app code.

---

## ADR-3 · Zustand for application state, local state by default

**Context.** Spec requires Zustand; uncontrolled global state becomes a
second domain layer.
**Decision.** One small store per feature (library, calculator, import wizard)
holding *application* state only: selection, drafts, load status, results.
Form keystrokes and purely visual state stay in component state.
**Consequences.** Stores stay trivially testable and serializable; the engine
and domain never import them.

---

## ADR-4 · Zod as the single validation language

**Context.** Validation is needed for files, user forms, calculator inputs and
eventually settings; four validation styles would drift.
**Decision.** Every editable/parsable structure gets a Zod schema next to its
type (`src/data/schemas`). Zod schemas are the executable spec; domain types
are the runtime vocabulary; mappers convert between them.
**Consequences.** Schema and domain type can drift — covered by round-trip
tests (see ADR-10). Plain-type duplication at the file boundary is accepted
because file formats *should* be able to evolve independently of the domain.

---

## ADR-5 · IndexedDB (Dexie) behind a repository interface; `.npsl` is not the database

**Context.** Spec: local-first, no backend, library must survive restarts;
`.npsl` is for backup/interchange.
**Decision.** Live data in IndexedDB via Dexie with explicit migrations and
atomic import transactions. All access goes through a repository interface
(`getAllDrugs`, `createDrug`, `importLibrary`, ...). React never imports
Dexie. Startup runs validate/migrate → hydrate; unparseable records are
quarantined and reported, never discarded.
**Consequences.** Persistence can be swapped (e.g. to file-system access)
without touching UI or domain. Migration bugs are covered by repository
tests, not UI tests.

---

## ADR-6 · Decimal.js for arithmetic that humans read

**Context.** Binary floating point produces artifacts like
`0.1 + 0.2 = 0.30000000000000004` in traces and reported values — fatal for a
transparency-focused tool.
**Decision.** Scalar arithmetic in models (+ − × ÷, `exp`, `ln`, powers) uses
Decimal.js at a documented precision; `CalculationValue.value` serializes to
`number` at that precision. Curve sampling may use native doubles (it is
visualization, not reported data).
**Consequences.** Slightly slower than doubles (irrelevant at MVP scale);
transcendental results carry documented rounding; tests assert stability.

---

## ADR-7 · Plotly behind a `CurveData` adapter; charts never calculate

**Context.** Spec mandates Plotly; chart libraries invite putting equations in
components.
**Decision.** The engine emits `CurveData`/`CurveSeries` (plain points, units,
scale hints, `model | observed` type). `src/components/charts` converts it to
Plotly traces. No formula, unit conversion or sampling decision lives in a
chart component.
**Consequences.** Plotly can be replaced by touching one folder; chart tests
assert mapping, engine tests assert math. Bundle size is handled by
route-level lazy loading when charts land (see ADR-12).

---

## ADR-8 · NPSL: strict types, loose unknown keys, explicit version gates

**Context.** Files must round-trip losslessly *and* survive format evolution;
strict rejection of unknown keys breaks forward compatibility, silent
acceptance hides typos.
**Decision.** Known fields are strictly typed (wrong type = hard error);
unknown keys are preserved through import/export (`z.looseObject`) — at
every supported nesting level of a drug record and in `libraryMetadata`;
the envelope's top-level extras have no storage location and are reported
(`ENVELOPE_FIELDS_DROPPED`), not silently kept or dropped;
`formatVersion`/`schemaVersion` gate readability (major must match, minor
must not exceed this build); `checkNpslVersions` implements the rule.
**Consequences.** A typo'd *known* field is caught; a typo'd *unknown* key
passes through (mitigated: semantic warnings can flag unrecognized keys).
Older files import; newer files are refused with a clear message.

---

## ADR-9 · Failures are data: `CalculationReport`, not exceptions

**Context.** "Missing Kd" is a normal, user-fixable situation; throwing
forces try/catch UI code and hides errors from tests.
**Decision.** Models return a discriminated union:
`{ ok: true, result }` or `{ ok: false, errors[] }`. Warnings/assumptions
ride along with successful results.
**Consequences.** UI renders errors inline next to inputs; tests assert error
codes directly; unexpected exceptions remain bugs (they should not occur for
valid types).

---

## ADR-10 · Round-trip tests as the compatibility contract

**Context.** NPSL ↔ domain duplication (ADR-4) can drift silently.
**Decision.** Required test: file → import → domain → export → file, with
normalizing deep equality on all scientifically meaningful data (values,
units, provenance, metadata). Any serializer/mapper change must keep it
green.
**Consequences.** Format changes require touching schema + mapper + tests in
one change — intentional friction.

---

## ADR-11 · No premature infrastructure

**Context.** Spec forbids backend, auth, LLM, microservices, GraphQL,
unnecessary state layers and heavy scientific frameworks.
**Decision.** Nothing is added until a phase requires it. Dependencies are:
React, router, zustand, zod, dexie, decimal.js, lucide-react, plotly (+ test
tooling). No data-fetching library, no form framework, no i18n, no
component kitchen-sink beyond what shadcn gives us.
**Consequences.** Some wheel reinvention later (e.g. simple form
validation) — accepted; removal is easier than addition.

---

## ADR-12 · Static deployment, lazy chart bundle

**Context.** Deploy to Cloudflare/GitHub Pages; Plotly is a large dependency.
**Decision.** Entire app is static (`vite build` → `dist/`). When charts are
implemented, the calculator route (or the chart subtree) is
`React.lazy`-loaded so first paint stays small. No SSR.
**Consequences.** All data local to the browser; no server config; charts
load on demand with a visible loading state.

---

## ADR-13 · Oxlint instead of ESLint

**Context.** Lint config churn; Vite templates now ship oxlint.
**Decision.** `oxlint` with react + typescript plugins; rules are minimal
(hooks correctness, fast-refresh hygiene). Formatter decisions are left to
the editor for now (Prettier can be added if the team wants it enforced).
**Consequences.** Near-instant lint runs; some ESLint-plugin rule coverage is
missing — acceptable for a small, strict-TS codebase.

---

## ADR-14 · Persistence DTO + versioned Dexie schema in one module

**Context.** Phase 3 stores drug records in IndexedDB. The domain `Drug` is
the scientific view; storage needs bookkeeping (a record-shape version) and
must survive future schema changes without destroying data it does not
understand.
**Decision.** One database module (`src/data/db/database.ts`) declares every
schema version: v1 (initial stores) and v2 (adds `origin`/`updatedAt`
indexes) with an *idempotent upgrade hook that only backfills bookkeeping*
(`persistenceVersion`, missing `createdAt`/`updatedAt`) — it never creates,
rewrites or deletes scientific or unknown fields. The persistence DTO is the
domain shape plus `persistenceVersion`, with explicit `toRecord`/`fromRecord`
mappers (`src/data/mappers/records.ts`) validated by the shared NPSL
`drugSchema`. Unknown (future/minor-version) fields are preserved by a
documented per-level key contract: contract keys are governed by the domain
value (clearing a field deletes it), out-of-contract keys are copied forward
from the previous record, and target rows are matched by stable id — never
by position. NPSL is the only interchange format; the export document is
built by `toNpslDocument`.
**Consequences.** Storage can evolve (new indexes, new bookkeeping) while
scientific data and unknown fields survive byte-for-byte — proven by the
migration test. The mapping stays near-identity on purpose (small repo,
small DB, clear mapping), but every crossing is explicit, so a DTO change
can never leak into the domain by accident.

---

## ADR-15 · Hydration reports quarantine instead of repairing

**Context.** Records can become unreadable (corruption, a schema change we
do not understand, a partial write from an older build). Silently skipping
them would "fix" a corrupt database by losing data invisibly.
**Decision.** `getAllDrugs` returns `{ drugs, quarantine }`: records failing
`drugSchema` are reported with their id, error paths and raw content, and
are **never deleted, never repaired, never skipped without a report**. The
library view surfaces the quarantine as a banner; exports contain only
readable records while quarantined rows stay in storage.
**Consequences.** An empty library always means "there is no data", never
"data was dropped". Repair tooling can be added later (records are
preserved), and repository/store tests can assert the report directly.
A Merge import also never overwrites a quarantined row: a colliding
incoming id is a blocking `QUARANTINE_CONFLICT` raised inside the import
transaction before any write (audit GAP-3), so "reported, not repaired"
cannot be undone by an ordinary import.

---

## ADR-16 · Log-Y axis conflicts are one structured warning, not changed data

**Context.** A logarithmic y-axis cannot represent `y ≤ 0`. Filtering or
clamping points to make the chart "work" would silently alter scientific
results; throwing at chart time would bury the reason.
**Decision.** The sampler validates `xScale`/`yScale` against an enum
(unknown scales are `OUT_OF_RANGE`) and, after sampling, emits exactly one
`LOG_Y_AXIS_NOT_REPRESENTABLE` warning when a log y-axis conflicts with the
points. Curve data is never altered — no filtering, clamping or
recomputation. The chart layer must reject or fall back based on
the warning (implemented in phase 4: the panel surfaces the warning
verbatim and the adapter forces a linear y-axis); the warning registry
documents severity `warning`.
**Consequences.** Results stay byte-identical whatever the axis choice, and
the decision "this cannot be drawn on log-Y" reaches the UI as data. Tests
cover positive/zero/negative/underflowed-zero/linear cases plus data
equality against the linear run.

---

## ADR-17 · Zustand for session state, IndexedDB as the source of truth

**Context.** The library UI needs reactive state, but a client cache that
diverges from storage would break the local-first contract (reload must not
change what is true).
**Decision.** The store is a *factory* (`createLibraryStore(repo)`) bound to
a repository; the app wires the singleton in `src/app/libraryStore.ts`
(composition root — the only React-side module that reaches into
`src/data/db`). Zustand holds session state only: hydrated list, quarantine,
selection, filter string, load status and the last error. Every mutation
goes through the repository and re-reads storage; nothing is computed,
defaulted or persisted by the store. Hydration is idempotent (in-flight
guarded) and triggered once from `AppLayout`.
**Consequences.** Tests inject a repository double (or `fake-indexeddb`)
without touching the UI; a reload re-derives identical state from IndexedDB;
there is exactly one source of truth and one write path.

---

## ADR-18 · Separate `.npsb` recovery archive; quarantine stays derived

**Context.** Ordinary exports (`.npsl`/`.json`/`.csv`) intentionally exclude
quarantined rows — `exportLibrary()` returns readable drugs only and the
UI announces the excluded count — so no current format is a complete
storage snapshot. Recovering an invalid raw row verbatim is impossible
through `replaceLibrary()`/`importLibrary()`, which rebuild domain records
and re-validate them with `drugSchema`. Losing quarantined or
unknown-field data permanently is the failure this phase exists to
prevent; the full contract is `docs/recovery-backup.md` (designed in
Phase 8A, implemented in Phase 8B).

**Decision.**
- **Separate format, not an NPSL extension.** `.npsb` (`formatId: "npsb"`,
  independent `backupVersion`, strict seven-key envelope, row entries
  `{key, value, specialNumbers?}`) keeps ordinary import strict: a `.npsb`
  file fails `parseNpsl()` (no `formatVersion`) and an `.npsl` file fails
  the recovery format check — mutual rejection, both tested.
- **Quarantine stays derived** (ADR-15): rows are stored raw; each build
  classifies them at hydration. The archive records export-time counts as
  *information*; restore reproduces rows verbatim and reports both the
  archive's classification and the receiving build's — it never mutates or
  rejects rows to make them agree. No second quarantine store: it would
  duplicate validity truth, freeze export-build judgments and need its own
  migration (a future "user acknowledged" flag would be its own ADR).
- **Restore = full snapshot replacement in one transaction** (`clear` +
  raw `put` of every `drugs`/`meta` entry; all meta rows, not only the
  first), with complete validation — size, duplicate JSON keys, parse,
  format id, version, envelope/entry shapes, key ≡ `value.id`, duplicate
  keys, sidecar placeholders, counts — *before* the transaction opens.
  Any in-transaction failure aborts with full rollback (same guarantee
  `replaceLibrary` relies on). Raw writes bypass `drugSchema` **only**
  inside this dedicated operation; `drugSchema`, `importLibrary` and
  `replaceLibrary` are untouched. Outcomes mirror import: `rejected` /
  `failed` (rolled back, previous library intact) / `ok` /
  `committed-refresh-failed` (committed — never reported as rollback,
  never auto-re-run).
- **Supported value domain = JSON domain plus four numeric shapes.**
  `null`/booleans/strings/dense arrays/plain objects round-trip as JSON;
  `-0`, `NaN`, `±Infinity` are restored exactly via an entry-level
  `specialNumbers` sidecar (RFC 6901 pointers, own-property-only
  resolution, placeholder checks) and are verified by re-parsing the
  serialized output and deep-comparing (`Object.is` leaves; prototypes and
  key order non-contractual) **before** any download. Everything else
  (`Date`, `Map`, binary, `BigInt`, `undefined`, sparse holes, cycles,
  non-string keys, …) fails the export with store/key/path/type — never
  coerced, omitted or partially written. No general-purpose serializer:
  those states are unreachable through the application's write paths.
- **Keys and metadata:** primary keys are captured from `cursor.key`
  (not the display-only `recordKey()`), string keys only (every write path
  validates `id: z.string().min(1)`; non-string keys imply external
  writes → explicit export failure), and `key ≡ value.id` is enforced on
  restore; duplicate keys are rejected pre-write because IDB `put`
  silently overwrites. All `meta` rows are captured and restored (the app
  itself reads only the first).
- **No checksum in v1.** Valid JSON and structural validation prove
  schema conformance only — not integrity or authenticity — and the docs
  say so plainly; a checksum would first need an algorithm + canonical
  byte definition (envelope change → minor bump), and would not add
  authenticity anyway.

**Alternatives rejected.** *Extending the NPSL envelope with raw rows* —
turns ordinary import into a validation escape hatch and breaks `drugs[]`
meaning (ADR-8). *Persistent quarantine store* — dual sources of truth,
staleness on every write, mandatory migration; ADR-15 already suffices.
*Merge restore* — undefined update/delete semantics for schema-invalid
rows; silent-loss territory. *Encoding every structured-clone type* — a
general-purpose serializer whose escaping bugs become the new data-loss
risk, for states the contract never produces. *Silently normalizing `-0`
→ `0`* — `JSON.stringify`'s default, invisible value change; forbidden.
*Requiring a boundary failure on `-0`/`±Infinity` too* — these are
reachable today (form `-0`, `1e400` in unknown fields) and unremovable
through the UI, which would deadlock the one feature meant to preserve
them.

**Consequences.** Phase 8B implements export/preview/restore strictly to
`docs/recovery-backup.md` (error codes, limits, outcome taxonomy and test
matrix were already specified); the fidelity boundary is testable
(export-side scan + post-serialization verification), and future schema
changes that add object stores or widen the value domain must bump
`backupVersion` in the same change. Phase 8B has shipped: the recovery
code lives in `src/data/recovery/` plus the repository, store and
Recovery-tab UI, with the §15 test matrix green. `.npsl` remains
interchange only — explicitly not a complete storage backup.

---

## ADR-19 · Device-local preferences in one versioned `localStorage` record

**Context.** `/settings` (phase 9B) needs a persistent theme and
per-model curve display defaults. These are presentation preferences,
not scientific records: putting them in IndexedDB would touch the
database schema, mapper and migration history for a few hundred bytes of
UI state, and scattering `localStorage` reads across components would
create a second, unvalidated source of truth (ADR-4 already anticipated
"eventually settings" as a Zod-validated structure).

**Decision.**
- **One record, namespaced key, explicit version.** Key
  `neuropharmacology-sandbox.preferences`, payload
  `{version: 1, theme, calculator: {settings}}`, written only by
  `src/features/preferences/` (schema → storage → theme → store, wired to
  the calculator store by `src/app/preferencesStore.ts`). IndexedDB,
  drug records, `.npsl`/`.npsb` formats and the persistence version are
  untouched.
- **Presentation preferences only.** `theme` (`system | light | dark`,
  default `system`) and the calculator's per-model `CurveSettings`
  (range, points, x/y scales — the chart's configuration; it never
  computes pharmacology). Input drafts, reports, curve data, drug
  records and provenance are never read or written by this layer, and
  the reset action restores only these preferences.
- **One authoritative state, one write path.** The preferences store is
  the sole owner of what persists; every mutation validates (Zod
  structure/formats + the engine's `validateCurveOptions` cross-field
  rules), persists, and applies (theme class, live calculator
  settings). A candidate that fails validation is refused outright —
  state and storage stay put; the Settings UI shows the field message.
  Defaults are defined once, in the calculator store
  (`defaultCalculatorSettings()`).
- **Startup applies before first paint.** `main.tsx` calls
  `initializePreferences()` synchronously before `render()`; the theme
  class lands on the document root through the existing `.dark`
  convention (the only writer), and saved display defaults are pushed
  into the calculator session store.
- **Fail safe, degrade visibly.** Malformed JSON, invalid values and
  unsupported versions are discarded wholesale in favour of the
  documented defaults; storage that throws yields in-memory defaults.
  Both cases surface as `role="status"` notes rather than interruptions.

**Consequences.** Preferences survive reloads per device without any
change to scientific storage; a preference write cannot touch a drug
record by construction (tests assert it). Version bumps are explicit:
an unsupported `version` is rejected, never half-applied. Removing the
record (or blocking storage) returns the app to documented defaults —
there is no hidden coupling to recover. Trade-off: preferences are not
part of the `.npsb` recovery archive (device-local UI state, recreated
in seconds), and there is no sync — by design (no accounts, static
deployment, ADR-12).

---

## ADR-20 · External target identity: optional per-source references, never auto-merged

**Context.** ChEMBL activities carry a `target_chembl_id`, but a
`ReceptorTarget` had no typed place for it: applying an observation to
a new target lost the source's stable target id, a selected row with
the same name/species could hide a different source identity, and the
acknowledgement flow had nothing honest to show. The field also
crosses every reconstruction path (form edits, IndexedDB rows, NPSL),
so silent loss was a real risk.
**Decision.** `ReceptorTarget.sourceReferences?: TargetSourceReference[]`
— one optional entry per source (`source`, `sourceName`,
`sourceTargetId`, reported `name`/`organism`, HTTPS target-record
`url`, verbatim `licenseNotice`/`licenseUrl`), validated by
`targetSourceReferenceSchema` and written as a first-class known field
by the persistence mapper (not left to unknown-field preservation).
Semantics: internal `ReceptorTarget.id` and external source ids are
distinct identity spaces; a new target created from an observation
carries the reference; attaching to a compatible row attaches a
missing reference idempotently (identical = no-op; a different
source's reference never conflicts); a same-source id conflict is a
`TargetMismatch` (`'source-id'` with structured `sourceIdConflict`
detail) that refuses without `confirmTargetMismatch` and — after
acknowledgement — keeps the stored reference verbatim with the
acknowledgement recorded in provenance notes; `mergeSourceReferences`
never merges a conflict. (Phase 18I.1 closure: the
one-entry-per-source rule became an enforced schema refinement in
`receptorTargetSchema` — a second entry with the same exact `source`,
identical `sourceTargetId` included, rejects the containing record with
the duplicate's path named; nothing is merged, deduplicated or
normalized, and rejecting malformed data needed no version bump.)
**No version bump**: the field is optional and
additive — old files load unchanged, and older builds (loose objects)
carry the key through unknown-field preservation (reference-level
unknown keys are matched by `source`, never position).
**Consequences.** Target identity survives edits, storage and NPSL
round trips; the UI can show a conflict honestly instead of hiding it.
The reference is the source's claim, not verified biological identity —
and an acknowledgement records a *linking decision*, never an identity
proof. A future second source attaches its reference without any schema
change (the domain model is not hard-coded to ChEMBL).

---

## ADR-21 · Optimistic concurrency for drug writes: per-record revisions, compare-and-write in one transaction

**Context.** Phase 19 confirmed the audit GAP-4 defect in a real
two-tab browser test: `DrugForm` submits a full snapshot of its
editable groups, so a tab whose form mounted before another tab's
commit silently reverts that commit on save — reporting success. The
repository's transaction re-read (`applyChanges`) composes only for
groups the caller *omits*; the form omits nothing. Cross-tab
refresh mechanisms (BroadcastChannel, storage events) were explicitly
insufficient: they shrink the stale window but do not close it — any
refresh is itself asynchronous, so a compare at write time is still
required to make stale writes impossible rather than unlikely. A fix
must not corrupt the byte-identical row contract (ADR-5/ADR-14), the
NPSL round-trip identity, quarantine/recovery paths, or `DrugChanges`
merge semantics for API callers.
**Decision.** Optimistic concurrency with a per-record monotonic
revision token, stored in a new additive Dexie table `revisions`
(`{ id, revision }`, absent row = 0) — never inside the drug row, so
rows stay byte-clean of it and exports/imports stay identity-preserving.
`Drug.revision?` is storage bookkeeping attached by repository reads
(`getAllDrugs`/`getDrug` read drugs+revisions in ONE read transaction
for a consistent token view) and stripped everywhere a domain value
becomes a row, a record or an exported document. `updateDrug(id,
changes, expectedRevision)` takes the token as a required third
argument and performs compare-and-bump **inside one read-write
transaction** over drugs+meta+revisions — no TOCTOU: a stale token
rejects before any write, a matching token commits and bumps, and the
bump rides the same transaction as the data write. A stale token raises
`RepositoryError('CONFLICT')` — a typed code alongside `NOT_FOUND`,
`VALIDATION`, `STORAGE` — with the stored record untouched. Every
mutation path that writes drug rows (create, import both modes,
replace, recovery restore) bumps the ids it writes inside its own
transaction; deletion keeps the tombstone so delete→recreate→restore
cannot mint a token that revives a stale form (ABA-safe). *Review fix — deletion is guarded too:* `deleteDrug(id, expectedRevision)` compares the token inside the deletion's own read-write transaction (drugs+meta+revisions) and rejects a stale delete with `CONFLICT` before removing or stamping anything — a stale detail page can never delete a record another tab has updated. A successful delete keeps the tombstone and deliberately does NOT advance it: deletion is the absence of data, not a content mutation, and with the row gone every stale action already fails `NOT_FOUND`; advancing would add no safety while blurring "the sequence advanced because data changed" with bookkeeping. Concurrent deletes cannot both succeed — the loser's transaction re-reads the post-delete state and fails `NOT_FOUND` ("already gone"), which never masks the conflict distinction for a record that still exists. The UI layer
receives a discriminated `UpdateDrugResult` (`ok` / `conflict` /
`error`); the form captures its token once at mount, never
auto-refreshes it after a conflict (no silent retry), keeps the draft
and the edit session open, names the conflict distinctly from ordinary
failures, and offers explicit recovery: open the latest record in a
new tab (draft kept) or reload (draft discarded, labeled as such). The
delete-confirmation flow is guarded the same way (`DeleteDrugResult`):
a conflict states that the deletion did not happen and that the record
changed elsewhere, and locks the delete action until the user
explicitly reloads/reviews — never an automatic retry.
Rejected alternatives: a `revision` column in the drug row (breaks the
byte-identical row contract and import/export identity); a parallel
revision map in store state (drifts from storage); content-hash tokens
(identical content defeats ABA safety, and hashes are data, not
identity); cross-tab refresh alone (timing-dependent, still racy).
**Consequences.** A stale write or delete is rejected atomically and
visibly — never silently; conflicting tabs converge by the user
explicitly re-basing on the current record. `DrugChanges` merge semantics for
omitted groups are preserved (API callers still compose; the
full-snapshot form simply cannot be stale without detection), and
validation/uniqueness failures stay distinguishable from conflicts by
code. Documented bypass: a hypothetical direct Dexie write that skips
the repository would neither compare nor bump — no such path exists in
app code, and the repository is the single enforced write gate
(`compositionRoot` injects the one instance). Cross-tab *display*
refresh remains out of scope (a stale display is safe; a stale write
is not).

---

## ADR-22 · Complete Data Sources → Library import as a typed snapshot on the drug record

**Context.** "Add to drug library" reduced a stored compound to a name,
synonyms and an optional CAS number, and pushed the rest of the source
attribution into `Drug.notes`. Every other Layer A field (PubChem CID,
ChEMBL id, InChIKey, SMILES, formula, molecular weight, source record id,
retrieval time, license) and *every* stored Layer B measurement were
discarded. The drug domain model had no structured place for source data,
so the information could not be recovered from the library record at all.

**Decision.** Attach a typed snapshot to the drug record:
`Drug.sourceRecords?: DrugSourceRecord[]` — external identity
(`source` + `sourceId`), name + all synonyms, the full
`CompoundIdentifiers` shape, `SourceAttribution` (record URL, retrieval
time, source version, license notice and URL), the measurements stored for
exactly that record (`ExperimentalObservation[]`, i.e. the Layer B type
itself, so the two can never drift) and `importedAt`.

- **Snapshot, not a foreign key.** The Layer A/B stores are an on-demand,
  replaceable acquisition cache; a drug record must keep its own complete
  source data. A snapshot survives the source stores being cleared, and
  needs no join, no second repository and no new table.
- **Identity rules mirror ADR-20.** One snapshot per exact `source`
  string; a different source system is appended, a same-source *different*
  record id is a reported `conflict` (never merged or overwritten), and a
  repeat of the same record only appends measurements it does not already
  hold. `mergeSourceRecord` is the single implementation, unit-tested.
- **Link by validated identity.** An observation joins a snapshot only when
  `compoundId === `${source}:${sourceId}`` — enforced again by
  `drugSourceRecordSchema`, so a name match can never associate a
  measurement, and a hand-edited file cannot smuggle one in.
- **Not Layer C.** Importing never writes `kd`/`ki`/`ec50`/`ic50`. The
  measurements are preserved as measurements; promotion stays the explicit,
  separately validated `applyObservation` flow.
- **Explicit, non-destructive linking.** `addToLibrary(compoundId,
  {drugId})` attaches to a *named* record and submits **only**
  `sourceRecords`; targets, parameters, target metadata, identifiers, tags
  and notes are untouched, and the write carries the record's revision
  token, so a stale attach is rejected like any other stale write (ADR-21).
  Nothing is ever selected by name.
- **A known field, not an extension.** `sourceRecords` is written by the
  persistence mapper and listed in the record's key contract, with
  per-level key sets for the snapshot, its identifiers, its attribution and
  its observations. Unknown keys inside those levels survive edits,
  matched by `source` (snapshots) and deterministic observation `id`
  (measurements) — never by position.
- **Optional and additive: no version bump.** Absent on every legacy
  record, written only when a record carries imported data (never `[]`),
  and accepted by the same `drugSchema` used for storage, `.npsl` and
  `.npsb` classification. `PERSISTENCE_VERSION` stays 2 and the Dexie
  schema is unchanged (no new table, no migration), so existing databases
  open byte-identically.
- **Honest outcomes.** `addToLibrary` returns a typed
  `created`/`linked`/`already-linked`/`conflict`/`failed` result; the
  panel shows which one happened and never reports success for a partial
  operation.

**Rejected alternatives.** *A separate `drug_source_records` table keyed by
drug id* — a second write path, a second transaction to keep consistent
with the drug row, a Dexie version bump, and a dangling-reference problem
when either side is deleted; the snapshot has none of these. *Storing the
data as JSON in `notes`* — unstructured, unvalidated, unfilterable and
inseparable from user notes. *Auto-creating target parameters from
measurements* — violates the Kd ≠ Ki ≠ EC50 ≠ IC50 rule and the explicit
promotion policy (ADR-20, data-sources.md §2). *Auto-merging a same-name
compound into an existing drug* — names are labels, not identities.

**Known limitation.** The CSV export is a flattened parameter projection
and does not carry `sourceRecords` or the imported observations; `.npsl`
and `.npsb` are the lossless carriers. The snapshot is a point-in-time
retrieval, not a live mirror: refreshing it is a new explicit import, and
a measurement removed at the source stays in the record until the user
re-links deliberately.

**Consequences.** A library record now retains everything the source
supplied, displays it in structured sections (identifiers, chemical
properties, attribution/license, imported observations), survives reloads,
ordinary edits and both round-trip formats, and can be linked explicitly
without losing anything it already held.

---

## ADR-23 · Adaptive ODE integration in IEEE-754 doubles, separate from the Decimal scalar path

**Context.** Every scalar model computes in Decimal.js and reports through
`roundForReport` (ADR-6). Phase 41 adds a dynamic simulation: a two-compartment
IV PK model integrated by an adaptive Dormand–Prince 5(4) pair. The solver
must take thousands of intermediate steps, each with a local error estimate,
and its step-size controller is mathematically defined for finite-precision
arithmetic.

**Decision.** The simulation core integrates in IEEE-754 doubles, with the
following rules:

- **No display rounding inside integration.** `solver.ts` never rounds an
  intermediate state; every stage value keeps full double precision.
- **Reporting still uses the existing helpers.** Samples leave the engine
  through `roundForReport` (12 significant digits) for the displayed
  quantities; the mass-balance residual is computed and reported at full
  internal precision precisely because it is a numerical diagnostic.
- **Finiteness is checked at every boundary.** Derivative vectors, candidate
  states, stage times and error norms are validated with `Number.isFinite`;
  a non-finite value is a structured `NUMERICAL_FAILURE`, never a plotted
  value.
- **The scalar path is unchanged.** `CalculationReport` and its models keep
  the Decimal arithmetic and the one-loss-policy warnings.

**Why not Decimal.** The embedded error estimate is a finite-precision
construction; carrying every Runge–Kutta stage through arbitrary precision
would multiply cost by orders of magnitude without making the estimate more
meaningful, and would make a "converged" solution indistinguishable from a
numerically meaningless one. Decimal protects *arithmetic that a person
reads*; adaptive integration is *numerical analysis* whose own error
estimator is the quality criterion.

**Consequences.** The solver is fast enough for interactive use, deterministic
on a given platform, and its accuracy is governed by explicit tolerances
rather than by rounding conventions. The boundary between the two policies is
documented in `calculation-engine.md` §8.

---

## ADR-24 · Dosing events: total ordering, per-session infusion identity, pre/post samples

**Context.** A simulation must apply IV bolus and constant-rate infusion events
deterministically, including several events at the same instant, and must
represent the discontinuity honestly. Array position and JavaScript's sort
stability are not scientific specifications.

**Decision.**

- **Same-time ordering is specified, not incidental.** Within one event time
  the phases are fixed: `infusion-stop` → `iv-bolus` → `infusion-start`.
  Inside a phase, events are ordered by `eventId` compared by Unicode code
  point (a locale-independent comparator implemented in the engine). The
  order is total, so any input permutation yields the same schedule, and a
  test asserts exactly that.
- **Bolus is an instantaneous jump** of `A_c` (and of the accounting state
  `A_in`), never a short infusion.
- **Infusions are sessions.** An `infusionId` may be started again after a
  stop; a stop must close the most recent start strictly later in time. A
  start and a stop at the same instant cannot form a positive-length interval
  (inside a group the stop is evaluated first and finds no open session), so
  zero-length intervals are rejected instead of reinterpreted. Missing
  starts, unstopped sessions and duplicate identifiers are typed
  `INVALID_EVENT_SEQUENCE` errors. A zero rate is valid (it contributes
  nothing); a negative rate is not.
- **Pre/post-event samples.** An event time produces a `pre-event` sample and
  a `post-event` sample with the same `time`, in that order, each tagged with
  its `eventGroup`. Individual transitions are kept in `eventTrace`
  (`before`/`after` at full precision, one entry per event), so a shared
  timestamp never loses an event. A chart adapter draws a vertical jump
  between the two sides and must not sort or deduplicate them.
- **The solver never steps across an event.** The orchestrator builds the
  boundary list from output times ∪ event times ∪ end time, and integration is
  clipped to each boundary. An output grid therefore cannot move, duplicate
  or suppress a dose.
- **The FSAL cache is invalidated by every event.** The integrator exposes
  `integrate(targets, hasCachedDerivative)`; the orchestrator passes `false`
  after any event, because a derivative computed for the pre-event rate
  belongs to a different right-hand side.

**Consequences.** Event application is reproducible, independently testable
(`events.test.ts` needs no PK model), and the same scheduler is reusable for
future oral or effect-site events without changing the solver.

---

## ADR-25 · One mass-balance reference point at startTime; doses counted once

**Context.** The simulation reports a mass-balance residual
`A_c + A_p + A_e − A_ref − A_in`. During phase 41 the initializer briefly used a
"carry-in" convention in which a bolus at `startTime` was prefilled into both
the central state and `A_in`, and the reference amount included that dose.
The result violated the invariant by exactly the dose once a second
convention (zero `A_in`, no carry-in) applied the same bolus again.

**Decision.** A single convention governs initialization, event handling,
samples, accounting and documentation:

- **The scenario's initial state is the pre-event state at `startTime`.**
  `A_c(0)`, `A_p(0)` are taken verbatim from `initialState`; `A_ref = A_c(0) + A_p(0)`.
- **Accounting states start at zero:** `A_e(0) = 0`, `A_in(0) = 0`.
- **Every dose is applied exactly once, by the event scheduler**, including a
  bolus or an infusion start at `startTime`: `A_c += D` and `A_in += D`.
- **The checked invariant is**
  `A_c + A_p + A_e − (A_c(0) + A_p(0)) − A_in ≈ 0`
  — evaluated at full precision for every reported sample. The pre-event
  sample at `startTime` reads 0 on both sides; the post-event sample reads
  `A_c(0) + D` against `A_ref + D`.
- **Tolerance.** `tol = 50 · (attempts + 1) · (atol + rtol · scale)` where
  `scale` is the largest mass the run can hold (`A_ref + max |A_in|`). It is
  derived from the solver settings and the mass scale, never a fixed
  percentage, and the derivation is recorded with every result.

**Rejected alternative.** Prefilling `A_in` with the start-time bolus and
letting the scheduler add it to `A_c` only: it is internally consistent but
splits bolus handling into two code paths keyed on the event clock, and it
makes `A_in(0) ≠ 0`, i.e. "cumulative input since the reference point" becomes
false on the first sample. A single rule for all times is simpler to test and
to explain.

**Consequences.** Hand-computable assertions: 100 mg initial + 30 mg bolus at
t0 yields 100 / 0 before the event and 130 / 30 after it, with residual 0 in
both rows. Regression tests in `simulate.test.ts` recompute these values from
the closed form rather than calling the production helper, and a bolus
strictly after `startTime` is covered by the same assertions so the rule cannot
degenerate into a first-event special case.

---

## ADR-26 · Simulation charts consume the engine's samples verbatim; concentrations and amounts never share an axis

**Context.** Phase 42 makes the Phase 41 simulation visible. The report is not
a `CurveData`: it carries two samples per dosing event (a `pre-event` and a
`post-event` row at the same time) that together encode an instantaneous
jump, plus accounting states, an event trace and numerical diagnostics. The
existing scalar curve adapter treats a series as a monotone sampling of x;
feeding the simulation through it would invite sorting, deduplication or
"one value per x" assumptions, and would silently erase the dose from the
picture.

**Decision.**

- **A separate pure adapter** (`src/components/charts/simulationAdapter.ts`)
  maps `SimulationResult` to chart descriptions. It copies every reported
  value in emission order, never computes concentration, derivative or
  integral, never resamples, smooths, deduplicates or sorts, and never calls
  `simulate()`.
- **Equal-time pre/post samples are a discontinuity, not a duplicate.** Both
  points are kept, in order, in the line trace; Plotly therefore draws the
  vertical segment at the exact event time. The per-point hover text names the
  side ("just before / just after the event") and the event group, so two
  points at one timestamp stay distinguishable. Tests assert the trace
  coordinates directly (same x, Δy equal to the dose or D/V_c), not merely
  that traces exist.
- **Concentrations and amounts are separate charts**: mg/L and mg are
  different physical dimensions, so they never share a y-axis. The amount
  chart also shows the cumulative-input and cumulative-eliminated accounting
  states, labelled as accounting.
- **Events come from `eventTrace`, never from the curve.** The page renders an
  event table with one row per applied event (including several at one time),
  and a stop is explicitly labelled as administering no amount.
- **An incomplete or invalid result is never charted.** A failed report, an
  empty sample set, a non-finite value or a failed mass-balance check becomes
  a typed reason shown as an error, not a plausible curve.
- **The chart layer stays dumb.** `SimulationChart` passes adapted traces to
  Plotly; no formula, unit conversion or default lives in JSX. Plotly is
  lazily imported, as for the scalar chart.

**Rejected alternatives.** *Projecting the report into `CurveData`* — the
scalar contract has no place for sample side, event group or accounting
semantics, and its consumers assume per-x uniqueness. *Drawing event markers
as extra scatter traces* — a marker trace would add points that are not
engine samples and would compete with the data; event times are communicated
by the table and the hover text, and by the discontinuity itself.
*Interpolating the bolus over the surrounding interval* — that is precisely
the misrepresentation this ADR forbids.

**Known limitation.** Plotly's canvas/SVG output is not fully accessible to
screen readers: the adapter exposes per-point text and the page repeats every
value in the event table and diagnostics, but a screen-reader user should
rely on those tables rather than the chart. The axes are linear only in this
phase; no log-axis configuration is offered, so no value is ever adjusted to
make a log axis usable.

**Consequences.** The demonstration page (§4.3b) is a thin renderer over the
engine, the chart contract is unit-testable without a browser, and adding the
Phase 43 scenario editor changes only how a scenario is built — never how
samples become charts.

---

## ADR-27 · Scenario editor: string drafts compile into the engine scenario; blank is never zero

**Context.** Phase 43 lets users edit the two-compartment scenario. The engine
contract requires fully populated numbers (`startTime`, `endTime`, an explicit
`outputTimes` array, unit-labelled parameters, engine dosing events, explicit
solver settings). A text field in between is not a number: it may be blank,
partially typed or unparseable, and converting "" to 0 would silently invent a
dose, a clearance or a horizon.

**Decision.**

- **Three representations, one direction.** `SimulationDraft` (every numeric
  field a string, rows keyed by a stable integer) → `compileScenario()` →
  `SimulationScenario` → `simulate()` → `SimulationReport`. The compiler is
  pure and never mutates the draft; the engine builds no scenario and the UI
  defines no second model.
- **Draft errors are narrow.** Only what text parsing can decide is reported
  before the engine: required fields, unparseable numbers, an unbuildable
  output grid and a stop time that is not after its start (the same rule the
  engine enforces; the editor names the row). Units, positivity, event
  sequencing against the horizon, duplicate ids and solver rules stay with
  `simulate()`, whose typed errors are displayed with code, stage, field and
  event id. A draft error never replaces an engine rule with a generic message.
- **Blank stays blank.** A new row starts with empty times and quantities, so
  "Add" never creates a dose; the run action refuses to build a scenario from
  incomplete text and never calls the engine with a guessed value.
- **The output grid is generated by one pure helper** (integer indices,
  exact endpoints, strictly ascending) and rejects an over-large grid with a
  documented maximum instead of quietly coarsening the interval. Sampling
  times are observations only; event times and solver steps are unaffected.
- **One infusion session → two engine events** (`infusion-start`/`infusion-stop`
  sharing an `infusionId`), with deterministic ids derived from the row key.
  Removing the row removes both.
- **Results are session-scoped and stale-proof**: any draft edit clears the
  previous result, so no chart can be attributed to a draft that did not
  produce it. Nothing is persisted.
- **Chart visibility is presentation only**: toggles hide or show charts and
  never re-run the engine, change the scenario or alter a result. The
  infusion-rate chart is drawn only from the engine's `infusionRates`
  (pre/post-event snapshots), never from event times, and is unavailable when
  the scenario has no infusion at all.

**Rejected alternatives.** *Editing `outputTimes` as a free list* — a
per-times editor invites duplicate/unsorted grid bugs that the engine would
reject; a uniform interval plus a pure generator keeps the contract
auditable. *Running the simulation on every input change* — it would make
results appear before the user has finished typing and multiply engine calls
with no scientific benefit. *Keeping the previous result while the draft
changes* — a stale chart reads as the new draft's answer; clearing is
unambiguous. *Deriving the infusion-rate chart from event rows* — that would
duplicate the scheduler's summation rules in the UI.

**Consequences.** Scientific and time-horizon fields start blank, no dosing
event is pre-filled, and "Clear scenario" returns the editor to that state
while retaining the technical solver defaults. Every displayed result still
comes from `simulate()`, and a future persistence or library integration can
reuse `compileScenario` unchanged. The synthetic scenario is a test fixture,
not a product default.

---

## ADR-28 · Experimental datasets are a separate measured-data model and `.npex` format

**Context.** Phase 47A adds imported concentration–time measurements. The
application already has several similar-sounding data concepts: Layer B
`ExperimentalObservation` source records (reported potency/affinity values
at a target, retrieved from PubChem/ChEMBL), NPSL drug records with
pharmacokinetic parameters, CSV as a convenience import/export projection,
and `.npsb` as a raw all-store recovery snapshot. None of them represents an
ordered series of measured time/concentration pairs. Reusing any of them
would make provenance ambiguous (a measured study is not a retrieved
activity record), force unrelated schema/version changes, or expose raw
database identity as scientific data.

**Decision.**

- **Distinct types.** `ExperimentalDataset` and `ExperimentalMeasurement`
  live in `src/domain/experiments/` and are never aliased to
  `ExperimentalObservation` or to drug/source-data records. A dataset owns
  its declared units, ordered measurements, provenance and local identity.
- **Explicit units.** Time and concentration units must resolve from the
  existing unit catalog with the correct dimensions. Import never infers a
  unit from a header, filename, magnitude or neighbouring value. Molar and
  mass concentration remain distinct.
- **Measured values stay measured.** Validation accepts finite non-negative
  numbers (zero included) and rejects qualifiers, markers, non-finite and
  negative values with row-specific errors. Source order, duplicate
  timestamps, exact replicates and sample ids are preserved; no averaging,
  deduplication, sorting, interpolation or unit conversion occurs.
- **CSV is mapping-first.** The existing RFC 4180 parser is reused, but the
  user must explicitly map time and concentration columns and select both
  units. A preview is read-only and all-row success is required before the
  repository can be called.
- **One dataset per `.npex`.** `.npex` is a new JSON envelope with
  `formatId: "npex"`, its own independent semantic version (`1.0.0`), strict
  objects, size/depth/row limits, duplicate-key rejection and an exact
  scientific round trip. It stores the original import provenance but no
  local database ids or timestamps; re-import always assigns new local
  identity. Rule: same major, file minor ≤ reader minor, patch free.
- **Additive persistence.** Dexie v6 adds an `experimentDatasets` store; the
  repository validates reads and writes, reports corrupt rows without
  deleting them, writes transactionally and uses `updatedAt` as an
  in-transaction optimistic-concurrency token. Units, measurements and
  provenance are immutable after creation; only name and notes are mutable.
- **Backup completeness is mandatory.** `.npsb` advances to 1.1.0 and
  carries all six persistent scientific stores. Current exports emit every
  array and count, including empty stores. Older supported archives remain
  restorable with one explicit absent-store warning per missing additive
  store; full replacement clears an absent store. Restore remains one
  atomic transaction over all stores plus revisions.
- **No fitting.** Phase 47A stores and plots observations only. Fitting,
  parameter estimation and diagnostics require later phases and their own
  contracts; they must not mutate the stored observations or retroactively
  change `.npex` fidelity.

**Rejected alternatives.** *Reuse `ExperimentalObservation`* — a reported
target activity and an ordered concentration time course have different
identity, provenance, units and lifecycle; overloading one type would make
both impossible to validate honestly. *Store datasets inside a Drug or the
source-data store* — measured studies are not drug parameters, and a Drug
edit must never rewrite observations. *Extend NPSL with an optional
dataset array* — NPSL is a drug-library interchange format with its own
versioning and quarantine semantics; adding a second scientific object would
make unrelated imports carry dataset shape risk. *Use `.npsb` as the
dataset interchange* — it is a raw all-store backup with local ids,
timestamps, quarantine and destructive full replacement, not a portable
single-dataset file. *Infer units from headers* — a wrong unit is a silent
scientific error; explicit selection is the only defensible boundary.
*Deduplicate or average replicates on import* — that destroys the measured
evidence before the user has chosen an analysis. *Fit while importing* —
fitting is a separate scientific operation with its own assumptions and
diagnostics, not a property of storage.

**Consequences.** There is a second additive store and a second versioned
file format, both with independent tests and docs. The UI owns a local
repository-backed workflow rather than a global store. `.npsb` must be
updated whenever a future persistent scientific store is added, or backups
would silently become incomplete. Phase 47B/47C can now build on stable,
immutable observations and a fidelity-tested interchange boundary without
changing how those observations are stored or displayed.

---

## ADR-29 · Repeated dosing is a pure expansion to the existing flat event list

**Context.** Phase 49 adds repeated and mixed dosing regimens. The engine
already treats dosing as first-class events — instantaneous bolus, zero-order
infusion with start/stop boundaries, deterministic same-time ordering
(ADR-24) and one mass-balance reference point (ADR-25) — and integrates in
segments between event times. Adding a "regimen" must therefore not add a
second event model or a second integrator; it only needs a way to state
"repeat this dose" and to expand that statement into the flat `DosingEvent[]`
the engine already consumes.

**Decision.**

- **Repeat lives on the editor row, not in the engine.** A bolus or infusion
  row may carry an optional `repeatCount` (total number of doses; blank or `1`
  = a single dose) and `repeatInterval` (hours between successive doses). The
  engine contract is unchanged: it still receives a flat, ordered
  `DosingEvent[]`.
- **One pure expansion, two consumers.** `expandEventRows(rows)` is the single
  place a regimen becomes an explicit schedule; both `compileScenario()` and
  the editor's "expanded dosing schedule" preview call it, so the preview can
  never disagree with what the engine receives. It is pure and never mutates
  the rows.
- **Deterministic ids.** A single dose keeps the historical id
  (`bolus-<key>`, `infusion-<key>-start/-stop`); a repeated dose appends the
  1-based dose number (`bolus-<key>-2`, `infusion-<key>-2-start`, …), so every
  event id is stable, unique and traceable to a row and dose.
- **Infusion repeat semantics.** Session *k* spans
  `[start + (k−1)·interval, stop + (k−1)·interval]`, so the duration is
  constant and the interval is measured between successive starts. A repeat
  whose interval is shorter than its own duration would overlap itself and is
  rejected rather than silently summed into a higher rate.
- **Draft-level validation only for row concerns.** Count must be a positive
  integer (capped at a documented maximum as a guard, not a scientific limit);
  interval is required and positive whenever count > 1. Units, horizon bounds,
  duplicate ids and event sequencing remain the engine's authority, exactly as
  for a single dose.
- **No new physics.** A repeated bolus is the same instantaneous state jump as
  a single bolus (never a short infusion), and a repeated infusion is the same
  zero-order input bounded by explicit start/stop events. Superposition of
  time-shifted single-dose responses in the linear model is a test oracle, not
  a hidden computation.

**Rejected alternatives.** *A parallel "regimen" engine* — two dosing models
would drift and double the event bookkeeping. *Approximating repeated infusion
as many small boluses* — that reintroduces the discontinuity misrepresentation
ADR-24 forbids. *Expanding repeats inside the engine* — the engine already
owns the flat schedule's ordering and bookkeeping; folding a higher-level
repeat syntax in would blur the boundary between "what the user stated" and
"what the integrator consumed".

**Consequences.** The engine, solver and charts are untouched; the only new
surface is the row-level repeat fields, the pure expansion, and a read-only
preview. Saved scenarios store the draft (including the repeat fields) and
thus persist regimens without a new storage path; records saved before this
phase omit the fields and load as single doses.

---

## ADR-30 · Administration metadata is optional, explicitly-unknown, and never inferred

**Context.** Phase 50A adds dosing/administration context to experimental
datasets, as the foundation for later dose-dependent NCA parameters. The
dataset already records measured time/concentration pairs with explicit units
and provenance; adding administration must not silently imply a dose, route or
time origin, and must not break datasets created before the field existed.

**Decision.**

- **The whole record is optional.** `administration` is absent on datasets
  created before this phase; absent means "no administration metadata", shown
  as unknown, never as an invented dose or route.
- **Unknown is an explicit value, not a fallback.** `route`, `regimen` and
  `timeReference` are enums with an `unknown` member; `dose`, `infusion`,
  `dosingInterval` and `bioavailability` are optional and appear only when
  known. Nothing is inferred from the measurements, and steady state is never
  inferred from a flat-looking curve.
- **Units stay explicit and dimension-checked.** Dose is a mass, infusion
  duration a time, infusion rate a mass-flow rate, and the dosing interval a
  time; the unit catalog validates the dimension and no value is converted or
  relabelled. An infusion records either a duration or a rate, never both.
- **Time origin is declared, not assumed.** `timeReference` states what the
  recorded times are relative to (`dose-time`, `infusion-start`,
  `first-observation`, `other`, `unknown`); time zero is not assumed to be a
  dose time.
- **Editing metadata never touches measurements.** The repository's `update`
  adds `administration` with the same keep/clear/replace semantics as `notes`;
  measurements, units and provenance are unchanged by a metadata edit.
- **Versioned interchange.** `.npex` advances to 1.1.0. Files without the key
  (≤ 1.0.x) still import; the independent version rule (same major, file
  minor ≤ reader minor) is unchanged, so an older reader rejects a 1.1.0 file
  rather than silently dropping the new field.
- **No dose-dependent parameters here.** CL, CL/F, Vz and Vz/F are explicitly
  out of scope; their prerequisites are documented, not implemented.

**Rejected alternatives.** *Making administration mandatory* — it would break
every existing dataset and force invented values. *Inferring route/regimen
from the data* — a flat curve is not evidence of steady state, and a spike is
not evidence of a bolus. *Storing a bare dose number without a unit* — a
dimensionless dose cannot support later CL/Vz without a hidden conversion.
*Encoding infusion as "amount + duration" only* — a rate is equally valid and
must be stored without deriving one from the other.

**Consequences.** Dose-dependent NCA can later be gated on explicit metadata
rather than on heuristics. Existing datasets keep working, `.npex` 1.1.0 is
backward-compatible in one direction, and the UI renders known, partially
known and unknown contexts without inventing information.

---

## ADR-31 · Dose-dependent NCA is gated on explicit preconditions and never substitutes a partial AUC

**Context.** Phase 50A added optional administration metadata. Phase 50B turns
it into `CL`, `CL/F`, `Vz` and `Vz/F`. The danger is that every one of these
parameters is numerically computable from almost any dataset — `Dose/AUC`
always returns a number — while being scientifically meaningless when the
route, time origin, regimen or AUC interval are wrong.

**Decision.**

- **A dedicated pure domain module** (`src/domain/experiments/dose-dependent-nca.ts`)
  consumes the *existing* `NcaAnalysis`; it never re-implements AUC or λ_z.
- **A complete `AUC(0→∞)` is mandatory.** The NCA result now carries an
  explicit `aucInfInterval: 'zero-to-infinity' | 'first-to-infinity' | null`
  discriminant, so this module refuses a partial interval without parsing a
  display name. `AUC(first→∞)` is never substituted, even though it is
  numerically available.
- **Single dose only.** `repeated-dose`, `repeated-dose-steady-state` and
  `unknown` are refused; τ is never treated as the analysis interval and no
  `AUCτ` is invented.
- **Route and time origin are explicit.** A bolus or extravascular dose needs
  `timeReference = dose-time`; an infusion needs `infusion-start`. Time zero is
  never assumed to be a dose time. `other`/`unknown` routes are refused.
- **Absolute vs apparent are separate results.** `CL`/`Vz` require `F`
  (an IV route supplies `F = 1` by definition); `CL/F`/`Vz/F` do not. For IV,
  the apparent twins are `not-applicable`, not duplicated values.
- **Units go through the unit catalog.** Mass → g, mass-concentration → g/L,
  time → h via `toBase`; the result is `L/h` and `L`. A molar concentration
  with a mass dose is refused rather than converted with an invented molecular
  weight. No second conversion table is introduced.
- **Four states, not one.** `available`, `conditional` (a recorded caveat:
  >20 % extrapolated, weak terminal R², extravascular flip-flop), `unavailable`
  (a structured code and message), and `not-applicable` (F = 1 for IV).
- **Full audit trail.** Dose, AUC, λ_z, F, formula, substitution and the checked
  preconditions travel with every result; the UI only renders them.
- **No persistence change.** Derived values are ephemeral and never written to
  the dataset, `.npex` or `.npsb`.

**Rejected alternatives.** *Compute whenever the arithmetic succeeds* — it
would publish a meaningless clearance from an unknown route or a partial AUC.
*Reuse the display name to detect the AUC interval* — a string match is not a
contract; the explicit discriminant is. *Treat an extravascular terminal slope
as elimination* — it may be absorption-limited (flip-flop), so the volume is
conditional, not absolute. *Derive the dose from rate × duration* — the
metadata records at most one of them, and a silent derivation would be a second
dose representation.

**Consequences.** Every displayed dose-dependent value has a stated formula,
unit, input provenance and precondition list. Missing or contradictory metadata
produces a specific refusal instead of a plausible-looking number. Repeated
dosing was subsequently implemented in its own path — see ADR-32 — and this
single-dose module still refuses it.

---

## ADR-32 · Interval AUCτ requires observed boundaries, and steady state is a declaration

**Context.** Phase 50C adds repeated-dose analysis. Three things are tempting and
all three are wrong: integrating "the last τ worth of data" automatically,
picking whichever τ-wide window looks best, and dividing the per-administration
dose by an interval area to call the result a clearance. Each produces a number
that looks authoritative and is scientifically unfounded.

**Decision.**

- **AUCτ is an explicitly selected interval with observed boundaries.** The
  analyst chooses `t_start` and `t_end` from the dataset's own sampling times;
  neither is interpolated, extrapolated or zero-filled. `t_end − t_start` must
  equal the recorded τ within `1e-9` relative tolerance, which exists only to
  absorb binary64/unit-factor noise. Anything else is
  `INTERVAL_BOUNDARY_NOT_OBSERVED` or `INTERVAL_LENGTH_MISMATCH`.
- **No automatic interval selection.** Multiple τ-wide windows may exist; the UI
  starts with nothing selected and never prefers the largest, the last, or the
  one closest to steady state. The choice is an analysis input, echoed in the
  audit trail, never persisted.
- **Alignment is confirmed, not derived.** `timeReference` does not identify a
  dose number, so τ alone cannot say which dose a window belongs to. The
  analyst confirms the interval starts at the recorded administration time; the
  steady-state parameters refuse with `INTERVAL_NOT_ALIGNED` without it.
- **Steady state must be declared.** Only `repeated-dose-steady-state` yields
  dose-dependent parameters. A plain `repeated-dose` dataset reports its AUCτ
  and is refused with `REGIMEN_NOT_STEADY_STATE`. No code path inspects curve
  shape, adjacent interval similarity or dose count to decide steadiness.
- **A dose basis is part of the contract.** `doseBasis`
  (`per-administration` | `total-regimen` | `unknown`) is optional and defaults
  to **not recorded**, never to `per-administration`. Only
  `per-administration` is a valid `Dose_τ`; a total-regimen amount is refused
  (`DOSE_BASIS_NOT_PER_ADMINISTRATION`) because dividing a cumulative amount by
  one interval inflates clearance by the number of doses.
- **λ_z comes from the selected interval.** The interval subset is analysed by
  the existing `analyzeNca`; the whole-dataset λ_z is never substituted. A
  missing interval λ_z leaves `CL`/`CL/F` available and `Vz`/`Vz/F`
  unavailable.
- **Reuse, don't reimplement.** The area uses the same `trapezoidalArea` as
  `AUC(0→last)`; units, statuses, audit strings and the parameter table are the
  phase-50B ones. `AUCτ` is never `aucInf` renamed, and the ≤20 % extrapolation
  criterion of the single-dose path does not apply to an observed-only area.
- **Additive interchange change.** `.npex` goes to 1.2.0 for `doseBasis`; 1.0.x
  and 1.1.x still import. `.npsb` needs no change because it snapshots rows
  verbatim. Derived values remain ephemeral.

**Rejected alternatives.** *Integrate the whole dataset and call it AUCτ* — its
length is not τ. *Auto-select the interval with the most points or the largest
area* — a selection rule is not evidence of a dosing interval. *Compute CL from
`repeated-dose` and label it "non-steady-state CL"* — no such parameter exists;
`Dose/AUCτ` off steady state is not a clearance. *Default a missing dose basis to
per-administration* — that silently turns a cumulative or unstated amount into a
per-dose amount. *Fit the terminal phase on the whole dataset and reuse its λ_z*
— it describes another window.

**Consequences.** Every AUCτ names the interval it covers, in the dataset's own
time units, with its source rows and integration segments. Every steady-state
parameter traces to an explicit per-administration dose, a confirmed τ-wide
observed interval and that interval's λ_z — or it is refused with a code that
says which of those is missing.

---

## ADR-33 · Interval exposure metrics are observed values, and the steady-state pair is gated on a declaration

**Context.** Phase 50D adds `Cmax,obs`, `Tmax,obs`, `Cmin,obs`, `Tmin,obs`,
`Cavg,interval`, `Cavg,ss` and the peak-to-trough fluctuation over the interval
phase 50C already integrates. The exposure pair is the classic trap: peak and
trough are naturally read as "the" peak and trough, and `AUC/τ` is naturally
read as a steady-state average even when the dataset never claimed steady
state.

**Decision.**

- **The names carry the caveat.** Every extreme is `Cmax,obs`/`Cmin,obs` and the
  result states, in its assumptions, that it is the largest/smallest
  *sampled* concentration — not the true extreme between samples. No
  interpolation, extrapolation, smoothing or fitting is used to invent a peak or
  a trough, and no sampling time is declared a peak because it is first or last.
- **Only the selected interval contributes.** The window comes from the validated
  phase-50C `IntervalAucReport` (both boundaries included); a higher or lower
  concentration elsewhere in the dataset cannot enter the interval metrics.
- **Ties are surfaced, not resolved away.** Every attaining observation (time,
  concentration, `sourceRow`) is returned; the scalar `Tmax,obs`/`Tmin,obs` is
  the earliest attaining time and the metric is `conditional`, because a single
  time would imply a uniqueness the data lack.
- **`Cavg,interval` is never a steady-state average.** It divides `AUCτ` by the
  interval's own duration in the dataset's time unit, so the result stays a
  concentration, and it is labelled as an interval mean.
- **The fluctuation is an estimate, not a bound.** Its numerator is a sampled
  range and its denominator an `AUCτ`-based mean: sparse sampling can miss the
  actual extremes and the trapezoidal area can err in either direction, so a
  smaller observed range does not make the normalized percentage a strict lower
  bound. The result is described as an observed-data-based estimate, and no
  bound is claimed without additional assumptions about the concentration–time
  profile between samples and the integration error. (An earlier draft of this
  phase claimed a lower bound; that claim was withdrawn in review.)
- **The steady-state pair needs a declaration plus the alignment confirmation.**
  `Cavg,ss = AUCτ/τ` and `100·(Cmax,obs − Cmin,obs)/Cavg,ss` exist only for
  `regimen = repeated-dose-steady-state` with the phase-50C interval-to-dose
  confirmation. Without the declaration both are `not-applicable` with
  `REGIMEN_NOT_STEADY_STATE`/`REGIMEN_UNKNOWN` — and that verdict survives an
  unusable interval, so the real reason is not masked. Without the confirmation
  they are `unavailable` with `INTERVAL_NOT_ALIGNED`.
- **No fabricated numbers at the boundary.** A zero, non-finite or overflowing
  `Cavg,ss` makes the fluctuation `unavailable` with `NUMERICAL_FAILURE`; never
  `Infinity`, `NaN` or a `0 %`.
- **Reuse.** The module consumes the interval report (window, `AUCτ`, source
  rows) and the unit catalog; it integrates nothing and re-derives no λ_z.
  `observed` vs `calculated` is part of every result and is rendered by the UI.
- **No persistence change.** All seven metrics are ephemeral and are never
  written to the dataset, `.npex` or `.npsb`.

**Rejected alternatives.** *Call it `Cmax`* — it would claim an unobserved
maximum. *Pick the first attaining row for `Tmax`* — it would hide ties that are
a property of the data (the earliest time is reported **and** every attaining row
is listed). *Compute `AUCτ/τ` for any repeated regimen and label it "average"* —
it is not a steady-state average without a steady-state declaration.
*Infer steady state from a flat curve* — same prohibition as ADR-32.
*Return `0 %` when the mean is zero* — a fabricated value for an undefined
ratio.

**Consequences.** Every displayed exposure number is labelled observed or
calculated, names the interval it covers, lists the source rows that produced an
extreme (including ties), and either reports its audit line or refuses with a
code that identifies the missing prerequisite.

---

## ADR-34 · Sampling diagnostics describe observations without judging their adequacy

**Context.** Phase 50E needs to expose where samples actually lie inside the
phase-50C selection. A largest-gap number or a peak at an interior sample can
look like an automatic quality judgement, but neither establishes that the true
extremes were observed or that a PK analysis is adequately sampled. Duplicate
rows and tied gaps also make record counts, time counts and “the” longest gap
easy to conflate.

**Decision.**

- **One explicit closed window.** Use `IntervalAucReport.selection` and actual
  rows in `[t_start, t_end]`. Never choose a default window, interpolate a
  boundary or infer a time between samples. Sampling statistics remain
  available when AUCτ has a separate refusal; their status never unlocks AUCτ.
- **Records and times are different quantities.** Report observation records,
  distinct times and adjacent-gap counts separately. Sort a copy of the
  distinct times for gap calculations, retain every original row, and return
  every source row in each repeated-time group without averaging replicates.
- **Complete gaps and ties.** For adjacent distinct times report minimum,
  standard median (the mean of the two middle values for an even count),
  arithmetic mean and maximum. Retain all gaps and all endpoint source rows;
  return every maximum tie. With fewer than two times, refuse gap statistics
  instead of inventing a zero.
- **A proportion, not a score.** `100 × maximumGap / windowDuration` is shown
  with its gap, width and dataset time unit. It is not a coverage or adequacy
  score. Non-finite arithmetic produces structured unavailability, while valid
  independent sections survive.
- **Reuse observed extremes.** Position diagnostics consume every tied
  `Cmax,obs`/`Cmin,obs` observation from phase 50D and classify each as start,
  interior or end. They never re-derive an extreme or use only the scalar
  earliest time. If phase 50D is unavailable, only this section is unavailable.
- **No verdict and no feedback into PK.** No point-count/gap threshold, curve
  inference, true-extreme claim, integration-error estimate or automatic NCA
  gate is introduced. The diagnostics never feed AUCτ, exposure or
  dose-dependent formulas, and the phase-50D fluctuation remains an
  observed-data-based estimate rather than a strict lower bound.
- **Ephemeral and dependency-free.** No persistence, schema, interchange
  version, migration, dependency or licence change is needed.

**Rejected alternatives.** *Call the percentage “coverage” or “adequacy”* — a
window proportion is not evidence of either. *Drop duplicate timestamps* — that
would discard real records and their provenance. *Return only the first longest
gap or first tied extreme* — both hide data. *Require AUCτ before showing any
sampling statistics* — the selection and observed times can support descriptive
statistics independently. *Infer a missed peak from a boundary maximum* — the
unobserved curve between samples is unknown.

**Consequences.** Users can audit what was sampled, where the longest gaps and
repeated times occurred, and where sampled extremes sit, with complete source
rows and explicit partial-unavailable states. Interpretation remains with the
analyst and the existing PK formulas and persisted data are untouched.

---

## Tooling notes (not decisions, but useful)

- **shadcn CLI workspace bug (v4.20/4.21):** `shadcn init` failed with
  "Could not load the workspace config" in this project; components were
  added with `shadcn add`, which works once `components.json` exists and the
  `@/*` paths are declared in the **root** `tsconfig.json` (the CLI reads the
  root config, while `tsc -b` reads `tsconfig.app.json` — both are kept in
  sync). Components were relocated to `src/components/ui` after the CLI wrote
  them to a literal `@\` folder.
- `npm audit` flags dev-only transitive deps of the `shadcn` CLI package; it
  does not affect the shipped bundle. Phase 7A verified this precisely:
  production audit clean (0 vulnerabilities), full tree 7 high from a single
  advisory with **no fixed release** (`braces` ≤ 3.0.3,
  GHSA-vfj7-8cjw-p6xm). CI therefore blocks on `npm audit --omit=dev` and
  reports the full tree without blocking; the re-check condition and full
  dependency paths live in `docs/architecture.md` §7 "Known tooling notes".
