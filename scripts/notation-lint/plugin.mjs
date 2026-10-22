/**
 * oxlint JS plugin: `notation/no-raw-scientific-notation`.
 *
 * Why a lint rule and not only component tests: a test proves that the labels
 * that exist today render correctly, but it cannot stop the next component from
 * writing `V_c` straight into JSX. This rule rejects the raw text at review
 * time, in the same `npm run lint` step CI already runs.
 *
 * What it inspects (presentation layer only — `src/features`, `src/app`,
 * `src/components`, excluding the renderer itself and test files):
 *   - JSX text children, e.g. `<dt>Reference time t_ref</dt>`
 *   - string values of display attributes (`label`, `title`, `aria-label`, …)
 *   - string values of display object properties (`label: 'Central volume V_c'`)
 *   - string literals passed as JSX children (`{'V_c'}`)
 *
 * What it deliberately does not flag:
 *   - `symbol` attributes/properties: that is the approved notation channel fed
 *     to `<ParameterLabel>` / `<ScientificText>`
 *   - anything inside <code>, <pre>, <samp>, <kbd>
 *   - snake_case identifiers, SCREAMING_SNAKE constants, CSS keywords, drug
 *     names — the base letter must be one of the app's scientific symbols and
 *     must start a token
 *   - engine/domain/data code, which must not carry display strings at all
 */
import {
  CODE_ELEMENTS,
  USER_FACING_ATTRIBUTES,
  USER_FACING_PROPERTIES,
  findRawNotation,
  isNotationTargetFile,
  notationReportMessage,
} from './detect.mjs'

/** Name of a JSX element, or '' for a member expression such as `<a.b>`. */
function elementName(node) {
  const name = node.openingElement?.name
  if (name === undefined || name === null) return ''
  if (name.type === 'JSXIdentifier') return name.name
  return ''
}

/** Name of a JSX attribute, including the dashed aria-* form. */
function attributeName(node) {
  const name = node.name
  if (name === undefined || name === null) return ''
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXNamespacedName') {
    return `${name.namespace?.name ?? ''}:${name.name?.name ?? ''}`
  }
  return ''
}

/**
 * Text of a string literal, a simple template literal, or an expression
 * container wrapping either. `undefined` for anything dynamic — computed text
 * is not this rule's business.
 */
function literalText(node) {
  if (node === undefined || node === null) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral') {
    if ((node.expressions ?? []).length > 0) return undefined
    return (node.quasis ?? []).map((quasi) => quasi.value?.cooked ?? '').join('')
  }
  if (node.type === 'JSXExpressionContainer') return literalText(node.expression)
  return undefined
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw scientific notation (V_c, t_ref, [D]^n) in user-facing text; use ScientificText or the shared parameter metadata.',
    },
  },
  create(context) {
    if (!isNotationTargetFile(context.filename ?? '')) return {}

    /** Elements currently open, so <code>/<pre> subtrees can be skipped. */
    const elements = []
    let attributeDepth = 0

    const insideCode = () => elements.some((name) => CODE_ELEMENTS.has(name))

    const report = (node, text) => {
      for (const hit of findRawNotation(text)) {
        context.report({ node, message: notationReportMessage(hit) })
      }
    }

    return {
      JSXElement(node) {
        elements.push(elementName(node))
      },
      'JSXElement:exit'() {
        elements.pop()
      },
      JSXAttribute(node) {
        attributeDepth += 1
        if (!USER_FACING_ATTRIBUTES.has(attributeName(node))) return
        const text = literalText(node.value)
        if (text !== undefined) report(node, text)
      },
      'JSXAttribute:exit'() {
        attributeDepth -= 1
      },
      JSXText(node) {
        if (insideCode()) return
        report(node, node.value)
      },
      JSXExpressionContainer(node) {
        // Attribute values were already checked by JSXAttribute (which owns the
        // allowlist); only children reach this point.
        if (attributeDepth > 0 || insideCode()) return
        const text = literalText(node)
        if (text !== undefined) report(node, text)
      },
      Property(node) {
        const key = node.key
        const name =
          key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? String(key.value) : ''
        if (name === '' || !USER_FACING_PROPERTIES.has(name)) return
        const text = literalText(node.value)
        if (text !== undefined) report(node, text)
      },
    }
  },
}

export default {
  meta: { name: 'notation' },
  rules: { 'no-raw-scientific-notation': rule },
}
