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
skip link, active-route semantics, no-emoji rule) and
`src/features/import-export/ImportExportView.test.tsx` (preview-before-
write, replace acknowledgement, explicit CSV mapping, export contents, the
committed-but-refresh-failed report — never "nothing was written" — and
the quarantine export warning against a populated vs. empty quarantine —
all against the real repository with fake-indexeddb).

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
3. Library: create drug → enter parameter with provenance → detail page
   shows provenance → reload → still present (persistence) — covered by
   component + repository tests today; a dedicated e2e joins the
   expanded coverage of phase 6.
4. Import/export (`e2e/importExport.spec.ts`, implemented — synthetic
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
5. Export round trip at the repository level (export → import → deep
   equality) is covered by repository tests; the E2E layer asserts the
   exported file's content parses back with provenance intact.

Config: `playwright.config.ts` (chromium; dev server auto-started).

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

Additional round-trip: domain → NPSL → domain (validating the mapper in both
directions), and a JSON ↔ NPSL identity check (`.npsl` is JSON).

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
- `npm run typecheck` (strict), `npm run lint`, `npm test` and `npm run build`
  must all pass before merging a change.
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
| Persistence DTO mapper tests | done — round trip, validation, unknown-field preservation (previous-record *and* incoming-drug sources, deterministic merge collisions) |
| Schema migration tests | done — v1→v2 upgrade: bookkeeping only, scientific + unknown fields survive |
| Repository tests | done — CRUD, metadata stamping, quarantine, atomic replace/import rollback, NPSL round trip, reload, extension-field matrix (replace/merge/hydration/edit/export/re-import/rollback) |
| Import pipeline tests | done — parse/schema/semantic/preview classification, metadata extension resolution, envelope-field warning |
| Store + library UI tests | done — hydration guard, quarantine report, form safeguards, transactional `importLibrary` outcome (ok / invalid / failed / committed-refresh-failed) |
| Calculator tests (adapters, store, schemas, components) | done — drafts, stale semantics, curve settings, PK mode union |
| CSV tests (parse, write, export, mapping, conversion) | done — quoting/escaping/BOM/errors, spreadsheet formula-injection guard (text cells protected, numeric cells byte-exact), stable header, provenance columns, ambiguity + unit rules, CSV → NPSL document, grouping, row errors |
| Import/export UI tests | done — preview-before-write, replace gate, cancel, CSV mapping flow, export contents + object-URL lifecycle, committed-but-refresh-failed report (never "nothing was written"), quarantine export warning (visible with data, silent when empty) |
| Test suite total | 562 unit tests (34 files) |
| Calculator + shell e2e | done — 6 workflows (`e2e/shell.spec.ts`, `e2e/calculator.spec.ts`) |
| Import/export e2e | done — 6 workflows (`e2e/importExport.spec.ts`) |
| Library reload e2e | pending — expanded coverage with phase 6; library covered today by component + repository tests |
