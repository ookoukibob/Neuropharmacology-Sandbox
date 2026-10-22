/**
 * Composition root for experimental datasets (phase 47A).
 *
 * The only module that constructs the Dexie dataset repository for the app;
 * the page receives it as a prop, so feature tests inject their own
 * implementation and React never imports Dexie. It shares the single app
 * database connection with the library/data-source/scenario roots.
 */
import { libraryDatabase } from './libraryStore'
import { DexieExperimentalDatasetRepository } from '@/data/repositories/dexieExperimentalDatasetRepository'

export const experimentDatasetRepository = new DexieExperimentalDatasetRepository(libraryDatabase)
