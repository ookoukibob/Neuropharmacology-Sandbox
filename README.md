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

## What works today

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
  are never overwritten. A stored compound can also be deleted
  individually with its measurements, behind a two-step confirmation;
  a drug-library entry that already imported it is never touched.
  ChEMBL measurements keep their exact
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

## Privacy and network requests

The application is a static site with a deliberately small network
footprint. What it actually does — verified against the code and the
deployed site:

- **Your scientific data stays in this browser.** Drug records and
  imported source records (compounds and measurements) are stored in
  browser-local IndexedDB, scoped to this origin and this browser
  profile. There is no application backend, no account system and no
  cloud-sync service (see
  [Data storage and backup](#data-storage-and-backup)).
- **Presentation preferences are local too.** The theme and per-model
  curve-display defaults are stored in one versioned `localStorage`
  record on this origin (ADR-19); it contains no scientific data.
- **Nothing is fetched until you ask.** PubChem and ChEMBL requests
  fire only from an explicit Search or Fetch measurements press.
  Loading the Data Sources page performs zero external requests
  (asserted by tests), and nothing is downloaded at startup or in the
  background.
- **Your query is transmitted to the provider you chose.** A search
  sends the term or identifier you entered — a compound name, CAS
  number, InChIKey or CID — to that source's servers: PubChem (NCBI,
  USA) or ChEMBL (EMBL-EBI, UK). The requests are plain GET lookups;
  like any web traffic, normal network metadata (potentially including
  your IP address) is visible to that provider, and to the hosting
  provider serving this static site (Cloudflare Pages). This
  application makes **no anonymity claim** toward either.
- **Searching never uploads your library.** Source requests carry only
  the query itself. Imported records are persisted locally, through the
  explicit import workflow after you review and confirm them — never
  as part of a search.
- **Import and export are user-initiated.** The app writes `.npsl`,
  `.json`, `.csv` and `.npsb` files only when you request an export and
  reads a file only when you choose one to import; it never transmits
  them anywhere. Treat exported files as sensitive data and store them
  accordingly.
- **No analytics or telemetry in the shipped code.** The application
  bundle contains no analytics, tracking or crash-reporting calls; its
  only network destinations are the data sources you explicitly query,
  the static host serving the page, and links you choose to click
  (source attribution and repository links).

## Current status

Development proceeds in numbered review phases. The detailed phase
record (**Phases 1–33**, moved verbatim from this page) lives in
[docs/development-history.md](docs/development-history.md); the
dependency-ordered roadmap lives in
[docs/architecture.md](docs/architecture.md) §6. Milestones at a
glance:

| Milestone | Record |
| --- | --- |
| Phases 1–9 — core application: architecture, calculation engine, drug library, calculator + charts, import/export, accessibility, dependency security audit, recovery backup, settings | done |
| Phases 10–17 — data-integrity audits and remediations (DI-01…DI-04, GAP-1, GAP-2, GAP-3) | done |
| Phase 18 — on-demand PubChem/ChEMBL data sources with per-record provenance, licensing and explicit import (plus 18G/18I integrity closures) | done |
| Phases 19–24 — multi-tab write safety (GAP-4, ADR-21), NV-1 crash durability, NV-3 CSV contract, NV-2 evidence upgrades and the authorized-validation runbook | done |
| Phases 25–32 — evidence and scientific-calculation audits, curve-validation E2E regression, coverage reporting and the blocking CI coverage gate | done |
| Phase 33 — repository governance: protected `main` with four required CI checks (`Quality gates`, `Coverage`, `E2E smoke test`, `NV-1 crash durability`) | done |
| Phases 34–35.1 — first public preview preparation and release-notes consistency (PRs #20 and #21) | `v0.1.0-alpha.1` published 2026-10-13 |

Known open issues are listed under "Known limitations" in
[CHANGELOG.md](CHANGELOG.md) — above all **NV-2** (no authentic
historical user database has been obtained or inspected; see
[First public preview](#first-public-preview) above) and the documented
multi-tab edit-conflict recovery workflow (ADR-21).

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
| [docs/development-history.md](docs/development-history.md) | The numbered phase record (Phases 1–33), preserved in full |

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
