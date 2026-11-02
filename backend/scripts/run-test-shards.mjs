#!/usr/bin/env node
/**
 * Run the backend Jest suite as N shards, ONE AT A TIME.
 *
 * Two separate constraints meet here, and each one alone suggests the wrong fix:
 *
 * 1. The whole suite in a single Jest run exceeds the 10-minute limit an automated shell call
 *    gets, so it is killed mid-run. A killed pool reports "Jest worker encountered N child
 *    process exceptions", which reads exactly like a product regression. Splitting into shards
 *    solves that.
 * 2. Shards run CONCURRENTLY hard-lock the machine. Each Jest process runs 4 workers holding a
 *    full TypeScript program with `cache: false`, so four shards is 16 compiling workers. This
 *    has cost a session's uncommitted work.
 *
 * So: shard, but serially, from a single supervising process. That process holds an exclusive
 * lock for its whole lifetime, which is what makes "serially" true even when something else in
 * the session tries to start a second run.
 *
 * ── A KILLED RUN MUST STILL TELL YOU WHAT IT LEARNED ────────────────────────────────────────────
 *
 * The third constraint, and the one that used to lose whole runs. A full pass takes longer than a
 * foreground tool call allows, so it gets moved to the background - and a backgrounded run here is
 * killed often enough that it should be assumed. This script used to write its shard reports into
 * a `mkdtemp` directory nobody could name, print its summary only at the very end, and delete the
 * directory on the way out. A run killed at minute 40 therefore produced NOTHING: not the shards
 * that had passed, not the failures it had already found. That has happened twice in one session.
 *
 * So results are durable and incremental now. Each shard's report lands in `test-results/` under
 * the backend root the moment it finishes, `summary.json` and `progress.log` are rewritten after
 * every shard, and a one-line verdict is printed per shard rather than saved for a summary the
 * caller may never reach. Nothing is deleted at the end. A killed run leaves a readable record of
 * everything up to the kill.
 *
 * And it is RESUMABLE, which is what makes a 45-minute suite runnable in an environment that only
 * grants 10 minutes at a time: run the shards one or a few at a time and the reports accumulate.
 *
 *   node scripts/run-test-shards.mjs                 # 4 shards, serially
 *   node scripts/run-test-shards.mjs --shards=8      # smaller shards, each likelier to fit
 *   node scripts/run-test-shards.mjs --only=3        # just shard 3, keeping earlier reports
 *   node scripts/run-test-shards.mjs --from=3        # resume at shard 3 after a kill
 *   node scripts/run-test-shards.mjs --report        # print the accumulated summary, run nothing
 *   node scripts/run-test-shards.mjs -- --silent     # everything after -- goes to jest
 *
 * Every shard runs even after one fails: a partial picture is how a red suite gets recorded as
 * "one known failure" when there were three.
 *
 * THE VERDICT IS THE RECORD'S, NOT THIS INVOCATION'S. Exit status is non-zero unless EVERY shard on
 * record has a report and NONE of those reports holds a failure, including a failure an earlier
 * invocation recorded. `--only=6` passing its one shard does not make a suite whose shard 11 failed
 * earlier green. `--report` prints the same verdict and exits the same way. See
 * `lib/shard-verdict.cjs`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lock = require('./lib/test-run-lock.cjs');
const { shardVerdict, shardFailed } = require('./lib/shard-verdict.cjs');

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Several suites read files above `backend/` (the docs guards, the coverage matrix, the e2e tree),
// so the staleness check has to be able to see them.
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

function parseArgs(argv) {
  const passThroughAt = argv.indexOf('--');
  const ours = passThroughAt === -1 ? argv : argv.slice(0, passThroughAt);
  const jestArgs = passThroughAt === -1 ? [] : argv.slice(passThroughAt + 1);

  let shards = 4;
  // WHETHER THE CALLER SAID SO, which `--report` needs: a default that silently disagrees with the
  // run being reported produces a total for a different run than the one that happened.
  let shardsExplicit = false;
  let from = 1;
  let only = null;
  let reportOnly = false;
  for (const arg of ours) {
    let m = /^--shards=(\d+)$/.exec(arg);
    if (m) { shards = Number(m[1]); shardsExplicit = true; continue; }
    m = /^--from=(\d+)$/.exec(arg);
    if (m) { from = Number(m[1]); continue; }
    m = /^--only=(\d+)$/.exec(arg);
    if (m) { only = Number(m[1]); continue; }
    if (arg === '--report') { reportOnly = true; continue; }
    // An unrecognised flag is far more likely a typo than an intent, and silently ignoring it
    // means running the wrong thing for 20 minutes before finding out.
    console.error(`Unrecognised option: ${arg}`);
    console.error('Usage: node scripts/run-test-shards.mjs '
      + '[--shards=N] [--from=N] [--only=N] [--report] [-- <jest args>]');
    process.exit(2);
  }
  if (!Number.isInteger(shards) || shards < 1 || shards > 16) {
    console.error(`--shards must be between 1 and 16 (got ${shards}).`);
    process.exit(2);
  }
  // CHECKED AGAINST THE SHARD COUNT, because `--only=9 --shards=4` is a typo that would otherwise
  // run nothing and exit green, which is the shape of a false pass.
  for (const [name, v] of [['--from', from], ['--only', only]]) {
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > shards)) {
      console.error(`${name} must be between 1 and ${shards} (got ${v}).`);
      process.exit(2);
    }
  }
  return { shards, shardsExplicit, from, only, reportOnly, jestArgs };
}

/**
 * Locate the jest CLI on disk. Deliberately NOT `require.resolve('jest/bin/jest.js')` - jest's
 * package.json `exports` map does not declare that subpath, so resolution fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED even though the file is right there. Spawning the binary directly
 * (rather than going through `npx`) also keeps the argv out of a shell, so nothing has to be
 * quoted for Windows.
 */
