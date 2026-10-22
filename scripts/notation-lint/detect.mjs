/**
 * Detection rules for the `notation/no-raw-scientific-notation` lint rule.
 *
 * Kept separate from the rule itself so the decisions can be unit-tested
 * without an AST: what counts as notation, where the rule applies, and how a
 * finding is explained to the developer.
 *
 * The narrowness is deliberate. A `\w+_\w+` pattern would flag `snake_case`,
 * `PK_KEYS`, `mw_freebase` and every CSS keyword with an underscore, so the
 * base letters are an explicit allowlist that mirrors the parser in
 * `src/components/scientific/notation.ts` (`NOTATION_UNDERSCORE_BASES`). That
 * mirror is asserted by `parity.test.mjs`.
 */

/** Base letters the application writes with an underscore subscript. */
export const NOTATION_BASES = ['A', 'C', 'E', 'K', 'R', 'V', 'f', 'k', 't']

/**
 * JSX attributes whose string value reaches the screen as visible copy.
 * `symbol` is intentionally absent: passing a notation source to
 * `<ParameterLabel>` / `<ScientificText>` is the approved channel.
 */
export const USER_FACING_ATTRIBUTES = new Set([
  'label',
  'title',
  'description',
  'placeholder',
  'help',
  'hint',
  'caption',
  'heading',
  'aria-label',
  'aria-description',
  'alt',
])

/** Object keys whose string value is display copy in the presentation layer. */
export const USER_FACING_PROPERTIES = new Set([
  'label',
  'title',
  'description',
  'placeholder',
  'heading',
  'caption',
])

/** Elements whose whole purpose is to show text literally. */
export const CODE_ELEMENTS = new Set(['code', 'pre', 'samp', 'kbd'])

const SUBSCRIPT = new RegExp(
  `(?<![A-Za-z0-9_])(?:d)?([${NOTATION_BASES.join('')}]_[A-Za-z0-9]+)(?![A-Za-z0-9_])`,
  'g',
)

/**
 * Files the rule applies to: all application source. Engine, domain and data
 * code is included on purpose — those layers must not carry display strings at
 * all, so notation appearing there is a defect too (it would be rendered
 * verbatim by whichever component prints it).
 */
const TARGET_FILE = /(?:^|[\\/])src[\\/]/

/**
 * Files that are legitimately full of notation: the renderer, its parser and
 * the approved label component; tests that assert on raw strings; fixtures and
 * test helpers.
 */
const EXEMPT_FILE =
  /(?:^|[\\/])src[\\/]components[\\/]scientific[\\/]|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|[\\/](?:__)?(?:fixtures|tests|__tests__)[\\/]/

/** True when `filename` is a file this rule should inspect. */
export function isNotationTargetFile(filename) {
  if (typeof filename !== 'string' || filename === '') return false
  const normalized = filename.replace(/\\/g, '/')
  return TARGET_FILE.test(normalized) && !EXEMPT_FILE.test(normalized)
}

/**
 * Every raw notation occurrence in `text`.
 *
 * Two shapes are detected, both of which render as literal characters in the
 * DOM: an underscore subscript (`V_c`, `A_c(0)`, `t_ref`, `k_e0`) and a caret
 * exponent (`[D]^n`). Ordinary words, identifiers and drug names produce
 * nothing.
 *
 * @param {string} text
 * @returns {ReadonlyArray<{ start: number, end: number, text: string, kind: 'subscript' | 'superscript' }>}
 */
export function findRawNotation(text) {
  if (typeof text !== 'string' || text === '') return []
  /** @type {Array<{ start: number, end: number, text: string, kind: 'subscript' | 'superscript' }>} */
  const hits = []

  for (const match of text.matchAll(SUBSCRIPT)) {
    const full = match[0]
    const symbol = match[1]
    const offset = match.index ?? 0
    const symbolStart = full.lastIndexOf(symbol)
    hits.push({
      start: offset + symbolStart,
      end: offset + symbolStart + symbol.length,
      text: symbol,
      kind: 'subscript',
    })
  }

  for (let index = 1; index < text.length - 1; index += 1) {
    if (text.charAt(index) !== '^') continue
    if (/\s/.test(text.charAt(index - 1))) continue
    if (/\s/.test(text.charAt(index + 1))) continue

    // The exponent ends at the first character that cannot be part of it, so
    // `[D]^n)` reports "^n" rather than swallowing the closing bracket.
    let end = index + 1
    if (text.charAt(end) === '(') {
      let depth = 0
      for (let cursor = end; cursor < text.length; cursor += 1) {
        const char = text.charAt(cursor)
        if (char === '(') depth += 1
        if (char === ')') {
          depth -= 1
          if (depth === 0) {
            end = cursor + 1
            break
          }
        }
      }
      if (depth > 0) continue
    } else {
      while (end < text.length && /[A-Za-z0-9.+−-]/.test(text.charAt(end))) end += 1
    }
    hits.push({ start: index, end, text: text.slice(index, end), kind: 'superscript' })
  }

  return hits.sort((a, b) => a.start - b.start)
}

/**
 * Developer-facing explanation. It names the fix rather than just the fault:
 * the shared renderer for a one-off symbol, the shared metadata for a form
 * field, and the explicit escape hatches.
 */
export function notationReportMessage(hit) {
  const fix =
    hit.kind === 'superscript'
      ? 'Render the expression with <ScientificText> (src/components/scientific) so the exponent ' +
        'becomes a real <sup>.'
      : `Render it with <ScientificText value="${hit.text}" /> (src/components/scientific), or take ` +
        'the label from src/features/simulation/parameterFields.ts and render <ParameterLabel />.'
  return (
    `Raw scientific notation "${hit.text}" would render literally. ${fix} ` +
    'Identifiers and code samples belong in <code>/<pre>, or add an ' +
    '"oxlint-disable-next-line notation/no-raw-scientific-notation" comment with a reason.'
  )
}
