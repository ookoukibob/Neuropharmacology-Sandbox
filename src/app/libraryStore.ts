/**
 * Composition root for the drug library: the IndexedDB-backed repository
 * wired to the session store. Components import `useLibraryStore` from
 * here; tests use `createLibraryStore` with their own repository instead.
 *
 * This is the one React-side module that reaches into `src/data/db` —
 * features and views depend on the store, which depends on the repository
 * interface, never on Dexie itself. The database instance is exported so
 * sibling composition roots (data sources) share ONE connection.
 */
import { SandboxDatabase } from '@/data/db/database'
import { DexieDrugRepository } from '@/data/repositories/dexieDrugRepository'
import { createLibraryStore } from '@/features/drug-library/store'

export const libraryDatabase = new SandboxDatabase()
export const libraryRepository = new DexieDrugRepository(libraryDatabase)
export const useLibraryStore = createLibraryStore(libraryRepository)
