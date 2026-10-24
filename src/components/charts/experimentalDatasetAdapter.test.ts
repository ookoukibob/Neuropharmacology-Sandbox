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

  it('plots below-limit records with a distinct marker, never as a concentration', () => {
    const withBlq: ExperimentalDataset = {
      ...dataset,
      measurements: [
        { id: 'm1', sourceRow: 1, time: 0, concentration: 5 },
        { id: 'm2', sourceRow: 2, time: 1, censored: true, censoring: 'below-quantification-limit', rawText: '<0.1', limit: 0.1 },
      ],
    }
    const chart = buildExperimentalDatasetChart(withBlq)
    expect(chart.traces).toHaveLength(2)
    const quantified = chart.traces[0]!
    const censored = chart.traces[1]!
    expect(quantified['x']).toEqual([0])
    expect(quantified['y']).toEqual([5])
    // The limit is a marker position, not a measured concentration in the
    // quantified series.
    expect((quantified['y'] as number[])).not.toContain(0.1)
    expect(censored['name']).toContain('Below limit')
    expect(censored['y']).toEqual([0.1])
    const hover = (censored['customdata'] as string[])[0]!
    expect(hover).toContain('Source row 2')
    expect(hover).toContain('not a measured concentration')
    expect(hover).toContain('&lt;0.1')
    expect(hover).toContain('LLOQ: 0.1 mg/L')
    expect(chart.ariaLabel).toContain('1 quantified points and 1 below-limit records')
  })
})
