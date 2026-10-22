/**
 * Imported source data on a drug record (phase 36): the structured view of
 * every external compound record the record was created from or explicitly
 * linked to, plus the measurements stored for exactly that record.
 *
 * Display rules encoded here:
 * - **Structured, not prose.** Identifiers and chemical properties are
 *   rendered from typed fields; a field the source did not supply is shown
 *   as "not reported", never omitted silently and never filled in.
 * - **Attribution travels with the data.** Source name, the record link,
 *   retrieval date, the source version and the license notice/URL are
 *   always shown, because the license obligation is part of the record.
 * - **Measurements stay separate.** Each observation is its own row with
 *   its own endpoint, value, unit, qualifier, target, species, assay and
 *   source record. Two records that disagree are both shown — nothing is
 *   averaged, merged or dropped, and nothing here is a model parameter.
 * - **Honest empty states.** A compound with no stored measurements says
 *   so instead of showing an empty table.
 */
import { ScientificText } from '@/components/scientific/ScientificText'
import type { NotationMode } from '@/components/scientific/notation'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { DrugSourceRecord, ImportedObservation } from '../../domain/drug/source-data'

/** A labelled value, or an explicit "not reported" marker. */
function Field({
  label,
  value,
  notation,
}: {
  readonly label: string
  readonly value: string | undefined
  readonly notation?: NotationMode
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm" data-testid={`source-field-${label}`}>
        {value === undefined ? (
          <span className="text-muted-foreground">not reported</span>
        ) : notation === undefined ? (
          value
        ) : (
          <ScientificText value={value} mode={notation} />
        )}
      </dd>
    </div>
  )
}

/** Reported value with its qualifier preserved exactly ('<' stays '<'). */
function reportedValue(observation: ImportedObservation): string {
  const relation = observation.qualifier === '=' ? '' : `${observation.qualifier ?? ''} `
  return `${relation}${observation.value}${observation.unit === undefined ? '' : ` ${observation.unit}`}`
}

