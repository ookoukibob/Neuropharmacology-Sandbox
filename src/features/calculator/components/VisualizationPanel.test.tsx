/**
 * Unit tests for VisualizationPanel component (phase 4).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VisualizationPanel } from './VisualizationPanel'
import type { ModelId } from '@/engine/types'

const mockCurve = {
  model: 'occupancy.single-site' as ModelId,
  xLabel: 'Concentration',
  yLabel: 'Occupancy (fraction)',
  xUnit: 'nM',
  yUnit: '1',
  xScale: 'log' as const,
  yScale: 'linear' as const,
  series: [
    {
      id: 'occupancy.fraction',
      name: 'Occupancy',
      seriesType: 'model' as const,
      points: [{ x: 0.1, y: 0.01 }, { x: 10, y: 0.68 }, { x: 100, y: 0.95 }],
      xUnit: 'nM',
      yUnit: '1',
    },
  ],
} as const

const mockSettings = {
  range: { min: '0.1', max: '100', points: '' },
  xScale: 'log' as const,
  yScale: 'linear' as const,
}

describe('VisualizationPanel', () => {
  const defaultProps = {
    curve: mockCurve,
    curveErrors: [],
    settings: mockSettings,
    hasValidReport: true,
    curveSettingsStale: false,
    onRangeChange: vi.fn(),
    onXScaleChange: vi.fn(),
    onYScaleChange: vi.fn(),
    onApply: vi.fn(),
    xUnitHint: 'nM',
  }

  it('renders range controls', () => {
    render(<VisualizationPanel {...defaultProps} />)

    expect(screen.getByLabelText('Range min')).toBeInTheDocument()
    expect(screen.getByLabelText('Range max')).toBeInTheDocument()
    expect(screen.getByLabelText('Points (blank = 200)')).toBeInTheDocument()
  })

  it('shows current range values', () => {
    render(<VisualizationPanel {...defaultProps} />)

    expect(screen.getByDisplayValue('0.1')).toBeInTheDocument()
    expect(screen.getByDisplayValue('100')).toBeInTheDocument()
  })

  it('calls onRangeChange when range min changes', () => {
    render(<VisualizationPanel {...defaultProps} />)

    fireEvent.change(screen.getByLabelText('Range min'), { target: { value: '0.5' } })
    expect(defaultProps.onRangeChange).toHaveBeenCalledWith({ min: '0.5' })
  })

  it('shows X scale radio buttons', () => {
    render(<VisualizationPanel {...defaultProps} />)

    // Use test IDs to disambiguate X vs Y axis radios
    expect(screen.getByTestId('x-scale-linear')).toBeInTheDocument()
    expect(screen.getByTestId('x-scale-log')).toBeInTheDocument()
  })

  it('calls onXScaleChange when X scale changes', () => {
    render(<VisualizationPanel {...defaultProps} />)

    const xLinearRadio = screen.getByTestId('x-scale-linear')
    fireEvent.click(xLinearRadio)
    expect(defaultProps.onXScaleChange).toHaveBeenCalledWith('linear')
  })

  it('shows Y scale radio buttons', () => {
    render(<VisualizationPanel {...defaultProps} />)

    expect(screen.getByTestId('y-scale-linear')).toBeInTheDocument()
    expect(screen.getByTestId('y-scale-log')).toBeInTheDocument()
  })

  it('calls onYScaleChange when Y scale changes', () => {
    render(<VisualizationPanel {...defaultProps} />)

    const yLogRadio = screen.getByTestId('y-scale-log')
    fireEvent.click(yLogRadio)
    expect(defaultProps.onYScaleChange).toHaveBeenCalledWith('log')
  })

  it('shows "Update curve" button', () => {
    render(<VisualizationPanel {...defaultProps} />)

    expect(screen.getByRole('button', { name: 'Update curve' })).toBeInTheDocument()
  })

  it('disables "Update curve" when no valid report', () => {
    render(<VisualizationPanel {...defaultProps} hasValidReport={false} />)

    expect(screen.getByRole('button', { name: 'Update curve' })).toBeDisabled()
  })

  it('shows curve settings stale notice', () => {
    render(<VisualizationPanel {...defaultProps} curveSettingsStale={true} />)

    expect(screen.getByTestId('curve-settings-stale')).toBeInTheDocument()
    expect(screen.getByText('Curve settings changed')).toBeInTheDocument()
  })

  it('shows "Curve range not configured" when range not set', () => {
    const emptyRangeSettings = { ...mockSettings, range: { min: '', max: '', points: '' } }
    render(<VisualizationPanel {...defaultProps} settings={emptyRangeSettings} />)

    expect(screen.getByTestId('range-not-configured')).toBeInTheDocument()
    expect(screen.getByText('Curve range not configured')).toBeInTheDocument()
  })

  it('shows curve errors when present', () => {
    const errors = [{ code: 'OUT_OF_RANGE' as const, parameter: 'range', message: 'min must be less than max' }]
    render(<VisualizationPanel {...defaultProps} curveErrors={errors} />)

    expect(screen.getByTestId('curve-errors')).toBeInTheDocument()
    expect(screen.getByText('Curve not generated')).toBeInTheDocument()
    expect(screen.getByText('min must be less than max')).toBeInTheDocument()
  })

  it('shows LOG_Y warning notice', () => {
    const curveWithLogYWarning = {
      ...mockCurve,
      warnings: [{ code: 'LOG_Y_AXIS_NOT_REPRESENTABLE' as const, severity: 'warning' as const, message: 'A logarithmic y-axis cannot represent 5 of 100 sampled points.' }],
    }
    render(<VisualizationPanel {...defaultProps} curve={curveWithLogYWarning} />)

    expect(screen.getByTestId('log-y-notice')).toBeInTheDocument()
    expect(screen.getByText('Logarithmic Y axis not representable')).toBeInTheDocument()
    expect(screen.getByText('A logarithmic y-axis cannot represent 5 of 100 sampled points.')).toBeInTheDocument()
  })

  it('shows curve warnings (underflow)', () => {
    const curveWithWarning = {
      ...mockCurve,
      warnings: [
        { code: 'LOG_Y_AXIS_NOT_REPRESENTABLE' as const, severity: 'warning' as const, message: 'log y warning' },
        { code: 'NUMERICAL_UNDERFLOW' as const, severity: 'info' as const, message: '5 of 100 sampled points underflowed to 0.' },
      ],
    }
    render(<VisualizationPanel {...defaultProps} curve={curveWithWarning} />)

    expect(screen.getByTestId('curve-warnings')).toBeInTheDocument()
    expect(screen.getByText('Curve warnings')).toBeInTheDocument()
    expect(screen.getByText('NUMERICAL_UNDERFLOW')).toBeInTheDocument()
    expect(screen.getByText('5 of 100 sampled points underflowed to 0.')).toBeInTheDocument()
  })

  it('shows "Calculate to generate a curve" when no report', () => {
    render(<VisualizationPanel {...defaultProps} hasValidReport={false} curve={null} />)

    expect(screen.getByTestId('no-curve')).toHaveTextContent('Calculate to generate a curve.')
  })

  it('shows "Enter a range and click Update curve" when report valid but range empty', () => {
    const emptyRangeSettings = { ...mockSettings, range: { min: '', max: '', points: '' } }
    render(<VisualizationPanel {...defaultProps} settings={emptyRangeSettings} curve={null} />)

    expect(screen.getByTestId('no-curve')).toHaveTextContent('Enter a range and click "Update curve" to generate.')
  })
})