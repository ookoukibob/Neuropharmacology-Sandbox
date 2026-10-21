import { unitCatalog } from '@/domain/pharmacology/unit-catalog'
import type { EditorUnitDimension } from '../draft'

/**
 * Unit symbols for one editor dimension, taken from the engine's catalog so
 * the choices can never drift from what the simulation accepts.
 */
export function editorUnitOptions(dimension: EditorUnitDimension): readonly string[] {
  if (dimension === 'concentration') {
    // Both concentration dimensions: a molar Kd is legitimate and is converted
    // only with an explicit molecular weight plus provenance.
    return [
      ...unitCatalog.unitsOfDimension('mass-concentration'),
      ...unitCatalog.unitsOfDimension('molar-concentration'),
    ].map((unit) => unit.symbol)
  }
  return unitCatalog.unitsOfDimension(dimension).map((unit) => unit.symbol)
}
