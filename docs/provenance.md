# Provenance

Provenance answers one question for every scientific value in the
application: **where did this number come from?** It is a first-class part of
the data model, not optional metadata.

Implementation: `src/domain/provenance/provenance.ts` (types) and
`src/data/schemas/npsl.ts` (serialization).

---

## 1. The five states

| `type` | Meaning | Required fields | UI treatment |
| --- | --- | --- | --- |
| `literature` | Taken from a documented source | `source` (non-empty) | Shown as "Literature"; citation/DOI/URL displayed as link when present |
| `user` | Entered or confirmed by the user | — | Shown as "User-provided"; never rendered as verified/authoritative |
| `calculated` | Produced by an engine model | `model` (engine model id) | Shown as "Calculated"; links to the calculation trace |
| `derived` | Recombined from other stored values | `method`, `from` (≥1 source labels) | Shown as "Derived"; shows the derivation rule and sources |
| `unknown` | Origin not known | — | Shown as "Unknown"; honest default for legacy imports |

Additional fields on every variant: optional `notes`; `recordedAt` /
`accessedAt` (ISO 8601) where meaningful.

---

## 2. Rules

1. **Never upgrade provenance.** User-entered data does not become
   `literature` through re-import, editing or calculation. Changing a
   parameter's provenance to `literature` requires the user to actually
   provide a source.
2. **Literature requires a source.** A `literature` provenance without
   `source` fails schema validation — a citation-shaped claim with no
   citation is exactly the failure mode this application exists to prevent.
3. **Calculated values point at their model.** `calculated.model` is a
   `ModelId` such as `pk.first-order-one-compartment`; the full inputs,
   formula and trace live in the calculation report (and, when a result is
   stored, in the record's `notes` or a future results store).
4. **Derived values list their inputs.** `{ method: "k = ln(2)/t½",
   from: ["halfLife"] }` — enough to see the rule and where it came from, even
   without re-running anything.
5. **`unknown` is always acceptable.** Forcing a provenance guess would be
   inventing information.
6. **Demo data is marked at two levels**: per-record `origin:
   'built-in-demo'` and per-library `dataStatus: 'example'` (see
   [domain-model.md](domain-model.md) §5).
7. **Unchanged parameters keep their provenance through edits.** The edit
   form compares every parameter against the stored record by stable
   target id and parameter kind: when the emitted value is `Object.is`-equal
   to the stored one — either because the draft still reads the source's
   own textual representation, so the stored number is submitted verbatim
   (relevant for display-lossy values such as `-0`, which the input shows
   as `"0"`, audit DI-04), or because the parsed draft is `Object.is`-equal
   — and the unit string is identical, the **complete**
   provenance object — every field, unknown extension keys included — is
   written back untouched (same object, never rebuilt or mutated).
   Editing name, synonyms, tags or notes therefore never rewrites the
   provenance of a parameter that did not change. Only a parameter whose
   value or unit actually changed, a newly added parameter, or a parameter
   whose kind changed receives the normal user-entry stamp
   `{ "type": "user", "recordedAt": … }`; parameters are matched by
   identity, never by array position, display name or row order. A
   *changed* value may still carry unknown provenance-level extension
   fields forward — that is the storage layer's lossless unknown-field
   rule (ADR-14), not a provenance rewrite: contract fields are governed
   by the new domain value.
8. **Imported source records carry their own attribution, and applied
   parameters keep it (phase 18).** Layer A/B records store
   `SourceAttribution` (`source`, `recordId`, `url`, `retrievedAt`,
   `licenseNotice?`, `licenseUrl?`, `recordUrl?`) — the source, the exact
   record id, a working link, the retrieval time and the license/term
   notice the adapter reports (ChEMBL: CC BY-SA 3.0 with attribution URL;
   PubChem: aggregation notice pointing at the downloads page). When a
   stored observation is promoted onto a drug parameter (Layer C), the
   written `literature` provenance sets `source` to the source name, the
   record URL in `url`, the retrieval time in `accessedAt` and the
   observation's id in `observationId` — the parameter is permanently
   traceable back to the exact stored measurement, in the database and in
   `.npsl` round trips (`observationId` is a recognized provenance field).

---

## 3. Where provenance appears

- **Domain**: inside every `ScientificValue` — provenance is part of the
  value, not a parallel field that can drift.
- **Files**: nested object per parameter in `.npsl`; preserved verbatim on
  import/export (round-trip tested). CSV export flattens it to columns —
  see [validation.md](validation.md) §7 for exactly what survives.
- **Calculator**: echoed per input in `CalculationInput.provenance`, so the
  report distinguishes literature-backed parameters from typed-in ones.
- **Charts**: `CurveSeries.provenance` + `seriesType: 'model' | 'observed'`
  distinguish calculated curves from measured points.
- **UI**: a consistent provenance badge component (phase 3,
  `src/features/drug-library/components/ProvenanceBadge.tsx`) renders the
  five states with text labels — never color alone (accessibility), never an
  emoji (design rule).
- **Source records (phase 18)**: every imported compound and observation
  row shows its attribution line — source, record link, retrieval date,
  license notice — in the stored-data panel, and the same attribution
  travels with the record through export.

---

## 4. What provenance does *not* do

- It does not rank values by trustworthiness or auto-select "the best" value.
- It does not make a user value authoritative by repetition.
- It does not get dropped when data is transformed: serialization that cannot
  represent provenance must either widen the format (CSV columns) or declare
  the loss to the user before export.
