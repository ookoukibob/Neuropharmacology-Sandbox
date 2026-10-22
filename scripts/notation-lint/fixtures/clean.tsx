/**
 * Fixture: text the rule must leave alone.
 *
 * Identifiers, constants, CSS keywords, drug names, code samples and the
 * approved rendering channels all live here. A test lints this file and asserts
 * zero findings, so a future widening of the pattern that starts flagging
 * ordinary code fails immediately.
 */
export const SNAKE_CASE = 'snake_case'
export const CONSTANTS = { PK_KEYS: 'PK_KEYS', NO_ERRORS: 'NO_ERRORS', mw_freebase: 'mw_freebase' }
export const CSS = 'color-mix(in_oklch, var(--a), var(--b))'
export const NAME = 'Synthetic Fixture Compound'
export const DRUG = 'Midazolam'
export const FORMULA = 'C12H14N2O'

/** Identifiers in prose stay as they are written. */
export const Prose = () => (
  <p>
    The sample_id and drug_name columns are stored verbatim; see the PK_KEYS constants and the
    COVID19 fixture for examples.
  </p>
)

/** Code samples are allowed to show literal characters. */
export const CodeSample = () => (
  <pre>
    <code>V_c</code> <code>t_ref</code>
  </pre>
)

/** The approved channels: a rendered symbol, a metadata label, a plain symbol prop. */
export const Approved = () => (
  <div>
    <ScientificText value="V_c" accessibleLabel="V subscript c" />
    <ParameterLabel label="Central volume" symbol="V_c" />
    <label htmlFor="x" data-symbol="V_c">
      Central volume
    </label>
  </div>
)
