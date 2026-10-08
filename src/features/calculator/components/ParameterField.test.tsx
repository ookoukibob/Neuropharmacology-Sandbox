/**
 * Unit tests for ParameterField component (phase 4).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ParameterField } from './ParameterField'
import type { CalculatorFieldSpec, LibraryCandidate, ParameterDraft } from '../modelAdapters'

const mockSpec: CalculatorFieldSpec = {
  key: 'kd',
  symbol: 'Kd',
  label: 'Equilibrium dissociation constant',
  unit: { kind: 'catalog', dimensions: ['molar-concentration'] },
}

const mockField: ParameterDraft = { value: '4.7', unit: 'nM' }

const mockCandidates: LibraryCandidate[] = [
  {
    key: 'target1:kd',
    label: 'TEST-R · Kd',
    value: 4.7,
    unit: 'nM',
    provenance: { type: 'literature', source: 'ChEMBL', accessedAt: '2026-01-01T00:00:00.000Z' },
  },
]

describe('ParameterField', () => {
  it('renders label with symbol', () => {
    render(
      <ParameterField
        spec={mockSpec}
        field={mockField}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    expect(screen.getByText('Kd')).toBeInTheDocument()
    expect(screen.getByText('Equilibrium dissociation constant')).toBeInTheDocument()
  })

  it('shows value input with current value', () => {
    render(
      <ParameterField
        spec={mockSpec}
        field={{ value: '12.4', unit: 'nM' }}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    expect(screen.getByDisplayValue('12.4')).toBeInTheDocument()
  })

  it('calls onValueChange when value input changes', () => {
    const onChange = vi.fn()
    render(
      <ParameterField
        spec={mockSpec}
        field={mockField}
        candidates={[]}
        onValueChange={onChange}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    fireEvent.change(screen.getByDisplayValue('4.7'), { target: { value: '10.0' } })
    expect(onChange).toHaveBeenCalledWith('10.0')
  })

  it('calls onUnitChange when unit select changes', () => {
    const onChange = vi.fn()
    render(
      <ParameterField
        spec={mockSpec}
        field={mockField}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={onChange}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    const select = screen.getByRole('combobox', { name: /Unit/i })
    fireEvent.change(select, { target: { value: 'µM' } })
    expect(onChange).toHaveBeenCalledWith('µM')
  })

  it('shows catalog unit options grouped by dimension', () => {
    render(
      <ParameterField
        spec={mockSpec}
        field={mockField}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    const select = screen.getByRole('combobox', { name: /Unit/i })
    expect(select).toHaveAccessibleName('Unit')
    // Should have optgroup for molar-concentration (lowercase label from dimensionLabel)
    // Check for optgroup element with label attribute
    const optgroup = screen.getByRole('group', { name: 'molar concentration' })
    expect(optgroup).toBeInTheDocument()
  })

  it('shows "From library" select when candidates provided', () => {
    render(
      <ParameterField
        spec={mockSpec}
        field={mockField}
        candidates={mockCandidates}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    expect(screen.getByRole('combobox', { name: /From library/i })).toBeInTheDocument()
    expect(screen.getByText('TEST-R · Kd — 4.7 nM')).toBeInTheDocument()
  })

  it('calls onLoad when library candidate selected', () => {
    const onLoad = vi.fn()
    render(
      <ParameterField
        spec={mockSpec}
        field={mockField}
        candidates={mockCandidates}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={onLoad}
        idPrefix="test"
        error={undefined}
      />
    )
    const select = screen.getByRole('combobox', { name: /From library/i })
    fireEvent.change(select, { target: { value: 'target1:kd' } })
    expect(onLoad).toHaveBeenCalledWith(mockCandidates[0])
  })

  it('shows "From library" provenance when field has source', () => {
    const fieldWithSource: ParameterDraft = {
      value: '4.7',
      unit: 'nM',
      source: {
        provenance: { type: 'literature', source: 'ChEMBL', accessedAt: '2026-01-01T00:00:00.000Z' },
        originLabel: 'TEST-R · Kd',
      },
    }
    render(
      <ParameterField
        spec={mockSpec}
        field={fieldWithSource}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    expect(screen.getByText('From library: TEST-R · Kd')).toBeInTheDocument()
    expect(screen.getByText('Literature')).toBeInTheDocument()
  })

  it('shows "User-entered" when field has value but no source', () => {
    render(
      <ParameterField
        spec={mockSpec}
        field={{ value: '12.4', unit: 'nM' }}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    expect(screen.getByText('User-entered — no source claim')).toBeInTheDocument()
  })

  it('shows nothing when field is empty and no source', () => {
    render(
      <ParameterField
        spec={mockSpec}
        field={{ value: '', unit: '' }}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    expect(screen.queryByText('User-entered')).not.toBeInTheDocument()
    expect(screen.queryByText('From library')).not.toBeInTheDocument()
  })

  it('shows error message when error prop provided', () => {
    render(
      <ParameterField
        spec={mockSpec}
        field={mockField}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error="Kd must be positive"
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Kd must be positive')
    expect(screen.getByText('Kd must be positive')).toBeInTheDocument()
  })

  it('renders fixed unit display for Hill coefficient', () => {
    const hillSpec: CalculatorFieldSpec = {
      key: 'hillCoefficient',
      symbol: 'n',
      label: 'Hill coefficient',
      unit: { kind: 'fixed', symbol: '1' },
    }
    render(
      <ParameterField
        spec={hillSpec}
        field={{ value: '1', unit: '' }}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('dimensionless (unit "1")')).toBeInTheDocument()
  })

  it('renders effect unit as text input', () => {
    const effectSpec: CalculatorFieldSpec = {
      key: 'e0',
      symbol: 'E0',
      label: 'Baseline effect',
      unit: { kind: 'effect' },
    }
    render(
      <ParameterField
        spec={effectSpec}
        field={{ value: '0', unit: '%' }}
        candidates={[]}
        onValueChange={vi.fn()}
        onUnitChange={vi.fn()}
        onLoad={vi.fn()}
        idPrefix="test"
        error={undefined}
      />
    )
    const input = screen.getByPlaceholderText('e.g. %, pmol/min')
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('%')
  })
})