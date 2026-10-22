import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScientificText } from './ScientificText'

describe('ScientificText', () => {
  it('renders native sub and sup elements without injecting markup', () => {
    const { container } = render(<ScientificText value="K_d · e^(−k·t)" />)
    const root = container.firstElementChild

    expect(root?.tagName).toBe('SPAN')
    expect(root?.getAttribute('data-notation-mode')).toBe('math')
    expect(root?.querySelector('sub')).toHaveTextContent('d')
    expect(root?.querySelector('sup')).toHaveTextContent('(−k·t)')
    expect(root?.textContent).toBe('Kd · e(−k·t)')
    expect(root?.querySelector('script')).toBeNull()
    expect(root?.innerHTML).not.toContain('&lt;')
  })

  it('renders the Hill formula with both index kinds', () => {
    const { container } = render(
      <ScientificText value="E = E0 + (Emax · [D]^n) / (EC50^n + [D]^n)" />,
    )
    const formula = container.firstElementChild

    expect(formula?.textContent).toBe('E = E0 + (Emax · [D]n) / (EC50n + [D]n)')
    expect(formula?.querySelectorAll('sub')).toHaveLength(3)
    expect(formula?.querySelectorAll('sup')).toHaveLength(3)
    expect(
      [...(formula?.querySelectorAll('sub') ?? [])].map((element) => element.textContent),
    ).toEqual(['0', 'max', '50'])
    expect(
      [...(formula?.querySelectorAll('sup') ?? [])].map((element) => element.textContent),
    ).toEqual(['n', 'n', 'n'])
  })

  it('formats molecular formulas only in chemical mode', () => {
    const { container } = render(
      <>
        <ScientificText value="C12H14N2O" />
        <ScientificText value="C12H14N2O" mode="chemical" />
      </>,
    )
    const [math, chemicalFormula] = [...container.querySelectorAll('span')]

    expect(math?.querySelectorAll('sub')).toHaveLength(0)
    expect(math?.textContent).toBe('C12H14N2O')
    expect(chemicalFormula?.querySelectorAll('sub')).toHaveLength(3)
    expect(chemicalFormula?.textContent).toBe('C12H14N2O')
  })

  it('leaves ordinary prose and drug names unchanged', () => {
    render(<ScientificText value="Midazolam is a synthetic fixture, not C12H14N2O." />)
    const text = screen.getByText('Midazolam is a synthetic fixture, not C12H14N2O.')
    expect(text.querySelectorAll('sub, sup')).toHaveLength(0)
  })

  it('passes className through and handles empty input', () => {
    const { container } = render(<ScientificText value="" className="font-mono" />)
    const root = container.firstElementChild

    expect(root).toHaveClass('font-mono')
    expect(root?.textContent).toBe('')
    expect(root?.childElementCount).toBe(0)
  })
})
