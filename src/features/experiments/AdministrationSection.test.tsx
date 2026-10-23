import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AdministrationMetadata } from '@/domain/experiments/experimental-dataset'
import { AdministrationSection } from './AdministrationSection'

function renderSection(administration?: AdministrationMetadata, onSave = vi.fn().mockResolvedValue(true)) {
  render(<AdministrationSection administration={administration} busy={false} onSave={onSave} />)
  return onSave
}

describe('AdministrationSection', () => {
  it('displays an explicit unknown context when no metadata is recorded', () => {
    renderSection()
    expect(screen.getByTestId('administration-unknown')).toHaveTextContent(/route, dose, regimen and time origin are unknown/i)
  })

  it('displays known and partially known administration contexts', () => {
    renderSection({
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
      dose: { value: 100, unit: 'mg' },
    })
    const summary = screen.getByTestId('administration-summary')
    expect(summary).toHaveTextContent('IV bolus')
    expect(summary).toHaveTextContent('Single dose')
    expect(summary).toHaveTextContent('100 mg')
    // Partially known: dose is present but infusion and bioavailability are not.
    expect(summary).toHaveTextContent('Unknown')
    expect(summary).toHaveTextContent('Dose administration time')
  })

  it('saves a newly entered administration context', () => {
    const onSave = renderSection()
    fireEvent.click(screen.getByTestId('administration-edit'))
    fireEvent.change(screen.getByTestId('administration-route'), { target: { value: 'iv-bolus' } })
    fireEvent.change(screen.getByTestId('administration-regimen'), { target: { value: 'single-dose' } })
    fireEvent.change(screen.getByTestId('administration-time-reference'), { target: { value: 'dose-time' } })
    fireEvent.change(screen.getByTestId('administration-dose'), { target: { value: '100' } })
    fireEvent.click(screen.getByTestId('administration-save'))

    expect(onSave).toHaveBeenCalledWith({
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
      dose: { value: 100, unit: 'mg' },
    })
  })

  it('shows validation errors and does not save an invalid infusion', () => {
    const onSave = renderSection()
    fireEvent.click(screen.getByTestId('administration-edit'))
    fireEvent.change(screen.getByTestId('administration-route'), { target: { value: 'iv-infusion' } })
    fireEvent.change(screen.getByTestId('administration-infusion-mode'), { target: { value: 'duration' } })
    // A blank duration is silently unknown, but a non-numeric duration is an error.
    fireEvent.change(screen.getByTestId('administration-infusion-duration'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByTestId('administration-save'))

    expect(screen.getByTestId('administration-errors')).toHaveTextContent(/finite number/i)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('clears administration metadata explicitly', () => {
    const onSave = renderSection({
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
    })
    fireEvent.click(screen.getByTestId('administration-clear'))
    expect(onSave).toHaveBeenCalledWith(undefined)
  })
})