function jestBin() {
  const candidates = [
    path.join(BACKEND_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
    path.join(BACKEND_ROOT, 'node_modules', 'jest-cli', 'bin', 'jest.js'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  console.error('Could not find the jest CLI at either of:');
  for (const c of candidates) console.error(`  ${c}`);
  console.error('Run `npm ci` in backend/ first.');
  return process.exit(2);
}

/**
 * Run one shard to completion. Output is inherited so progress is visible live; the machine
 * -readable counts go to a file, because parsing them back out of the inherited stream is not
 * possible and re-running to get them is not acceptable.
 */
function runShard(bin, index, total, jestArgs, reportPath) {
  return new Promise((resolve) => {
    const args = [
      bin,
      `--shard=${index}/${total}`,
      '--json',
      `--outputFile=${reportPath}`,
      // A FILTERED run legitimately leaves some shards with nothing to do, and jest exits 1 on
      // "no tests found" - which would report a green suite as failed. An UNFILTERED run has
      // hundreds of files across a handful of shards, so an empty shard there is a real anomaly
      // and is left to fail loudly rather than being papered over.
      ...(jestArgs.length > 0 ? ['--passWithNoTests'] : []),
      ...jestArgs,
    ];
    const child = spawn(process.execPath, args, { cwd: BACKEND_ROOT, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`\nShard ${index}/${total} failed to start: ${err.message}`);
      resolve({ code: 1, counts: null });
    });
    child.on('close', (code, signal) => {
      resolve({ code: signal ? 1 : (code ?? 1), signal, counts: readCounts(reportPath) });
    });
  });
}

function readCounts(reportPath) {
  try {
    const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return {
      suites: r.numTotalTestSuites ?? 0,
      tests: r.numTotalTests ?? 0,
      failed: r.numFailedTests ?? 0,
      // A suite that fails to compile or throws at module scope has ZERO failed tests, so these are
      // what keep it from reading as a pass.
      failedSuites: (r.numFailedTestSuites ?? 0) + (r.numRuntimeErrorTestSuites ?? 0),
      success: r.success,
      skipped: (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0),
    };
  } catch {
    return null; // the shard died before writing one; the inherited output is the record
  }
}

/**
 * Where results live: stable, gitignored, and never deleted.
 *
 * It used to be a `mkdtemp` directory removed on the way out, which meant a killed run left
 * nothing behind and an interrupted one left an unreachable directory with a random name. The
 * point of a report is to outlive the process that wrote it.
 */
const REPORT_DIR = path.join(BACKEND_ROOT, 'test-results');

/**
 * Every shard report on disk, whether this invocation wrote it or an earlier one did.
 *
 * READ BACK FROM DISK rather than remembered in memory, which is exactly what makes a resumed run
 * total correctly: the process running shard 3 cannot know what shards 1 and 2 found unless it
 * reads what they wrote.
 */
function collectResults(shards) {
  const out = [];
  for (let i = 1; i <= shards; i++) {
    const reportPath = path.join(REPORT_DIR, `shard-${i}.json`);
    const counts = readCounts(reportPath);
    if (!counts) continue;
    // WHEN, not just what. A report is evidence about the tree as it stood when the shard ran, and
    // the verdict compares this against the newest source change to catch a green line standing over
    // reports that predate the code. An unreadable mtime is left undefined rather than guessed.
    let at;
    try { at = fs.statSync(reportPath).mtimeMs; } catch { /* unmeasured, never called stale */ }
    out.push({ shard: i, counts, at });
  }
  return out;
}

/**
 * When the newest file the suite exercises last changed, epoch ms, or null if nothing can be read.
 *
 * INCLUDES THE DOCS, and that is deliberate rather than over-broad: several suites in this repo read
 * `docs/` and `README.md` directly (the drift guard, the code-reference guards, the coverage matrix,
 * the knobs table), so a documentation edit really can turn a passing shard red. Leaving them out
 * would make the staleness rule quietly wrong in exactly the cases those guards exist to catch.
 *
 * `test-results` is excluded because it is this mechanism's own output: including it would make every
 * run instantly stale against itself.
 *
 * MTIME, NOT CONTENT, with the trade-off taken deliberately. A `touch`, a branch checkout, or a
 * formatter that rewrites a file byte-for-byte all move an mtime without changing what the suite
 * would find, so this errs toward declaring a stale run that is really still valid. That direction is
 * the safe one: the cost is re-running a shard, while the opposite error is the false green this rule
 * exists to stop. Content hashing would be exact and is the upgrade if the false positives ever
 * become annoying enough to pay for; mtime is what `make` and every build tool of its generation use,
 * and it needs no cache of its own.
 */
function newestSourceChangeMs() {
  const roots = [
    path.join(BACKEND_ROOT, 'lambda'),
    path.join(BACKEND_ROOT, 'lib'),
    path.join(BACKEND_ROOT, 'bin'),
    path.join(BACKEND_ROOT, 'test'),
    path.join(BACKEND_ROOT, 'scripts'),
    path.join(BACKEND_ROOT, 'package.json'),
    path.join(BACKEND_ROOT, 'jest.config.js'),
    path.join(REPO_ROOT, 'tests'),
  ];
  const SKIP = new Set(['node_modules', 'cdk.out', 'test-results', '.git', 'dist', 'coverage']);
  let newest = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (SKIP.has(path.basename(p))) return;
      let entries;
      try { entries = fs.readdirSync(p); } catch { return; }
      for (const e of entries) walk(path.join(p, e));
      return;
    }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const r of roots) walk(r);
  return newest > 0 ? newest : null;
}

