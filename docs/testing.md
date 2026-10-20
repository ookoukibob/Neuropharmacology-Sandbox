# Testing strategy

Scientific calculations require stronger testing than ordinary UI code.
Tests are treated as part of the specification: the required matrix below is
written **before** each model is implemented (TDD for the engine).

Harness (phase 1, working):

| Tool | Scope | Command |
| --- | --- | --- |
| Vitest | unit, schema, component tests (`src/**/*.test.{ts,tsx}`) | `npm test` |
| React Testing Library | component behaviour in jsdom | (same) |
| Vitest coverage (v8) | `src/domain/**`, `src/engine/**`, `src/data/**`, `src/features/**`, `src/components/charts/curveAdapter.ts` | `npm run test:coverage` |
| Playwright | end-to-end workflows (`e2e/`) | `npm run test:e2e` |
| axe-core | automated accessibility scans inside Playwright (`e2e/a11y.spec.ts`) | `npm run test:e2e` |

`npm run test:coverage` prints the coverage summary tables into the
terminal and writes the full report under `coverage/` (gitignored); CI
runs the same script as its own blocking `Coverage` job
(`.github/workflows/ci.yml`), independently of the other three jobs.

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

### 1a. Dynamic simulation matrix (phase 41)

Run with `npx vitest run src/engine/simulation`. Every numerical expectation
is an independent closed form (or hand arithmetic), never a value copied from
the implementation.

| File | Covers |
| --- | --- |
| `solver.test.ts` (22) | tableau consistency (row sums = c, weights sum to 1, error weights sum to 0); constant derivative `y = y₀ + a·t`; exponential decay; the coupled linear system `y₂' = k₁y₁ − k₂y₂` against its closed form; the `(cos t, sin t)` circle at π; error falls as tolerances tighten (1e-8 → 1e-10 → 1e-12); steps adapt instead of following the output grid; steps clip at targets; invalid tolerances/steps/budgets; unordered or non-increasing targets; wrong derivative length; non-finite derivatives; `MAX_STEPS_EXCEEDED`; `FAILED_TO_ADVANCE` at the double time resolution (1e17 spacing); deterministic repeated runs; input immutability; the exact evaluations-per-attempt table (6·A + 8·R) including FSAL reuse; no success after a failure |
| `models/two-compartment-pk.test.ts` (15) | derivative written out by hand for both compartments; `C = A/V`; **Q = 0 analytical oracle** (`A_c = D·e^(−kt)`, `C_c = (D/V_c)e^(−kt)`, `A_e = D(1−e^(−kt))`); mass balance along the run; peripheral transfer with Q > 0 (rise, peak, return); the no-elimination exchange closed form for both compartments; zero input/state; steady input; determinism |
| `events.test.ts` (24) | empty schedule; identifiers (missing/duplicate); non-finite, out-of-horizon and negative quantities; session rules (stop without start, unstopped session, second start, repeated stop, zero-duration pair, same-instant start+stop); total ordering (time → stop/bolus/start → code-point id) independent of input order; bolus jump writes both `A_c` and `A_in`; overlapping rates summed; per-event trace with before/after and the post-event rate; no double application; caller state untouched; pre/post rate snapshots |
| `simulate.test.ts` (34) | closed-form Q = 0 trajectory; report completeness (model id/version, initial state, parameters, solver settings, warnings); unit-equivalent scenarios give identical trajectories; pre/post-event samples; no stepping across events; **output-grid independence** (same event trace, same science); each event applied once; same-time order in the trace; simultaneous infusions with CL = 0 (area under the rate = accumulated amount); start-time event semantics; repeated boluses and sessions; mass balance across boluses, infusions, overlaps, repeated events, non-zero initial amounts and distribution; tolerance derived from settings and mass scale; elimination integrated as a state (coarse vs dense grid); **ADR-25 reference-point tests with hand-computed expected residuals** (start-time bolus, mid-run bolus control, two-compartment initial amounts, zero residual at the initial sample); validation errors (`MISSING_PARAMETER`, `NOT_A_NUMBER`, `NEGATIVE_VALUE`, `ZERO_NOT_ALLOWED`, `OUT_OF_RANGE`, `UNKNOWN_UNIT`, `INCOMPATIBLE_UNITS`, `INVALID_EVENT_SEQUENCE`); a solver failure surfaces as a structured failure without samples; byte-identical repeat runs; scenario immutability |
| `domain/pharmacology/unit-catalog.test.ts`, `engine/units/units.test.ts` | new dimensions: mass (base g), volume (base L), clearance (base L/h), mass-flow rate (base mg/h); exact factors (1 mL = 1e-3 L, 1 mL/min = 0.06 L/h, 1 µg/min = 0.06 mg/h); rejection of every cross-dimension conversion (mg↔L, L/h↔mg/h, L/h↔h, mg↔mg/L); `dimensionLabel` covers every catalog dimension |

**Tolerances.** Solver cases assert against the closed form with explicit
bounds (e.g. `1e-9·max(1, exact)` at atol/rtol 1e-10–1e-11). Mass-balance
assertions use the run's own derived tolerance — never a fixed percentage —
and the invariant regression tests recompute the expected residual by hand
rather than calling the production helper.

**Runtime verification note.** While the phase-41 accounting was being
fixed, the failing assertion was reproduced twice in a fresh Vitest process,
the resolved source file was confirmed by a direct filesystem read, and the
failure disappeared once the double counting described in ADR-25 was removed;
no infrastructure defect had to be assumed.

---

## 2. Schema tests (phase 1 — implemented)

`src/data/schemas/npsl.test.ts` covers:

- valid fixture parses; all five provenance variants preserved;
- normalization defaults (empty collections, `dataStatus`);
- forward compatibility (the loose parse keeps unknown keys — envelope,
  metadata and every drug nesting level; full round-trip preservation and
  the merge collision policy are covered by the repository/mapper tests);
- rejections: non-finite value, wrong value type, empty unit, unknown
  provenance type, `literature` without `source`, empty/malformed
  portable attribution fields (`sourceRecordId`, `licenseUrl`), missing
  `libraryMetadata`, malformed ISO date, invalid version string;