function ObservationRow({ observation }: { readonly observation: ImportedObservation }) {
  const assay = observation.assay
  const reference = observation.reference
  const context = [
    observation.species !== undefined ? `species ${observation.species}` : null,
    observation.target.organism !== undefined && observation.target.organism !== observation.species
      ? `target organism ${observation.target.organism}`
      : null,
    assay?.assayId !== undefined ? `assay ${assay.assayId}` : null,
    assay?.assayType !== undefined ? `assay type ${assay.assayType}` : null,
    assay?.description ?? null,
    reference?.referenceId !== undefined ? `reference ${reference.referenceId}` : null,
    reference?.journal !== undefined ? reference.journal : null,
    reference?.year !== undefined ? String(reference.year) : null,
  ].filter((part): part is string => part !== null && part.length > 0)

  return (
    <li className="space-y-1 rounded-md border p-3 text-sm" data-testid="imported-observation">
      <p className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{observation.endpoint}</Badge>
        <span className="font-medium" data-testid="imported-observation-value">
          {reportedValue(observation)}
        </span>
        <span className="text-muted-foreground">
          {observation.target.name ?? 'target not named'}
          {observation.target.sourceTargetId !== undefined
            ? ` (${observation.target.sourceTargetId})`
            : ''}
        </span>
        {observation.parameterKind !== undefined ? (
          <Badge variant="outline">maps to {observation.parameterKind.toUpperCase()}</Badge>
        ) : (
          <Badge variant="outline">no parameter mapping</Badge>
        )}
        {observation.rawRelation !== undefined && (
          <Badge variant="outline">reported relation “{observation.rawRelation}”</Badge>
        )}
      </p>
      {context.length > 0 && (
        <p className="break-words text-xs text-muted-foreground" data-testid="imported-observation-context">
          {context.join(' · ')}
        </p>
      )}
      {observation.activityComment !== undefined && (
        <p className="break-words text-xs" data-testid="imported-observation-comment">
          {observation.activityComment}
        </p>
      )}
      {observation.dataValidityNote !== undefined && (
        <p className="break-words text-xs text-muted-foreground">
          Data validity: {observation.dataValidityNote}
        </p>
      )}
      <p className="break-words text-xs text-muted-foreground" data-testid="imported-observation-source">
        Source:{' '}
        <a
          href={observation.provenance.url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2"
        >
          {observation.provenance.sourceName} record {observation.provenance.recordId}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>{' '}
        · retrieved {observation.provenance.retrievedAt.slice(0, 10)}
        {observation.provenance.licenseNotice !== undefined
          ? ` · ${observation.provenance.licenseNotice}`
          : ''}
      </p>
    </li>
  )
}

function SourceRecordSection({ record }: { readonly record: DrugSourceRecord }) {
  const identifiers = record.identifiers
  return (
    <section className="space-y-4" data-testid="source-record" aria-label={`${record.provenance.sourceName} source record`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">
          {record.name ?? record.sourceId}
        </h3>
        <Badge variant="secondary">{record.provenance.sourceName}</Badge>
        <span className="text-xs text-muted-foreground">
          record {record.sourceId} · imported {record.importedAt.slice(0, 10)}
        </span>
      </div>

      <div>
        <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Identifiers</h4>
        <dl className="grid gap-2 sm:grid-cols-2" data-testid="source-identifiers">
          <Field label="Preferred name" value={record.name} />
          <Field
            label="Synonyms"
            value={record.synonyms.length > 0 ? record.synonyms.join(', ') : undefined}
          />
          <Field label="CAS number" value={identifiers.casNumber} />
          <Field label="PubChem CID" value={identifiers.pubchemCid} />
          <Field label="ChEMBL ID" value={identifiers.chemblId} />
          <Field label="InChIKey" value={identifiers.inchiKey} />
        </dl>
      </div>

      <div>
        <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
          Chemical properties
        </h4>
        <dl className="grid gap-2 sm:grid-cols-2" data-testid="source-chemical-properties">
          <Field
            label="Molecular formula"
            value={identifiers.molecularFormula}
            notation="chemical"
          />
          <Field
            label="Molecular weight"
            value={
              identifiers.molecularWeight !== undefined
                ? `${identifiers.molecularWeight} g/mol`
                : undefined
            }
          />
          <Field label="SMILES" value={identifiers.smiles} />
        </dl>
      </div>

      <div>
        <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
          Source attribution
        </h4>
        <dl className="grid gap-2 sm:grid-cols-2" data-testid="source-attribution">
          <Field label="Source" value={record.provenance.sourceName} />
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">Source record</dt>
            <dd className="break-words text-sm">
              <a
                href={record.provenance.url}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2"
                data-testid="source-record-link"
              >
                {record.provenance.sourceName} record {record.provenance.recordId}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </dd>
          </div>
          <Field label="Retrieved" value={record.provenance.retrievedAt} />
          <Field label="Source version" value={record.provenance.sourceVersion} />
          <Field label="License" value={record.provenance.licenseNotice} />
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">License terms</dt>
            <dd className="break-words text-sm">
              {record.provenance.licenseUrl !== undefined ? (
                <a
                  href={record.provenance.licenseUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  {record.provenance.licenseUrl}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <span className="text-muted-foreground">not reported</span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
          Imported experimental observations
        </h4>
        <p className="mb-2 text-xs text-muted-foreground">
          Reported measurements, exactly as the source supplied them. They are not model parameters —
          use “Use as parameter…” in Data Sources to apply one, which keeps its own validation rules.
        </p>
        {record.observations.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="source-observations-empty">
            No measurements are stored for this source record.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="source-observations">
            {record.observations.map((observation) => (
              <ObservationRow key={observation.id} observation={observation} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** Every imported source record on one drug, or nothing when there is none. */
export function DrugSourceDataSection({
  records,
}: {
  readonly records: readonly DrugSourceRecord[] | undefined
}) {
  if (records === undefined || records.length === 0) return null
  return (
    <Card data-testid="drug-source-data">
      <CardHeader>
        <CardTitle headingLevel={2} className="text-base">
          Imported source data
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {records.map((record) => (
          <SourceRecordSection key={record.source} record={record} />
        ))}
      </CardContent>
    </Card>
  )
}
