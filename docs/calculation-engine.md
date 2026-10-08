# Calculation engine

Contract and design rules for the scientific core. The engine is pure,
independently testable and completely decoupled from React, Zustand,
IndexedDB and the DOM.

Implemented contract: `src/engine/types.ts` (phase 1). Model implementations
arrive in phase 2 (`src/engine/pk`, `src/engine/occupancy`,
`src/engine/dose-response`).

---

## 1. Purity rules

A calculation function may:

- accept a plain input object,
- use Decimal.js / `Math` and the unit catalog,
- return a `CalculationReport`.

It may **not**:

- import React, Zustand, Dexie or any browser API,
- read the clock (timestamps are injected by callers, if needed),
- mutate its inputs,
- throw for user-fixable conditions — invalid input is returned as data
  (`ok: false` + errors), so the UI can render it and tests can assert it,
- invent, default or interpolate any pharmacological parameter.

---

## 2. The report — results are never bare numbers

```ts
type CalculationReport =
  | { ok: true;  result: CalculationResult }
  | { ok: false; model: ModelId; errors: readonly CalculationError[] }

interface CalculationResult {
  model: ModelId                 // 'occupancy.single-site'
  modelLabel: string             // 'Single-site receptor occupancy'
  formula: string                // 'Occupancy = [D] / ([D] + Kd)'
  inputs: CalculationInput[]     // symbol, label, value, unit, provenance?
  trace: TraceStep[]             // ordered derivation, inputs → outputs
  outputs: CalculationValue[]    // symbol, label, value, unit
  assumptions: string[]          // model assumptions, always shown
  warnings: CalculationWarning[] // e.g. 'MODEL_RESULT_NOT_CLINICAL'
}
```

Every user-visible result panel is built from exactly these fields:
inputs, formula, intermediates, final result, assumptions, warnings — as
required by the specification.

### Trace steps

```ts
interface TraceStep {
  index: number
  label: string        // 'Elimination constant'
  expression: string   // 'k = ln(2) / t½'
  substituted: string  // 'ln(2) / 6 h'
  result: CalculationValue  // { value, unit }
}
```

The trace is the transparency mechanism: a user must be able to follow a
result from input to output without reading source code. Traces are built by
`src/engine/trace` helpers so every model produces them in the same style.

### Inputs carry provenance

`CalculationInput.provenance` is set when the input came from a library
record (so the report shows *why* that Kd is trusted) and absent for values
typed into the calculator. The report therefore distinguishes literature-backed
and user-typed inputs without assuming either is correct.

---

## 3. Error taxonomy

| Code | Meaning | Example trigger |
| --- | --- | --- |
| `MISSING_PARAMETER` | Required input absent | no `halfLife` in the record |
| `NOT_A_NUMBER` | Input is NaN/±∞ | unparsed form state |
| `NEGATIVE_VALUE` | Negative where impossible | `Kd = -3 nM` |
| `ZERO_NOT_ALLOWED` | Zero divisor/parameter | `EC50 = 0` in Hill model |
| `OUT_OF_RANGE` | Outside model domain | `n ≤ 0`, occupancy inputs producing >100 % |
| `UNKNOWN_UNIT` | Unit not in catalog | `"molars"` |
| `INCOMPATIBLE_UNITS` | Dimension mismatch | `[D]` in `mg/L`, `Kd` in `nM` |
| `MODEL_NOT_APPLICABLE` | Model cannot describe inputs | e.g. inputs imply an unsupported route of administration |

Errors are aggregated (all problems reported at once), each with a
`parameter` symbol so the UI can highlight the offending field.

Warnings (non-fatal) always include, for MVP models:

- `MODEL_RESULT_NOT_CLINICAL` — the result is a mathematical model output,
  not a clinical prediction.
- `MODEL_LIMITATION` — e.g. "One-compartment first-order model; real human
  pharmacokinetics may be multi-compartmental."

---

## 4. Model registry

```ts
interface EngineModel<I> {
  readonly id: ModelId
  readonly label: string
  readonly formula: string
  readonly assumptions: readonly string[]
  calculate(input: I): CalculationReport
}
```

Models are registered in a plain map (`src/engine/registry.ts`, phase 2) so
the calculator's model selector is data-driven — adding a model never requires
editing the calculation UI beyond its input schema.

Planned models and their inputs:

| Model id | Formula | Required inputs | Output |
| --- | --- | --- | --- |
| `pk.first-order-one-compartment` | `C(t) = C0 · e^(−k·t)`, `k = ln(2)/t½` | `C0` (concentration), `t½` (time) or `k`, `t` (time) | concentration at `t`, plus `k` |
| `occupancy.single-site` | `Occupancy = [D] / ([D] + Kd)` | `[D]` ligand concentration, `Kd` | fraction + % |
| `dose-response.hill` | `E = E0 + Emax·[D]^n / (EC50^n + [D]^n)` | `E0`, `Emax`, `EC50`, `n`, `[D]` (or a range) | effect `E` at each point |

Unit expectations are declared per input and checked by
`src/engine/units` (`UNKNOWN_UNIT` / `INCOMPATIBLE_UNITS`).

---

## 5. Curves and the chart boundary

The engine produces chart-agnostic data:

```ts
interface CurveData {
  model: ModelId
  xLabel: string; yLabel: string
  xUnit: string;  yUnit: string
  xScale: 'linear' | 'log'
  yScale: 'linear' | 'log'
  series: CurveSeries[]
}

interface CurveSeries {
  name: string
  seriesType: 'model' | 'observed'   // calculated vs measured data
  points: { x: number; y: number }[]
  xUnit: string; yUnit: string
  provenance?: Provenance
  source?: string
}
```

Flow: `model → generateCurve() → CurveData → chart adapter → Plotly`.

Rules:

- **Plotly never computes pharmacology.** No formula appears in a chart
  component; swapping Plotly for another library touches only the adapter.
- `seriesType` exists from day one so future observed/literature points can
  share a chart with the model curve while remaining visually and semantically
  distinguishable.
- Axis scale defaults: linear time axis for PK (log-y optional, explicit
  control), **log-x default for concentration–response** curves. Scale is a
  chart setting, not a calculation input; changing it re-renders existing
  points and never changes results.

---

## 6. Numerical policy

- Arithmetic that affects displayed values (+, −, ×, ÷, powers, `exp`, `ln`)
  is performed with **Decimal.js** to avoid binary floating-point artifacts in
  traces and results (`docs/decisions.md` §6).
- Results are serialized to `number` in `CalculationValue` at a documented
  precision; the UI formats for display (significant digits per model).
- Curve points may use faster double-precision evaluation: they are
  visualization sampling, not reported values. Reported scalar outputs always
  come from the Decimal path.
- Precision tests assert stability (see [testing.md](testing.md)).

---

## 7. Scientific boundary (enforced by model design)

The engine contains no model that maps:

- dose → clinical effect
- receptor occupancy → subjective effect
- plasma concentration → brain occupancy

such a model would require an explicit validated formulation plus all of its
parameters. Without them, `MODEL_NOT_APPLICABLE` is the answer. The Hill model
outputs `E` — a dimensionless mathematical response scaled by user-supplied
`E0`/`Emax` — and is labeled a model result, never "efficacy".

Adding a future model means: new `EngineModel` implementation, input schema,
assumptions list, warnings, and the full test matrix — not a UI change.
