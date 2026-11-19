#!/usr/bin/env node
/**
 * RUN A RELEASE'S STEPS AND RECORD WHAT EACH FOUND (DESIGN-RELEASE-EVIDENCE sections 4 and 5), against the
 * checkout's commit, into `backend/test-results/release/<commit>/`. The report (`release-report.mjs`) reads
 * the records; this runs no judgment of its own.
 *
 *   node scripts/release-steps.mjs gates                  # build, typecheck, synth, frontend lint/test/build
 *   node scripts/release-steps.mjs smoke [--item=<id>]    # the deployed smoke set, against the deployment
 *   node scripts/release-steps.mjs deny                   # the release's deny scripts, against the deployment
 *
 * Each item runs on its own, one after another, and is recorded the moment it finishes, so a killed run keeps
 * what it found. A smoke item runs `validate.mjs --only=<phase> [--spec=<name>] --strict`, and validate sets
 * E2E_REQUIRE_ALL=1, so a skip fails the item: a passed item ran with nothing skipped. An item the design calls
 * for and nothing builds yet (`pending`) is not run and is left for the report to name.
 *
 * A checkout with uncommitted changes still runs and records, marked dirty; the report refuses it.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gitState } from './lib/deployed-commit.mjs';
import { appendRecords } from './lib/release-records.mjs';

const require = createRequire(import.meta.url);
const { SMOKE_ITEMS, DENY_SCRIPTS, GATES } = require('./lib/release-smoke.cjs');

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(BACKEND, '..');
const [step, ...rest] = process.argv.slice(2);
const onlyItem = rest.find((a) => a.startsWith('--item='))?.slice('--item='.length);

function run(cmd, cwd) {
  console.log(`\n$ ${cmd.join(' ')}   (in ${path.relative(ROOT, cwd) || '.'})`);
  // `shell` so `npm` and `npx` resolve on Windows; every argument here is this file's own constant.
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
  return r.error ? 1 : (r.status ?? 1);
}

const state = gitState(BACKEND);
console.log(`release ${step}: ${state.head.slice(0, 8)}${state.dirty ? ' (uncommitted changes: the report will refuse these records)' : ''}`);

let failures = 0;
if (step === 'gates') {
  for (const g of GATES.filter((x) => !onlyItem || x.id === onlyItem)) {
    const exit = run(g.cmd, path.join(ROOT, g.cwd));
    appendRecords(state.head, 'gates', [{ id: g.id, outcome: exit === 0 ? 'passed' : 'failed', exit, dirty: state.dirty }]);
    if (exit !== 0) failures += 1;
  }
} else if (step === 'smoke') {
  for (const item of SMOKE_ITEMS.filter((x) => !onlyItem || x.id === onlyItem)) {
    if (item.pending) { console.log(`\nsmoke ${item.id}: NOT BUILT (${item.pending}); not run`); continue; }
    const args = ['node', path.join('scripts', 'validate.mjs'), `--only=${item.only}`, ...(item.spec ? [`--spec=${item.spec}`] : []), '--strict'];
    const exit = run(args, BACKEND);
    appendRecords(state.head, 'smoke', [{ id: item.id, outcome: exit === 0 ? 'passed' : 'failed', exit, dirty: state.dirty }]);
    if (exit !== 0) failures += 1;
  }
} else if (step === 'deny') {
  const names = DENY_SCRIPTS.filter((x) => !onlyItem || x.name === onlyItem).map((d) => d.name);
  failures += run(['node', path.join('scripts', 'run-deny-tests.mjs'), '--record', ...names], BACKEND) === 0 ? 0 : 1;
} else {
  console.error('usage: node scripts/release-steps.mjs gates|smoke|deny [--item=<id>]');
  process.exit(2);
}
process.exitCode = failures ? 1 : 0;
