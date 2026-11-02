/**
 * What the RAG sync uploads, and when it may call the corpus ingested (`scripts/sync-project-knowledge.mjs --rag`).
 *
 * The sync used to put every key on every run and report success once the puts returned. That said nothing about
 * the corpus: DocumentIngestion runs on the S3 event, asynchronously, in the analytics VPC, and an invoke that timed
 * out left the object in S3 with no chunks while every phase reported success. These are the decisions that close
 * it, kept free of AWS so they are tested:
 *
 *   - a key is put when it is new, when its content changed (the `content-sha256` metadata the sync writes), or when
 *     the database holds no chunks for it, which re-fires the S3 event that ingests it; an unchanged key the
 *     database already holds is not put, so a run does not re-ingest the corpus;
 *   - after the puts, the corpus is ingested when every key holds chunks written at the ETag S3 now has for it.
 */

/** The object metadata key the sync writes each upload's content hash under (S3 returns it lower-cased). */
const CONTENT_HASH_METADATA = 'content-sha256';

/**
 * The puts a run makes. `corpus`: `[{ key, sha256 }]`. `heads`: key -> `{ sha256, etag }` for an object S3 holds (its
 * content-hash metadata, or undefined, and its ETag), absent for one it does not. `coverage`: key -> `{ chunks, etag }`
 * from the database, or null when the database could not be asked (every key is then put, as before the check
 * existed). Returns `{ put: [{ key, reason }], unchanged: [key] }`, reasons `new` | `changed` | `coverage-unknown` |
 * `no-chunks` | `stale-chunks` (chunks written at another ETag than the object's).
 */
function planRagSync({ corpus, heads, coverage }) {
  const put = [];
  const unchanged = [];
  for (const { key, sha256 } of corpus) {
    const head = heads.get(key);
    const held = coverage?.get(key);
    if (!head) put.push({ key, reason: 'new' });
    else if (head.sha256 !== sha256) put.push({ key, reason: 'changed' });
    else if (!coverage) put.push({ key, reason: 'coverage-unknown' });
    else if (!(held?.chunks > 0)) put.push({ key, reason: 'no-chunks' });
    else if (head.etag && held.etag && stripQuotes(held.etag) !== stripQuotes(head.etag)) put.push({ key, reason: 'stale-chunks' });
    else unchanged.push(key);
  }
  return { put, unchanged };
}

const stripQuotes = (etag) => String(etag ?? '').replace(/"/g, '');

/**
 * The keys not yet ingested at their current content: no chunks, or chunks written at an ETag other than the one S3
 * holds now (the previous version's, before the new one's ingest has run). `etags`: key -> the object's S3 ETag.
 */
function unsettledKeys({ keys, etags, coverage }) {
  return keys.filter((key) => {
    const c = coverage.get(key);
    if (!c || !(c.chunks > 0)) return true;
    const want = stripQuotes(etags.get(key));
    return Boolean(want) && stripQuotes(c.etag) !== want;
  });
}

/**
 * Wait, bounded, until every key is ingested at its current ETag. DocumentIngestion emits no completion signal the
 * sync could subscribe to, so this reads the database (`read()` -> the coverage map) at a fixed interval until every
 * key settles or `timeoutMs` passes. Returns `{ settled, unsettled }`. `sleep` and `now` are injectable for tests.
 */
async function waitForIngest({ keys, etags, read, timeoutMs, intervalMs, sleep, now = Date.now, onPoll = () => {} }) {
  const deadline = now() + timeoutMs;
  let unsettled = keys;
  for (;;) {
    const coverage = await read();
    unsettled = unsettledKeys({ keys, etags, coverage });
    onPoll(unsettled);
    if (!unsettled.length) return { settled: true, unsettled };
    if (now() + intervalMs > deadline) return { settled: false, unsettled };
    await sleep(intervalMs);
  }
}

/** The coverage op's answer (`ragSourceCoverage`, data plane) as a key -> `{ chunks, etag }` map. */
function coverageMap(answer) {
  return new Map((answer?.sources || []).map((s) => [s.key, { chunks: Number(s.chunks) || 0, etag: s.etag ?? null }]));
}

module.exports = { CONTENT_HASH_METADATA, planRagSync, unsettledKeys, waitForIngest, coverageMap };
