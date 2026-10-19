#!/usr/bin/env node
/**
 * Live ChEMBL smoke check — manual, explicit, never part of CI.
 *
 * Probes the exact request URLs this app builds (the same paths and query
 * parameters as `src/data/sources/chembl.ts`) against the real ChEMBL
 * web services, and reports status, content type and response shape.
 * CI runs only deterministic mocked-fixture tests (no live network); this
 * script exists for the occasional manual live check described in
 * `docs/data-sources.md` §3 ("Deterministic tests vs live verification").
 *
 * The target-search check pins the documented JSON endpoint
 * (`target/search.json`): the API's default format without a suffix is
 * XML, so the format must be part of the request — this script makes a
 * regression to a format-less path visible in the report.
 *
 * Usage:  npm run smoke:chembl
 * Network: three GET requests, nothing is written anywhere. Exits
 * non-zero when any check fails.
 */
const BASE = 'https://www.ebi.ac.uk/chembl/api/data'

const checks = [
  {
    name: 'target search, documented JSON endpoint (target/search.json)',
    url: `${BASE}/target/search.json?q=lipoxygenase&limit=2`,
    expect: (body) => Array.isArray(body?.targets) && body.targets.length > 0,
  },
  {
    name: 'activity page, default parameter-endpoint filter',
    url: `${BASE}/activity.json?molecule_chembl_id=CHEMBL25&limit=1&offset=0&standard_type__in=${encodeURIComponent('Ki,Kd,IC50,EC50')}`,
    expect: (body) => Array.isArray(body?.activities),
  },
  {
    name: 'compound search (preferred-name filter)',
    url: `${BASE}/molecule.json?pref_name__icontains=aspirin&limit=1`,
    expect: (body) => Array.isArray(body?.molecules),
  },
]

let failures = 0

for (const check of checks) {
  try {
    const response = await fetch(check.url, { headers: { Accept: 'application/json' } })
    const contentType = response.headers.get('content-type') ?? ''
    const shapeOk = response.ok && contentType.includes('json') && check.expect(await response.json())
    console.log(
      `${shapeOk ? 'PASS' : 'FAIL'}  ${check.name}\n` +
        `      ${response.status} ${contentType || '(no content type)'}\n` +
        `      ${check.url}`,
    )
    if (!shapeOk) failures += 1
  } catch (error) {
    failures += 1
    console.log(
      `FAIL  ${check.name}\n      ${error instanceof Error ? error.message : String(error)}\n      ${check.url}`,
    )
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} live smoke check(s) failed. The adapter requires an explicit .json format on every request — never weaken the URLs to diagnose an outage.`,
  )
  process.exit(1)
}

console.log('\nAll live ChEMBL smoke checks passed.')