/**
 * When the newest DOCUMENTATION file last changed.
 *
 * SEPARATE FROM THE CODE WALK, because it invalidates far less. A handful of suites read the docs
 * tree - they check that a document's code citations resolve and that its cited line numbers are
 * inside the files they name - so a markdown edit genuinely can turn one of those red. It cannot
 * touch a shard that never opens a `.md` file.
 *
 * Folding docs into the code walk made every markdown edit cost a full twelve-shard re-run, about
 * twenty-five minutes, to re-prove work the edit could not have affected. Correcting one citation in
 * a design record charged the same as changing the router.
 */
function newestDocsChangeMs() {
  const roots = [path.join(REPO_ROOT, 'docs'), path.join(REPO_ROOT, 'README.md')];
  const SKIP = new Set(['node_modules', '.git']);
  let newest = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (SKIP.has(path.basename(p))) return;
      let entries;
      try { entries = fs.readdirSync(p); } catch { return; }
      for (const e of entries) walk(path.join(p, e));
      return;
    }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const r of roots) walk(r);
  return newest > 0 ? newest : null;
}

/**
 * Which shards ran a suite that READS the docs tree.
 *
 * Derived from the reports rather than from a hand-kept list of suite names, for the reason every
 * other derived check in this repository exists: a list would be right when written and silently
 * wrong the first time somebody adds a suite that reads a document. A suite counts as doc-reading
 * when its own source mentions the docs directory or a markdown file.
 *
 * FAILS TOWARD STALE. A suite whose source cannot be read is treated as doc-reading, so the shard
 * stays answerable to documentation changes. Being wrong here costs one re-run; the other direction
 * would report a shard as proven when a doc edit had in fact broken it.
 */
