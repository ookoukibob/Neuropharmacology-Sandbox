# Testing strategy

Scientific calculations require stronger testing than ordinary UI code.
Tests are treated as part of the specification: the required matrix below is
written **before** each model is implemented (TDD for the engine).

Harness (phase 1, working):

| Tool | Scope | Command |
| --- | --- | --- |
| Vitest | unit, schema, component tests (`src/**/*.test.{ts,tsx}`) | `npm test` |
| React Testing Library | component behaviour in jsdom | (same) |
| Vitest coverage (v8) | `src/domain/**`, `src/engine/**`, `src/data/**` | `npm run test:coverage` |
| Playwright | end-to-end workflows (`e2e/`) | `npm run test:e2e` |
| axe-core | automated accessibility scans inside Playwright (`e2e/a11y.spec.ts`) | `npm run test:e2e` |

Setup: `vitest.config` in `vite.config.ts`, `src/tests/setup.ts`
(jest-dom matchers), fixtures in `src/tests/fixtures/`.

Tests are **colocated** with the code they test
(`src/data/schemas/npsl.test.ts`), with shared fixtures under `src/tests/`.
This keeps the import path short and the suite discoverable.

---

## 1. Engine test matrix (required for every model)

Each model (`pk`, `occupancy`, `dose-response`) gets a test file covering:

| Category | Examples |
| --- | --- |
| Normal values | documented reference inputs → independently computed expected outputs (hand-derived in the test, not copied from the code) |
| Zero concentration | `[D] = 0` → occupancy `0`; `C0 = 0` → `C(t) = 0`; Hill `E = E0` |
| Boundary values | `t = 0` → `C(0) = C0`; `[D] = Kd` → occupancy `0.5`; `[D] → ∞` → occupancy → 1, Hill → `E0 + Emax` |
| Negative inputs | `Kd < 0`, `t < 0`, `C0 < 0` → `NEGATIVE_VALUE` errors |
| Missing parameters | omitted `halfLife` / `Kd` / `EC50` → `MISSING_PARAMETER`, **no default** |
| Invalid units | unknown symbol → `UNKNOWN_UNIT`; `mg/L` vs `nM` → `INCOMPATIBLE_UNITS` |
| Invalid combinations | `EC50 = 0` (Hill), `n ≤ 0`, `Emax`/`E0` non-finite → typed errors |
| Non-numbers | `NaN`, `±Infinity` → `NOT_A_NUMBER` |
| Extreme magnitudes | very large/small concentrations (1e-9 … 1e9), long times — no overflow/NaN, graceful decay to 0 |
| Numerical precision | Decimal-path results stable to the documented precision; identical inputs → byte-identical reports |
| Report completeness | `ok: true` results contain formula, inputs, non-empty trace, outputs, assumptions, warnings (incl. `MODEL_RESULT_NOT_CLINICAL`) |
| Purity | same input twice → deep-equal output; inputs not mutated |

Curve generation additionally tests: point counts, axis scale declarations
(`xScale`/`yScale`), monotonicity of decay, endpoint behaviour, and that
`seriesType` is set.

---

## 2. Schema tests (phase 1 — implemented)

`src/data/schemas/npsl.test.ts` covers:

- valid fixture parses; all five provenance variants preserved;
- normalization defaults (empty collections, `dataStatus`);
- forward compatibility (the loose parse keeps unknown keys — envelope,
  metadata and every drug nesting level; full round-trip preservation and
  the merge collision policy are covered by the repository/mapper tests);
- rejections: non-finite value, wrong value type, empty unit, unknown
  provenance type, `literature` without `source`, missing
  `libraryMetadata`, malformed ISO date, invalid version string;
- `checkNpslVersions`: accept same/older-minor, reject newer minor and
  different major.

Fixture policy: test data is **synthetic and explicitly marked** —
`src/tests/fixtures/example-library.npsl.json` has
`"dataStatus": "example"` and names like "Test Compound 001 (synthetic
fixture)". No fabricated value ever resembles real pharmacology.

