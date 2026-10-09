# Specification review — weaknesses and proposed corrections

The MVP specification is strong on scientific boundaries and weak on a few
mechanics it assumes but never defines. This document lists every material
gap found during the architecture phase, why it matters, and the correction
proposed (and adopted, unless marked *open*). Corrections are reflected in the
schema, domain types and documentation referenced below.

---

### §1 · "Calculated" vs "derived" provenance is undefined

**Gap.** Both provenance states are required, but the boundary between them
is never stated. Implementers will diverge (is `k = ln(2)/t½` calculated or
derived?).
**Why it matters.** Provenance is the core feature; inconsistent semantics
make it untrustworthy.
**Correction (adopted).** `calculated` = produced by running an engine model
(`provenance.model` = model id). `derived` = recomputed from other *stored*
values by a stated rule (`method` + `from`). See `docs/provenance.md` §1–2
and `src/domain/provenance/provenance.ts`.

---

### §2 · Nothing marks demo/example data in the required schema fields

**Gap.** The spec demands that example data be "explicitly marked", but the
required `.npsl` fields (`formatVersion`, `schemaVersion`,
`libraryMetadata`, `drugs`) provide no place to say so.
**Why it matters.** Without a required-by-schema field, a demo library can be
imported and displayed looking authoritative — exactly the failure the rule
exists to prevent.
**Correction (adopted).** Added `libraryMetadata.dataStatus`
(`example | sourced | mixed | user | unspecified`, default `unspecified`) and
`drug.origin` (`built-in-demo | user | imported`). The UI must display both.
See `docs/npsl-format.md` §2–3.

---

### §3 · "Never invent parameters" has no encoding for "missing"

**Gap.** The spec forbids inventing values but never says how absence is
represented or what callers get when a parameter is absent.
**Why it matters.** Implementations drift toward defaults (`Kd ?? 1000`).
**Correction (adopted).** Absence = field omitted; the engine returns
`MISSING_PARAMETER` as data (never a default, never a thrown exception).
Error taxonomy: `docs/calculation-engine.md` §3.

---

### §4 · Explicit units are required, but there is no unit system

**Gap.** "Units must be explicit" without a catalog means unit strings are
decorative: nothing defines that `"h"` and `"hours"` are the same unit, or
that `mg/L` and `nM` are not.
**Why it matters.** Incompatible-unit arithmetic is silent scientific error;
the required "invalid units" tests need something to validate against.
**Correction (adopted).** A dimension-based `UnitCatalog` interface with
units relevant to pharmacology (`docs/domain-model.md` §2), engine-level
`UNKNOWN_UNIT` / `INCOMPATIBLE_UNITS` errors, and a hard rule: mass ⇄ molar
concentration is **never** converted (requires a molecular weight, which the
app must not invent). Unit catalog implementation is scheduled ahead of the
engine (roadmap phase 2).

---

### §5 · Occupancy model input units are unspecified

**Gap.** `Occupancy = [D] / ([D] + Kd)` requires `[D]` and `Kd` in the same
units; the spec does not say what happens if they differ (`mg/L` vs `nM`).
**Correction (adopted).** Convert within a dimension (e.g. `µM` → `nM`);
refuse across dimensions with `INCOMPATIBLE_UNITS`. The formula is evaluated
in one canonical unit per dimension, recorded in the trace.
See `docs/calculation-engine.md` §4.

---

### §6 · CSV "preserve provenance whenever the format allows" is ambiguous

**Gap.** CSV structurally cannot represent nested provenance, and the spec
does not define what "the target format allows" means in practice — so
exports will differ per implementer, and users may not notice information
loss.
**Why it matters.** Silent provenance loss on export defeats the product
definition.
**Correction (adopted).** Written policy: `.npsl`/JSON are lossless; CSV is a
**declared-lossy** projection that flattens each parameter into
`value, unit, provenance_type, provenance_source` columns (deeper provenance
fields serialized as a JSON string cell), and the export UI must state the
loss and recommend `.npsl` for backup. CSV import requires an explicit field
mapping step; ambiguous headers must be resolved by the user.
See `docs/validation.md` §7 and `docs/architecture.md` §4.5.

---

### §7 · The two version fields have no ownership rule

**Gap.** `formatVersion` and `schemaVersion` are both required but their
respective jurisdiction ("what change bumps which?") and the compatibility
rule are undefined — the classic path to unimportable libraries.
**Correction (adopted).** Ownership split (envelope vs data schema),
semver-style bump rules, and the reader rule *major must match, minor must
not exceed this build*, implemented as `checkNpslVersions()` with tests.
See `docs/npsl-format.md` §1, §6.

---

### §8 · "Validate before modifying" lacks an atomicity guarantee

**Gap.** The spec says invalid imports must not modify the library, but does
not define partial-failure behaviour (e.g. 500 valid records, 3 invalid).
**Correction (adopted).** All-or-nothing pipeline: parse → schema → version →
semantic → preview → confirm → **single Dexie transaction**; per-record
failures are surfaced in the preview and require an explicit user choice
(skip/fix); a transaction failure rolls back completely. Startup migration
quarantines unparseable records instead of deleting them.
See `docs/validation.md` §5.

---