- portable literature attribution on promoted values (`sourceRecordId`,
  `licenseNotice`, `licenseUrl`) accepted and preserved;
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
an occupied slot, and complete library import with the full source
snapshot), and
`src/features/data-sources/import-to-library.test.ts` (the complete
Data Sources → Library import against the real repositories: a full
PubChem import keeping every identifier and chemical property, a full
ChEMBL import keeping attribution, license terms and the measurement
context, missing fields staying absent, a compound with no measurements,
identity-aware repeat imports, same-name/different-identity records,
same-source conflicts, linking an existing manual record without
disturbing its targets/parameters/notes, the import never setting a
model parameter, and zero network traffic on the whole path), and
`src/domain/drug/source-data.test.ts` (the merge policy: idempotent
re-import, append-only new measurements, a same-source conflict reported
and never merged, disagreeing measurements preserved), and
`src/data/mappers/sourceRecords.test.ts` plus
`src/data/repositories/dexieDrugRepository.sourceRecords.test.ts`
(round-trip identity, unknown-field preservation matched by source and
observation id, legacy records and files, `.npsl` and `.npsb` round
trips, revision-guarded attach, and rejection of malformed snapshots
with nothing written), and
`src/features/drug-library/DrugSourceData.test.tsx` plus
`src/features/drug-library/sourceData.persistence.test.tsx` (the detail
sections and list indicator, honest "not reported" markers, disagreeing
measurements kept separate, and an edit → reload cycle that keeps every
imported field).

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
     flagged until "Update curve";
   - blank-input curve validation (phase 27, regression for the phase 26
     fix): after a valid PK calculation and curve, clearing C0 and
     pressing "Update curve" — or changing the x-axis scale, which
     auto-applies — surfaces the schema message "Enter a value." with the
     input marked `aria-invalid` and wired through `aria-describedby`,
     removes the chart instead of silently plotting a zero curve, keeps
     the previous report only as a stale result, shows no misleading
     engine `ZERO_NOT_ALLOWED` for the blank field, and regenerates the
     curve after the field is corrected. The rendered chart is asserted
     to contain its SVG and to have drawn the expected endpoints
     (C(0) = 100 µM, C(10) ≈ 0.09765625 µM), read back from the chart's
     committed trace data.
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
    `e2e/sourceMocks.ts`, isolated context per test, six workflows):
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
    - source-target identity (phase 18I): a measurement applied to a new
      target carries the source's own target identity (id, record link,
      license notice) read-only in the target detail; a synthetic
      conflicting measurement (same reported name and organism, a
      different ChEMBL target id — `mockChEMBLWithConflictingTarget`)
      shows both identities in the comparison and the mismatch
      confirmation, stays blocked until acknowledged, and after applying,
      the stored reference is unchanged — the conflicting id is never
      merged;
    - a failed search explains itself (`Network error`) and writes
      nothing.

   Shared route mocks live in `e2e/sourceMocks.ts`; they are also used by
   the accessibility scans.

11. Multi-tab write safety (`e2e/multitab.spec.ts`, implemented —
    phase 19 observed the defect / phase 20 remediated it, audit
    GAP-4): two pages in the SAME browser context (one shared
    IndexedDB) mount edit forms on one synthetic user-origin record
    from the same stored snapshot before either tab saves. Both
    scenarios assert the phase-20 conflict contract: the later save
    from the still-stale tab is REJECTED atomically — a typed
    "Record changed elsewhere" alert inside the still-open form, the
    draft intact (tags and mount-time name in scenario 1; rename and
    untouched stale targets in scenario 2), no session error, the
    stored record kept exactly as the committing tab wrote it (fresh
    tab verification; scenario 2 also pins the exact provenance badge
    title and the ChEMBL source reference), recovery via open-latest
    (popup, draft kept), dismissal (draft and stale token kept — a
    re-save conflicts again) and reload-then-edit (successful, the
    other tab's commit preserved). The unrelated control record and
    library metadata remain unchanged. The phase-19 scenarios that
    pinned the silent overwrite were replaced by these conflict
    assertions (the observed behavior is retained as history in
    `docs/data-integrity-audit.md` GAP-4 and `docs/architecture.md`
    §4.2). A third scenario covers the review fix: a stale tab's
    revision-guarded delete is rejected with a "Deletion did not
    happen" conflict (record, science, provenance, source identity and
    the unrelated record all intact; delete locked behind the explicit
    reload), and the reviewed delete succeeds through the unchanged
    destructive confirmation. Synthetic fixtures only; no external
    requests; no sleeps — every wait is an assertion poll. Contract:
    `docs/architecture.md` §4.2, ADR-21.