---

## 3. Component tests (RTL)

What we assert: semantics and behaviour — roles, accessible names,
`aria-current` on the active route, keyboard reachability, error/warning
rendering, provenance labels, absence of emoji as UI.

What we do **not** assert: pixel styling, class strings of shadcn internals.

Current examples: `src/app/layout/AppLayout.test.tsx` (navigation landmarks,
skip link, active-route semantics, page titles, main-region focus
placement, no-emoji rule),
`src/features/drug-library/views.test.tsx` (form error summary tied to the
invalid control with `aria-invalid` / `aria-describedby` and focus moved to
it, two-step delete acknowledgement with Escape, loading and error
announcements, provenance preservation across edits — unchanged
parameters keep their complete provenance while only changed or new ones
are re-stamped, matched by stable identity — and target-metadata
preservation across edits: the supported target-level fields
(`gene`, `action`, `species`, `notes`) survive unrelated drug edits,
target renames, parameter changes, row removal with position shifts and
recreated-target name collisions, are never inherited by new rows, and
absent fields stay absent with no explicit `undefined` keys, plus
untouched list/text preservation across edits — synonyms/tags/name/notes
whose draft is still at its mount-time baseline are submitted verbatim,
embedded commas, duplicate entries and edge whitespace included, while
only actually-changed fields are parsed or trimmed and a reverted draft
counts as unchanged (audit DI-03)) and
`src/features/calculator/CalculatorView.test.tsx` (heading hierarchy, the
URL ⇄ store deep-link convergence regression, the roving PK
parameterization radio group, and schema errors surfacing on the fields
when Calculate runs with empty inputs), and
`src/features/import-export/ImportExportView.test.tsx` (preview-before-
write, replace acknowledgement, explicit CSV mapping, export contents, the
committed-but-refresh-failed report — never "nothing was written" — and
the quarantine export warning against a populated vs. empty quarantine —
all against the real repository with fake-indexeddb), and
`src/features/import-export/RecoveryPanel.test.tsx` (recovery preview
counts and acknowledgement gating, the four restore outcomes including
the committed-refresh-failed report whose retry re-runs only the session
refresh, export failure honesty with no file and no success status, and
mutual rejection with ordinary import), and
`src/features/drug-library/DrugForm.persistence.test.tsx` (an edit save
through the real detail → form → store → repository chain keeps unchanged
parameter provenance whole — citation/DOI/unknown keys included — in the
actual stored record, stamps only the parameter that changed, keeps
every surviving target's `gene` / `action` / `species` / `notes` in the
raw IndexedDB row — with no metadata migrating onto survivors or
recreated targets — proven by a fresh repository read, keeps the
stored-only identifier metadata `description` / `casNumber` byte-identical
in the raw row after an unrelated edit (audit DI-01), and keeps the
untouched list/text fields `synonyms` / `tags` / name / top-level notes
byte-identical in the raw row after an unrelated edit — embedded commas,
duplicates and edge whitespace included (audit DI-03); same
real-repository setup) and
`src/app/pages/SettingsPage.test.tsx` (the settings controls against the
real app stores: theme applied to the document root and persisted,
per-model curve display defaults with field- and engine-level
validation, invalid text refused and never saved, the Import / Export
link, and the acknowledged reset whose scientific-data scope is asserted
with repository spies and an untouched calculator draft — initialized
exactly like `main.tsx`), and
`src/features/data-sources/DataSourcesView.test.tsx` (the whole
on-demand chain against the real Dexie repositories with `fetch`
stubbed from checked-in fixtures: picker contents, **zero network
requests on mount**, PubChem search → selection → preview → confirmed
import landing in IndexedDB with provenance, code-specific network
failure with nothing written, honest empty state, and the Layer C rules
at the UI level — new-target promotion with an `observationId`
provenance link, no substitution for an unmappable endpoint, the bound
(`<`) qualifier keeping Apply disabled, the explicit overwrite gate for
an occupied slot, and identity-only library addition with attribution).

---

