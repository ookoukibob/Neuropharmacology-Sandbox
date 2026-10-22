# Scientific notation: one renderer, one source of labels, one guard

How the application writes `V` with a subscript `c`, and how that is kept from
regressing into a literal `V_c` on screen.

## 1. The defect class

Scientific notation is written in source as ASCII (`V_c`, `A_c(0)`, `K_d`,
`[D]^n`). Browsers render that text literally unless the subscript is a real
`<sub>` element. A fix that only touches the component in front of the reviewer
leaves the rest of the application — and every future component — free to print
the raw string.

Three separate mechanisms produced the recurrence:

1. **The renderer was a component, not a convention.** `ScientificText` existed
   after #37, but nothing required a new label to use it.
2. **Labels were duplicated.** A form control passed `symbol="V_c"` and the
   validation layer independently carried `label: 'Central volume V_c'`. The
   first copy went through the renderer, the second was printed raw into the
   error summary. Fixing one copy left the other.
3. **Notation lived in non-rendering layers.** Engine and domain modules carried
   display strings (`'Central volume V_c'`) that were interpolated into plain
   text messages and rendered verbatim.

## 2. The convention

| Layer | Rule |
| --- | --- |
| `src/components/scientific/notation.ts` | Parses ASCII notation into typed tokens (`text`, `sub`, `sup`). Never produces HTML. |
| `src/components/scientific/ScientificText.tsx` | Renders those tokens as native `<sub>`/`<sup>`. The only component allowed to interpret notation. |
| `src/components/scientific/ParameterLabel.tsx` | Composes "symbol + prose name" for a parameter. The only place a field label is built. |
| `src/features/simulation/parameterFields.ts` | Single source of truth for the editor's parameter metadata: stable `id`, prose `label`, optional notation `symbol`. |
| Validation (`draft.ts`, `outputGrid.ts`, engine) | Returns an **identifier** (`field`) plus a sentence that does **not** repeat the parameter name. No JSX, no labels. |
| Presentation layer | Resolves `field` → metadata (`fieldSubject`) and renders `<ParameterLabel>`; prints the message as its own sentence. |

Notation therefore appears in exactly two places: the parser (`notation.ts`) and
the metadata (`parameterFields.ts`). Every visible symbol goes through
`ScientificText`.

### Adding a parameter

1. Add an entry to `SIMULATION_FIELDS` with a prose `label` and, if the symbol
   needs an index, a `symbol` written as it would be typed (`V_c`).
2. Render the control with `<ParameterLabel label={…label} symbol={…symbol} />`
   (the field primitives in `components/fields.tsx` already do this).
3. Emit validation errors with the field `id` only. Do not pass a label.

### Accessibility

`ParameterLabel` passes a spoken form (`describeNotation`) to `ScientificText`,
which exposes it as `role="math"` + `aria-label`. `V_c` is announced as
"V subscript c", so the distinction between `V_c` and `V_p` survives
screen-reader flattening. The visible markup is unchanged.

## 3. The guard

`notation/no-raw-scientific-notation` (`scripts/notation-lint/plugin.mjs`) is an
oxlint JS plugin registered in `.oxlintrc.json`, so it runs inside the existing
`npm run lint` step and therefore inside CI.

It reports:

- JSX text containing notation: `<dt>Reference time t_ref</dt>`
- string values of display attributes: `label`, `title`, `description`,
  `placeholder`, `help`, `hint`, `caption`, `heading`, `aria-label`,
  `aria-description`, `alt`
- string values of display object properties: `label`, `title`, `description`,
  `placeholder`, `heading`, `caption`
- string literals used as JSX children: `{'V_c'}`

It understands two shapes: underscore subscripts over an explicit base-letter
allowlist (`A C E K R V f k t`, mirroring `NOTATION_UNDERSCORE_BASES`), and
caret exponents.

### What it deliberately does not do

- **No generic `\w+_\w+` pattern.** `snake_case`, `PK_KEYS`, `NO_ERRORS`,
  `mw_freebase` and `in_oklch` are not notation, and are covered by tests.
- **`symbol` is an approved channel.** It is by definition the notation source
  handed to the renderer.
- **`<code>`, `<pre>`, `<samp>`, `<kbd>` subtrees are skipped.** Code samples are
  meant to show literal characters.
- **Tests, fixtures and the renderer itself are exempt**
  (`src/components/scientific/**`, `*.test.*`, `*.spec.*`, `tests/`, `fixtures/`).
- **Dynamic strings are not analysed.** `{model.formula}` cannot be checked
  statically; that is why the model-comparison formulas are wrapped in
  `ScientificText` by hand and pinned by view tests. This is the rule's main
  limitation and it is accepted deliberately: the alternative is a heuristic
  that flags ordinary code.

An inline escape exists for the rare legitimate case:

```tsx
{/* oxlint-disable-next-line notation/no-raw-scientific-notation -- shows the raw wire format */}
<span>V_c</span>
```

It should be accompanied by a reason, and review should treat it as a smell.

## 4. Tests

| Test | What it proves |
| --- | --- |
| `notation.test.ts` | Parser rules: subscripts vs exponents, safe failure on malformed input, identifiers untouched. |
| `ScientificText.test.tsx` | Tokens become `<sub>`/`<sup>`; no HTML injection. |
| `ParameterLabel.test.tsx` | `V_c` → `V<sub>c</sub>`, `V_p` → `V<sub>p</sub>`, `A_c(0)` keeps `(0)` on the baseline, accessible name spells the subscript. |
| `parameterFields.test.ts` | Labels carry no notation; symbols are where notation lives; field paths resolve. |
| `ScenarioSections.test.tsx` | The form label and the error summary render the same `<sub>` markup; the summary does not repeat the parameter name. |
| `scripts/notation-lint/detect.test.mjs` | Detection accepts identifiers and rejects notation. |
| `scripts/notation-lint/rule.test.mjs` | The real oxlint binary, with the real plugin config, fails a fixture of raw notation and passes a fixture of identifiers, code samples and approved channels. |
| `scripts/notation-lint/parity.test.mjs` | The lint allowlist and the parser allowlist are identical. |
| `e2e/scientificNotation.spec.ts` | Chromium: the validation summary's label and the field label carry the same `<sub>`, at desktop and narrow widths. |
