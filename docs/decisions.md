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

## Tooling notes (not decisions, but useful)

- **shadcn CLI workspace bug (v4.20/4.21):** `shadcn init` failed with
  "Could not load the workspace config" in this project; components were
  added with `shadcn add`, which works once `components.json` exists and the
  `@/*` paths are declared in the **root** `tsconfig.json` (the CLI reads the
  root config, while `tsc -b` reads `tsconfig.app.json` — both are kept in
  sync). Components were relocated to `src/components/ui` after the CLI wrote
  them to a literal `@\` folder.
- `npm audit` flags dev-only transitive deps of the `shadcn` CLI package; it
  does not affect the shipped bundle.
