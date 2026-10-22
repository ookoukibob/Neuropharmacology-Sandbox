import { draftFromScenario } from '../draft'
import { DEMO_SCENARIO } from './demoScenario'

/**
 * Test-only adapter for the deterministic synthetic scenario. Product UI
 * code must start from emptyDraft() and must not import this fixture.
 */
export function demoDraft() {
  return draftFromScenario(DEMO_SCENARIO)
}