function docsReadingShards(shards) {
  const reads = (file) => {
    try {
      const src = fs.readFileSync(file, 'utf8');
      return /['"`\/]docs[\/'"`]/.test(src) || /\.md['"`)]/.test(src) || /README\.md/.test(src);
    } catch {
      return true;
    }
  };
  const cache = new Map();
  const out = [];
  for (const { shard, raw } of collectRawResults(shards)) {
    const suites = (raw?.testResults || []).map((t) => t?.name).filter(Boolean);
    let any = false;
    for (const f of suites) {
      if (!cache.has(f)) cache.set(f, reads(f));
      if (cache.get(f)) { any = true; break; }
    }
    if (any) out.push(shard);
  }
  return out;
}

/** Every report on disk, parsed, for callers that need more than the counts. */
function collectRawResults(shards) {
  const out = [];
  for (let i = 1; i <= shards; i++) {
    const f = path.join(REPORT_DIR, `shard-${i}.json`);
    try {
      out.push({ shard: i, raw: JSON.parse(fs.readFileSync(f, 'utf8')) });
    } catch { /* no report, or unreadable: nothing to classify */ }
  }
  return out;
}

/** The three measurements the staleness rule needs, gathered in one place so the two callers agree. */
function staleInputs(shards) {
  return {
    sourceChangedAt: newestSourceChangeMs(),
    docsChangedAt: newestDocsChangeMs(),
    docsReadingShards: docsReadingShards(shards),
  };
}

/**
 * Print what is known so far. Safe to call after every shard, and after a kill.
 *
 * `persist` IS OFF FOR READERS, and that is not a detail. `--report` calling this with persistence on
 * REWROTE `summary.json` with whatever shard count the reader happened to assume, so reading an
 * 8-shard run with the default of 4 rewrote the record as a 4-shard run - and the next resume then
 * believed it. Reading a record must never edit it.
 */
function printSummary(shards, elapsedMin, persist = false) {
  const found = collectResults(shards);
  const totals = { suites: 0, tests: 0, failed: 0, skipped: 0 };
  for (const r of found) for (const k of Object.keys(totals)) totals[k] += r.counts[k];

  const seen = new Set(found.map((r) => r.shard));
  const missing = [];
  for (let i = 1; i <= shards; i++) if (!seen.has(i)) missing.push(i);

  console.log(`\n===== summary${elapsedMin ? ` (${elapsedMin} min this run)` : ''} =====\n`);
  for (const r of found) {
    console.log(
      `  shard ${r.shard}/${shards}: ${shardFailed(r.counts) ? 'FAIL' : 'pass'} - `
      + `${r.counts.suites} suites, ${r.counts.tests} tests, `
      + `${r.counts.failed} failed, ${r.counts.skipped} skipped`
      + (r.counts.failedSuites ? `, ${r.counts.failedSuites} suite(s) failed to run` : ''),
    );
  }
  console.log('');
  console.log(
    `  TOTAL: ${totals.suites} suites, ${totals.tests} tests, `
    + `${totals.failed} failed, ${totals.skipped} skipped`,
  );
  // NAMED, not counted. "3 shards missing" tells you the total is incomplete; "shards 2, 3, 4
  // have no report" tells you which command to run next.
  if (missing.length) {
    console.log('');
    console.log(`  INCOMPLETE - no report from shard(s) ${missing.join(', ')}.`);
    console.log(`  Resume with: node scripts/run-test-shards.mjs --shards=${shards} --from=${missing[0]}`);
  }
  // NAMED THE SAME WAY, and for the same reason: "some reports are old" is not something a reader can
  // act on, but a shard list and the command that refreshes it is.
  const staleNow = shardVerdict(shards, found, staleInputs(shards)).stale;
  if (staleNow.length) {
    console.log('');
    console.log(`  STALE - shard(s) ${staleNow.join(', ')} last ran before the source changed.`);
    console.log(`  Re-run each: node scripts/run-test-shards.mjs --shards=${shards} --only=<n>`);
  }
  if (persist) {
    try {
      fs.writeFileSync(
        path.join(REPORT_DIR, 'summary.json'),
        JSON.stringify({ shards, totals, present: [...seen], missing, stale: staleNow }, null, 2),
      );
    } catch { /* the printed summary is the record; a failed write must not fail the run */ }
  }
  // FROM THE SAME `found` THE TOTAL ABOVE WAS SUMMED FROM, so the verdict cannot disagree with it.
  return {
    totals,
    missing,
    verdict: shardVerdict(shards, found, staleInputs(shards)),
  };
}

/**
 * How many shards the run on disk was split into.
 *
 * `--report` MUST DESCRIBE THE RUN THAT HAPPENED, not the default. Reporting an 8-shard run against
 * a default of 4 reads the first four reports, finds them all green, and prints a complete-looking
 * TOTAL for half a run - the same "looks finished, is not" failure this script exists to stop
 * elsewhere. The count is recorded by the run itself, so it is read back rather than assumed.
 */
function shardsOfRecordedRun(fallback) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, 'summary.json'), 'utf8'));
    if (Number.isInteger(s?.shards) && s.shards >= 1) return s.shards;
  } catch { /* no previous run to describe; the caller's value is all there is */ }
  return fallback;
}

async function main() {
  const { shards, shardsExplicit, from, only, reportOnly, jestArgs } = parseArgs(process.argv.slice(2));

  fs.mkdirSync(REPORT_DIR, { recursive: true });

  // READING THE RECORD IS NOT RUNNING TESTS, so it takes no lock and can be done while a run is in
  // flight - which is the point, since that is when you most want to know where it has got to.
  if (reportOnly) {
    const { verdict } = printSummary(shardsExplicit ? shards : shardsOfRecordedRun(shards), null);
    console.log(`\n${verdict.line}`);
    process.exit(verdict.proven ? 0 : 1);
  }

  // RESUMING INTO A DIFFERENT SPLIT IS REFUSED, because shard 3 of 4 and shard 3 of 8 are different
  // sets of files under the same report name. Allowing it would overwrite one with the other and
  // total them together, producing a number that counts some files twice and others not at all -
  // and it would look like a clean full run.
  const recorded = shardsOfRecordedRun(null);
  if ((only !== null || from > 1) && recorded !== null && recorded !== shards) {
    console.error(`REFUSING TO RESUME: the run on disk was split into ${recorded} shards, not ${shards}.`);
    console.error(`  Continue it with --shards=${recorded}, or start a fresh full run to replace it.`);
    process.exit(2);
  }

  const held = lock.acquire(`run-test-shards --shards=${shards}`);
  if (!held) {
    const other = lock.readLock();
    console.error('REFUSING TO START: another test run is already in progress.');
    if (other) {
      const mins = lock.heldForMinutes(other);
      console.error(`  Holder : ${other.label} (pid ${other.pid} on ${other.host})`);
      console.error(`  Started: ${other.startedAt}${mins === null ? '' : ` (${mins} min ago)`}`);
    }
    console.error(`  Lock   : ${lock.LOCK_PATH}`);
    console.error('');
    console.error('Test runs are deliberately serial - concurrent Jest shards have hard-locked');
    console.error('this machine. Wait for the run above to finish, or stop it, then retry.');
    process.exit(3);
  }
  lock.releaseOnExit();

  const bin = jestBin();
  const started = Date.now();

  // WHICH SHARDS THIS INVOCATION RUNS. `--only` is one, `--from` resumes, and the default is all
  // of them.
  const isFullRun = only === null && from === 1;
  const todo = only !== null
    ? [only]
    : Array.from({ length: shards - from + 1 }, (_, k) => from + k);

  // A FRESH FULL RUN STARTS FROM AN EMPTY RECORD. Without this, reports left by a previous run at
  // a different commit would be totalled in alongside this one's, and the number would be a blend
  // of two codebases - the most expensive kind of wrong, because it looks precise. A resumed run
  // deliberately keeps what is there; that is what resuming means.
  if (isFullRun) {
    for (const f of fs.readdirSync(REPORT_DIR)) {
      if (/^shard-\d+\.json$/.test(f) || f === 'summary.json') {
        try { fs.rmSync(path.join(REPORT_DIR, f)); } catch { /* best effort */ }
      }
    }
  }

  console.log(`Running shard(s) ${todo.join(', ')} of ${shards}, one at a time.`);
  console.log(`Reports accumulate in ${REPORT_DIR} and survive a kill.`);
  console.log('A full pass outlives a foreground tool call. If it is killed, resume with --from=N;');
  console.log('nothing already reported is lost or re-run.');
  console.log('');

  const results = [];
  for (const i of todo) {
    console.log(`\n===== shard ${i}/${shards} =====\n`);
    const reportPath = path.join(REPORT_DIR, `shard-${i}.json`);
    // eslint-disable-next-line no-await-in-loop -- serial is the entire point of this script
    const result = await runShard(bin, i, shards, jestArgs, reportPath);
    results.push({ shard: i, ...result });

    // PRINTED THE MOMENT IT IS KNOWN, not saved for a summary the caller may never reach. A run
    // killed during shard 3 still shows shards 1 and 2, and shows them even if the caller piped
    // this through something that buffers.
    const c = result.counts;
    console.log(
      `\n>>> shard ${i}/${shards}: ${result.code === 0 ? 'pass' : `FAIL (exit ${result.code})`}`
      + (c ? ` - ${c.suites} suites, ${c.tests} tests, ${c.failed} failed, ${c.skipped} skipped`
        : ' - no report written (the shard died; see output above)'),
    );
    // Rewritten after EVERY shard so the file on disk is never further behind than one shard.
    printSummary(shards, null, true);
  }

  const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
  const { verdict } = printSummary(shards, elapsedMin, true);

  // A SHARD THIS INVOCATION RAN CAN EXIT NON-ZERO WITH A REPORT THAT LOOKS CLEAN (a signal, a worker
  // pool that died after writing). Its own exit code is evidence too, so it is named as well.
  const exitedNonZero = results.filter((r) => r.code !== 0);
  if (exitedNonZero.length > 0) {
    console.log(`\nFAILED THIS RUN: ${exitedNonZero.map((r) => `${r.shard}/${shards}`).join(', ')}`);
  }
  // THE VERDICT IS THE ACCUMULATED RECORD'S, not this invocation's. Judged on this invocation, a run
  // that lost three shards to a dead worker pool ended on a green line, and a resumed `--only=6`
  // printed "All shards passed." beneath a summary listing shard 11 as FAIL. Every shard present AND
  // no failure in any report, or the suite is NOT proven and this exits non-zero.
  console.log(`\n${verdict.line}`);
  if (!verdict.proven || exitedNonZero.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
