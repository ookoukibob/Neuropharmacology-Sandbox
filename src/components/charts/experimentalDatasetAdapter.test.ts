import { describe, expect, it } from 'vitest'
import type { ExperimentalDataset } from '@/domain/experiments/experimental-dataset'
import { buildExperimentalDatasetChart } from './experimentalDatasetAdapter'

const dataset: ExperimentalDataset = {
  id: 'dataset-1',
  name: 'Observed <study>',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  timeUnit: 'h',
  concentrationUnit: 'mg/L',
  provenance: {
    source: 'csv',
    fileName: 'study.csv',
    importedAt: '2026-01-01T00:00:00.000Z',
  },
  measurements: [
    { id: 'm1', sourceRow: 1, time: 0, concentration: 0, sampleId: '<A>', note: 'first & baseline' },
    { id: 'm2', sourceRow: 2, time: 0, concentration: 0, sampleId: '<A>', note: 'replicate' },
    { id: 'm3', sourceRow: 3, time: 2, concentration: 1.5 },
  ],
}

describe('experimental dataset chart adapter', () => {
  it('emits observed markers only, with duplicate points preserved', () => {
    const chart = buildExperimentalDatasetChart(dataset)
    expect(chart.traces).toHaveLength(1)
    const trace = chart.traces[0]!
    expect(trace['type']).toBe('scatter')
    expect(trace['mode']).toBe('markers')
    expect(trace['x']).toEqual([0, 0, 2])
    expect(trace['y']).toEqual([0, 0, 1.5])
    expect(trace['line']).toBeUndefined()
    expect(trace['fill']).toBeUndefined()
    expect(JSON.stringify(chart.traces)).not.toContain('spline')
  })

  it('labels both axes with the declared units', () => {
    const chart = buildExperimentalDatasetChart(dataset)
    expect((chart.layout['xaxis'] as { title: { text: string } }).title.text).toBe('Time (h)')
    expect((chart.layout['yaxis'] as { title: { text: string } }).title.text).toBe(
      'Measured concentration (mg/L)',
    )
    expect(chart.ariaLabel).toContain('3 points')
    expect(chart.ariaLabel).toContain('No fitted curve')
  })

  it('escapes untrusted hover labels', () => {
    const chart = buildExperimentalDatasetChart(dataset)
    const customdata = chart.traces[0]!['customdata'] as string[]
    expect(customdata[0]).toContain('&lt;A&gt;')
    expect(customdata[0]).toContain('first &amp; baseline')
    expect(customdata[0]).not.toContain('<A>')
  })
})
