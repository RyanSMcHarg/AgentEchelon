'use strict';
/**
 * THE REGISTRY'S ADMISSION DATA, READ AT RUNTIME BY A TRIGGER THAT CANNOT IMPORT THE REGISTRY.
 *
 * This directory is deployed with `lambda.Code.fromAsset` - a raw directory, not an esbuild bundle - so a
 * trigger here cannot import `lib/profile-registry`. It reads the same rows every bundled handler reads
 * (`loadProfileRegistry`): one SSM parameter per classification under the path the function is told
 * (`AE_PROFILE_REGISTRY_PATH`), published by the stack that owns the classification, and assembles the
 * admission data `lib/classification-admission.ts` builds from the registry:
 *
 *   - `groupClearance`: which group clears for which classification;
 *   - `grants`: what each classification reaches, the admin plane itself alone;
 *   - `clearanceGroups`: the groups clearing for a classification that is not the admin plane, exclusive of
 *     each other, in the order of the classification values;
 *   - `adminPlane`: the admin plane's values.
 *
 * So a classification added or removed changes no environment here. Pinned against the registry by
 * `backend/test/lib/admission-mirrors-the-registry.test.ts`.
 *
 * THE ROWS ARE ASSEMBLED PER ITEM, as `profilesConfigFromPublishedRows` assembles them for every other handler: a
 * row that cannot be read is left out, a second row for one classification is left out, and a grant naming a
 * classification no row declares is dropped, each logged and counted (`RegistryItemDropped`). A read that fails
 * keeps the data read before for at most twice the TTL from the last read that succeeded, and throws past it or
 * when there is none: the trigger never admits from data it guessed.
 */
const { gunzipSync } = require('zlib');

const TTL_MS = 5 * 60 * 1000;
/** How long the data may be kept, from the last read that succeeded, while reads fail (`PROFILE_REGISTRY_MAX_STALE_MS`). */
const MAX_STALE_MS = 2 * TTL_MS;
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
/** The registry's metric namespace (`PROFILE_REGISTRY_METRIC_NAMESPACE`, `lib/profile-registry.ts`). */
const NAMESPACE = 'AgentEchelon/ProfileRegistry';

/** One EMF line, the same document `emitEmfMetric` writes, so the count is the metric the registry's alarms read. */
function report(path, metric, fields) {
  console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [['RegistryPath']], Metrics: [{ Name: metric, Unit: 'Count' }] }] },
    RegistryPath: path, [metric]: 1, event: `profile-registry.${metric}`, ...fields,
  }));
}

/**
 * The rows the parameter values carry, each defect costing only its own item: what was left out is returned in
 * `dropped`, in the shape `RegistryDrop` (`lib/config/profiles.ts`) has.
 */
function rowsOfValues(values) {
  const dropped = [];
  const read = [];
  values.forEach((v, i) => {
    try { read.push(rowOf(v)); } catch (err) { dropped.push({ kind: 'unreadable-row', detail: `row ${i}: ${err && err.message ? err.message : String(err)}` }); }
  });
  read.sort((a, b) => (a.classification.value < b.classification.value ? -1 : a.classification.value > b.classification.value ? 1 : 0));
  const rows = [];
  for (const r of read) {
    if (rows.some((k) => k.classification.value === r.classification.value)) dropped.push({ kind: 'duplicate-row', classification: r.classification.value, detail: 'a second row for this classification' });
    else rows.push(r);
  }
  const present = new Set(rows.map((r) => r.classification.value));
  for (const r of rows) {
    if (r.classification.adminPlane || !Array.isArray(r.classification.grants)) continue;
    for (const g of r.classification.grants) {
      if (!present.has(g)) dropped.push({ kind: 'dangling-grant', classification: r.classification.value, detail: `grants '${g}', which no row declares` });
    }
  }
  return { rows, dropped };
}

/** The row a parameter value carries (`registryRowValue`, `lib/config/profiles.ts`). */
function rowOf(value) {
  const json = value.startsWith('gz64:') ? gunzipSync(Buffer.from(value.slice('gz64:'.length), 'base64')).toString('utf8') : value;
  const row = JSON.parse(json);
  if (!row || !row.classification || typeof row.classification.value !== 'string') throw new Error('registry-admission: a row is not a classification registry row');
  return row;
}

