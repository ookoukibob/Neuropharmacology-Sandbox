/**
 * Fixture: every user-facing shape that must be rejected.
 *
 * This file is never imported or built — a test lints it and asserts that the
 * rule reports each of these. When adding a new shape the rule must catch, add
 * it here rather than relying on the real tree to still contain a mistake.
 */
/** Central volume V_c written straight into JSX text. */
export const RawJsxText = () => (
  <dl>
    <dt>Reference time t_ref</dt>
    <dd>Initial amount A_c(0) is fixed</dd>
  </dl>
)

/** A display attribute carrying notation instead of rendering it. */
export const RawAttribute = () => <p title="Peripheral volume V_p">hover me</p>

/** A string literal child. */
export const RawChildExpression = () => <span>{'K_d in mg/L'}</span>

/** An object property that feeds a summary or a table. */
export const RAW_LABELS = {
  label: 'Central volume V_c',
  description: 'Elimination rate k_e0',
}

/** A caret exponent is equally broken as literal text. */
export const RawExponent = () => <p>Occupancy is [D]^n over (EC50^n + [D]^n)</p>

/** The approved renderer is the fix, shown here to keep the contrast clear. */
export const Rendered = () => <ScientificText value="V_c" />
