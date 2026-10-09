import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AppLayout } from './AppLayout'

function renderLayout(initialPath = '/library') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppLayout />
    </MemoryRouter>,
  )
}

describe('AppLayout', () => {
  it('renders the primary navigation with accessible link labels', () => {
    renderLayout()

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(
      within(nav).getByRole('link', { name: 'Drug Library' }),
    ).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Calculator' })).toBeInTheDocument()
    expect(
      within(nav).getByRole('link', { name: 'Import / Export' }),
    ).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })

  it('marks the active route with aria-current on other routes too', () => {
    renderLayout('/settings')

    expect(
      screen.getByRole('link', { name: 'Settings' }),
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('link', { name: 'Drug Library' }),
    ).not.toHaveAttribute('aria-current')
  })

  it('uses semantic landmarks and a skip link', () => {
    renderLayout()

    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument()
  })

  it('contains no emoji characters in the UI shell', () => {
    const { container } = renderLayout()
    expect(container.textContent ?? '').not.toMatch(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    )
  })

  it('sets a meaningful document title for the initial route', () => {
    renderLayout('/calculator')
    expect(document.title).toBe('Calculator — Neuropharmacology Sandbox')
  })

  it('updates the document title on client-side navigation', () => {
    renderLayout('/library')

    expect(document.title).toBe('Drug Library — Neuropharmacology Sandbox')
    fireEvent.click(screen.getByRole('link', { name: 'Import / Export' }))
    expect(document.title).toBe('Import / Export — Neuropharmacology Sandbox')
  })

  it('makes the main region a focus target and moves focus there after navigation', () => {
    renderLayout('/library')
    const main = screen.getByRole('main')

    expect(main).toHaveAttribute('tabindex', '-1')
    expect(main).toHaveAttribute('id', 'main-content')
    // First load keeps focus on the document — nothing is stolen on entry.
    expect(document.activeElement).not.toBe(main)

    fireEvent.click(screen.getByRole('link', { name: 'Calculator' }))
    expect(document.activeElement).toBe(main)
  })

  it('routes the skip link to the main region', () => {
    renderLayout()

    const skipLink = screen.getByRole('link', { name: 'Skip to main content' })
    expect(skipLink).toHaveAttribute('href', '#main-content')
    expect(document.getElementById('main-content')).toBe(screen.getByRole('main'))
  })
})
