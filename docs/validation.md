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
- forward compatibility: unknown keys are kept by the loose parse and
  preserved end-to-end — inside `libraryMetadata` and inside every nesting
  level of a drug record (root, identifiers, targets, parameters,
  provenance, pharmacokinetics) through preview → import → storage →
  export (Merge collision policy in `docs/npsl-format.md` §6). Unknown
  keys at the top level of the envelope have no storage location; they are
  reported as warning `ENVELOPE_FIELDS_DROPPED` instead of being dropped
  silently.

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

## 4. Semantic layer (import: phase 3; calculator inputs: phase 4; CSV mapping: phase 5)

Structurally valid data can still be scientifically wrong. The import
checks are implemented as pure functions in
`src/data/import/importPipeline.ts` with unit tests; calculator-input
checks are enforced by the engine's validation layer (phase 2) and
rendered field-by-field by the calculator (phase 4).

| Check | Rule | Outcome (at import) |
| --- | --- | --- |
| Unit known | every `unit` exists in the unit catalog | warning `UNKNOWN_UNIT` — imported exactly as declared; a calculation that *uses* it fails with the engine's `UNIT_UNKNOWN` |
| Unit dimension | `halfLife` is time, `kd`/`ki`/`ec50`/`ic50` are molar- or mass-concentration, `bioavailability` is dimensionless | warning `UNEXPECTED_DIMENSION` — never rewritten |
| Cross-parameter consistency | one target may not carry both `kd` and `ki` **for the same measurement** with conflicting literature sources | non-blocking warning in the CSV mapping UI (`mapping-warnings`: the two stay separate values, never substituted) — the import never resolves it silently |
| Duplicate ids | unique `Drug.id`, unique `targets[].id` per drug | error `DUPLICATE_ID` — blocking |
| Duplicate names | same `identifiers.name` twice in one file | warning `DUPLICATE_NAME` — names are labels, not identities |
| Ranges | fraction-like values in range, non-negative where required | error (form) / engine-side (calculator) |
| Provenance completeness | `literature` with no citation/doi/url beyond `source` | accepted — `source` alone satisfies the schema; a fuller citation is encouraged by documentation, not enforced by an import warning |
| Demo marking | `origin: 'built-in-demo'` drugs belong to demo/example data | accepted at import — demo data is identified in the UI by the origin badge (`Demo example`) and the library `dataStatus` badge, not by an import warning |
| Kd/Ki separation | importers may never map a column named ambiguously (`"Kd/Ki"`) without explicit user mapping choice | never auto-mapped — the column stays unmapped (listed as *not imported* in the preview) until the user assigns it |

---

## 5. Import pipeline (all-or-nothing)

