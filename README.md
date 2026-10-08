# Neuropharmacology Sandbox

A transparent, reproducible pharmacology calculation environment.

The application distinguishes clearly between externally sourced
pharmacological data, user-provided data, calculated values, derived values
and unverified data. It never invents pharmacological parameters.

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

**Phase 1 — technical foundation (complete).** This repository currently
contains the architectural foundation, not the full application:

| Area | Status |
| --- | --- |
| Project scaffold (Vite, React, TypeScript strict, Tailwind v4, shadcn/ui) | done |
| Domain model types (drug, pharmacology, provenance, library) | done (types) |
| Calculation engine contract (`CalculationReport`, trace, curve types) | done (types) |
| NPSL `.npsl` schema + version compatibility (Zod) | done, with tests |
| App shell: routes, layout, placeholder views | done |
| Unit/component/e2e test harness | done (harness + first tests) |
| Calculation models (PK, occupancy, Hill) | phase 2 |
| Drug library UI, charts, import/export UI, Dexie persistence | phases 2–3 |

See [docs/architecture.md](docs/architecture.md) for the roadmap and
[docs/spec-review.md](docs/spec-review.md) for specification issues found
during design, with proposed corrections.

## Quick start

Prerequisites: Node.js 20+ and npm.

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
