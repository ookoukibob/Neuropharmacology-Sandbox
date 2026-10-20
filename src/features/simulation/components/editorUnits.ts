import { unitCatalog } from '@/domain/pharmacology/unit-catalog'
import type { EditorUnitDimension } from '../draft'

/**
 * Unit symbols for one editor dimension, taken from the engine's catalog so
 * the choices can never drift from what the simulation accepts.
 */
export function editorUnitOptions(dimension: EditorUnitDimension): readonly string[] {
  return unitCatalog.unitsOfDimension(dimension).map((unit) => unit.symbol)
}
