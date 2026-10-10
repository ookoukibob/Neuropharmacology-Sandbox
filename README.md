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

## Current status

**Phase 1 — technical foundation (complete).**
**Phase 2 — scientific calculation engine (complete, after a hardening pass).**
**Phase 3 — drug library + local persistence (complete).**
**Phase 4 — calculator + scientific visualization (complete, after a
hardening and closure pass).**
**Phase 5 — import/export workflows (complete).**
**Phase 6 — accessibility, keyboard workflows and end-to-end library
persistence (complete).**
**Phase 8 — recovery backup/restore (`.npsb`, complete).**
**Phase 9 — settings & persistent presentation preferences (complete).**
**Phase 10 — target-metadata preservation on drug edits (complete).**
**Phase 11 — repository data integrity audit (complete).**
**Phase 12 — identifier-metadata preservation on drug edits (complete).**
**Phase 13 — duplicate-target-id rejection in NPSL imports (complete).**
**Phase 14 — untouched list/text preservation on drug edits (complete).**
**Phase 15 — negative-zero preservation in NPSL round trips (complete).**
**Phase 16 — GAP-1/GAP-2 regression coverage and -0 collision coverage (complete).**
**Phase 17 — GAP-3 quarantine-vs-merge import collision protection (complete).**

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
typecheck, lint, tests, build, and the Playwright end-to-end workflows.

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
npm run test:e2e       # Playwright end-to-end tests (needs: npx playwright install chromium)
```

The build output in `dist/` is a static frontend deployable to Cloudflare
Pages, GitHub Pages or any equivalent static host. There is no backend.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Stack, layer diagram, directory structure, dependency rules, data flows, roadmap |
| [docs/domain-model.md](docs/domain-model.md) | Core entities, invariants, Kd/Ki/EC50/IC50 distinctions |
| [docs/calculation-engine.md](docs/calculation-engine.md) | Engine contract, report/trace types, model registry, error taxonomy |
| [docs/provenance.md](docs/provenance.md) | The five provenance states and their rules |
| [docs/npsl-format.md](docs/npsl-format.md) | `.npsl` file format, fields, versioning policy |
| [docs/validation.md](docs/validation.md) | Layered validation and the import pipeline |
| [docs/testing.md](docs/testing.md) | Test strategy, required test matrix, round-trip testing |
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
