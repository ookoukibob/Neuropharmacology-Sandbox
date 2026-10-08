/**
 * Composition root for the drug library: the IndexedDB-backed repository
 * wired to the session store. Components import `useLibraryStore` from
 * here; tests use `createLibraryStore` with their own repository instead.
 *
 * This is the one React-side module that reaches into `src/data/db` —
 * features and views depend on the store, which depends on the repository
 * interface, never on Dexie itself.
 */
import { SandboxDatabase } from '@/data/db/database'
import { DexieDrugRepository } from '@/data/repositories/dexieDrugRepository'
import { createLibraryStore } from '@/features/drug-library/store'

export const libraryRepository = new DexieDrugRepository(new SandboxDatabase())
export const useLibraryStore = createLibraryStore(libraryRepository)