### §9 · Test matrix mentions "invalid units" and "incompatible units" with no unit module

**Gap.** Same root cause as §4: the required tests cannot be written until a
unit registry exists.
**Correction (adopted).** Unit catalog scheduled before engine implementation
(roadmap phase 2); test matrix updated to include unknown-unit and
cross-dimension cases (`docs/testing.md` §1).

---

### §10 · One-compartment PK: is `C0` an input or derived from dose?

**Gap.** `C(t) = C0·e^(−k·t)` needs `C0`, but the spec's language ("dose →
clinical effect" prohibition) never says where `C0` comes from. Deriving
`C0` from a dose would need route, `F`, `Vd` — parameters the spec forbids
inventing; leaving it unstated invites implementations that compute
`C0 = dose / Vd` silently.
**Correction (adopted).** MVP model takes `C0` as an **explicit input**
(concentration at t = 0). Dose → `C0` conversion is out of scope; if ever
added it must be its own model with `F`, `Vd` and route as required inputs.
See `docs/calculation-engine.md` §4.

---

### §11 · The spec bans occupancy → effect inference but not the *labeling* of model output

**Gap.** Hill output `E` is a mathematical construct scaled by user-provided
`E0`/`Emax`; nothing specifies how it must be labeled, and a bare "Effect:
0.73" reads like a prediction.
**Correction (adopted).** Every model result carries a
`MODEL_RESULT_NOT_CLINICAL` warning plus its assumptions; the UI must render
"model result" labeling alongside outputs; `assumptions`/`warnings` are
mandatory fields of `CalculationResult`, not optional extras.
See `docs/calculation-engine.md` §2–3.

---

### §12 · Kd ≠ Ki is stated as a rule but not as a *mechanism*

**Gap.** Naming rules erode under time pressure ("it's basically the same
thing"). Nothing in the design makes substitution structurally impossible.
**Correction (adopted).** Separate named fields everywhere (domain + schema),
and the occupancy model's input type is declared `kd`-only: a record with
only `ki` produces `MISSING_PARAMETER`. Any future Ki-based model must be a
separate model id with its own formula, assumptions and tests — substitution
can never happen silently inside a model.
See `docs/domain-model.md` §3.

---

### §13 · Provenance for calculator inputs typed by the user is unaddressed

**Gap.** Provenance types assume values live in the library; typed-in
calculator inputs have none. Implementers may label them `user` (inflating
the record) or `literature` (fabricating).
**Correction (adopted).** `CalculationInput.provenance` is **optional**: set
only when the value came from a record; absent for typed values, and the
report distinguishes them explicitly. Typed values are never persisted with a
provenance claim unless the user saves them as user data.
See `docs/calculation-engine.md` §2.

---

### §14 · "Search and filtering" and editing have no schema story

**Gap.** The drug library feature list includes search/filter/CRUD, but the
spec's data layer says nothing about how user edits are validated or how
provenance is *entered* (a free-text field invites fake citations).
**Correction (partially adopted; UX detail open).** All user-editable
structures get Zod schemas next to their types; the literature-provenance
form must have distinct source/citation/DOI/URL fields with `source`
required (`docs/validation.md` §2). *Open:* whether DOI/URL fields are
format-validated strictly or only warned about — to be settled with the
literature-provenance form, which the phase-4 calculator did not include.

---

### §15 · No statement about determinism/versioning of results

**Gap.** Reproducibility is a product goal, but nothing requires a result to
record *which* engine version/model produced it — results computed a year
apart may use different formulas with no way to tell.
**Correction (adopted for stored values).** `calculated` provenance stores
the model id; the calculation report stores the exact formula string.
Model-version stamping of stored results is *deferred* — it needs a results
store, which is out of MVP scope; noted here so it is not forgotten.
**Open (low priority).** Add `engineVersion` to stored calculated provenance
when results can be persisted.

---

### §16 · Phase-1 wording conflict: "do not implement models yet" vs "unit tests for every calculation model"

**Gap.** The architecture brief defers model implementation, while the MVP
testing section demands tests for them. Ordering could be misread as "write
tests for code that does not exist".
**Correction (adopted).** Resolution: models and their test matrix ship
together in phase 2 of the roadmap (`docs/architecture.md` §6), written
test-first. Phase 1 delivers schema tests for what *does* exist.

---

## Summary

| # | Weakness | Status |
| --- | --- | --- |
| 1 | calculated/derived boundary undefined | adopted |
| 2 | no schema field marking demo data | adopted |
| 3 | no encoding for missing parameters | adopted |
| 4 | no unit system | adopted (impl phase 2) |
| 5 | occupancy unit mismatch undefined | adopted |
| 6 | CSV provenance ambiguity | adopted |
| 7 | version field ownership undefined | adopted |
| 8 | import atomicity undefined | adopted |
| 9 | unit tests blocked by missing units | adopted |
| 10 | `C0` derivation ambiguity | adopted |
| 11 | model output labeling undefined | adopted |
| 12 | Kd/Ki rule without mechanism | adopted |
| 13 | provenance for typed inputs | adopted |
| 14 | user-edit validation / citation UX | partly open |
| 15 | result reproducibility stamping | open (deferred) |
| 16 | phase ordering conflict | adopted |
