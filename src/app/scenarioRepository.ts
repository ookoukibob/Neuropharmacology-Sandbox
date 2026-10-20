/**
 * Composition root for saved scenarios (phase 45).
 *
 * The only module that constructs the Dexie scenario repository for the app;
 * the page receives it as a prop, so tests inject their own implementation
 * and the feature never imports the database module.
 *
 * It reuses the app's single database instance (`libraryDatabase`), so saved
 * scenarios live in the same IndexedDB database as the drug library and are
 * covered by the same `.npsb` snapshot.
 */
import { libraryDatabase } from '@/app/libraryStore'
import { DexieScenarioRepository } from '@/data/repositories/dexieScenarioRepository'

export const scenarioRepository = new DexieScenarioRepository(libraryDatabase)
