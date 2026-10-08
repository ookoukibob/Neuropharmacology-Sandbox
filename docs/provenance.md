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

---

## 3. Where provenance appears

- **Domain**: inside every `ScientificValue` — provenance is part of the
  value, not a parallel field that can drift.
- **Files**: nested object per parameter in `.npsl`; preserved verbatim on
  import/export (round-trip tested). CSV export flattens it to columns —
  see [validation.md](validation.md) §5 for exactly what survives.
- **Calculator**: echoed per input in `CalculationInput.provenance`, so the
  report distinguishes literature-backed parameters from typed-in ones.
- **Charts**: `CurveSeries.provenance` + `seriesType: 'model' | 'observed'`
  distinguish calculated curves from measured points.
- **UI**: a consistent provenance badge component (phase 3,
  `src/features/drug-library/components/ProvenanceBadge.tsx`) renders the
  five states with text labels — never color alone (accessibility), never an
  emoji (design rule).

---

## 4. What provenance does *not* do

- It does not rank values by trustworthiness or auto-select "the best" value.
- It does not make a user value authoritative by repetition.
- It does not get dropped when data is transformed: serialization that cannot
  represent provenance must either widen the format (CSV columns) or declare
  the loss to the user before export.
