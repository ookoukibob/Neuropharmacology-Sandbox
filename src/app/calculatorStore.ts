/**
 * Composition root for the calculator store (phase 4).
 *
 * This is the only module that imports the store factory and creates the
 * singleton hook used by React components. Tests can import the factory
 * directly to create isolated stores.
 */
import { createCalculatorStore } from '@/features/calculator/store'

export const useCalculatorStore = createCalculatorStore()