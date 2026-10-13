# Neuropharmacology Sandbox

A transparent, reproducible pharmacology calculation environment.

The application distinguishes clearly between externally sourced
pharmacological data, user-provided data, calculated values, derived values
and unverified data. It never invents pharmacological parameters.

> **Guiding principle:** The application stores scientific data locally,
> calculates only from explicit inputs, preserves provenance, and makes no
> unsupported pharmacological claims.

## What this is

- A calculation and data-management tool for pharmacology modelling.
- A local-first application with explicit provenance on every scientific value.
- A system whose results are traceable to inputs, formulas, intermediate steps
  and assumptions.

## What this is not

- Not an AI pharmacologist. No LLM layer exists or is planned for the MVP.
- Not a clinical decision-support system, not a medical diagnosis tool.
- Not a replacement for authoritative pharmacology databases.
- Not a black-box simulator: every result exposes its full calculation trace.

## First public preview

The first public preview is versioned **`v0.1.0-alpha.1`** — a
**pre-release**, not a stable `1.0.0`. Preview scope and known
limitations are tracked in [CHANGELOG.md](CHANGELOG.md); the auditable
release procedure lives in [docs/releasing.md](docs/releasing.md).

What preview users should know up front:

- **NV-2 remains open:** no authentic historical user database has been
  obtained or inspected. Schema-migration evidence comes from synthetic
  legacy databases only — historical-database compatibility has **not**
  been validated against real user data.
- There is **no bundled authoritative pharmacology database**. External
  data (PubChem/ChEMBL) are retrieved only when you explicitly request
  them, and imported records keep their source attribution.
- Model results are mathematical outputs under declared inputs and
  assumptions — not clinical predictions and not medical advice.
