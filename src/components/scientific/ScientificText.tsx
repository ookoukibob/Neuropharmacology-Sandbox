/**
 * ScientificText renders trusted scientific notation with native, semantic
 * <sub> and <sup> elements. It never uses dangerouslySetInnerHTML and never
 * interprets a string as HTML.
 *
 * Call sites are responsible for the trust boundary: use this for
 * application-authored symbols, equations, trace expressions and known
 * molecular formulas only. Drug names, descriptions, notes, user values,
 * free text and imported source identifiers must be rendered as plain text.
 *
 * Accessibility: pass `accessibleLabel` when the notation's shape carries
 * meaning that baseline text alone would lose (a subscript read as an ordinary
 * letter). The element then exposes a `role="math"` name such as
 * "V subscript c" while the visible markup stays unchanged.
 */
import type { NotationMode } from './notation'
import { parseNotation } from './notation'

export interface ScientificTextProps {
  readonly value: string
  readonly mode?: NotationMode
  readonly className?: string
  /**
   * Spoken form of `value` (see `describeNotation`). When omitted the element
   * has no explicit accessible name and its text content is used as before.
   */
  readonly accessibleLabel?: string
}

export function ScientificText({
  value,
  mode = 'math',
  className,
  accessibleLabel,
}: ScientificTextProps) {
  const tokens = parseNotation(value, mode)
  const accessibility =
    accessibleLabel === undefined ? {} : ({ role: 'math', 'aria-label': accessibleLabel } as const)
  return (
    <span className={className} data-notation-mode={mode} {...accessibility}>
      {tokens.map((token, index) => {
        if (token.kind === 'sub') {
          return <sub key={index}>{token.value}</sub>
        }
        if (token.kind === 'sup') {
          return <sup key={index}>{token.value}</sup>
        }
        return token.value
      })}
    </span>
  )
}
