import { experimentDatasetRepository } from '../experimentDatasetRepository'
import { ExperimentalDatasetsView } from '@/features/experiments/ExperimentalDatasetsView'

/**
 * Route page for experimental datasets (phase 47A). The composition root
 * supplies the repository; the feature view never imports Dexie.
 */
export function ExperimentalDatasetsPage() {
  return <ExperimentalDatasetsView repository={experimentDatasetRepository} />
}