## 4. End-to-end tests (Playwright)

Critical workflows only (each one is a spec-level guarantee):

1. Shell: load → navigate between views → boundary notice visible
   (`e2e/shell.spec.ts`, implemented).
2. Calculator (`e2e/calculator.spec.ts`, implemented — all synthetic
   values, records tagged as test fixtures):
   - occupancy calculation → result, formula, calculation trace;
   - PK half-life ↔ rate-constant switching preserves inputs and
     recalculates (regression for the discriminated-union bug);
   - drug → calculator: candidate visible but never auto-selected,
     explicit load carries provenance into the report;
   - stale state: input edits and library loads mark the result stale
     until recalculated;
   - curve workflow: explicit range → chart container, settings changes
     flagged until "Update curve".
3. Library persistence (`e2e/library.spec.ts`, implemented — real UI and
   real IndexedDB, no mocks, isolated context per test): create a
   synthetic record → save → the detail page shows name, target, value,
   unit, storage-origin badge and provenance badge → reload → the record
   hydrates with its provenance intact → edit one value → save → reload
   → the edit persisted → delete through the two-step acknowledgement →
   reload → the library is empty again. Plus the phase 10 workflow: a
   user-origin record whose target carries supported metadata
   (`gene`, `action`, `species`, `notes`, entered via the NPSL import
   path) → an unrelated edit (drug name) → all four fields still shown →
   real reload → still persisted.
4. Keyboard workflows (`e2e/keyboard.spec.ts`, implemented): skip link is
   the first tab stop and moves focus to the main region; navigation and
   route activation without a mouse (with focus placement and page
   title); drug form → validation error → correction → save; calculator
   model select → PK parameterization radio group → blocking errors →
   result → focus indicator; import/export tabs and the replace
   acknowledgement → confirm sequence; plus a 375 px viewport check that
   navigation and core forms stay operable without horizontal overflow.
5. Accessibility scans (`e2e/a11y.spec.ts`, implemented): axe-core
   (`@axe-core/playwright`) over the WCAG 2.0/2.1 A and AA rule tags on
   22 stable states across seven tests — library, create form, detail +
   edit form, calculator (initial, PK parameterization, with result),
   empty import/export, CSV mapping, import preview, replace
   acknowledgement, export, the recovery states (initial empty
   library, rejected archive, preview + acknowledgement, restore
   outcome), the settings states (defaults, reset confirmation) and the
   data-sources states (idle with nothing fetched — proving the page
   needs no network —, target results + fetched measurements, import
   report, apply card). No
   rule is disabled and no violation is
   suppressed: a violation fails the spec.
6. Import/export (`e2e/importExport.spec.ts`, implemented — synthetic
   in-memory buffers, six workflows):
   - valid NPSL → preview shows counts and records, **nothing is written
     before the confirmation**, the committed report shows real counts and
     the record (with provenance badge) appears in the library;
   - invalid NPSL → visible parse error with its code, no confirm control,
     library unchanged;
   - replace → blocked (record count unchanged) until the explicit
     acknowledgement is checked, then the whole library is replaced;
   - export `.npsl` + `.json` → byte-identical envelopes, parse round trip
     asserting metadata, values, units and provenance survive;
   - CSV mapping → every select starts unmapped (a `Kd/Ki` header is never
     inferred), missing drug-name and missing unit-source are blocked with
     visible reasons, the explicit Kd choice lands as Kd with its unit and
     no Ki, storage origin shows `Imported`;
   - CSV export → stable 57-column header, one row per target, and the
     always-visible lossiness warning.
7. Recovery backup/restore (`e2e/recovery.spec.ts`, implemented —
   synthetic records, isolated context per test, quarantine seeded
   through narrowly-scoped raw IndexedDB writes, four workflows):
   - export → replace → restore round trip: the downloaded `.npsb`
     carries readable + quarantined + metadata rows with exact counts,
     a replace import clears the quarantined row, restore brings it
     back verbatim and it survives a reload;
   - malformed archive → visible structured rejection, no confirm
     control, library unchanged now and after a reload;
   - mutual rejection both directions (`.npsb` in ordinary Import fails
     on `formatVersion`, `.npsl` in restore fails `ARCHIVE_NOT_NPSB`
     with import guidance), nothing written;
   - export failure honesty: a stored `Date` fails the export with
     store/key/path/type diagnostics, **no download event** (bounded
     wait, not a sleep) and no success status.