- Your data stay in this browser's local storage (see
  [Data storage and backup](#data-storage-and-backup) below).

## Data storage and backup

- All scientific data live in the browser's IndexedDB, tied to **this
  origin and this browser profile**. There is no server copy and no
  account system.
- Clearing browser or site storage may permanently remove your library.
  Export your data regularly and keep the exported files somewhere safe.
- `.npsb` recovery backups (full-storage snapshots consumed by the
  Recovery tab) and ordinary `.npsl`/JSON interchange files serve
  **different purposes and are not interchangeable** — each import path
  deliberately rejects the other file type.
- Moving the application to a different origin does **not** carry the
  library with it; the app will open an empty database at the new
  origin.

## Current status

Development proceeds in numbered review phases; the table below is the
authoritative record. Phases 1–24 are summarized with their full
deliverables; the most recent phases (25–33) follow:

| Phase | Deliverable | Status |
| --- | --- | --- |
| 1 | Architecture, domain types, NPSL schema + tests, app shell, test harness | done |
| 2 | Calculation engine: first-order PK, single-site occupancy, Hill response, chart-agnostic curves, unit catalog, Decimal.js numerics, calculation traces, provenance propagation — plus the hardening pass (log y-axis validation, consistent numerical-loss reporting, invariant coverage, GitHub Actions CI) | done |
| 3 | Drug library: Dexie/IndexedDB persistence behind a repository abstraction, versioned schema with in-place migration, startup hydration with quarantine reporting, transactional NPSL import (preview → all-or-nothing commit), minimal library UI (list/select/create/edit/delete with provenance display), export → import round trip | done |
| 4 | Calculator + visualization: model selector, explicit parameter inputs, provenance-aware library loading (explicit selection only), calculation results with structured traces, CurveData → Plotly chart adapter, linear/log controls, log-Y representability handling, curve settings state — plus the hardening pass (PK mode union fix, stale-state semantics, curve readiness separation) and the critical calculator E2E workflows | done |
| 5 | Import/export UI: `.npsl`/`.json` import with preview → confirm (merge/replace with explicit destructive acknowledgement), explicit CSV column mapping (nothing inferred from column names, declared unit policy, CSV → versioned NPSL document → same validation pipeline), whole-library export to `.npsl`/`.json` (lossless for records and
provenance; envelope extras and quarantined records are excluded, each with
a visible warning) and CSV (lossy, with a visible warning), component + CSV unit tests and six E2E workflows | done |
| 6 | Accessibility and keyboard workflows: semantic headings, landmarks, page titles and active-route state; a working skip link with focus placement; accessible names, error announcements (`role="alert"` / `aria-invalid` / `aria-describedby`) and focus indicators; every core workflow operable without a mouse (library incl. validation recovery and delete acknowledgement, calculator incl. PK parameterization, import/export incl. tabs and the replace gate); axe-core WCAG A/AA scans of twelve stable states; a real-IndexedDB library persistence E2E; narrow-viewport operability — plus the fix for an invalid Calculate press that used to fail silently | done |
| 8 | Recovery backup: `.npsb` full-storage archive (raw rows incl. quarantined and unknown-field records, every metadata row, numeric sidecar for `-0`/`NaN`/`±Infinity`, explicit fidelity boundary), a dedicated Recovery tab with preview → explicit acknowledgement → atomic full-replacement restore and the four outcomes (rejected / failed / ok / committed-refresh-failed, never auto-re-run), mutual rejection with ordinary `.npsl` import, honest export failure with no file — contract designed in 8A (`recovery-backup.md`, ADR-18), implemented and verified in 8B with unit/repository/component/E2E/axe suites | done |
| 9 | Settings: device-local presentation preferences — a persistent theme (system/light/dark, `.dark` on the document root, live OS follow), per-model curve display defaults validated with Zod and the engine's own curve rules, data-management links, About, and a scoped acknowledged reset that restores only preferences (one versioned `localStorage` record, ADR-19; scientific data neither stored nor touched) | done |
| 10 | Data integrity: supported target-level metadata (`gene`, `action`, `species`, `notes`) now survives edits to existing drug records — reattached by stable target id in the form's submit path, verified by form-level tests, a real-repository/IndexedDB integration test and an E2E workflow; no new editing controls, schema or format change | done |
| 11 | Repository data integrity audit: evidence-driven coverage matrix over reconstruction, serialization, import/export, persistence, identity and recovery boundaries — confirmed findings DI-01…DI-04, coverage gaps and a prioritized remediation backlog in `docs/data-integrity-audit.md` (audit-only commit) | done |
| 12 | Data integrity: stored-only identifier metadata (`description`, `casNumber`) now survives edits to existing drug records (audit DI-01) — reattached from the stored record in the form's submit path while editable fields stay form-driven, verified by form-level tests and a real-repository/raw-IndexedDB test; no new editing controls, schema or format change | done |
| 13 | Data integrity: NPSL import now blocks documents carrying duplicate `targets[].id` inside one drug (audit DI-02) — per-drug uniqueness enforced with blocking `DUPLICATE_ID` at the existing validation boundary, rejection proven to write nothing to storage, CSV behavior unchanged; no schema or format change | done |
| 14 | Data integrity: an edit no longer normalizes fields the user never touched (audit DI-03) — synonyms, tags, name and top-level notes are submitted from the stored record verbatim when their draft text is unchanged (embedded commas, duplicate entries, edge whitespace and the `notes` present/absent distinction survive), only actually-changed fields are parsed/trimmed, verified by form-level tests and a real-repository/raw-IndexedDB test; the comma-delimited edit limitation is documented; no widget, schema or format change | done |
| 15 | Data integrity: negative zero now survives every supported NPSL interchange path and unrelated edit (audit DI-04) — the shared JSON serializer emits the numeric `-0` token (collision-proof placeholder, byte-identical output for `-0`-free documents) and a parameter draft still showing the source's own text submits the stored number verbatim, keeping an untouched `-0` *and* its complete provenance; verified by serializer, repository (literal-token import/export/re-import), form and raw-IndexedDB tests; contract documented in `npsl-format.md`; no sidecar, version bump, schema or format change | done |
| 16 | Data integrity: committed regression coverage closes audit gaps GAP-1 and GAP-2 — test-only, no production change: unknown target extensions survive targets-replacing updates by stable id (import baseline, reordered same-id replacement, removal/new-id non-transfer boundaries, repository and real form path), pharmacokinetics values, units and provenance (incl. an unknown extension key) survive unrelated edits (raw-row and fresh-read deep equality), and the `-0` serializer's placeholder collision branch is exercised with marker-like source data (marker value, marker-like extension key and the first extended candidate) | done |
| 17 | Data integrity: a Merge import never overwrites a quarantined raw record (audit GAP-3) — the merge pre-scan classifies the colliding stored row with the authoritative hydration validator (`fromRecord`) inside the import transaction and rejects the whole document with blocking `QUARANTINE_CONFLICT` before any write (quarantined row byte-identical and still reported), the import preview surfaces an advisory naming the colliding ids while the transaction remains the authoritative boundary (a stale preview cannot bypass it); policy documented in `validation.md`, `npsl-format.md` and ADR-15; repository + UI regression tests; no schema or format change | done |
| 18 | On-demand data sources: a dedicated Data Sources page searches PubChem (compound identity) and ChEMBL (identity, targets, measurements) only on explicit user request — validate → preview → explicit select → atomic local import into two new Dexie stores with deterministic `source:recordId` ids (existing records win, never overwritten), per-record provenance + license/attribution (ChEMBL CC BY-SA 3.0, PubChem aggregation notice with links), endpoint/qualifier/unit fidelity (`<`/`>` preserved, missing stays missing, no endpoint substitution), cancellation and stale-answer guards, offline usable stored panel, and an explicit "Use as parameter…" promotion of one measurement onto one Kd/Ki/IC50/EC50 slot with an `observationId` provenance link; no bundled database, no startup download or seeding, mocked-fixture unit/view/E2E suites incl. a zero-requests-on-load guarantee; contract in `docs/data-sources.md` | done |
| 19 | Data integrity (audit GAP-4, documentation-first): the multi-tab stale-write defect was confirmed in a real two-tab browser test — the edit form's full-snapshot save silently reverts another tab's committed change and reports success — and documented as a limitation with the per-group field-merge contract, the reload-before-edit precaution and repository partial-update tests (`docs/data-integrity-audit.md` GAP-4, `docs/architecture.md` §4.2); no production change in this phase | done |
| 20 | Data integrity (audit GAP-4 remediation): optimistic concurrency for every drug write — a per-record monotonic revision token (additive `revisions` Dexie store, schema v4; the token never appears in rows, exports or archives) compared and bumped inside the same IndexedDB transaction as the write, stale saves rejected atomically as a typed `CONFLICT` with the stored record untouched, the edit form keeping the draft and edit session open with explicit recovery (open the latest record in a new tab, or reload — dismissal preserves the draft, no automatic retry, no silent token refresh), ABA-safe revision tombstones across delete→recreate/restore/import, deletion itself revision-guarded (review fix: a stale delete is rejected atomically before anything is removed — "Deletion did not happen", record intact, delete locked behind an explicit reload; the reviewed delete goes through the unchanged destructive confirmation; the tombstone is kept un-advanced), `DrugChanges` merge semantics, target identity/provenance/source references, uniqueness/validation and all import/export/recovery/quarantine paths preserved; repository, store, form, real-chain and rewritten two-tab browser tests; contract in ADR-21 and `docs/architecture.md` §4.2 | done |
| 21 | Data integrity (audit NV-1): real-browser crash durability for the recovery restore — a supervised Chromium process (disposable `--user-data-dir`, launched blank, driven over CDP) is terminated from the OUTSIDE (`taskkill /T /F` on Windows, SIGKILL to the detached process group on POSIX) at a deterministic in-flight checkpoint of the production `.npsb` restore transaction (test-only in-page instrumentation marks the `drugs.clear()` transaction and blocks its second drug `put` success dispatch with a synchronous XHR to a test-owned server whose receipt is the observable checkpoint proof; no production failpoint, no sleeps), and a same-profile restart in a fresh Chromium process verifies byte-level rollback of drugs/metadata/revision entries (unknown fields, provenance, source references), the old metadata marker, exact pre-crash revision entries and no false restore success; positive control — a committed restore survives the same kill with the full restored state (incl. the `-0` numeric-sidecar row pinned in-page with `Object.is`) and revision bumps of exactly one per restored id; dedicated `npm run test:crash` script + `NV-1 crash durability` CI job, isolated from the ordinary E2E suite and profile; harness contract in `docs/testing.md` §4.12, audit NV-1 now verified with the process-crash-only limits stated | done |
| 22 | Data integrity (audit NV-3): exhaustive 57-column CSV contract — every actual header pinned literally and asserted cell-by-cell against intended export values (marker library covering all five provenance variants, negative/scientific-notation numbers, hostile text), all 56 import destinations (`origin` the sole tested, deliberately non-importable column) round-tripped through export → `parseCsv` → explicit mapping → NPSL validation → real repository commit/read-back, every deliberate loss boundary tested as policy (formula-guard apostrophes kept verbatim, trim, empty→absent, `-0`→`'0'`, unknown-field drop, provenance stamping, `origin` re-stamp, list `';'` semantics, blocking rules); test-only — no production code, schema or format change; complete contract table in `docs/csv-column-contract.md`, audit NV-3 closed, NV-2 remains open (no real user database obtainable by design) | done |
| 23 | Data integrity (audit NV-2 evidence upgrade): real-Chromium schema migration tests — synthetic legacy databases created with the raw IndexedDB API at the authentic Dexie-native versions (10/20/30; `dexie@4.4.6` opens at declared × 10, the same version every historical build used) with store/index layouts verified against the original schema commits, seeded from an intercepted same-origin page that never loads the app bundle and closed before the real application opens the same database and upgrades it to native 40 (declared 4); raw-snapshot assertions prove the v1→v2 backfill runs bookkeeping-only (one shared stamp for both-missing timestamps; existing values / complete rows / metadata / unknown fields preserved — raw snapshots deeply equal), no spurious backfill from v2/v3 (bookkeeping-incomplete tripwire rows), additive v3/v4 stores empty, full hydration with zero quarantined records and reopen stability; test-only — no production migration change; harness contract in `docs/testing.md` §4.13, audit NV-2 evidence upgraded but **remains open** (no authentic legacy user database obtained or inspected) | done |
| 24 | Data integrity (audit NV-2): authorized-validation protocol prepared — `docs/nv2-authorized-validation.md`, an authorization-first runbook for validating an authentic legacy database in the future if its owner explicitly authorizes it: provenance/authorization gate, original-preserving isolated disposable-copy handling on the exact historical origin (supervised-Chromium feasibility constraints, documented copy-consistency confirmation, never-create raw probe order), evidence classes A (authentic physical database) / B (authentic row payloads reseeded) / C (synthetic) kept explicitly distinct, starting-version migration-path reporting (only a native-10 start exercises the v1→v2 hook; 20/30/40 runs must not be reported as validating it), sanitized local-only evidence rules requiring an independently enforced outbound-network boundary (Playwright request logs are explicitly not the boundary), hard stop conditions, and an explicit NV-2 closure checklist; documentation-only — no authentic database obtained, inspected or fabricated, no code or test change, and the runbook itself verifies nothing | done |
| 25 | Post-merge evidence audit: documentation-level traceability audit mapping every data-integrity claim to its concrete test evidence, with evidence-type wording bounded to project evidence and the NV-2 limitation re-scoped to evidence-bounded claims (PR #14) | done |
| 26 | Scientific-calculation audit: blank calculator fields no longer become silent numeric zeros on the curve path — production fix with regression coverage (PR #15) | done |
| 27 | Curve-validation E2E regression suite: explicit-undefined trace keys no longer blank Plotly charts (production fix), real Plotly curve rendering asserted end-to-end, and the curve-adapter trace contract pinned with regression tests (PR #16) | done |
| 28 | Coverage scope: `src/components/charts/curveAdapter.ts` included in the Vitest v8 coverage report; the adapter reaches 100 % statements/functions/lines with its remaining branch gap documented as unreachable empty-unit fallbacks (PR #17) | done |
| 29 | Test infrastructure: the coverage run caps workers (`--maxWorkers=2`) so slow instrumented tests stay under the default per-test budget; timeout root-cause forensics recorded (PR #18) | done |
| 30 | CI hardening: an independent, blocking `Coverage` job runs `npm run test:coverage` on every push and pull request; coverage-scope documentation aligned with the configuration (PR #19) | done |
| 31–32 | Release-integration audit and execution: the Phase 28–30 stacked pull requests were audited for merge readiness (cumulative-diff, CI and ancestry evidence), then integrated into `main` through three verified merge commits with per-step CI and content acceptance (PRs #17–#19) | done |
| 33 | Repository governance: `main` is protected — changes must arrive through pull requests, force pushes and branch deletion are rejected, and four CI checks (`Quality gates`, `Coverage`, `E2E smoke test`, `NV-1 crash durability`) are required before merging, each source-bound to GitHub Actions | done |

### What works today

- A local drug library: create, edit and delete records in the browser
  (IndexedDB). Every stored scientific value carries explicit provenance;
  the application never invents a parameter or a source.
- The three MVP scientific models — first-order one-compartment
  elimination, single-site receptor occupancy, Hill/Emax dose–response —
  calculated only from explicit user-entered parameters or values
  explicitly loaded from the library.
- Structured calculation traces: formula, substituted inputs,
  intermediate steps, assumptions and warnings for every result.
- Chart-agnostic curve data sampled by the engine over an explicit range,
  visualized with Plotly behind a project-owned adapter, with linear/log
  axis controls and log-Y representability handling.
- Provenance preserved end to end: a library-loaded value keeps its
  provenance badge in the input and in the report's inputs used; typed
  values are labelled as making no source claim.
- Import/export in the browser: `.npsl`/`.json` files preview before
  anything is written (replace needs an explicit acknowledgement), CSV
  imports go through a visible column-mapping step with declared units,
  and the whole library exports to `.npsl`/`.json` — lossless for
  records, provenance and unknown record-level keys (unknown envelope
  fields are not stored and are reported as `ENVELOPE_FIELDS_DROPPED`;
  quarantined records are excluded from every interchange export, with
  a visible
  warning) — or to a lossy-but-convenient CSV that always warns it is
  not a backup format (its text cells are guarded against spreadsheet
  formula injection).
- On-demand data sources (PubChem, ChEMBL): a dedicated page searches
  an external database only when you ask, shows every record with its
  source link, retrieval date and license before anything is written,
  and imports your explicit selection atomically — existing records
  are never overwritten. ChEMBL measurements keep their exact
  endpoint, unit and qualifier (`<`, `>`), stored records are usable
  offline, and a measurement becomes a drug-record parameter only
  through an explicit "Use as parameter…" action that preserves the
  provenance link back to the source record. Nothing is downloaded at
  startup, in the background or in bulk — the app bundles no default
  database (see [docs/data-sources.md](docs/data-sources.md)).
- Recovery backup (`.npsb`, separate from interchange): the Recovery tab
  exports a complete snapshot of both object stores — quarantined and
  unknown-field rows included — with exact counts and a stated
  fidelity boundary (no checksum, not authenticated), and restores it
  verbatim as one acknowledged, all-or-nothing replacement that
  reports committed vs. rejected vs. failed honestly and never
  re-runs itself; each format rejects the other's files (`.npsb` in
  ordinary import fails, `.npsl` in restore fails with import
  guidance).
- Settings that are real preferences: a persistent theme (system /
  light / dark, applied before the first paint and following the OS in
  system mode) and per-model curve display defaults the calculator
  starts with, stored in one versioned, validated, device-local
  `localStorage` record — with a scoped reset that restores only those
  preferences and never your drug library, imports or backups.
- Built to be operated from the keyboard: skip link, landmarks and page
  titles, one visible focus indicator per control, error summaries tied
  to the invalid field with `aria-invalid`/`aria-describedby`, a
  two-step acknowledgement before any destructive action, and axe-core
  scans (WCAG 2.x A/AA) over the main screens in the E2E suite.
- Fully static: no backend, no accounts, no cloud sync.

All quality gates run locally and in CI (`.github/workflows/ci.yml`):
typecheck, lint, tests, build, a blocking coverage run, and the
Playwright end-to-end and crash-durability suites.

See [docs/architecture.md](docs/architecture.md) for the roadmap and
[docs/spec-review.md](docs/spec-review.md) for specification issues found
during design, with proposed corrections.

## Quick start

Prerequisites: Node.js 22+ and npm (matches CI).

```bash
npm install            # install dependencies
npm run dev            # start the dev server (Vite)
npm test               # run unit + schema tests (Vitest)
npm run typecheck      # strict TypeScript check (tsc -b)
npm run typecheck:e2e  # strict TypeScript check for the Playwright specs
npm run lint           # oxlint
npm run build          # production build to dist/ (static hosting ready)
npm run preview        # serve the production build locally (vite preview)
npm run test:e2e       # Playwright end-to-end tests (needs: npx playwright install chromium)
npm run test:crash     # NV-1 crash-durability suite (supervised Chromium, dedicated config; same install)
```

The build output in `dist/` is a static frontend deployable to Cloudflare
Pages, GitHub Pages or any equivalent static host. There is no backend,
no API key and no build-time service dependency — the initial shell
renders from static assets alone. Packaged preview builds (static ZIP
plus a SHA-256 checksum) are published as **pre-release** GitHub Releases
following [docs/releasing.md](docs/releasing.md); nothing has been
publicly released until that page says so.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Stack, layer diagram, directory structure, dependency rules, data flows, roadmap |
| [docs/domain-model.md](docs/domain-model.md) | Core entities, invariants, Kd/Ki/EC50/IC50 distinctions |
| [docs/calculation-engine.md](docs/calculation-engine.md) | Engine contract, report/trace types, model registry, error taxonomy |
| [docs/provenance.md](docs/provenance.md) | The five provenance states and their rules |
| [docs/npsl-format.md](docs/npsl-format.md) | `.npsl` file format, fields, versioning policy |
| [docs/validation.md](docs/validation.md) | Layered validation and the import pipeline |
| [docs/data-sources.md](docs/data-sources.md) | On-demand PubChem/ChEMBL retrieval: three-layer model, provenance/licensing, explicit selection and import rules |
| [docs/testing.md](docs/testing.md) | Test strategy, required test matrix, round-trip testing |
| [docs/releasing.md](docs/releasing.md) | Release procedure for the static build: checks, tagging, ZIP + SHA-256, GitHub pre-release |
| [CHANGELOG.md](CHANGELOG.md) | Release notes per version, starting with the `0.1.0-alpha.1` preview |
| [docs/decisions.md](docs/decisions.md) | Architecture decision records (ADR) with rationale |
| [docs/spec-review.md](docs/spec-review.md) | Weaknesses in the specification and proposed corrections |

## Scientific boundary

The application calculates only what is justified by the supplied inputs and
the selected mathematical model. It does not automatically assert:

- dose → clinical effect
- receptor occupancy → subjective effect
- plasma concentration → brain receptor occupancy

If a required parameter is missing, the calculation is reported as
impossible — no value is guessed, defaulted or inferred. Kd, Ki, EC50 and
IC50 are distinct parameters and are never silently substituted for one
another.

## License

Source-available under the **PolyForm Noncommercial License 1.0.0** — see
[LICENSE](LICENSE).

> Required Notice: Copyright 2026 OokoukiBob (https://github.com/ookoukibob/Neuropharmacology-Sandbox)

This is **not** OSI-approved open-source software. Noncommercial use
(including personal research, study, teaching and hobby projects, and use by
charitable/educational/public/government organizations) is permitted;
commercial use, distribution for commercial purposes, and commercial
sublicensing are not. SPDX identifier: `PolyForm-Noncommercial-1.0.0`.
