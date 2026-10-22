/**
 * ParameterLabel is the one place a scientific parameter is turned into
 * user-facing text: notation symbol first, prose name second.
 *
 * It exists so the form label and the validation summary cannot drift apart —
 * both render the same `ParameterLabel` from the same field definition. Call
 * sites must not rebuild "V_c Central volume" strings by hand; a raw
 * underscore in a label is what this component removes.
 *
 * The visible text stays `V` + <sub>c</sub> + " Central volume"; the accessible
 * name spells the subscript out ("V subscript c Central volume") so the
 * distinction survives screen-reader flattening.
 */
import { describeNotation } from './notation'
import { ScientificText } from './ScientificText'

export interface ParameterLabelProps {
  /** Prose name, without notation. */
  readonly label: string
  /** Notation source, for example `V_c` or `A_c(0)`. */
  readonly symbol?: string | undefined
  readonly className?: string
}

export function ParameterLabel({ label, symbol, className }: ParameterLabelProps) {
  if (symbol === undefined || symbol.trim() === '') {
    return (
      <span className={className} data-parameter-label="">
        {label}
      </span>
    )
  }
  return (
    <span className={className} data-parameter-label="">
      <ScientificText
        value={symbol}
        className="font-mono"
        accessibleLabel={describeNotation(symbol)}
      />{' '}
      {label}
    </span>
  )
}