8. Settings (`e2e/settings.spec.ts`, implemented — synthetic values,
   isolated context per test, two workflows):
   - theme → Dark is applied immediately as the `.dark` class on the
     document root; theme and a valid per-model curve display default
     both survive a reload; the calculator starts from the saved
     default; the data-management link lands on Import / Export; the
     scoped reset (two-step acknowledgement) restores the documented
     defaults and they persist through another reload;
   - system mode follows an emulated OS color-scheme change live, and a
     manual theme choice is never overridden by later OS changes.
9. Export round trip at the repository level (export → import → deep
   equality) is covered by repository tests; the E2E layer asserts the
   exported file's content parses back with provenance intact.
10. Data sources (`e2e/dataSources.spec.ts`, implemented — all HTTP
    intercepted with `page.route` from checked-in fixture payloads in
    `e2e/sourceMocks.ts`, isolated context per test, five workflows):
    - **startup honesty**: loading `/data-sources` performs **zero
      external requests** and leaves the stored panel empty (no bundled
      database, no download, no seeding);
    - PubChem search → selection → advisory preview → confirmed import
      landing in the stored panel, with the identity-only source not
      misrepresented as an activity source;
    - ChEMBL target flow: measurements keep their qualifiers (`<`, `>`,
      preserved raw relations), the valueless row is counted as omitted,
      unmappable endpoints are labelled, and the imported observation's
      compound identity is resolved through the batch lookup;
    - Layer C: an imported measurement supplies a parameter on a drug
      record created through the real form, with the provenance badge
      showing its ChEMBL source;
    - a failed search explains itself (`Network error`) and writes
      nothing.

   Shared route mocks live in `e2e/sourceMocks.ts`; they are also used by
   the accessibility scans.

Config: `playwright.config.ts` (chromium; dev server auto-started).

The specs themselves are held to the same strictness as the application:
`npm run typecheck:e2e` runs `tsc --noEmit -p tsconfig.e2e.json` over every
`e2e/**/*.ts` file (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, unused locals/parameters), separately from
`npm run typecheck` so a spec-only error is reported against the specs. CI
runs it in the quality-gates job as a mandatory step.

---

## 5. Round-trip testing (NPSL)

Required by the specification:

```
NPSL file → import → internal domain model → export → NPSL file
```

Test procedure:

1. Parse fixture with `npslFileSchema` + semantic validation + mapper →
   `DrugLibrary`.
2. Export back through the serializer.
3. Assert with **normalizing deep equality**:
   - every scientific value keeps `value`, `unit` and full `provenance`;
   - library metadata (name, author, description, timestamps, dataStatus)
     preserved;
   - drug identity, targets (including Kd/Ki/EC50/IC50 separation), tags,
     notes preserved;
   - unknown forward-compatible keys survive (every supported nesting
     level plus library metadata; envelope-level extras are reported as
     `ENVELOPE_FIELDS_DROPPED`, not retained).
4. Assert explicitly documented normalizations (defaults filled, import-time
   stamps) rather than ignoring them.
5. Scope the "lossless" claim for `.npsl`/`.json` accurately: records,
   library metadata, provenance and unknown keys at every supported
   nesting level survive the round trip; two exclusions are documented
   rather than hidden — unknown top-level *envelope* fields are not
   stored (the import reports `ENVELOPE_FIELDS_DROPPED`) and quarantined
   records are excluded from every export (a visible warning appears
   whenever the quarantine is non-empty, so such an export is
   explicitly not a complete backup of storage).