```
File selected
  → parse (JSON / CSV with explicit encoding)
  → version compatibility
  → schema validation (Zod)
  → semantic validation
  → PREVIEW: file info, counts, per-record status, full error/warning list,
             field mapping UI for CSV, conflict resolution (merge/replace)
             (`previewNpslImport` ships in phase 3; the import/export UI
             with explicit CSV column mapping ships in phase 5)
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
- **Extension fields preserved; Merge collisions deterministic.** Unknown
  fields accepted by the loose schema survive the full round trip at every
  supported nesting level (drug root, identifiers, targets, parameters,
  provenance, pharmacokinetics, library metadata). On Merge of an existing
  id, the incoming file wins a key collision and stored-only extensions are
  kept — incoming extensions are never silently discarded. Unknown
  envelope-level fields are reported as `ENVELOPE_FIELDS_DROPPED` because
  storage has nowhere to keep them.
- **Honest commit reporting.** A committed transaction is never presented
  as a rollback: if the session refresh *after* a successful commit fails,
  the outcome is `committed-refresh-failed` — the UI states the records
  were written, shows the original refresh error, and offers a session
  refresh retry (the import itself is never re-run automatically).

Validation of existing data at startup: on boot, the repository layer
validates/migrates persisted records. Migration never discards data
silently: unparseable records are quarantined and reported, not deleted
(`docs/decisions.md` ADR-5, ADR-15).

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

- **Import**: RFC 4180 parse (quoted fields, escaped quotes, embedded
  newlines, BOM tolerated; structural problems — unterminated quote, quote
  in an unquoted field, row wider than the header, duplicate column names —
  fail with the line number) → **explicit column mapping UI** → then layers
  2–5 as usual. Ambiguous headers (`"Kd/Ki"`, `"conc."`, `"affinity"`,
  `"potency"`) are never inferred: every mapping select starts as "Ignore
  (not imported)" and the user assigns each column; unmapped columns are
  listed in the preview as *not imported*. Mapping rules, each blocking the
  preview with a visible, actionable message:
  - `drug.name` must be mapped; two columns may not claim the same meaning;
  - every mapped value column needs a unit source — its own unit column
    *or* a visibly declared fixed unit, never both. Fixed units are picked
    from the unit catalog where the parameter has a dimension (molar/mass
    concentration for Kd/Ki/EC50/IC50, time for t½, dimensionless for
    bioavailability) and declared as free text where the catalog has no
    units (clearance, volume of distribution). Units are stored verbatim —
    never converted, defaulted or guessed;
  - provenance columns require a provenance type column; literature
    provenance requires a source; a source column is rejected for
    non-literature types; provenance JSON must parse to a JSON object;
  - target-scoped columns require the target name column;
  - row-level problems (missing drug name, non-finite value, empty unit
    cell, unit/provenance without a value, unknown target action) block the
    **whole** import with per-row messages — the repository import is
    all-or-nothing, so a partial write cannot be expressed.

  Rows are grouped into one record only through an explicit drug id column
  (identical drug-level fields required; a repeated target id inside one
  group is rejected). Without an id column every row becomes its own record
  with a generated id — equal names never merge records. Generated ids are
  identity bookkeeping only. Imported records carry storage
  `origin: "imported"` (distinct from provenance), and values without
  provenance columns are stamped `{ "type": "user" }` — provenance is never
  invented or upgraded. The mapped rows are assembled into a normal
  versioned NPSL document that then passes through the *same*
  `previewNpslImport` → repository transaction pipeline — CSV never gets a
  second, weaker validation path.
- **Export**: the header schema is stable and derived from one parameter
  table (57 columns): identity/bookkeeping (`drug_id`, `origin`, `name`,
  `synonyms`, `description`, `cas_number`, `tags`, `notes`, `created_at`,
  `updated_at`), target fields (`target_id` … `target_notes`), four
  target-scope parameters (`kd`, `ki`, `ec50`, `ic50`) and four PK
  parameters (`half_life`, `clearance`, `volume_of_distribution`,
  `bioavailability`) each as `value` / `unit` / `provenance_type` /
  `provenance_source` / `provenance_json`, plus `pk_notes` between the
  blocks. One row per target (a drug without targets yields one row with
  empty target columns); drug-level columns repeat on every row of that
  drug and are tied together by `drug_id`. Nested provenance beyond
  type+source is serialized as a JSON string in the `_provenance_json`
  cell; storage `origin` stays its own column, distinct from provenance.
  The UI shows an always-visible warning that CSV is a lossy projection
  and recommends `.npsl` for backup (see `spec-review.md` §6).
- **Export — spreadsheet formula-injection guard.** Spreadsheets can
  *execute* text cells that start with `=`, `+`, `-` or `@` — including
  behind leading whitespace or control characters they trim first. Every
  text cell (ids, names, notes, units, enum cells, timestamps, provenance
  cells) therefore passes through a guard before RFC-4180 quoting:
  dangerous cells gain a leading apostrophe (the established spreadsheet
  text marker), ordinary text is emitted byte-identically, and numeric
  value cells (`String(finite number)`) are never touched, so legitimate
  values such as `-2.5`, `0` and `1e-9` survive exactly. The guard exists
  only in the export representation — the in-memory library and its
  records are never modified — and a CSV re-import keeps the apostrophe
  verbatim. This is a documented mitigation, not a proof: how consumers
  treat the marker varies, which is one more reason CSV is never the
  authoritative backup (the UI states both facts).

---

## 8. What is deliberately *not* validated

- The scientific correctness of literature values — the application records
  provenance, it does not referee it.
- Whether a value "makes pharmacological sense" beyond hard domain bounds;
  plausibility warnings must be evidence-based, not vibes-based.
- Anything that would require inventing a value to pass validation.
