#!/usr/bin/env node
/**
 * THE RELEASE REPORT (DESIGN-RELEASE-EVIDENCE): one JSON document per commit and deployment configuration,
 * generated last from the records each step wrote, and running no test itself.
 *
 *   AWS_PROFILE=<profile> node scripts/release-report.mjs [--config=deploy.config.json]
 *
 * It reads:
 *   - the checkout's commit and whether it is dirty (`gitState`);
 *   - the backend shard run on record (`test-results/shard-<n>.json` and the commit stamp beside each,
 *     `shard-<n>.meta.json`, written by `run-test-shards.mjs`);
 *   - the build gates, the deployed smoke set and the deny scripts (`release-steps.mjs`, `run-deny-tests.mjs
 *     --record`), from `test-results/release/<commit>/`;
 *   - every stack's deployed commit, from SSM `/<instance>/deployed-commit/<Stack>`.
 *
 * It writes `test-results/release/<commit>/report-<configuration key>.json` and exits 0 only when that report is
 * `proven`. The report holds no account id, instance name, URL, address or user name, so it can be published
 * beside the source. The verdict is decided in `lib/release-report.cjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { gitState } from './lib/deployed-commit.mjs';
import { REPORT_DIR, readRecords, releaseDir } from './lib/release-records.mjs';

const require = createRequire(import.meta.url);
const { configurationOf, releaseVerdict } = require('./lib/release-report.cjs');
const { SMOKE_ITEMS, DENY_SCRIPTS, GATES } = require('./lib/release-smoke.cjs');
const { DEPLOYED_COMMIT_DIR, parseDeployedCommitRecord } = require('./lib/deploy-guards.cjs');
const { resolveInstanceName } = require('./lib/stack-lookup.cjs');

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const configPath = path.resolve(BACKEND, args.find((a) => a.startsWith('--config='))?.slice('--config='.length) || 'deploy.config.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The shard run on record: its declared count, and each report's counts, commit stamp and skipped tests. */
function shardRecord() {
  const summary = readJson(path.join(REPORT_DIR, 'summary.json'));
  const declared = Number.isInteger(summary?.shards) ? summary.shards : null;
  const found = [];
  for (let i = 1; declared && i <= declared; i += 1) {
    const r = readJson(path.join(REPORT_DIR, `shard-${i}.json`));
    if (!r) continue;
    const meta = readJson(path.join(REPORT_DIR, `shard-${i}.meta.json`)) || {};
    const skippedNames = [];
    for (const suite of r.testResults || []) {
      for (const a of suite.assertionResults || []) {
        if (a.status === 'pending' || a.status === 'todo') skippedNames.push(`${path.relative(BACKEND, suite.name).replace(/\\/g, '/')}: ${a.fullName}`);
      }
    }
    found.push({
      shard: i,
      counts: {
        failed: r.numFailedTests ?? 0,
        failedSuites: (r.numFailedTestSuites ?? 0) + (r.numRuntimeErrorTestSuites ?? 0),
        success: r.success,
        skipped: (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0),
        tests: r.numTotalTests ?? 0,
      },
      commit: meta.commit ?? undefined,
      dirty: meta.dirty ?? undefined,
      shards: meta.shards ?? undefined,
      filtered: meta.filtered ?? undefined,
      skippedNames,
    });
  }
  return { declared, found };
}

/** Every stack's deployed-commit record, or null when SSM cannot be read. */
async function deployedCommits() {
  try {
    const ssm = new SSMClient({});
    const out = {};
    let NextToken;
    do {
      // eslint-disable-next-line no-await-in-loop -- pages of one listing
      const page = await ssm.send(new GetParametersByPathCommand({ Path: `/${resolveInstanceName()}/${DEPLOYED_COMMIT_DIR}`, NextToken }));
      for (const p of page.Parameters || []) out[p.Name.split('/').pop()] = parseDeployedCommitRecord(p.Value) || { commit: null };
      NextToken = page.NextToken;
    } while (NextToken);
    return out;
  } catch (err) {
    console.error(`deployed-commit records unreadable: ${err?.name || err}`);
    return null;
  }
}

const state = gitState(BACKEND);
const config = readJson(configPath);
if (!config) {
  console.error(`cannot read the deploy config at ${configPath}`);
  process.exit(2);
}
const configuration = configurationOf(config);
const dir = releaseDir(state.head);
const otherReports = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => /^report-.+\.json$/.test(f) && f !== `report-${configuration.key}.json`)
    .map((f) => readJson(path.join(dir, f))).filter(Boolean)
    .map((r) => ({ analyticsMode: r.configuration?.analyticsMode, verdict: r.verdict }))
  : [];
const shards = shardRecord();
const result = releaseVerdict({
  commit: state.head,
  dirty: state.dirty,
  configuration,
  shards,
  deployedCommits: await deployedCommits(),
  smokeItems: SMOKE_ITEMS,
  smoke: readRecords(state.head, 'smoke'),
  denyScripts: DENY_SCRIPTS,
  deny: readRecords(state.head, 'deny'),
  gates: readRecords(state.head, 'gates'),
  gateIds: GATES.map((g) => g.id),
  otherReports,
});

const report = {
  commit: state.head,
  dirty: state.dirty,
  generatedAt: new Date().toISOString(),
  configuration,
  backend: {
    shards: shards.declared,
    perShard: shards.found.map((s) => ({ shard: s.shard, commit: s.commit ?? null, tests: s.counts.tests, failed: s.counts.failed, failedSuites: s.counts.failedSuites, skipped: s.counts.skipped })),
    skipped: result.backend.skipped,
    skippedNames: result.backend.skippedNames,
  },
  gates: GATES.map((g) => {
    const rec = [...readRecords(state.head, 'gates')].reverse().find((x) => x.id === g.id);
    return { id: g.id, outcome: rec?.outcome ?? 'not-run' };
  }),
  smoke: result.smoke,
  deny: result.deny,
  verdict: result.verdict,
  reasons: result.reasons,
  release: result.release,
  releaseReasons: result.releaseReasons,
};
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `report-${configuration.key}.json`);
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`release report for ${state.head.slice(0, 8)}, configuration ${configuration.key}: ${result.verdict.toUpperCase()}`);
for (const r of result.reasons) console.log(`  - ${r}`);
if (result.backend.skipped) console.log(`  (${result.backend.skipped} backend test(s) skipped, listed in the report; a skip is not a pass)`);
console.log(`release (both analytics modes): ${result.release.toUpperCase()}${result.releaseReasons.length ? ` - ${result.releaseReasons.join('; ')}` : ''}`);
console.log(`written to ${path.relative(BACKEND, out)}`);
process.exitCode = result.verdict === 'proven' ? 0 : 1;
