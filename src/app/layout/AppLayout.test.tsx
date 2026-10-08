import { render, screen, within } from '@testing-library/react'
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
})
