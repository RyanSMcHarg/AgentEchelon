/**
 * THE RELEASE REPORT'S VERDICT (DESIGN-RELEASE-EVIDENCE sections 3 and 9), decided from the records each
 * step wrote and nothing else.
 *
 * A release is the claim that one commit, deployed in one configuration, works. Every input here names the
 * commit it is about, and an input about another commit, an input that is missing, a skip and a step that did
 * not run all count as NOT PROVEN. The verdict lists each reason, so the reader knows which step to run next.
 *
 * PURE, so it is tested without a deployment or a suite: `release-report.mjs` reads the records and the
 * deployment, and this decides. NOT A JEST TEST FILE.
 */
const crypto = require('node:crypto');
const { shardFailed } = require('./shard-verdict.cjs');

/**
 * Deploy-config keys whose values name THIS deployment rather than what it is: addresses, mailboxes, network
 * ids and secrets. Two deployments of the same configuration differ only in these, so they are left out of the
 * configuration key, and the report never carries them (it is safe to publish beside the source).
 */
const DEPLOYMENT_SPECIFIC_KEYS = new Set([
  'appUrl', 'adminAppUrl', 'analyticsVpcId', 'analyticsVpcSubnetType', 'senderEmail', 'presenterMailbox',
  'cognitoEmailFromSender', 'cognitoEmailVerifiedDomain', 'imageGenKeysSecretArn', 'testInboxDomain',
  'testInboxBucket', 'testInboxPrefix', 'account', 'region', 'instanceName', 'notifyUserPoolId',
]);

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (k.startsWith('_') || DEPLOYMENT_SPECIFIC_KEYS.has(k)) continue;
      out[k] = normalized(value[k]);
    }
    return out;
  }
  return value;
}

/** What the configuration is, without what makes it this deployment: mode, capabilities and its key. */
function configurationOf(config) {
  const analyticsMode = typeof config?.analyticsMode === 'string' && config.analyticsMode ? config.analyticsMode : 'athena';
  const capabilities = Array.isArray(config?.capabilities) ? [...config.capabilities].map(String).sort() : [];
  const hash = crypto.createHash('sha256').update(JSON.stringify(normalized(config || {}))).digest('hex').slice(0, 8);
  return { analyticsMode, capabilities, key: `${analyticsMode}-${hash}` };
}

/** The smoke items and deny scripts a configuration owes: those whose required capabilities it declares. */
function applicable(items, capabilities) {
  const declared = new Set(capabilities || []);
  return (items || []).filter((i) => (i.requires || []).every((c) => declared.has(c)));
}

/**
 * The verdict for one commit and configuration.
 *
 * @param {object} r
 * @param {string} r.commit  the checkout's HEAD
 * @param {boolean} r.dirty  whether the checkout differs from it
 * @param {object} r.configuration  `configurationOf(config)`
 * @param {{ declared: number|null, found: Array<{ shard: number, counts: object|null, commit?: string, dirty?: boolean, shards?: number, filtered?: boolean, skippedNames?: string[] }> }} r.shards
 * @param {Record<string, { commit: string, dirty?: boolean }>|null} r.deployedCommits  per stack; null when unreadable
 * @param {Array<{ id: string, requires?: string[], pending?: string }>} r.smokeItems  the declared smoke set
 * @param {Array<{ id: string, commit?: string, outcome: 'passed'|'failed', exit?: number }>} r.smoke  smoke records
 * @param {Array<{ name: string, requires?: string[] }>} r.denyScripts  the declared deny set
 * @param {Array<{ name: string, kind: string, commit?: string }>} r.deny  deny records
 * @param {Array<{ id: string, commit?: string, outcome: 'passed'|'failed' }>} r.gates  build, typecheck and frontend gates
 * @param {string[]} r.gateIds  the gates a release owes
 * @param {Array<{ analyticsMode: string, verdict: string }>} [r.otherReports]  reports for the same commit
 */