Additional round-trip: domain → NPSL → domain (validating the mapper in both
directions), and a JSON ↔ NPSL identity check (`.npsl` is JSON).

Negative zero is covered by the number round trip: the serializer emits the
valid JSON numeric token `-0` (a plain `JSON.stringify` would canonicalize it
to `0`), so a stored `-0` survives export → parse → re-import with its sign —
proven at serializer level (`npslDocument.test.ts`, `Object.is` assertions)
and through the repository with a hand-written document text containing a
literal `-0` token (`dexieDrugRepository.test.ts`).

CSV round-trip is **not** claimed to be lossless; the CSV tests document
exactly which fields survive: value/unit/provenance columns round trip
through writer + reader (`csvExport.test.ts`, `writeCsv.test.ts`), while
a CSV import re-stamps storage `origin` and bookkeeping timestamps — the
lossy edges are listed in `docs/validation.md` §7.

---

## 6. Coverage & gates

- Target for `src/domain`, `src/engine`, `src/data`, `src/features`: high
  branch coverage —
  every error code **any model can emit** must have at least one test
  producing it. Codes reserved without a producer
  (`NUMERICAL_ERROR`, `MODEL_NOT_APPLICABLE`) are documented as reserved in
  [calculation-engine.md](calculation-engine.md) §3 and gain a producing
  test the moment a producer exists.
- `npm run typecheck` (strict), `npm run typecheck:e2e` (strict, every
  Playwright spec), `npm run lint`, `npm test` and `npm run build`
  must all pass before merging a change. CI additionally requires
  `npm audit --omit=dev` (production dependency advisories) to pass, and
  reports the full-tree `npm audit` as a non-blocking step because of the
  known dev-only `shadcn` chain — see `docs/architecture.md` §7
  "Known tooling notes" for the verified baseline.
- Coverage numbers are a smoke alarm, not a goal: an untested *case* (missing
  parameter, bad unit) matters more than an untested line.

---

## 7. Status

