import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { emptyDraft, type DraftError } from '../draft'
import { ScenarioErrorSummary, ParameterSection } from './ScenarioSections'

/**
 * The defect this guards against was structural: the form rendered its label
 * through the notation renderer while the error summary printed a hand-written
 * copy of the same string. These tests assert on the rendered DOM that both
 * paths now produce the same markup — a real <sub>, not "V_c".
 */
const centralVolumeError: DraftError = {
  code: 'NOT_A_NUMBER',
  field: 'centralVolume',
  message: 'Must be a finite number (got "abc").',
}

function renderSection(errors: readonly DraftError[]) {
  const draft = emptyDraft()
  return render(
    <>
      <ScenarioErrorSummary draftErrors={errors} engineErrors={[]} onFocusField={() => {}} />
      <ParameterSection
        draft={draft}
        draftErrors={errors}
        engineErrors={[]}
        onChange={() => {}}
        onChangeQuantity={() => {}}
      />
    </>,
  )
}

/** `<sub>` texts inside an element, in document order. */
const subscripts = (root: HTMLElement): readonly (string | null)[] =>
  [...root.querySelectorAll('sub')].map((element) => element.textContent)

describe('ParameterSection — field labels', () => {
  it('renders the scientific symbols with native subscripts', () => {
    const { container } = renderSection([])
    const labelFor = (testId: string): HTMLElement =>
      container.querySelector(`[data-testid="${testId}"]`)?.closest('[data-field-path]') ??
      container

    expect(subscripts(labelFor('central-volume-value'))).toEqual(['c'])
    expect(subscripts(labelFor('peripheral-volume-value'))).toEqual(['p'])
    expect(subscripts(labelFor('initial-central-value'))).toEqual(['c'])
    expect(subscripts(labelFor('initial-peripheral-value'))).toEqual(['p'])
  })

  it('keeps "(0)" on the baseline after the subscript', () => {
    const { container } = renderSection([])
    const label = container.querySelector('[data-field-path="initialCentralAmount"] label')

    expect(label?.textContent).toContain('Ac(0) Initial central amount')
    expect(label?.querySelector('sub')?.textContent).toBe('c')
  })

  it('shows no raw underscore in any label', () => {
    const { container } = renderSection([])
    for (const label of container.querySelectorAll('label')) {
      expect(label.textContent ?? '').not.toMatch(
        /(?<![A-Za-z0-9_])[ACEKRVfkt]_[A-Za-z0-9]+/,
      )
    }
  })
})

describe('ScenarioErrorSummary — validation errors', () => {
  it('renders the V_c label with the same subscript as the field itself', () => {
    const { container } = renderSection([centralVolumeError])
    const summary = screen.getByTestId('form-errors')
    const fieldLabel = container.querySelector('[data-field-path="centralVolume"] label')
    const summaryLabel = within(summary).getByRole('button')

    expect(subscripts(fieldLabel as HTMLElement)).toEqual(['c'])
    expect(subscripts(summaryLabel)).toEqual(['c'])
    // Same component, same notation: the text of the summary label equals the
    // text of the field label.
    expect(summaryLabel.textContent).toBe(fieldLabel?.textContent)
  })

  it('names the field once, then states the problem', () => {
    renderSection([centralVolumeError])
    const summary = screen.getByTestId('form-errors')

    expect(summary.textContent).toContain('Vc Central volume: Must be a finite number (got "abc").')
    expect(summary.textContent).not.toContain('Central volume: Central volume')
  })

  it('resolves a dosing-row error to prose without notation', () => {
    renderSection([
      {
        code: 'OUT_OF_RANGE',
        field: 'events.1.stopTime',
        message: 'An infusion stop time must be later than its start time (start 1 h, stop 1 h).',
      },
    ])
    const summary = screen.getByTestId('form-errors')

    expect(summary.textContent).toContain('Dosing row 1: stop time')
    expect(summary.querySelectorAll('sub')).toHaveLength(0)
  })

  it('keeps the summary accessible: the label is a button that reports its field', () => {
    const clicked: string[] = []
    render(
      <ScenarioErrorSummary
        draftErrors={[centralVolumeError]}
        engineErrors={[]}
        onFocusField={(field) => clicked.push(field)}
      />,
    )
    const summary = screen.getByTestId('form-errors')
    within(summary).getByRole('button').click()

    expect(clicked).toEqual(['centralVolume'])
  })
})
