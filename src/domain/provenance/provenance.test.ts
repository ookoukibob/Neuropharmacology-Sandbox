import { describe, expect, it } from 'vitest'
import { isLiterature, provenanceLabel } from './provenance'

describe('provenance guards', () => {
  const literature = {
    type: 'literature',
    source: 'Example source',
  } as const

  it('narrows literature provenance', () => {
    expect(isLiterature(literature)).toBe(true)
    expect(isLiterature({ type: 'user' })).toBe(false)
  })

  it('labels every provenance state without emoji', () => {
    const labels = [
      provenanceLabel(literature),
      provenanceLabel({ type: 'user' }),
      provenanceLabel({ type: 'calculated', model: 'occupancy.single-site' }),
      provenanceLabel({ type: 'derived', method: 'k = ln(2) / t½', from: ['halfLife'] }),
      provenanceLabel({ type: 'unknown' }),
    ]

    expect(labels).toEqual([
      'Literature',
      'User-provided',
      'Calculated',
      'Derived',
      'Unknown',
    ])
    for (const label of labels) {
      expect(label).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    }
  })
})