| Area | Status |
| --- | --- |
| Vitest + RTL + coverage harness | done |
| NPSL schema tests (15 cases) | done |
| AppLayout component tests | done |
| Playwright config + shell smoke test | done |
| Engine model tests (matrix §1) | done — 3 models, curves, units, numeric, registry |
| Persistence DTO mapper tests | done — round trip, validation, unknown-field preservation (previous-record *and* incoming-drug sources, deterministic merge collisions); NPSL serializer negative-zero preservation (numeric `-0` token emission, `Object.is` round trip incl. nested unknown fields/arrays, look-alike strings untouched, collision-proof placeholder with an explicit collision-branch round trip (source data containing the initial marker as a value and as an extension key plus the first extended candidate, so the loop advances twice; marker-like strings and `-0` both verified after `JSON.parse` — audit DI-04 follow-up), byte-stable output for `-0`-free documents, NaN/Infinity still rejected — audit DI-04) |
| Schema migration tests | done — v1→v2 upgrade: bookkeeping only, scientific + unknown fields survive |
| Repository tests | done — CRUD, metadata stamping, quarantine, atomic replace/import rollback (duplicate drug ids; duplicate target ids leave every stored row byte-identical), NPSL round trip, reload, extension-field matrix (replace/merge/hydration/edit/export/re-import/rollback), targets-replacing unknown-extension preservation (import baseline, reordered same-id replacement + unrelated edit with per-position raw-row asserts, removal/new-id non-transfer boundary — audit GAP-1), merge-vs-quarantined-row collision (rejection with `QUARANTINE_CONFLICT`, raw row byte-identical incl. unknown extension, whole-document no-write with metadata untouched, valid same-id merge still succeeds, authoritative `fromRecord` failure classes enum/structure — audit GAP-3), literal-`-0` NPSL import → raw-row `Object.is` → export token → re-import provenance identity (audit DI-04) |
| Import pipeline tests | done — parse/schema/semantic/preview classification, metadata extension resolution, envelope-field warning, per-drug duplicate-target-id rejection (rejection, per-drug scope, schema authority for missing/empty ids, mixed-document atomicity, preview reporting) |
| Store + library UI tests | done — hydration guard, quarantine report, form safeguards, target-metadata preservation on edit (unrelated edit, rename, parameter change, multiple targets, removal + position shift, remove-and-recreate, absent fields stay absent, create mode), identifier-metadata preservation on edit (unrelated rename, synonyms/tags/notes edits, lone description, lone casNumber, absent stays absent, editable fields from form state, no source mutation, create mode), negative-zero parameter preservation on edit (untouched `-0` value + complete provenance kept exactly, `+0` control, explicit-change restamp, cross-target isolation — audit DI-04), transactional `importLibrary` outcome (ok / invalid / failed / committed-refresh-failed) |
| Calculator tests (adapters, store, schemas, components) | done — drafts, stale semantics, curve settings, PK mode union |
| CSV tests (parse, write, export, mapping, conversion) | done — quoting/escaping/BOM/errors, spreadsheet formula-injection guard (text cells protected, numeric cells byte-exact), stable header, provenance columns, ambiguity + unit rules, CSV → NPSL document, grouping, row errors |
| Import/export UI tests | done — preview-before-write, replace gate, cancel, CSV mapping flow, export contents + object-URL lifecycle, committed-but-refresh-failed report (never "nothing was written"), quarantine export warning (visible with data, silent when empty), quarantined-id merge advisory in the preview plus its authoritative enforcement through the transaction even when the cached quarantine list is stale (audit GAP-3) |
| Recovery format tests | done — fidelity/sidecar/pointer/limits (`fidelity.test.ts`), string-aware duplicate-key scanner (`duplicateKeys.test.ts`), envelope/limits/version/entry/sidecar/warnings batteries (`archive.test.ts`) |
| Recovery repository + store tests | done — read-only snapshot export with fail-closed `BACKUP_READ_FAILED`, single-transaction cross-connection consistency, verbatim restore (quarantine + unknown fields + metadata), rejection before any transaction, rollback on mid-write failure, mutual rejection; store outcomes ok / rejected / failed / committed-refresh-failed with the restore never re-run |
| Recovery UI tests | done — preview count groups, acknowledgement gating, four outcome reports, export failure honesty (no file, no success status), oversized/invalid file rejection, cancel (`RecoveryPanel.test.tsx`) |
| Preferences tests (schema, storage, store) | done — defaults on first run, save/restore round trip with verbatim string forms, malformed JSON and non-object payloads, unsupported schema versions, invalid theme/scale/value types, engine cross-field range rules (min < max, log-safe min, points bounds), live system-mode theme behavior, manual-theme precedence over OS changes, write-failure degradation (`loadStatus: 'unavailable'`), scoped reset, persisted-key shape (no scientific state) |
| Calculator presentation-settings tests | done — `applyPresentationSettings` replaces display defaults without touching drafts/report/curve, marks the curve stale when a report exists; `defaultCalculatorSettings` returns fresh independent copies |
| Settings UI tests | done — four sections with accessible headings, theme applied + persisted per model blocks, invalid range text refused with `aria-invalid`/description, cross-field enforcement, restore-defaults keeps the theme, data-management link, About metadata, acknowledged reset (Escape, focus, scope) with repository mutation spies and an untouched scientific draft, invalid/unavailable-storage notes |
| Source adapter tests | done — PubChem name/CAS/InChIKey resolution, ChEMBL compound/target/activity/endpoint filtering, fixtures-only HTTP (`src/data/sources/*.test.ts`) |
| Source-data repository tests | done — atomic import (validation failure rolls back, nothing written), deterministic ids, existing-records-win skip reporting, orphan-observation rejection, quarantine on invalid stored rows, hydrate with provenance and license survival (`dexieSourceDataRepository.test.ts`) |
| Database schema tests | done — verno 3 with `compounds` + `observations` stores, fresh-install table creation, v1→v2→v3 migration chain, drug rows byte-identical through the v2→v3 upgrade (`database.test.ts`) |
| Data-sources store tests | done — startup-no-seed with real adapters (zero fetch), search lifecycle (stale/cancel/source- and scope-switch), observation retrieval (merge paging, page-source snapshot, stale guard), import (identity resolution, whole-batch failure, no-op, advisory preview), Layer C apply rules (endpoint mapping, qualifiers, units, occupied-slot overwrite, unknown ids) (`src/features/data-sources/store.test.ts`) |
| Data-sources UI tests | done — full chain against real repositories with fixture-stubbed `fetch`: picker, zero network on mount, search → preview → confirmed import, network-failure honesty, Layer C UI gates, identity-only library addition (`DataSourcesView.test.tsx`) |
| Drug-form persistence integration tests | done — real detail → form → store → Dexie chain: whole provenance of unchanged parameters in the raw stored row, user stamp only on the changed parameter, supported target metadata (`gene` / `action` / `species` / `notes`) intact after an unrelated edit, no metadata migration after removal + same-name recreation, stored-only identifier metadata (`description` / `casNumber`) preserved byte-identical in the raw row after an unrelated edit (raw row + fresh repository read), untouched list/text fields (`synonyms` / `tags` / name / top-level notes) preserved byte-identical in the raw row after an unrelated edit (audit DI-03), a negative-zero parameter kept exact (`Object.is`) with its complete provenance in the raw row after an unrelated edit, and top-level `notes` absent/empty proven by raw-row own-property checks (audit DI-04 + DI-03 follow-up), unknown target extension fields surviving the form's targets-replacing save with a post-import baseline (record, target and provenance level, stable-id + non-transfer asserts — audit GAP-1), and the whole pharmacokinetics object (half-life, clearance, Vd, bioavailability: values, units, complete provenance incl. an unknown extension key) deep-equal in the raw row and a fresh read after an unrelated rename (audit GAP-2) |
| Test suite total | 868 unit tests (52 files) |
| Calculator + shell e2e | done — 6 workflows (`e2e/shell.spec.ts`, `e2e/calculator.spec.ts`) |
| Import/export e2e | done — 6 workflows (`e2e/importExport.spec.ts`) |
| Library reload e2e | done — 2 workflows (`e2e/library.spec.ts`): create → detail → reload → edit → reload → delete via acknowledgement → reload; and target metadata: import user-origin record with `gene`/`action`/`species`/`notes` → unrelated edit → fields still shown → reload → persisted |
| Keyboard e2e | done — 6 workflows (`e2e/keyboard.spec.ts`): skip link, navigation, drug form recovery, calculator, import/export confirmation, narrow-viewport operability |
| Recovery e2e | done — 4 workflows (`e2e/recovery.spec.ts`): quarantine-preserving export → replace → restore round trip with reload persistence, malformed rejection, mutual `.npsb`/`.npsl` rejection, export failure honesty with a bounded no-download wait |
| Settings e2e | done — 2 workflows (`e2e/settings.spec.ts`): theme + calculator display defaults persist across reloads and the scoped reset restores only preferences; system-mode follows live OS color-scheme changes with manual precedence |
| Data-sources e2e | done — 5 workflows (`e2e/dataSources.spec.ts`, fixture-mocked HTTP via `e2e/sourceMocks.ts`): zero external requests on page load, PubChem search → explicit selection → confirmed import, ChEMBL measurement fidelity (qualifiers, omitted row counting, unresolved-identity resolution), Layer C promotion with provenance badge, network-failure honesty with nothing written |
| Accessibility e2e | done — 7 scans (`e2e/a11y.spec.ts`) covering 22 stable states (incl. four Recovery, two Settings and four Data Sources states) with axe-core WCAG A/AA tags; no rules disabled, no violations suppressed (0 violations) |
| Dependency security gate | done — `npm audit --omit=dev`: 0 production vulnerabilities (blocking in CI); full tree: 7 high, all dev-only, from one advisory with no fixed release (`braces` ≤ 3.0.3, GHSA-vfj7-8cjw-p6xm), reported non-blocking |
