/**
 * Composition root for the data-sources session: the source-data
 * repository (shared Dexie connection with the drug library) wired to the
 * store with the real source adapters. Components import
 * `useDataSourcesStore` from here; tests build their own store with
 * `createDataSourcesStore` and fake adapters instead.
 *
 * Construction performs no I/O: adapters are created but no request is
 * made until the user searches or fetches (see store guards + tests).
 */
import { DexieSourceDataRepository } from '@/data/repositories/dexieSourceDataRepository'
import { createSourceAdapters } from '@/data/sources/registry'
import { createDataSourcesStore } from '@/features/data-sources/store'
import { libraryDatabase, libraryRepository } from './libraryStore'

export const sourceDataRepository = new DexieSourceDataRepository(libraryDatabase)

export const useDataSourcesStore = createDataSourcesStore({
  sourceRepository: sourceDataRepository,
  drugRepository: libraryRepository,
  adapters: createSourceAdapters(),
})
