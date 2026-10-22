import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ParameterLabel } from './ParameterLabel'

/**
 * These tests assert on the DOM, not on source strings: the defect this module
 * exists for was text that *looked* right in the source and rendered as
 * `V_c` on screen. Every assertion therefore looks for a real <sub> element.
 */
describe('ParameterLabel — scientific parameters', () => {
  it('renders central volume as V with a real <sub>c</sub>', () => {
    const { container } = render(<ParameterLabel label="Central volume" symbol="V_c" />)
    const root = container.firstElementChild

    expect(root?.textContent).toBe('Vc Central volume')
    expect(root?.querySelectorAll('sub')).toHaveLength(1)
    expect(root?.querySelector('sub')).toHaveTextContent('c')
    expect(root?.textContent).not.toContain('V_c')
  })

  it('renders peripheral volume as V with a real <sub>p</sub>', () => {
    const { container } = render(<ParameterLabel label="Peripheral volume" symbol="V_p" />)
    const root = container.firstElementChild

    expect(root?.querySelectorAll('sub')).toHaveLength(1)
    expect(root?.querySelector('sub')).toHaveTextContent('p')
    expect(root?.textContent).toBe('Vp Peripheral volume')
  })

  it('keeps (0) on the baseline after an initial-amount subscript', () => {
    const { container } = render(
      <>
        <ParameterLabel label="Initial central amount" symbol="A_c(0)" />
        <ParameterLabel label="Initial peripheral amount" symbol="A_p(0)" />
      </>,
    )
    const [central, peripheral] = [...container.querySelectorAll('[data-parameter-label]')]

    expect(central?.querySelectorAll('sub')).toHaveLength(1)
    expect(central?.querySelector('sub')).toHaveTextContent('c')
    // The parenthesis must NOT be inside the subscript: A<sub>c</sub>(0).
    expect(central?.textContent).toBe('Ac(0) Initial central amount')
    expect(central?.querySelector('sub')?.textContent).not.toContain('(0)')

    expect(peripheral?.querySelector('sub')).toHaveTextContent('p')
    expect(peripheral?.textContent).toBe('Ap(0) Initial peripheral amount')
  })

  it('spells the subscript out for assistive technologies', () => {
    const { container } = render(<ParameterLabel label="Central volume" symbol="V_c" />)

    const math = container.querySelector('[role="math"]')
    expect(math).toHaveAttribute('aria-label', 'V subscript c')
    expect(container.textContent).toContain('Central volume')
  })

  it('leaves a label without a symbol as plain text', () => {
    const { container } = render(<ParameterLabel label="Output interval (h)" />)
    const root = container.firstElementChild

    expect(root?.textContent).toBe('Output interval (h)')
    expect(root?.querySelectorAll('sub, sup')).toHaveLength(0)
  })

  it('does not reinterpret ordinary words or identifiers in the prose label', () => {
    const { container } = render(
      <ParameterLabel label="Molecular-weight provenance" symbol="K_d" />,
    )
    const root = container.firstElementChild

    expect(root?.textContent).toBe('Kd Molecular-weight provenance')
    expect(root?.textContent).not.toContain('Molecular-weight provenance'.replace('-', '_'))
    expect(root?.querySelectorAll('sub')).toHaveLength(1)
  })
})
