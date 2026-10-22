/**
 * ScientificText renders trusted scientific notation with native, semantic
 * <sub> and <sup> elements. It never uses dangerouslySetInnerHTML and never
 * interprets a string as HTML.
 *
 * Call sites are responsible for the trust boundary: use this for
 * application-authored symbols, equations, trace expressions and known
 * molecular formulas only. Drug names, descriptions, notes, user values,
 * free text and imported source identifiers must be rendered as plain text.
 */
import type { NotationMode } from './notation'
import { parseNotation } from './notation'

export interface ScientificTextProps {
  readonly value: string
  readonly mode?: NotationMode
  readonly className?: string
}

export function ScientificText({ value, mode = 'math', className }: ScientificTextProps) {
  const tokens = parseNotation(value, mode)
  return (
    <span className={className} data-notation-mode={mode}>
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
