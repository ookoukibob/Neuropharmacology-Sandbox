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

| Phase | Deliverable | Status |
| --- | --- | --- |
| 1 | Architecture, domain types, NPSL schema + tests, app shell, test harness | done |
| 2 | Calculation engine: first-order PK, single-site occupancy, Hill response, chart-agnostic curves, unit catalog, Decimal.js numerics, calculation traces, provenance propagation — plus the hardening pass (log y-axis validation, consistent numerical-loss reporting, invariant coverage, GitHub Actions CI) | done |
| 3 | Drug library: Dexie/IndexedDB persistence behind a repository abstraction, versioned schema with in-place migration, startup hydration with quarantine reporting, transactional NPSL import (preview → all-or-nothing commit), minimal library UI (list/select/create/edit/delete with provenance display), export → import round trip | done |
| 4 | Calculator + visualization: model selector, explicit parameter inputs, provenance-aware library loading (explicit selection only), calculation results with structured traces, CurveData → Plotly chart adapter, linear/log controls, log-Y representability handling, curve settings state — plus the hardening pass (PK mode union fix, stale-state semantics, curve readiness separation) and the critical calculator E2E workflows | done |
| 5 | Import/export UI: `.npsl`/`.json` import with preview → confirm (merge/replace with explicit destructive acknowledgement), explicit CSV column mapping (nothing inferred from column names, declared unit policy, CSV → versioned NPSL document → same validation pipeline), whole-library export to `.npsl`/`.json` (lossless) and CSV (lossy, with a visible warning), component + CSV unit tests and six E2E workflows | done |
| 6 | Accessibility polish, keyboard workflows, expanded E2E coverage | next |

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
  and the whole library exports to a lossless `.npsl`/`.json` or a
  lossy-but-convenient CSV that always warns it is not a backup format.
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