12. NV-1 real-browser crash durability (phase 21, audit
    NV-1 — `e2e-crash/crash-durability.spec.ts`, implemented): a
    supervised-browser harness that proves the production `.npsb`
    restore transaction (`restoreRecoveryArchive`, one `rw`
    transaction over `drugs`+`meta`+`revisions`) is atomic across a
    real browser-PROCESS kill, and that a committed restore survives
    the same kill. It runs OUTSIDE the ordinary suite: dedicated
    config `playwright.crash.config.ts`, `npm run test:crash`, its
    own CI job (`NV-1 crash durability`), one worker, and its own
    disposable Chromium processes — the ordinary E2E browser profile
    is never touched.
    - **Supervision and process termination**: the test spawns
      Chromium as its own OS child (`--headless=new`,
      `--remote-debugging-port=0`, fresh `mkdtemp` user-data dir,
      launched on `about:blank` — connecting over CDP while the
      dev-server page is still loading stalls the handshake), drives
      it via `chromium.connectOverCDP`, and kills the process TREE
      externally with `taskkill /T /F` (Windows) or SIGKILL to the
      detached process group (POSIX), awaiting the child `exit` event
      under a bounded watchdog. A page reload, tab close, graceful
      shutdown or `transaction.abort()` is never used and would not
      satisfy the test.
    - **Checkpoint synchronization (no sleeps)**: test-only
      instrumentation (`IDBObjectStore.prototype.clear`/`put`
      wrappers installed with `addInitScript` — no production
      failpoint) marks the transaction that clears the `drugs` store
      (the restore's signature, `clearSeen: 1`) and on its SECOND
      completed drug `put` (`putsInTx: 2`: clear + put #1 applied,
      put #2 applied at dispatch) sends a SYNCHRONOUS
      XMLHttpRequest to a test-owned local HTTP server and never
      returns — the server records the payload and withholds the
      response, so the renderer main thread blocks inside the
      transaction's success dispatch while the transaction stays open
      and uncommitted. The server's receipt is the observable proof
      the real transaction reached that exact checkpoint; the
      supervisor kills the process on that signal.
    - **Crash-scenario assertions**: the same profile is relaunched
      in a fresh Chromium process; a raw-storage snapshot taken
      BEFORE the restore (direct `indexedDB.open` reads of
      drugs/meta/revisions — byte-level truth including unknown
      extension fields, provenance and ChEMBL source references)
      deep-equals the post-restart snapshot store-by-store; the UI
      hydrates the whole old library (3 records incl. the old-only
      raw-seeded row, old metadata marker, Kd 4.2 nM, provenance
      badge title, source id); no restore success report exists; the
      revision entries are exactly the pre-crash values
      (`{r1: 2, r2: 1}` — no partial bumps survive). The archive
      carries changed values, one added record, no old-only record,
      different metadata and a `-0` numeric-sidecar row.
    - **Positive control (same infrastructure)**: the same restore
      runs to commit (observable "Restore complete" report plus an
      observe-mode checkpoint receipt), the browser is killed AFTER
      the commit, the profile is reopened, and the FULL restored
      state survives: archive rows byte-equal (incl. the `-0` sidecar
      row materialized back — pinned in-page with `Object.is`, since
      the assertion must run in storage's realm), archive metadata,
      revisions advanced by exactly one per restored id, the
      old-only record's row absent, and the changed science rendering
      (Kd 88.8 nM, new source id).
    - **Determinism and hygiene**: event-driven waits only (HTTP
      receipt, child `exit` event, Playwright auto-waiting) with
      bounded watchdogs (180 s test budget, 120 s hook budget, 45 s
      checkpoint window, 30 s kill window); every run uses fresh temp
      profiles removed in `finally` blocks plus a suite-start sweep of
      stale `nv1-*` temp dirs; observed locally: 8/8 consecutive
      full-suite runs green with checkpoint evidence present and zero
      leftover processes or directories. What it does NOT prove:
      hardware power loss, OS/kernel crash, physical disk failure or
      storage-controller failure.

13. NV-2 evidence — real-Chromium schema migration (phase 23, audit
    NV-2 — `e2e/migration.spec.ts`, implemented — runs inside the
    ordinary `npm run test:e2e` suite): the historical v1/v2/v3 → v4
    IndexedDB upgrades executed by REAL Chromium's versioned-upgrade
    engine, independent of the `fake-indexeddb` unit coverage
    (`database.test.ts`). It does NOT prove correctness against
    authentic legacy user data — no real user database exists or was
    simulated, and audit NV-2 stays open (`data-integrity-audit.md`
    §6 "Evidence upgraded in Phase 23").
    - **Authentic historical versions and schemas**: every build of
      this application used `dexie@4.4.6`, which opens IndexedDB at
      `declared × 10` (`nativeVerToOpen = Math.round(db.verno * 10)`,
      upgrade hooks normalized with `oldVer / 10`) — so real legacy
      databases live at native versions 10/20/30 (the v1/v2/v3
      declarations) and the current build opens at native 40
      (declared 4). The tests seed at those native versions (never
      fabricated 1/2/3) with store/index layouts copied from the
      original schema commits (v1/v2 `b178c0d`, v3 `5146264`,
      v4 `de95c95`), not from the migration-test fixtures.
    - **Deterministic same-origin seeding (no sleeps; an IndexedDB
      database cannot be downgraded)**: an intercepted `page.route`
      serves a minimal same-origin HTML document that never loads
      the app bundle; it creates the historical schema with the RAW
      IndexedDB API, inserts the synthetic rows in one transaction,
      closes its connection and reports readiness in the DOM — only
      then does the test navigate to the real app, whose normal open
      path performs the upgrade. Every scenario runs in its own
      browser context (isolated storage partition); storage-level
      assertions are direct raw `indexedDB.open` snapshots (version,
      per-store index names, every row structured-cloned out) — not
      Dexie, not app code; the snapshots are compared with deep
      equality — value/structure preservation, not a physical-byte
      comparison of the database's internal storage — while
      hydration is asserted through the
      UI (drug list, count, quarantine banner absent) with bounded
      Playwright waits.
    - **Three scenarios**: (A) v1 (native 10) → current — only the
      documented v1→v2 bookkeeping backfill runs: missing
      `persistenceVersion` added; both-missing timestamps get ONE
      shared generated stamp (`updatedAt === createdAt`); a lone
      `createdAt` backfills `updatedAt` from itself; pre-existing
      timestamps, a fully complete row and metadata remain deeply
      equal; unknown fields at five nesting levels are preserved
      under deep comparison; additive
      v3/v4 stores present and empty. (B) v2 (native 20) → current —
      every stored row remains deeply equal, with a bookkeeping-incomplete
      tripwire row proving the v1→v2 backfill never fires on an
      already-v2 database (complete rows alone could not detect a
      no-op hook run). (C) v3 (native 30) → current — all
      pre-existing stores' raw snapshots deeply equal (incl. `compounds` /
      `observations` marker rows), `revisions` added empty, no drug
      row rewritten by the additive upgrade (same tripwire). All
      three: the app hydrates every synthetic record with zero
      quarantined records, and a close/reopen (fresh page load plus
      a fresh raw connection) deep-equals the post-migration
      snapshot. Fixtures are unmistakably synthetic (`NV23 …`
      markers, `example.invalid` URLs).
    - Run individually with `npx playwright test e2e/migration.spec.ts`
      (dev server auto-started); it also runs in CI's `E2E smoke
      test` job with the rest of the ordinary suite.
    - Phase 24 prepared the **NV-2 authorized-validation protocol**
      (`docs/nv2-authorized-validation.md`): an authorization-first
      runbook for validating an authentic legacy database in the
      future, against an isolated disposable copy on the exact
      historical origin. Review-hardened in the same PR: documented
      owner confirmation that the profile was copied after its
      browser fully exited; a never-create probe order
      (`indexedDB.databases()` existence/version check *before* any
      versionless `open`, which would otherwise create an empty
      database); an **independently enforced outbound-network
      boundary** required for any local-only claim (Playwright
      routing is supplementary observability, not the boundary);
      and explicit reporting of which starting native version's
      path was exercised (only native 10 runs the v1→v2 hook).
      Documentation-only readiness — the synthetic coverage above
      remains mechanism evidence (evidence class C in the runbook's
      taxonomy) and never a substitute for authentic data; NV-2
      stays open.

Config: `playwright.config.ts` (chromium; dev server auto-started) for
the ordinary suite; `playwright.crash.config.ts` (chromium, 1 worker;
its own `npm run test:crash` script and CI job) for the NV-1 crash
harness, which owns its browser-process lifecycle and never shares a
profile with the ordinary suite.

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
lossy edges are listed in `docs/validation.md` §7. Since phase 22 this is
an exhaustive per-column contract rather than a sample: all 57 headers are
pinned literally and asserted cell-by-cell against intended export values,
all 56 import destinations are round-tripped through export → `parseCsv` →
explicit mapping → NPSL validation → real repository, and every deliberate
loss boundary (guard apostrophes, trim, empty→absent, `-0`→`'0'`,
unknown-field drop, provenance stamping, `origin` re-stamp, list `';'`
semantics, conflicting metadata / duplicate target ids / bad action /
invalid provenance blocking the whole import) is tested as policy
(`csvColumnContract.test.ts`, contract table
`docs/csv-column-contract.md` — audit NV-3 closed).

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
  must all pass before merging a change. The NV-1 crash-durability
  suite (`npm run test:crash`, its own CI job) must also pass; it is
  deterministic, self-contained (dedicated config, its own supervised
  browser processes and disposable profiles) and never shares a
  browser profile with the ordinary suite. CI additionally requires
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
| NPSL schema tests (17 cases) | done |
| AppLayout component tests | done |
| Playwright config + shell smoke test | done |
| Engine model tests (matrix §1) | done — 3 models, curves, units, numeric, registry |
| Persistence DTO mapper tests | done — round trip, validation, unknown-field preservation (previous-record *and* incoming-drug sources, deterministic merge collisions); NPSL serializer negative-zero preservation (numeric `-0` token emission, `Object.is` round trip incl. nested unknown fields/arrays, look-alike strings untouched, collision-proof placeholder with an explicit collision-branch round trip (source data containing the initial marker as a value and as an extension key plus the first extended candidate, so the loop advances twice; marker-like strings and `-0` both verified after `JSON.parse` — audit DI-04 follow-up), byte-stable output for `-0`-free documents, NaN/Infinity still rejected — audit DI-04) |
| Schema migration tests | done — v1→v2 upgrade: bookkeeping only, scientific + unknown fields survive (jsdom + `fake-indexeddb`; the same paths re-run against real Chromium in the next row) |
| Real-Chromium migration tests (phase 23, audit NV-2 evidence) | done — `e2e/migration.spec.ts` (3 tests, ordinary e2e suite): raw-IndexedDB synthetic legacy databases seeded at the authentic native versions 10/20/30 (dexie@4.4.6 opens at declared × 10 — the same version every historical build used) with store/index layouts verified against the original schema commits, created from an intercepted same-origin page that never loads the app bundle, then upgraded in place by the real application's normal open path; raw snapshots prove the v1→v2 backfill runs bookkeeping-only (one shared stamp for both-missing timestamps, existing values / complete rows / metadata / unknown fields preserved — snapshots deeply equal), no spurious backfill from v2/v3 (bookkeeping-incomplete tripwire rows), additive v3/v4 stores present and empty, full hydration with zero quarantined records, and reopen stability; **audit NV-2 itself remains OPEN — no authentic legacy user database obtained or inspected** |
| Repository tests | done — CRUD, metadata stamping, quarantine, atomic replace/import rollback (duplicate drug ids; duplicate target ids leave every stored row byte-identical), NPSL round trip, reload, extension-field matrix (replace/merge/hydration/edit/export/re-import/rollback), targets-replacing unknown-extension preservation (import baseline, reordered same-id replacement + unrelated edit with per-position raw-row asserts, removal/new-id non-transfer boundary — audit GAP-1), merge-vs-quarantined-row collision (rejection with `QUARANTINE_CONFLICT`, raw row byte-identical incl. unknown extension, whole-document no-write with metadata untouched, valid same-id merge still succeeds, authoritative `fromRecord` failure classes enum/structure — audit GAP-3), literal-`-0` NPSL import → raw-row `Object.is` → export token → re-import provenance identity (audit DI-04), optimistic concurrency (phase 20, audit GAP-4): stale token rejected atomically with row + revision + metadata byte-identical, two concurrent writers (one and two connections) never both committing, fresh-token commit advancing the revision exactly once, VALIDATION-rejected writes not advancing it, delete→recreate tombstone monotonicity, merge/replace/restore/import invalidating prior tokens, `CONFLICT`/`NOT_FOUND`/`VALIDATION` codes distinguishable, the token never appearing in rows, exports or hand-edited NPSL (unknown-key carry strips it), hydration attaching revision 0 / the stored entry, partial-`DrugChanges` merge semantics preserved (phase 19 describe), and revision-guarded deletion (review fix): stale delete rejected atomically with row+revision+metadata byte-identical (provenance and source references asserted), current-revision delete succeeding with the tombstone kept and deliberately NOT advanced, repeat deletes failing `NOT_FOUND` regardless of token, delete→re-import invalidating pre-delete edit AND delete tokens while the current token still deletes, and concurrent deletion attempts (one connection and two connections) with exactly one success and the loser failing `NOT_FOUND` |
| Import pipeline tests | done — parse/schema/semantic/preview classification, metadata extension resolution, envelope-field warning, per-drug duplicate-target-id rejection (rejection, per-drug scope, schema authority for missing/empty ids, mixed-document atomicity, preview reporting) |
| Store + library UI tests | done — hydration guard, quarantine report, form safeguards, target-metadata preservation on edit (unrelated edit, rename, parameter change, multiple targets, removal + position shift, remove-and-recreate, absent fields stay absent, create mode), identifier-metadata preservation on edit (unrelated rename, synonyms/tags/notes edits, lone description, lone casNumber, absent stays absent, editable fields from form state, no source mutation, create mode), negative-zero parameter preservation on edit (untouched `-0` value + complete provenance kept exactly, `+0` control, explicit-change restamp, cross-target isolation — audit DI-04), transactional `importLibrary` outcome (ok / invalid / failed / committed-refresh-failed), stale-save conflict outcome (phase 20, audit GAP-4): typed `UpdateDrugResult` conflict leaving session drugs/metadata/status and storage untouched, an ordinary failure still setting the session error, fresh-token retry committing; form conflict UI: mount-time token submitted with the edit, create mode token-less, distinct alert with the draft and edit session preserved, dismissal keeping the draft (and the stale token — re-saving conflicts again), open-latest (keeps draft) / reload (labeled: discards draft) recovery actions, ordinary failures shown without recovery actions, double-submit guard dropping a second activation while a save is in flight; delete outcomes (review fix): typed `DeleteDrugResult` conflict with the session error untouched, storage and session preserved, fresh-token retry deleting, `error` outcome for a missing id with the message surfaced, and the detail-view delete-conflict UI (distinct alert naming the conflict and the non-deletion, record view intact, no session banner, single attempt with the page's token, delete action disabled until the explicit reload/recovery action re-hydrates) |
| Calculator tests (adapters, store, schemas, components) | done — drafts, stale semantics, curve settings, PK mode union |
| CSV tests (parse, write, export, mapping, conversion) | done — quoting/escaping/BOM/errors, spreadsheet formula-injection guard (text cells protected, numeric cells byte-exact), stable header, provenance columns, ambiguity + unit rules, CSV → NPSL document, grouping, row errors |
| CSV 57-column contract tests (phase 22, audit NV-3) | done — `csvColumnContract.test.ts` (25 tests): the full ordered 57-header pinned as an independent literal (drift detection against `CSV_HEADERS`), 57-cell row widths everywhere, a fully populated marker library asserting the intended exported value of **every** column (table-driven, all five provenance variants incl. JSON remainders and an empty-remainder cell, negative + scientific-notation numbers, hostile text — commas/quotes/newlines/semicolons/leading whitespace/formula triggers with parse-back equality), one-row-per-target + drug-level/PK repetition + sparse-target empties + the single targetless row, the 56-destination bijection (`origin` the sole tested exclusion), full export → `parseCsv` → mapping → NPSL-validation round trip (marker drug deep-equal with `origin: 'imported'`; hostile drug's documented transformations), library-metadata stamping, and a real Dexie repository commit + read-back (raw row incl. `revision: 1`, quarantine empty); every loss/transform boundary asserted as policy — contract table `docs/csv-column-contract.md` |
| Import/export UI tests | done — preview-before-write, replace gate, cancel, CSV mapping flow, export contents + object-URL lifecycle, committed-but-refresh-failed report (never "nothing was written"), quarantine export warning (visible with data, silent when empty), quarantined-id merge advisory in the preview plus its authoritative enforcement through the transaction even when the cached quarantine list is stale (audit GAP-3) |
| Recovery format tests | done — fidelity/sidecar/pointer/limits (`fidelity.test.ts`), string-aware duplicate-key scanner (`duplicateKeys.test.ts`), envelope/limits/version/entry/sidecar/warnings batteries (`archive.test.ts`) |
| Recovery repository + store tests | done — read-only snapshot export with fail-closed `BACKUP_READ_FAILED`, single-transaction cross-connection consistency, verbatim restore (quarantine + unknown fields + metadata), rejection before any transaction, rollback on mid-write failure, mutual rejection; store outcomes ok / rejected / failed / committed-refresh-failed with the restore never re-run |
| Recovery UI tests | done — preview count groups, acknowledgement gating, four outcome reports, export failure honesty (no file, no success status), oversized/invalid file rejection, cancel (`RecoveryPanel.test.tsx`) |
| Preferences tests (schema, storage, store) | done — defaults on first run, save/restore round trip with verbatim string forms, malformed JSON and non-object payloads, unsupported schema versions, invalid theme/scale/value types, engine cross-field range rules (min < max, log-safe min, points bounds), live system-mode theme behavior, manual-theme precedence over OS changes, write-failure degradation (`loadStatus: 'unavailable'`), scoped reset, persisted-key shape (no scientific state) |
| Calculator presentation-settings tests | done — `applyPresentationSettings` replaces display defaults without touching drafts/report/curve, marks the curve stale when a report exists; `defaultCalculatorSettings` returns fresh independent copies |
| Settings UI tests | done — four sections with accessible headings, theme applied + persisted per model blocks, invalid range text refused with `aria-invalid`/description, cross-field enforcement, restore-defaults keeps the theme, data-management link, About metadata, acknowledged reset (Escape, focus, scope) with repository mutation spies and an untouched scientific draft, invalid/unavailable-storage notes |
| Source adapter tests | done — PubChem name/CAS/InChIKey resolution, ChEMBL compound/target/activity/endpoint filtering with the target search pinned to the documented JSON URL (`target/search.json?q=…` — a reverted format-less path fails the suite instead of passing through mock routing), endpoint selection (`standard_type__in` for a checked subset; the filter omitted for "all reported endpoints"; an empty list retrieving nothing without issuing a request), fixtures-only HTTP (`src/data/sources/*.test.ts`) |
| Source transport tests (phase 18H) | done — rate limiter (`limiter.test.ts`): minimum interval between starts (injected clock/wait), FIFO grants, failure-without-bypass spacing, queued cancellation rejecting without a grant, cancelled waiter leaving no phantom slot, per-instance isolation, `abortableDelay` semantics; `fetchJson` (`http.test.ts`): no second attempt after cancellation during the retry wait (aborted, 1 fetch), 429 retried once, bounded `Retry-After` honoured via injected wait (2 s header → 2000 ms wait), long `Retry-After` failing fast with status + `retryAfterMs` and zero waits, unparseable header → fixed delay, non-retryable 4xx carrying `Retry-After` still never retried, `parseRetryAfterMs` (delta-seconds, HTTP-date, past date, garbage); PubChem adapter (`pubchem.test.ts`): default spacing ≥ 200 ms (5 req/s line), request starts paced across adapter instances sharing one limiter (4 requests, 3 waits), request cancelled while queued never reaching the network, cancellation during the synonym lookup rejecting as `aborted` (not downgraded to best-effort) (`src/data/sources/*.test.ts`) |
| Source transport boundary tests (phase 18H.1) | done — retries re-enter the shared limiter (`beforeAttempt` per-attempt hook): initial attempt + automatic retry both permit-gated with zero transport delay, concurrent searches interleaved with a retry keeping 4 paced waits over 5 attempt starts, `Retry-After: 0` retry still queueing for its permit, a retry cancelled while waiting for its permit never calling fetch; prompt mid-queue cancellation (three callers: third aborts while second's wait is pending → rejects `aborted` before that wait is released, no permit/wait consumed, survivors keep FIFO + spacing); typed interruptions during response-body reads (`http.test.ts`): cancel during a successful `json()` → `aborted`, attempt-timeout during a successful `json()` → `timeout` (fake timers), cancel during a non-retryable error-body read → `aborted` (never downgraded to `http`), genuine body failure → `invalid-response`, unparseable error body keeping the HTTP status; each new behavior verified to fail against the pre-18H.1 implementations (`src/data/sources/*.test.ts`) |
| Source attribution URL tests (phase 18H) | done — absolute-HTTPS `url`/`licenseUrl` accepted, missing license stays missing, malformed/relative/`javascript:`/`file:`/plain-http/empty/whitespace rejected with the offending field named, unknown-field preservation, synthetic fixtures still validating (`src/data/schemas/sources.test.ts`) |
| Target identity reference tests (phase 18I) | done — ChEMBL activity mapping retains the target id and target-record URL when the source supplies one and leaves both absent when it does not (`chembl.test.ts`); `sourceTargetUrl` HTTPS-only validation at the observation-record boundary (`sources.test.ts`); `targetSourceReferenceSchema`: complete references kept verbatim, absent references staying omitted (key absent — never `[]`/`undefined`), multiple sources side by side, non-HTTPS/malformed `url`/`licenseUrl` and empty identity fields rejected with the field named, unknown keys inside a reference round-tripping (`npsl.test.ts`); mapper: reference round trip, omitted-key shape, malformed-reference rejection before any write, unknown reference extensions matched by source (never position), references staying on their own target under target reordering (`records.test.ts`); identity comparison + apply rules in the store (`store.test.ts`): same name/species with a different same-source id reported as a structured `'source-id'` conflict (with `sourceIdConflict` detail), exact source+id match as an identity match (name policy preserved even then), a different source's reference never conflicting, missing reference info never fabricating a mismatch, unacknowledged refusal with zero writes, acknowledged conflict keeping the stored reference verbatim with both ids recorded in provenance notes, new-target creation carrying the complete reference, idempotent attach (no duplicates on repeat application), the reference present in the raw IndexedDB row and a fresh repository read, and a `.npsb` recovery export → restore keeping a reference-bearing raw row byte-identical (`dexieDrugRepository.recovery.test.ts`) |
| Source-data repository tests | done — atomic import (validation failure rolls back, nothing written), deterministic ids, existing-records-win skip reporting, orphan-observation rejection, quarantine on invalid stored rows, hydrate with provenance and license survival, quarantine-collision conflicts (compound- and observation-id collisions with deliberately malformed raw rows: `QUARANTINE_CONFLICT`, whole-batch no-write with valid siblings, raw rows byte-identical incl. unknown fields, observation-vs-malformed-compound rejection), cross-field identity invariants (mismatched ids, inconsistent provenance, invalid compound references — and identity-consistent PubChem + ChEMBL fixtures still import), import-time rejection of a non-HTTPS provenance URL before any write with valid siblings also unwritten, and deletion (phase 39): one transaction deletes a compound with exactly its observations (identity-scoped via the `compoundId` index, never by display name — a same-named lookalike survives), a compound with no observations deletes cleanly, other compounds and their measurements stay byte-identical, quarantine refusal preserving the raw row byte-identically, orphan-measurement refusal preserving everything, storage-failure rollback with both tables byte-identical, idempotent-safe `NOT_FOUND`, and an imported `Drug.sourceRecords` snapshot (identifiers, license notice, observations) fully untouched (`dexieSourceDataRepository.test.ts`) |
| Database schema tests | done — verno 4 with `drugs`, `meta`, `compounds`, `observations` + the additive `revisions` store (`{ id, revision }`), fresh-install table creation, v1→v2→v3→v4 migration chain (v3 databases gain `revisions` with no rows — absent = revision 0, pinned by the migration test), drug rows byte-identical through the v2→v3→v4 upgrades (`database.test.ts`) |
| Data-sources store tests | done — startup-no-seed with real adapters (zero fetch), search lifecycle (stale/cancel/source- and scope-switch), observation retrieval (merge paging, page-source snapshot, stale guard), import (identity resolution, whole-batch failure, no-op, advisory preview), Layer C apply rules (endpoint mapping, qualifiers, units, occupied-slot overwrite, unknown ids), existing-target mismatch safety (refusal naming both sides until `confirmTargetMismatch`, acknowledgement recorded in provenance notes, name-and-species match needs no ack, species-only mismatch refuses), portable attribution surviving an NPSL export → re-import round trip, user-visible transport failure distinctions (429 throttling, 503/504 temporarily unavailable, other HTTP generic-but-actionable, network/timeout/cancellation/invalid-response wording), measurement-endpoint multi-select semantics (a checked subset and "all reported endpoints" passed to the adapter for target-, compound- and multi-compound retrieval; an empty selection refusing retrieval and paging with a validation message and never a request; a selection change aborting an in-flight request, discarding its late answer and clearing rows, observation selection and pagination context; paging continuing under the filter that fetched the displayed list) (`src/features/data-sources/store.test.ts`) |
| Stored-compound deletion tests (phase 39) | done — `delete-compound.test.ts` (session boundary against the real repositories): delete with exactly its measurements then panel re-read from IndexedDB, delete without measurements with an honest count, other compounds and measurements byte-identical, deleted observation ids dropped from the selection, typed failures writing nothing (`NOT_FOUND`, quarantined-row `QUARANTINE_CONFLICT` preserving the row, `STORAGE` rollback with both tables unchanged), a Library import (complete snapshot, a promoted parameter with its provenance, a user note) byte-identical after the source copy is deleted, repeat import of a deleted record failing without inventing a record, and zero network requests on the whole path |
| Data-sources UI tests | done — full chain against real repositories with fixture-stubbed `fetch`: picker, zero network on mount, search → preview → confirmed import, network-failure honesty, Layer C UI gates (incl. the target comparison block and the required mismatch-acknowledgement checkbox), identity-only library addition, and deleting a stored compound (phase 39): the two-step confirmation naming the record, its id and its measurement count with focus moved into the acknowledgement and back on cancel, Escape cancelling, cancel leaving storage untouched, a confirmed deletion reporting the count and refreshing list and counts from IndexedDB, other compounds and their measurements kept listed, an honest zero-measurement confirmation, and a quarantined-row failure shown as an actionable error with the row kept and no success claimed, and the measurement-endpoint multi-select (phase 40): an accessible labelled checkbox group with the four model-parameter endpoints checked by default, checked subsets driving the actual `standard_type__in` request (asserted on the requested URL), "All reported endpoints" disabling the individual choices and omitting the endpoint filter from the request, an empty selection blocking retrieval with a validation message and no request, and a selection change clearing already-fetched rows (`DataSourcesView.test.tsx`) |
| Drug-form persistence integration tests | done — real detail → form → store → Dexie chain: whole provenance of unchanged parameters in the raw stored row, user stamp only on the changed parameter, supported target metadata (`gene` / `action` / `species` / `notes`) intact after an unrelated edit, no metadata migration after removal + same-name recreation, stored-only identifier metadata (`description` / `casNumber`) preserved byte-identical in the raw row after an unrelated edit (raw row + fresh repository read), untouched list/text fields (`synonyms` / `tags` / name / top-level notes) preserved byte-identical in the raw row after an unrelated edit (audit DI-03), a negative-zero parameter kept exact (`Object.is`) with its complete provenance in the raw row after an unrelated edit, and top-level `notes` absent/empty proven by raw-row own-property checks (audit DI-04 + DI-03 follow-up), unknown target extension fields surviving the form's targets-replacing save with a post-import baseline (record, target and provenance level, stable-id + non-transfer asserts — audit GAP-1), and the whole pharmacokinetics object (half-life, clearance, Vd, bioavailability: values, units, complete provenance incl. an unknown extension key) deep-equal in the raw row and a fresh read after an unrelated rename (audit GAP-2), and target `sourceReferences` intact (raw row + fresh read) after an unrelated edit with no migration onto survivors or recreated targets (phase 18I), and the full stale-write chain (phase 20, audit GAP-4): session hydrates → second writer commits → form save rejected with the typed conflict alert, form and draft open, error banner untouched, stored row (name, targets, provenance, source references, tags) exactly the other writer's commit with the revision advanced by that commit only, no `revision` key in the raw row, then unmount → hydrate → re-edit commits the draft against the fresh token (revision +1) |
| Test suite total | 1178 unit tests (63 files) |
| Test harness async-wait budget (phase 20) | done — `src/tests/setup.ts` raises the Testing Library `findBy*`/`waitFor` default deadline from 1 s to 5 s (`configure({ asyncUtilTimeout: 5000 })`) so wall-clock waits are not exceeded by full-suite CPU contention (observed: load-induced deadline overruns in persistence/import/apply chains that pass in isolation); assertions, poll semantics and skip behavior are unchanged — a broken chain still fails, just after the longer budget |
| Calculator + shell e2e | done — 8 workflows (`e2e/shell.spec.ts`, `e2e/calculator.spec.ts`), incl. the phase 27 blank-input curve-validation regressions (Update curve and the automatic scale-change re-apply) |
| Import/export e2e | done — 6 workflows (`e2e/importExport.spec.ts`) |
| Library reload e2e | done — 2 workflows (`e2e/library.spec.ts`): create → detail → reload → edit → reload → delete via acknowledgement → reload; and target metadata: import user-origin record with `gene`/`action`/`species`/`notes` → unrelated edit → fields still shown → reload → persisted |
| Keyboard e2e | done — 6 workflows (`e2e/keyboard.spec.ts`): skip link, navigation, drug form recovery, calculator, import/export confirmation, narrow-viewport operability |
| Recovery e2e | done — 4 workflows (`e2e/recovery.spec.ts`): quarantine-preserving export → replace → restore round trip with reload persistence, malformed rejection, mutual `.npsb`/`.npsl` rejection, export failure honesty with a bounded no-download wait |
| Settings e2e | done — 2 workflows (`e2e/settings.spec.ts`): theme + calculator display defaults persist across reloads and the scoped reset restores only preferences; system-mode follows live OS color-scheme changes with manual precedence |
| Target reference uniqueness tests (phase 18I.1) | done — `npslFileSchema` rejects two references with the same exact `source` whether their `sourceTargetId` values match or differ, with the structured issue path naming the duplicate entry (`drugs.n.targets.m.sourceReferences.k.source`) and the message stating duplicates are never merged; source equality proven exact (no case folding: `'chembl'` vs `'ChEMBL'` coexist as distinct sources); different sources still accepted together with each reference's values and unknown extension fields intact (`npsl.test.ts`) — repository through the real write/read paths: create and update rejected by `assertWritable` before any write with the duplicate path in the error, a transactional import containing a duplicate-reference record plus valid siblings commits nothing (stored rows byte-identical, valid sibling absent), a pre-existing raw row with duplicate references quarantined and reported with the duplicate named while staying byte-identical next to readable valid rows (`dexieDrugRepository.test.ts`) — `.npsb` raw recovery still snapshots and restores a duplicate-reference row verbatim, the archive report classifies it quarantined for the current build, and the row stays untouched after hydration attempts (`dexieDrugRepository.recovery.test.ts`) |
| Quarantine repair-path tests (phase 18I.2) | done — repository-level manual-repair workflow (`dexieDrugRepository.recovery.test.ts`): a duplicate-source-reference row (unknown fields at drug, target and reference level) quarantined unchanged, `.npsb` export carrying it verbatim (counts 1 readable / 1 quarantined), a deliberate user-choice JSON edit — located via the archive entry's `key` ≡ row id — retaining one reference and removing the duplicate; a structurally broken edit still rejected (`ARCHIVE_KEY_MISMATCH`) with storage untouched; the edited archive previews with the non-blocking `RECLASSIFICATION_DIFFERS` warning (this build: 2 readable / 0 quarantined) and restores verbatim — repaired row readable with exactly the retained reference incl. unknown extension fields, unrelated valid row + metadata (unknown fields) byte-identical, no silent row loss or creation, quarantine report consistent with the restore report, and the untouched original export text still previews as the pre-repair snapshot. Proves the documented §11 manual repair technique works under the existing `.npsb` contract — no production deduplication, no format change, no version bump |
| Sidecar-safe repair guidance tests (phase 18I.2.1) | done — repository-level (`dexieDrugRepository.recovery.test.ts`): the `.npsb` numeric-sidecar edge case of the §11 manual array edit. **Hazard case**: a row whose later references carry `Infinity`/`NaN` special numbers (annotated in the sidecar) and another later reference with a compatible plain-`null` placeholder at the same property name; the documented removal performed lazily (duplicate removed, sidecar untouched) — the sidecar still points at the ORIGINAL array indexes, every stale pointer still resolves against the shifted elements' compatible placeholders, the archive is ACCEPTED, and the special numbers are reconstructed at the SHIFTED destinations (silent semantic corruption, row still validates as readable) — asserted explicitly as the documented hazard, not a successful repair. **Safe case**: the same archive with a deliberately adjusted sidecar (deleted-owner annotation removed, shifted annotation reindexed, out-of-array annotation preserved) — the retained special number is reconstructed at the intended reference, the duplicate source entry is removed, unknown fields survive, unrelated rows and metadata stay byte-identical, and the repaired record is readable. Test + docs only — no production change, no format/version bump |
| Partial-update repository tests (phase 19, audit GAP-4) | done — `dexieDrugRepository.test.ts` describe `partial DrugChanges merge semantics (audit GAP-4)`: an omitted group composing with an interleaved committed write from a second connection (rename survives a tags-only update; omitted targets/PK/notes byte-equal to the freshly re-read fixture; `updatedAt` restamped, `createdAt` kept); supplied groups replacing wholesale — an `identifiers` replacement dropping the fixture's description (no deep merge) and a `targets` replacement shrinking two rows to one with the removed targets' names absent from the whole raw record; `notes` absent-keeps vs explicit-`undefined`-clears. Pins the repository API's narrower merge independently of the UI's full-snapshot form — unchanged by phase 20 |
| Optimistic-concurrency repository tests (phase 20, audit GAP-4 remediation) | done — `dexieDrugRepository.test.ts` describe `DexieDrugRepository — optimistic concurrency (phase 20, audit GAP-4)`: a stale-token update rejected atomically with the stored row, the revision entry and the metadata row byte-identical (transaction-level, not compare-then-write — the compare and the bump share one `rw` transaction over drugs+meta+revisions); `CONFLICT` distinct from `NOT_FOUND` (deleted id) and `VALIDATION` (bad payload) by error code; two concurrent writers on one connection and on two connections — exactly one commits, the loser gets `CONFLICT`; a fresh-token retry committing and advancing the revision exactly once, with no replay of the stale attempt; a VALIDATION-rejected write not advancing the revision; delete→recreate (tombstone kept) and merge/replace/restore/import invalidating all prior tokens (ABA-safety); the token never written into rows, exports or hand-edited NPSL (unknown-key carry strips it); hydration attaching revision 0 (absent entry) or the stored value, in one read transaction with the row |
| Multi-tab write-safety e2e (phase 20, audit GAP-4 remediation; rewrites the phase-19 limitation scenarios) | done — 3 workflows (`e2e/multitab.spec.ts`): two pages in the SAME browser context (one shared IndexedDB) mount edit forms from the same stored snapshot before either saves. Scenario 1: tab A renames and saves; tab B (no reload) saves a tags-only change → typed conflict alert ("Record changed elsewhere") instead of a write — form still open, draft (tags AND mount-time name) intact, no session error banner, fresh-tab verification that A's rename stands and B's tags never reached storage; recovery: open-latest popup shows A's commit while B keeps its draft, dismissing the alert keeps the draft, re-saving the stale draft conflicts AGAIN (no token refresh), `conflict-reload` then a fresh edit commits keeping A's rename; target identity and the ChEMBL source reference intact throughout. Scenario 2: tab A's committed Kd edit (9.9 nM + user provenance) survives tab B's stale rename save as a conflict; a fresh tab pins the exact provenance badge title as committed, the stored name unchanged, source references intact; reload recovery re-applies the rename leaving A's parameter, provenance and source references byte-exact. Both scenarios end with the unrelated control record and library metadata unchanged. Scenario 3 (review fix, revision-guarded deletion): tab A commits a Kd edit; tab B — still on the pre-edit view — opens the unchanged destructive confirmation and confirms → "Deletion did not happen" conflict alert, record view intact, delete action disabled (no auto-retry, no session banner); a fresh tab pins the record with its 9.9 nM value, exact provenance badge title, source identity and tags intact; the explicit reload shows A's committed state (the review step), then the delete succeeds through the same confirmation with the fresh token, leaving the unrelated record and metadata standing. Synthetic fixtures only, no external requests; deterministic interleaving (no sleeps) |
| NV-1 crash-durability e2e (phase 21) | done — 2 workflows (`e2e-crash/crash-durability.spec.ts`, `npm run test:crash`, dedicated `NV-1 crash durability` CI job): an external process-tree kill of a supervised Chromium at a deterministic in-flight checkpoint of the real restore transaction (sync-XHR stall inside the transaction's success dispatch; the test server's receipt is the observable checkpoint proof; no production failpoint), with same-profile restart verifying byte-level rollback of drugs/meta/revisions (unknown fields, provenance, source references, exact revision entries) and no false success report; positive control — a committed restore survives the same kill with the full restored state (incl. the `-0` sidecar row, pinned in-page with `Object.is`) and revision bumps of exactly one per restored id. Real Chromium + real IndexedDB, never `fake-indexeddb`; 8/8 consecutive local full-suite runs green with zero leftover processes/profiles |
| Data-sources e2e | done — 6 workflows (`e2e/dataSources.spec.ts`, fixture-mocked HTTP via `e2e/sourceMocks.ts`): zero external requests on page load, PubChem search → explicit selection → confirmed import, ChEMBL measurement fidelity (qualifiers, omitted row counting, unresolved-identity resolution), Layer C promotion with provenance badge, a source target identity stored, shown on a synthetic same-source conflict, acknowledged and never merged (phase 18I), network-failure honesty with nothing written |
| Accessibility e2e | done — 7 scans (`e2e/a11y.spec.ts`) covering 22 stable states (incl. four Recovery, two Settings and four Data Sources states) with axe-core WCAG A/AA tags; no rules disabled, no violations suppressed (0 violations) |
| Dependency security gate | done — `npm audit --omit=dev`: 0 production vulnerabilities (blocking in CI); full tree: 7 high, all dev-only, from one advisory with no fixed release (`braces` ≤ 3.0.3, GHSA-vfj7-8cjw-p6xm), reported non-blocking |
