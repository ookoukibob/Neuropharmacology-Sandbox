/**
 * Unit tests for ResultPanel component (phase 4).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ResultPanel } from './ResultPanel'
import type { CalculationResult } from '@/engine/types'
import type { ModelId } from '@/engine/types'

const mockResult = {
  model: 'occupancy.single-site' as ModelId,
  modelLabel: 'Single-site receptor occupancy',
  formula: 'Occupancy = [D] / ([D] + Kd)',
  inputs: [
    { symbol: '[D]', label: 'Ligand concentration', value: 12.4, unit: 'nM', provenance: { type: 'literature' as const, source: 'ChEMBL', accessedAt: '2026-01-01T00:00:00.000Z' } },
    { symbol: 'Kd', label: 'Equilibrium dissociation constant', value: 4.7, unit: 'nM' },
  ],
  trace: [
    { index: 1, label: 'Unit conversion', expression: 'Kd → nM', substituted: '4.7 nM', result: { value: 4.7, unit: 'nM' } },
    { index: 2, label: 'Denominator', expression: '[D] + Kd', substituted: '12.4 nM + 4.7 nM', result: { value: 17.1, unit: 'nM' } },
    { index: 3, label: 'Occupancy (fraction)', expression: 'Occ = [D] / ([D] + Kd)', substituted: '12.4 nM / 17.1 nM', result: { value: 0.725, unit: '1' } },
  ],
  outputs: [
    { symbol: 'Occ', label: 'Occupancy (fraction)', value: 0.725, unit: '1' },
    { symbol: 'Occ%', label: 'Occupancy (percent)', value: 72.5, unit: '%' },
  ],
  assumptions: [
    'Single-site equilibrium binding: one ligand, one site.',
    'Percentage is a display form of the fraction: occupancy% = occupancy × 100.',
  ],
  warnings: [
    { code: 'MODEL_LIMITATION' as const, severity: 'info' as const, message: 'Equilibrium single-site model; does not cover binding kinetics.' },
    { code: 'MODEL_RESULT_NOT_CLINICAL' as const, severity: 'warning' as const, message: 'Occupancy is a model quantity; it is not a clinical or subjective effect.' },
  ],
} as const satisfies CalculationResult

const hillResult = {
  model: 'dose-response.hill',
  modelLabel: 'Hill / Emax dose–response',
  formula: 'E = E0 + (Emax · [D]^n) / (EC50^n + [D]^n)',
  inputs: [
    { symbol: '[D]', label: 'Ligand concentration', value: 10, unit: 'nM' },
    { symbol: 'EC50', label: 'Half-maximal concentration', value: 10, unit: 'nM' },
    { symbol: 'E0', label: 'Baseline effect', value: 0, unit: '%' },
    { symbol: 'Emax', label: 'Maximal effect', value: 100, unit: '%' },
    { symbol: 'n', label: 'Hill coefficient', value: 1, unit: '1' },
  ],
  trace: [
    {
      index: 1,
      label: 'Fractional response',
      expression: 'f = [D]^n / (EC50^n + [D]^n)',
      substituted: '10^1 / (10^1 + 10^1)',
      result: { value: 0.5, unit: '1' },
    },
    {
      index: 2,
      label: 'Predicted effect',
      expression: 'E = E0 + Emax · f',
      substituted: '0 % + 100 % × 0.5',
      result: { value: 50, unit: '%' },
    },
  ],
  outputs: [
    { symbol: 'f', label: 'Fractional response', value: 0.5, unit: '1' },
    { symbol: 'E', label: 'Predicted effect', value: 50, unit: '%' },
  ],
  assumptions: ['E0 and Emax are the reported baseline and maximal effect.'],
  warnings: [
    {
      code: 'MODEL_LIMITATION' as const,
      severity: 'info' as const,
      message: 'Hill/Emax describes the supplied concentration–effect relation.',
    },
  ],
} satisfies CalculationResult

describe('ResultPanel', () => {
  it('renders outputs with symbol, label, value, and unit', () => {
    render(<ResultPanel result={mockResult} stale={false} />)

    expect(screen.getByText('Occ')).toBeInTheDocument()
    expect(screen.getByText('Occupancy (fraction)')).toBeInTheDocument()
    expect(screen.getByText('0.725 1')).toBeInTheDocument()
    expect(screen.getByText('Occ%')).toBeInTheDocument()
    expect(screen.getByText('72.5 %')).toBeInTheDocument()
  })

  it('renders formula with a semantic subscript', () => {
    render(<ResultPanel result={mockResult} stale={false} />)

    expect(screen.getByText('Formula')).toBeInTheDocument()
    const formula = screen.getByTestId('result-formula')
    expect(formula).toHaveTextContent('Occupancy = [D] / ([D] + Kd)')
    expect(formula.querySelector('sub')).toHaveTextContent('d')
  })

  it('renders subscripts and superscripts in the Hill formula and inputs', () => {
    render(<ResultPanel result={hillResult} stale={false} />)

    const formula = screen.getByTestId('result-formula')
    expect(formula).toHaveTextContent(
      'E = E0 + (Emax · [D]n) / (EC50n + [D]n)',
    )
    expect(
      [...formula.querySelectorAll('sub')].map((element) => element.textContent),
    ).toEqual(['0', 'max', '50'])
    expect(formula.querySelectorAll('sup')).toHaveLength(3)

    const inputs = screen.getByTestId('result-inputs')
    expect(
      [...inputs.querySelectorAll('sub')].map((element) => element.textContent),
    ).toEqual(['50', '0', 'max'])
  })

  it('renders scientific notation in assumptions without changing the text', () => {
    render(<ResultPanel result={hillResult} stale={false} />)

    const assumptions = screen.getByTestId('result-assumptions')
    expect(assumptions).toHaveTextContent(
      'E0 and Emax are the reported baseline and maximal effect.',
    )
    expect(assumptions.querySelectorAll('sub')).toHaveLength(2)
  })

  it('renders inputs used with provenance', () => {
    render(<ResultPanel result={mockResult} stale={false} />)

    expect(screen.getByText('Inputs Used')).toBeInTheDocument()
    expect(screen.getByText('[D]')).toBeInTheDocument()
    expect(screen.getByText('Ligand concentration')).toBeInTheDocument()
    expect(screen.getByText('12.4 nM')).toBeInTheDocument()
    expect(screen.getByText('Literature')).toBeInTheDocument()
    expect(screen.getByText('User-entered')).toBeInTheDocument()
  })

  it('renders assumptions', () => {
    render(<ResultPanel result={mockResult} stale={false} />)

    expect(screen.getByText('Assumptions (2)')).toBeInTheDocument()
    // Assumptions are collapsible, initially expanded
    expect(screen.getByText('Single-site equilibrium binding: one ligand, one site.')).toBeInTheDocument()
    expect(screen.getByText('Percentage is a display form of the fraction: occupancy% = occupancy × 100.')).toBeInTheDocument()
  })

  it('renders warnings with code and severity', () => {
    render(<ResultPanel result={mockResult} stale={false} />)

    expect(screen.getByText('Warnings (2)')).toBeInTheDocument()
    expect(screen.getByText('MODEL_LIMITATION')).toBeInTheDocument()
    expect(screen.getByText('MODEL_RESULT_NOT_CLINICAL')).toBeInTheDocument()
    expect(screen.getByText('Equilibrium single-site model; does not cover binding kinetics.')).toBeInTheDocument()
    expect(screen.getByText('Occupancy is a model quantity; it is not a clinical or subjective effect.')).toBeInTheDocument()
  })

  it('shows stale banner when stale=true', () => {
    render(<ResultPanel result={mockResult} stale={true} />)

    expect(screen.getByTestId('result-stale')).toHaveTextContent('Inputs changed since this result was calculated')
  })

  it('does not show stale banner when stale=false', () => {
    render(<ResultPanel result={mockResult} stale={false} />)

    expect(screen.queryByTestId('result-stale')).not.toBeInTheDocument()
  })

  it('toggles assumptions visibility', () => {
    render(<ResultPanel result={mockResult} stale={false} />)

    const button = screen.getByRole('button', { name: /Assumptions/ })
    expect(screen.getByText((content) => content.includes('Single-site equilibrium binding'))).toBeInTheDocument()

    fireEvent.click(button)
    expect(screen.queryByText((content) => content.includes('Single-site equilibrium binding'))).not.toBeInTheDocument()

    fireEvent.click(button)
    expect(screen.getByText((content) => content.includes('Single-site equilibrium binding'))).toBeInTheDocument()
  })

  it('toggles warnings visibility', () => {
    render(<ResultPanel result={mockResult} stale={false} />)

    const button = screen.getByRole('button', { name: /Warnings/ })
    expect(screen.getByText('MODEL_LIMITATION')).toBeInTheDocument()

    fireEvent.click(button)
    expect(screen.queryByText('MODEL_LIMITATION')).not.toBeInTheDocument()
  })
})