# Validation strategy

Validation is layered. Each layer answers a different question, fails with a
different kind of message, and lives in a different place. Nothing that
touches the user's library is validated "on the way in" after the fact —
validation happens **before** any write.

Implemented in phase 1: layer 1–2 for NPSL (`src/data/schemas/npsl.ts` +
tests). Implemented in phase 2: engine input validation for all three models
(layer 5 for calculator inputs — `src/engine/validate`, plus curve range
validation in `src/engine/curve`). Layers 1, 3–4 for calculator inputs and
library records arrive with the calculator and import features.

---

## 1. The five layers

| Layer | Question | Where | Tool |
| --- | --- | --- | --- |
| 1. Parse | Is this bytes/text of the expected encoding & JSON? | `src/data/parse` (p2) | `JSON.parse`, CSV parser |
| 2. Schema | Is the structure exactly right (types, enums, required fields)? | `src/data/schemas` | Zod |
| 3. Version | Can this build read this format/schema version? | `src/data/schemas` | `checkNpslVersions()` |
| 4. Semantic | Do the *values* make scientific sense together? | `src/data/semantic` (p3–4) | pure functions |
| 5. Domain | Does it satisfy domain invariants? | `src/domain` guards + forms | pure functions |

Layer failure output shape (shared):

```ts
type ValidationIssue = {
  path: string          // "drugs[0].targets[2].kd.unit"
  code: string          // 'SCHEMA' | 'VERSION' | 'UNIT_UNKNOWN' | ...
  message: string       // human-readable, specific
  severity: 'error' | 'warning'
}
```

Errors block the operation; warnings are surfaced in the preview but do not.

---

## 2. Schema layer (implemented)

`npslFileSchema` enforces:

- required top-level fields (`formatVersion`, `schemaVersion`,
  `libraryMetadata`, `drugs`);
- semver-shaped version strings;
- ISO 8601 date-times;
- finite numeric `value`s (no `NaN`/`±Infinity`);
- non-empty `unit` strings;
- the `origin` / `action` / `dataStatus` enums;
- discriminated provenance unions, including `literature` → `source`,
  `calculated` → `model`, `derived` → `method` + `from`;
- normalization defaults for omitted collections (`tags`, `targets`,
  `synonyms`, `pharmacokinetics`, `dataStatus`);
- forward compatibility: unknown keys are preserved, never silently dropped.

The same Zod-first approach is used for calculator inputs and user-defined
drug forms (phases 3–4): every user-editable structure has a schema next to
its
type, and forms validate with the same schema the engine consumes — one
source of truth for "valid".

---

## 3. Version layer (implemented)

`checkNpslVersions(file)` → `{ ok } | { ok: false, reason }`:

- major ≠ supported major → refuse ("formatVersion: Major version 2 is not
  supported (this build reads major version 1)");
- minor > supported minor → refuse with "update the application";
- otherwise accept, including older minors of the same major.

---

## 4. Semantic layer (phase 3–4)

Structurally valid data can still be scientifically wrong. Planned checks,
each a pure function with unit tests:

| Check | Rule | Outcome |
| --- | --- | --- |
| Unit known | every `unit` exists in the unit catalog | error `UNIT_UNKNOWN` |
| Unit dimension | `halfLife` is time, `kd`/`ki`/`ec50`/`ic50` are molar-concentration, `bioavailability` is dimensionless | error |
| Cross-parameter consistency | one target may not carry both `kd` and `ki` **for the same measurement** with conflicting literature sources | warning |
| Duplicate ids | unique `Drug.id`, unique `targets[].id` per drug | error on duplicates, `DUPLICATE_ID` |
| Ranges | fraction-like values in range, non-negative where required | error |
| Provenance completeness | `literature` with no citation/doi/url beyond `source` | warning (encourage full citation) |
| Demo marking | `origin: 'built-in-demo'` drugs must be in a library with `dataStatus: 'example'` | warning |
| Kd/Ki separation | importers may never map a column named ambiguously (`"Kd/Ki"`) without explicit user mapping choice | blocks until resolved in mapping UI |

---

## 5. Import pipeline (all-or-nothing)

```
File selected
  → parse (JSON / CSV with explicit encoding)
  → schema validation (Zod)
  → version compatibility
  → semantic validation
  → PREVIEW: file info, counts, per-record status, full error/warning list,
             field mapping UI for CSV, conflict resolution (merge/replace)
  → user confirms
  → single Dexie transaction: metadata + drugs written atomically
  → success summary
```

Guarantees:

- **No partial writes.** Any error at any stage aborts before the
  transaction; a failure inside the transaction rolls it back. The user's
  existing library is unchanged — this is asserted by tests.
- **No silent drops.** Records that fail validation are listed individually
  with reasons; the user chooses to fix the file or skip them explicitly.
- **No provenance upgrades** during import (see
  [provenance.md](provenance.md) §2).

Validation of existing data at startup: on boot, the repository layer
validates/migrates persisted records. Migration never discards data
silently: unparseable records are quarantined and reported, not deleted
(`docs/decisions.md` §5).

---

## 6. Calculator inputs

Calculator input schemas define, per model:

- required vs optional parameters (missing → `MISSING_PARAMETER`, never a
  default — in particular the Hill coefficient `n` has no default),
- numeric constraints (finite; ≥ 0; `EC50 > 0`, `Kd > 0`, `t½ > 0`,
  `k > 0`; Hill coefficient `n > 0`; `E0`/`Emax` signed),
- expected unit dimension per input (`n` requires the literal unit `1`,
  `%` is rejected),
- mutually exclusive parameter pairs (PK: exactly one of `t½`/`k`;
  both present → `CONFLICTING_PARAMETERS`).

Validation runs **twice**: at the form (fast, field-level feedback — phase 4)
and inside the engine (authoritative — the engine never trusts its caller;
implemented phase 2). The engine's checks produce the `CalculationError`
taxonomy documented in [calculation-engine.md](calculation-engine.md) §3.

Engine-side codes in production today: `MISSING_PARAMETER`,
`NOT_A_NUMBER`, `NEGATIVE_VALUE`, `ZERO_NOT_ALLOWED`, `OUT_OF_RANGE`
(curve ranges), `UNKNOWN_UNIT`, `INCOMPATIBLE_UNITS`,
`CONFLICTING_PARAMETERS`. Reserved: `NUMERICAL_ERROR` (defensive curve
invariant), `MODEL_NOT_APPLICABLE` (unsupported-calculation answer, no
producer until the UI layer).

Molar ↔ mass concentration conversion is rejected rather than approximated:
it needs a molecular weight the engine will never invent.

---

## 7. CSV specifics

CSV is structurally weaker than JSON:

- **Import**: header detection → **field mapping UI** (spec requires mapping
  where necessary) → type/unit coercion per mapped column → then layers 2–5
  as usual. Ambiguous headers (`"Kd/Ki"`, `"conc."`) must be resolved by the
  user, never guessed.
- **Export**: provenance is flattened into companion columns
  (`kd`, `kd_unit`, `kd_provenance_type`, `kd_provenance_source`, ...);
  nested provenance beyond that is serialized as a JSON string in the cell.
  The UI must warn that CSV is a lossy projection and recommend `.npsl` for
  backup (see `spec-review.md` §6).

---

## 8. What is deliberately *not* validated

- The scientific correctness of literature values — the application records
  provenance, it does not referee it.
- Whether a value "makes pharmacological sense" beyond hard domain bounds;
  plausibility warnings must be evidence-based, not vibes-based.
- Anything that would require inventing a value to pass validation.