function releaseVerdict(r) {
  const reasons = [];
  const commit = r.commit;
  if (r.dirty) reasons.push('the checkout has uncommitted changes, so it is not the commit being released');

  // BACKEND SHARDS: one run, every shard present, none failed, every one stamped with this commit.
  const declared = Number.isInteger(r.shards?.declared) && r.shards.declared > 0 ? r.shards.declared : null;
  const found = r.shards?.found || [];
  let skipped = 0;
  const skippedNames = [];
  if (!declared) {
    reasons.push('no shard run is on record (backend/test-results/summary.json names no shard count)');
  } else {
    const byShard = new Map(found.map((s) => [s.shard, s]));
    for (let i = 1; i <= declared; i += 1) {
      const s = byShard.get(i);
      if (!s || !s.counts) { reasons.push(`shard ${i}/${declared} has no report`); continue; }
      if (s.shards && s.shards !== declared) reasons.push(`shard ${i} ran as part of a ${s.shards}-shard run, not ${declared}`);
      if (!s.commit) reasons.push(`shard ${i}/${declared} records no commit, so it cannot be tied to this release`);
      else if (s.commit !== commit) reasons.push(`shard ${i}/${declared} ran against ${s.commit.slice(0, 8)}, not ${commit.slice(0, 8)}`);
      if (s.dirty) reasons.push(`shard ${i}/${declared} ran on a checkout with uncommitted changes`);
      if (s.filtered) reasons.push(`shard ${i}/${declared} ran a filtered subset of the suite`);
      if (shardFailed(s.counts)) reasons.push(`shard ${i}/${declared} records a failure`);
      skipped += s.counts.skipped ?? 0;
      for (const n of s.skippedNames || []) skippedNames.push(n);
    }
  }

  // GATES: build, typecheck, synth and the frontend's lint, unit tests and build, for this commit.
  for (const id of r.gateIds || []) {
    const g = (r.gates || []).find((x) => x.id === id && x.commit === commit);
    if (!g) reasons.push(`gate ${id} has no record for this commit`);
    else if (g.outcome !== 'passed') reasons.push(`gate ${id} failed`);
  }

  // DEPLOYMENT: every stack's recorded commit is this one, so the smoke ran against this code.
  if (!r.deployedCommits) {
    reasons.push('the deployed-commit records could not be read');
  } else if (Object.keys(r.deployedCommits).length === 0) {
    reasons.push('no stack records a deployed commit');
  } else {
    for (const [stack, rec] of Object.entries(r.deployedCommits).sort()) {
      if (rec?.commit !== commit) reasons.push(`stack ${stack} runs ${String(rec?.commit || 'an unknown commit').slice(0, 8)}, not ${commit.slice(0, 8)}`);
      else if (rec.dirty) reasons.push(`stack ${stack} was deployed from a checkout with uncommitted changes`);
    }
  }

  // SMOKE: every applicable item ran against this commit and passed. A skip fails its item under
  // E2E_REQUIRE_ALL, so a passed item ran with no skip. An item not yet built is named, not excused.
  const owedSmoke = applicable(r.smokeItems, r.configuration?.capabilities);
  const notApplicable = (r.smokeItems || []).filter((i) => !owedSmoke.includes(i)).map((i) => i.id);
  const smokeRows = [];
  for (const item of owedSmoke) {
    const rec = [...(r.smoke || [])].reverse().find((s) => s.id === item.id && s.commit === commit);
    if (item.pending) { reasons.push(`smoke ${item.id} is NOT BUILT: ${item.pending}`); smokeRows.push({ id: item.id, outcome: 'not-built' }); continue; }
    if (!rec) { reasons.push(`smoke ${item.id} did not run against this commit`); smokeRows.push({ id: item.id, outcome: 'not-run' }); continue; }
    if (rec.outcome !== 'passed') reasons.push(`smoke ${item.id} failed (exit ${rec.exit ?? '?'})`);
    smokeRows.push({ id: item.id, outcome: rec.outcome });
  }

  // DENY: every applicable script held, on this commit's deployment.
  const owedDeny = applicable(r.denyScripts, r.configuration?.capabilities);
  const denyRows = [];
  for (const script of owedDeny) {
    const rec = [...(r.deny || [])].reverse().find((d) => d.name === script.name && d.commit === commit);
    if (!rec) { reasons.push(`deny ${script.name} did not run against this commit`); denyRows.push({ name: script.name, kind: 'not-run' }); continue; }
    if (rec.kind !== 'held') reasons.push(`deny ${script.name}: ${rec.kind}`);
    denyRows.push({ name: script.name, kind: rec.kind });
  }

  // THE OTHER ANALYTICS MODE: a release needs a proven report for each.
  const mode = r.configuration?.analyticsMode;
  const otherMode = mode === 'aurora' ? 'athena' : 'aurora';
  const otherProven = (r.otherReports || []).some((o) => o.analyticsMode === otherMode && o.verdict === 'proven');
  const releaseReasons = otherProven ? [] : [`no proven report for ${otherMode} mode at this commit`];

  return {
    verdict: reasons.length === 0 ? 'proven' : 'not-proven',
    reasons,
    release: reasons.length === 0 && releaseReasons.length === 0 ? 'proven' : 'not-proven',
    releaseReasons,
    backend: { shards: declared, skipped, skippedNames },
    smoke: { rows: smokeRows, notApplicable },
    deny: { rows: denyRows, notApplicable: (r.denyScripts || []).filter((s) => !owedDeny.includes(s)).map((s) => s.name) },
  };
}

module.exports = { configurationOf, releaseVerdict, applicable, DEPLOYMENT_SPECIFIC_KEYS };