/** The admission data the rows assemble to, as `classificationAdmission` builds it from the registry. */
function admissionOfRows(rows) {
  const sorted = [...rows].sort((a, b) => (a.classification.value < b.classification.value ? -1 : a.classification.value > b.classification.value ? 1 : 0));
  const adminPlane = sorted.filter((r) => r.classification.adminPlane).map((r) => r.classification.value);
  const order = sorted.map((r) => r.classification.value);
  // In the order of the classification values, as `ProfileRegistry.grantsFor` answers.
  const inOrder = (values) => values.filter((v) => order.includes(v)).sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const grants = {};
  for (const r of sorted) grants[r.classification.value] = inOrder(r.classification.adminPlane ? [r.classification.value] : r.classification.grants);
  const groupClearance = {};
  for (const r of sorted) Object.assign(groupClearance, r.groupClearance || {});
  const clearanceGroups = Object.entries(groupClearance)
    .filter(([, value]) => order.includes(value) && !adminPlane.includes(value))
    .sort((a, b) => order.indexOf(a[1]) - order.indexOf(b[1]))
    .map(([group]) => group);
  return { groupClearance, grants, clearanceGroups, adminPlane };
}

// One client per container, with the SDK's adaptive retry, so a burst of cold starts backs off together.
let ssmClient = null;

async function readRows(path) {
  const { SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');
  if (!ssmClient) ssmClient = new SSMClient({ retryMode: 'adaptive', maxAttempts: 6 });
  const client = ssmClient;
  const values = [];
  let NextToken;
  do {
    const page = await client.send(new GetParametersByPathCommand({ Path: path, Recursive: false, MaxResults: 10, NextToken }));
    for (const p of page.Parameters || []) if (typeof p.Value === 'string') values.push(p.Value);
    NextToken = page.NextToken;
  } while (NextToken);
  return values;
}

// A test's row reader, held on the global object so a test that resets its modules still reaches this copy.
const TEST_READER = Symbol.for('agent-echelon.registry-admission.row-reader');
const reader = (path) => (globalThis[TEST_READER] || readRows)(path);
let cached = null;
let cachedAt = 0;
let readAt = 0;

/**
 * The deployment's admission data, read once per five minutes. Throws when the path is not set, when the first
 * read fails, and when reads have failed for longer than `MAX_STALE_MS` since the last that succeeded.
 */
async function loadAdmission() {
  const path = (process.env.AE_PROFILE_REGISTRY_PATH || '').trim();
  if (!path) throw new Error('registry-admission: AE_PROFILE_REGISTRY_PATH is not set');
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS && now - readAt < MAX_STALE_MS) return cached;
  try {
    const { rows, dropped } = rowsOfValues(await reader(path));
    if (dropped.length) {
      console.error(`[registry-admission] ${path}: ${dropped.length} item(s) left out of the set`, JSON.stringify(dropped));
      for (const d of dropped) report(path, 'RegistryItemDropped', { kind: d.kind, classification: d.classification || '', detail: d.detail });
    }
    cached = admissionOfRows(rows);
    cachedAt = readAt = Date.now();
  } catch (err) {
    report(path, 'RegistryReadFailed', { detail: err && err.message ? err.message : String(err) });
    const at = Date.now();
    if (!cached || at - readAt >= MAX_STALE_MS) {
      cached = null;
      throw err;
    }
    console.warn('[registry-admission] reading the registry failed; keeping the data read before', err);
    cachedAt = at - TTL_MS + RETRY_AFTER_FAILURE_MS;
  }
  return cached;
}

/** Test-only: replace the row reader (`undefined` restores SSM) and forget what was read. */
function __setRowReaderForTest(fn) {
  if (fn) globalThis[TEST_READER] = fn;
  else delete globalThis[TEST_READER];
  cached = null;
  cachedAt = 0;
  readAt = 0;
  ssmClient = null;
}

module.exports = { loadAdmission, admissionOfRows, rowsOfValues, rowOf, MAX_STALE_MS, __setRowReaderForTest };
