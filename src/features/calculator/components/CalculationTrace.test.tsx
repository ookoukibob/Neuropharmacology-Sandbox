/**
 * Unit tests for CalculationTrace component (phase 4).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CalculationTrace } from './CalculationTrace'
import type { TraceStep } from '@/engine/types'

const mockTrace: TraceStep[] = [
  {
    index: 1,
    label: 'Unit conversion',
    expression: 'Kd → nM',
    substituted: '4.7 nM',
    result: { value: 4.7, unit: 'nM' },
  },
  {
    index: 2,
    label: 'Denominator',
    expression: '[D] + Kd',
    substituted: '12.4 nM + 4.7 nM',
    result: { value: 17.1, unit: 'nM' },
  },
  {
    index: 3,
    label: 'Occupancy (fraction)',
    expression: 'Occ = [D] / ([D] + Kd)',
    substituted: '12.4 nM / 17.1 nM',
    result: { value: 0.725, unit: '1' },
  },
]

describe('CalculationTrace', () => {
  it('renders all trace steps', () => {
    render(<CalculationTrace trace={mockTrace} />)

    expect(screen.getByTestId('calculation-trace')).toBeInTheDocument()
    expect(screen.getByText('Calculation Trace')).toBeInTheDocument()
    expect(screen.getByTestId('trace-step-1')).toBeInTheDocument()
    expect(screen.getByTestId('trace-step-2')).toBeInTheDocument()
    expect(screen.getByTestId('trace-step-3')).toBeInTheDocument()
  })

  it('renders step index and label', () => {
    render(<CalculationTrace trace={mockTrace} />)

    expect(screen.getByText('Step 1')).toBeInTheDocument()
    expect(screen.getByText('Unit conversion')).toBeInTheDocument()
    expect(screen.getByText('Step 2')).toBeInTheDocument()
    expect(screen.getByText('Denominator')).toBeInTheDocument()
  })

  it('renders expression', () => {
    render(<CalculationTrace trace={mockTrace} />)

    expect(screen.getByText('Kd → nM')).toBeInTheDocument()
    expect(screen.getByText('[D] + Kd')).toBeInTheDocument()
  })

  it('renders substituted values', () => {
    render(<CalculationTrace trace={mockTrace} />)

    expect(screen.getByText('4.7 nM')).toBeInTheDocument()
    expect(screen.getByText((content) => content.includes('12.4 nM') && content.includes('+ 4.7 nM'))).toBeInTheDocument()
  })

  it('renders result value with unit', () => {
    render(<CalculationTrace trace={mockTrace} />)

    // The result values are in font-mono spans, check for the values individually
    const traceContainer = screen.getByTestId('calculation-trace')
    expect(traceContainer).toHaveTextContent('4.7 nM')
    expect(traceContainer).toHaveTextContent('→')
    expect(traceContainer).toHaveTextContent('17.1 nM')
    expect(traceContainer).toHaveTextContent('0.725')
    expect(traceContainer).toHaveTextContent('1')
  })

  it('renders nothing for empty trace', () => {
    render(<CalculationTrace trace={[]} />)

    expect(screen.queryByTestId('calculation-trace')).not.toBeInTheDocument()
  })
})