/**
 * Effect-site editor section (phase 46).
 *
 * Opt-in controls for the effect-site / occupancy coupling. Every numeric
 * input stays an independent STRING in `EffectSiteDraft`: blank or half-typed
 * text is preserved, nothing is defaulted, and disabling the section keeps
 * whatever the user already entered (it is hidden, not cleared).
 *
 * Field errors are produced by `compileScenario` (draft parsing) and shown
 * next to their control; scientific validation remains the engine's.
 */
import { ScientificText } from '@/components/scientific/ScientificText'
import { Label } from '@/components/ui/label'
import type { EffectSiteDraft } from '../draft'
import type { DraftError } from '../draft'
import { NumberField, QuantityField } from './fields'

export interface EffectSiteSectionProps {
  readonly draft: EffectSiteDraft
  /** Draft errors for effect-site fields, keyed by their field path. */
  readonly errors: readonly DraftError[]
  readonly onChange: (next: EffectSiteDraft) => void
}

const errorFor = (errors: readonly DraftError[], field: string): string | undefined =>
  errors.find((error) => error.field === field)?.message

export function EffectSiteSection({ draft, errors, onChange }: EffectSiteSectionProps) {
  const enabled = draft.enabled
  return (
    <section aria-labelledby="effect-site-heading" className="flex flex-col gap-3" data-testid="effect-site-section">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          id="effect-site-enabled"
          checked={enabled}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          className="mt-0.5 size-4 shrink-0 rounded border-input accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="effect-site-enabled"
        />
        <div className="grid gap-1">
          <Label htmlFor="effect-site-enabled" className="text-sm font-medium">
            Effect-site and receptor-occupancy analysis
          </Label>
          <p className="text-xs text-muted-foreground">
            Optional. Adds an effect-site concentration <ScientificText value="C_e" /> (a
            mathematical model variable — not a measured brain or CNS concentration) and a
            single-site binding ratio{' '}
            <ScientificText value="C_e/(C_e + K_d)" /> — not an effect, efficacy or clinical
            prediction. Unbound central concentration is reconstructed as piecewise linear between
            emitted PK samples.
          </p>
        </div>
      </div>

      {enabled ? (
        <div className="grid gap-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              id="effect-site-fu"
              label="Unbound fraction"
              symbol="f_u"
              help="Dimensionless, greater than 0 and at most 1. Never defaulted."
              value={draft.unboundFraction}
              error={errorFor(errors, 'effectSite.unboundFraction')}
              testId="effect-site-fu"
              fieldPath="effectSite.unboundFraction"
              onChange={(value) => onChange({ ...draft, unboundFraction: value })}
            />
            <NumberField
              id="effect-site-ke0"
              label="Equilibration rate"
              symbol="k_e0"
              help="Inverse hours (h⁻¹), the simulation's canonical time unit."
              value={draft.ke0}
              error={errorFor(errors, 'effectSite.ke0')}
              testId="effect-site-ke0"
              fieldPath="effectSite.ke0"
              onChange={(value) => onChange({ ...draft, ke0: value })}
            />
          </div>
          <QuantityField
            id="effect-site-kd"
            label="Equilibrium dissociation constant"
            symbol="K_d"
            value={draft.kd.value}
            unit={draft.kd.unit}
            error={errorFor(errors, 'effectSite.kd')}
            dimension="concentration"
            testId="effect-site-kd"
            unitTestId="effect-site-kd-unit"
            fieldPath="effectSite.kd"
            onChange={(value) => onChange({ ...draft, kd: { ...draft.kd, value } })}
            onUnitChange={(unit) => onChange({ ...draft, kd: { ...draft.kd, unit } })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              id="effect-site-mw"
              label="Molecular weight"
              help="g/mol. Required only when Kd is declared in a molar unit; blank means absent."
              value={draft.molecularWeight}
              error={errorFor(errors, 'effectSite.molecularWeight')}
              testId="effect-site-mw"
              fieldPath="effectSite.molecularWeight"
              onChange={(value) => onChange({ ...draft, molecularWeight: value })}
            />
            <NumberField
              id="effect-site-mw-provenance"
              label="Molecular-weight provenance"
              help="Where the value came from. Required with a molar Kd."
              value={draft.molecularWeightProvenance}
              error={errorFor(errors, 'effectSite.molecularWeightProvenance')}
              testId="effect-site-mw-provenance"
              fieldPath="effectSite.molecularWeightProvenance"
              onChange={(value) => onChange({ ...draft, molecularWeightProvenance: value })}
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}
