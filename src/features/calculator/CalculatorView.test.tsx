/**
 * CalculatorView structure, keyboard and validation tests (phase 6).
 *
 * These cover what the engine/store tests do not: the page's heading
 * hierarchy, the keyboard-operable PK parameterization radio group
 * (roving tab stop + arrow keys) and the way an invalid Calculate press
 * reaches the user. Scientific behaviour is covered by the store,
 * modelAdapters and engine suites — every value here is synthetic.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { useCalculatorStore } from '@/app/calculatorStore'
import { CalculatorView } from './CalculatorView'

function renderCalculator(path = '/calculator'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <CalculatorView />
    </MemoryRouter>,
  )
}

/** Router location as the test sees it after flushing effects. */
const router: { location: ReturnType<typeof useLocation> | null } = { location: null }

function LocationSpy(): null {
  const location = useLocation()
  useEffect(() => {
    router.location = location
  }, [location])
  return null
}

/** Changes the store's model from an effect — used to land a change while the
 *  view's own `?model=` write is still in flight (the URL race under test). */
function ChangeModelOnMount({ model }: { model: 'pk.first-order-one-compartment' | 'occupancy.single-site' }): null {
  useEffect(() => {
    useCalculatorStore.getState().setModel(model)
  }, [model])
  return null
}

describe('CalculatorView heading hierarchy', () => {
  it('presents its sections as level-2 headings before any result exists', () => {
    renderCalculator()

    expect(screen.getByRole('heading', { level: 2, name: 'Inputs' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Result' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Visualization' }),
    ).toBeInTheDocument()
    // No deeper heading appears before a level-2 section heading exists.
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument()
  })
})

describe('CalculatorView PK parameterization keyboard control', () => {
  it('applies a deep-linked model from the URL and converges with the URL sync', () => {
    // Regression: the URL→store and store→URL syncs used to overwrite each
    // other forever when the linked model differed from the store default.
    renderCalculator('/calculator?model=pk.first-order-one-compartment')

    expect(useCalculatorStore.getState().draft.model).toBe('pk.first-order-one-compartment')
    expect(screen.getByTestId('pk-mode-toggle')).toBeInTheDocument()
  })

  function radios(): { group: HTMLElement; halfLife: HTMLElement; k: HTMLElement } {
    return {
      group: screen.getByRole('radiogroup', { name: 'PK parameterization' }),
      halfLife: screen.getByTestId('pk-mode-halfLife'),
      k: screen.getByTestId('pk-mode-k'),
    }
  }

  it('starts on a single tab stop: the checked radio is focusable, the other is not', () => {
    renderCalculator('/calculator?model=pk.first-order-one-compartment')

    const { group, halfLife, k } = radios()
    expect(group).toBeInTheDocument()
    expect(halfLife).toHaveAttribute('aria-checked', 'true')
    expect(halfLife).toHaveAttribute('tabindex', '0')
    expect(k).toHaveAttribute('aria-checked', 'false')
    expect(k).toHaveAttribute('tabindex', '-1')
  })

  it('switches parameterization with the arrow keys and follows the focus', () => {
    renderCalculator('/calculator?model=pk.first-order-one-compartment')

    const { halfLife } = radios()
    fireEvent.keyDown(halfLife, { key: 'ArrowRight' })

    expect(screen.getByTestId('pk-mode-k')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('pk-mode-k')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('pk-mode-halfLife')).toHaveAttribute('tabindex', '-1')
    expect(document.activeElement).toBe(screen.getByTestId('pk-mode-k'))

    // The previously checked radio keeps the arrow handler: ArrowLeft moves
    // the selection back to the half-life parameterization.
    fireEvent.keyDown(screen.getByTestId('pk-mode-k'), { key: 'ArrowLeft' })
    expect(screen.getByTestId('pk-mode-halfLife')).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(screen.getByTestId('pk-mode-halfLife'))
  })

  it('ignores keys that do not move a radio group', () => {
    renderCalculator('/calculator?model=pk.first-order-one-compartment')

    const { halfLife } = radios()
    fireEvent.keyDown(halfLife, { key: 'a' })

    expect(screen.getByTestId('pk-mode-halfLife')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('pk-mode-k')).toHaveAttribute('aria-checked', 'false')
  })

  it('activates the inactive radio with Enter (native button behaviour)', () => {
    renderCalculator('/calculator?model=pk.first-order-one-compartment')

    const { k } = radios()
    fireEvent.keyDown(k, { key: 'Enter' }) // the group handler leaves Enter alone
    fireEvent.click(k)

    expect(screen.getByTestId('pk-mode-k')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('pk-mode-k')).toHaveAttribute('tabindex', '0')
  })
})

describe('CalculatorView invalid-input feedback', () => {
  it('reports schema errors on the fields when Calculate runs with empty inputs', () => {
    renderCalculator('/calculator?model=pk.first-order-one-compartment')
    useCalculatorStore.getState().resetInputs()

    fireEvent.click(screen.getByTestId('calculate-btn'))

    // Every invalid field carries an announced, associated error…
    const error = screen.getByTestId('error-c0')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error.id).toBe('calc-c0-error')
    expect(screen.getByTestId('error-time')).toBeInTheDocument()
    expect(screen.getByTestId('error-halfLife')).toBeInTheDocument()

    const input = screen.getByTestId('input-c0-value')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', 'calc-c0-error')

    // …and the press is visibly blocked rather than silently ignored.
    expect(screen.queryByTestId('result-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('calculation-errors')).not.toBeInTheDocument()

    // Editing the field clears its schema error again (validation recovery).
    fireEvent.change(screen.getByTestId('input-c0-value'), { target: { value: '100' } })
    expect(screen.queryByTestId('error-c0')).not.toBeInTheDocument()
    expect(screen.getByTestId('input-c0-value')).toHaveAttribute('aria-invalid', 'false')

    useCalculatorStore.getState().resetInputs()
  })
})

describe('CalculatorView URL synchronisation', () => {
  it('converges on the store when a model change lands during its own URL write', () => {
    const initial = useCalculatorStore.getState().draft.model
    const other =
      initial === 'pk.first-order-one-compartment'
        ? 'occupancy.single-site'
        : 'pk.first-order-one-compartment'

    render(
      <MemoryRouter initialEntries={['/calculator']}>
        <LocationSpy />
        <CalculatorView />
        {/* Effects run in tree order, so the model changes right after the
            view has pushed its own `?model=` write: the store must win over
            that write and the URL must then converge on the store. The
            browser race this guards needs interleaved history commits that
            jsdom flushes in one batch, so this asserts the resulting
            invariant, not the timing window itself. */}
        <ChangeModelOnMount model={other} />
      </MemoryRouter>,
    )

    expect(useCalculatorStore.getState().draft.model).toBe(other)
    expect(router.location?.search).toBe(`?model=${other}`)
  })
})
