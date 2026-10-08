# Domain model

The domain layer defines the vocabulary of the application. It is pure
TypeScript: no React, no Zod, no Dexie, no engine imports. Everything here is
implemented as types in `src/domain/`; invariants are enforced by the layers
that *produce* domain objects (forms, importers, engine).

Source files:

- `src/domain/provenance/provenance.ts`
- `src/domain/pharmacology/scientific-value.ts`
- `src/domain/pharmacology/units.ts`
- `src/domain/drug/drug.ts`
- `src/domain/library/library.ts`

---

## 1. Scientific value — the atomic unit

```ts
interface ScientificValue<Unit extends string = string> {
  value: number        // finite
  unit: Unit           // explicit, never omitted
  provenance: Provenance
}
```

Rules:

- A pharmacological parameter is **never** a bare number. `{ kd: 4.2 }` does
  not exist in this codebase; it is
  `kd: { value: 4.2, unit: "nM", provenance: { type: "literature", ... } }`.
- `value` must be finite (no `NaN`, no `±Infinity`); Zod rejects these at the
  schema boundary.
- Units are strings validated against the unit catalog
  (`src/domain/pharmacology/units.ts`); they are never guessed or defaulted.
- **Absence is meaningful.** Optional parameters (`kd?`, `halfLife?`) are
  simply missing when not provided. The engine reports
  `MISSING_PARAMETER` instead of substituting a value.

---

## 2. Units and dimensions

Dimensions are declared explicitly (see `DimensionId`):

| Dimension | Base | Example units |
| --- | --- | --- |
| `molar-concentration` | M | M, mM, µM, nM, pM |
| `mass-concentration` | g/L | mg/L, µg/mL |
| `time` | h | s, min, h, d |
| `amount` | mol | mol, mmol, nmol |
| `mass` | g | g, mg, µg |
| `volume` | L | L, mL |
| `dimensionless` | 1 | 1, % |

Critical rules:

- **Mass concentration ≠ molar concentration.** Converting `mg/L` ⇄ `nM`
  requires a molecular weight; the application never invents one, so the
  conversion is refused, not estimated.
- Cross-dimension arithmetic is a hard error
  (`INCOMPATIBLE_UNITS`), not a warning.
- The catalog (`UnitCatalog`) is an interface: the engine depends on the
  contract, not a concrete implementation.

---

## 3. Parameter terminology — Kd ≠ Ki ≠ EC50 ≠ IC50

`ReceptorTarget` keeps each parameter in its own explicitly named field:

| Field | Meaning | Expected dimension |
| --- | --- | --- |
| `kd` | Equilibrium dissociation constant | molar-concentration |
| `ki` | Inhibition constant (assay-dependent, e.g. Cheng–Prusoff-derived) | molar-concentration |
| `ec50` | Concentration giving half-maximal *effect* | molar-concentration |
| `ic50` | Concentration giving half-maximal *inhibition* | molar-concentration |

Rules:

- The engine declares which parameter a model consumes. The occupancy model
  consumes `kd` **only**. If only `ki` is available, the calculation reports
  the parameter as missing (`MISSING_PARAMETER`) — a future model may accept
  `ki` explicitly, but substitution must always be an explicit, user-visible
  act, never a silent default.
- `dose`, `exposure` and `concentration` are also distinct concepts: the MVP
  models take *concentrations*, not doses. See `spec-review.md` §10.

---

## 4. Drug aggregate

```
Drug
├── id: DrugId                      uuid (user data) / stable slug (built-in)
├── identifiers
│   ├── name: string                required
│   ├── synonyms: string[]
│   ├── description?, casNumber?
├── origin: DrugOrigin              'built-in-demo' | 'user' | 'imported'
├── tags: string[]
├── targets: ReceptorTarget[]       zero or more
│   └── each: id, name, gene?, action?, species?,
│             kd?, ki?, ec50?, ic50?, notes?
├── pharmacokinetics
│   ├── halfLife?                   time unit expected
│   ├── clearance?                  volume/time unit expected
│   ├── volumeOfDistribution?       volume unit expected
│   ├── bioavailability?            dimensionless / %
│   └── notes?
├── notes?
└── createdAt? / updatedAt?         ISO 8601
```

Invariants:

1. `identifiers.name` is non-empty; a record without a name cannot exist.
2. `targets[].id` is unique **within** a drug; `Drug.id` is unique within a
   library (duplicate detection happens during import/semantic validation).
3. Every parameter present carries provenance — there are no anonymous
   numbers.
4. `origin` is never rewritten by the application: user-entered data stays
   `user`, imported data stays `imported`. Provenance of *parameters* follows
   the same rule (`src/data` importers may not upgrade `user` → `literature`).
5. Demo records are marked: `origin: 'built-in-demo'` and their library
   carries `dataStatus: 'example'`.

---

## 5. Library aggregate

```ts
interface LibraryMetadata {
  id: string
  name: string
  author?: string
  description?: string
  createdAt: string   // ISO 8601
  updatedAt: string
  dataStatus: 'example' | 'sourced' | 'mixed' | 'user' | 'unspecified'
}

interface DrugLibrary {
  metadata: LibraryMetadata
  drugs: readonly Drug[]
}
```

`dataStatus` is the top-level honesty label required by the specification:
example/demo data must be *explicitly* marked as such, and the UI must show
it. Per-parameter provenance remains the fine-grained source of truth;
`dataStatus` is the summary.

The same shape backs:

- the live IndexedDB library (via repositories), and
- the portable `.npsl` file (via the Zod schema in `src/data/schemas/npsl.ts`,
  mapped to/from domain objects — see [npsl-format.md](npsl-format.md)).

---

## 6. Relationship to the engine

The engine does not mutate domain objects. It consumes domain-shaped inputs
(`ScientificValue`, explicit numbers with units) and returns a
`CalculationReport` that *echoes its inputs with their provenance* so a result
can be traced back to the exact library parameters it used — see
[calculation-engine.md](calculation-engine.md).

Calculated values that are written back to the library (e.g. a derived
elimination constant) get provenance
`{ type: 'calculated', model }` or `{ type: 'derived', method, from }`, never
`literature`.
