import { expect, test } from '@playwright/test'
import { mockPubChem } from './sourceMocks.js'

/**
 * Translation-style DOM mutation simulation — NOT the real Google
 * Translate extension.
 *
 * Chrome's Google Translate wraps rendered text nodes in <font> elements.
 * React keeps believing those text nodes are still direct children of
 * their original parent, so when a status transition removes one, the
 * commit throws
 * "NotFoundError: Failed to execute 'removeChild' on 'Node'" and the
 * whole app unmounts (facebook/react#11538; reproduced against the
 * production build on 2026-10-13). These tests inject the same kind of
 * mutation into the live DOM with page.evaluate and then exercise the
 * transitions that used to crash. They SIMULATE the mutation a translator
 * performs — they do not run or emulate the actual translation engine.
 */

test('search survives a translation-style <font> wrap of the status text', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })

  await mockPubChem(page)
  await page.goto('/data-sources')
  await page.getByTestId('query-input').fill('synthetic')
  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('search-status')).toContainText('1 result')
  await expect(page.getByTestId('compound-results')).toContainText('Synthetic Fixture Compound')

  // Wrap every non-empty text node under the status paragraph in <font> —
  // the DOM shape a page translator produces.
  const wrapped = await page.evaluate(() => {
    const paragraph = document.querySelector('[data-testid="search-status"]')
    if (paragraph === null) return 0
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    while (walker.nextNode() !== null) {
      const node = walker.currentNode
      if (node instanceof Text && node.textContent.trim() !== '') texts.push(node)
    }
    for (const text of texts) {
      const font = document.createElement('font')
      font.setAttribute('style', 'vertical-align: inherit;')
      text.parentNode?.insertBefore(font, text)
      font.appendChild(text)
    }
    return texts.length
  })
  expect(wrapped).toBeGreaterThan(0)

  // A second search drives results → searching → results: the transition
  // that crashed the app before the fix.
  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('search-status')).toContainText('1 result')
  await expect(page.getByTestId('compound-results')).toContainText('Synthetic Fixture Compound')

  // The application must still be mounted — a crash would land on the
  // router's "Unexpected Application Error!" page instead.
  await expect(page.getByTestId('data-sources-view')).toBeVisible()
  expect(pageErrors.filter((message) => message.includes('removeChild'))).toEqual([])
})
