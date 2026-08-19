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
 * It runs longer than 10 minutes by design, so start it in the background and read the summary
 * when it lands. It prints that instruction rather than assuming it.
 *
 *   node scripts/run-test-shards.mjs                 # 4 shards, serially
 *   node scripts/run-test-shards.mjs --shards=2
 *   node scripts/run-test-shards.mjs -- --silent     # everything after -- goes to jest
 *
 * Every shard runs even after one fails: a partial picture is how a red suite gets recorded as
 * "one known failure" when there were three. Exit status is non-zero if any shard failed.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lock = require('./lib/test-run-lock.cjs');

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const passThroughAt = argv.indexOf('--');
  const ours = passThroughAt === -1 ? argv : argv.slice(0, passThroughAt);
  const jestArgs = passThroughAt === -1 ? [] : argv.slice(passThroughAt + 1);

  let shards = 4;
  for (const arg of ours) {
    const m = /^--shards=(\d+)$/.exec(arg);
    if (m) {
      shards = Number(m[1]);
      continue;
    }
    // An unrecognised flag is far more likely a typo than an intent, and silently ignoring it
    // means running the wrong thing for 20 minutes before finding out.
    console.error(`Unrecognised option: ${arg}`);
    console.error('Usage: node scripts/run-test-shards.mjs [--shards=N] [-- <jest args>]');
    process.exit(2);
  }
  if (!Number.isInteger(shards) || shards < 1 || shards > 16) {
    console.error(`--shards must be between 1 and 16 (got ${shards}).`);
    process.exit(2);
  }
  return { shards, jestArgs };
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
      skipped: (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0),
    };
  } catch {
    return null; // the shard died before writing one; the inherited output is the record
  }
}

async function main() {
  const { shards, jestArgs } = parseArgs(process.argv.slice(2));

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
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-shards-'));
  const started = Date.now();

  console.log(`Running the backend suite as ${shards} shards, one at a time.`);
  console.log('This takes longer than a foreground tool call allows - run it in the background.');
  console.log('');

  const results = [];
  for (let i = 1; i <= shards; i++) {
    console.log(`\n===== shard ${i}/${shards} =====\n`);
    const reportPath = path.join(reportDir, `shard-${i}.json`);
    // eslint-disable-next-line no-await-in-loop -- serial is the entire point of this script
    const result = await runShard(bin, i, shards, jestArgs, reportPath);
    results.push({ shard: i, ...result });
  }

  const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n===== summary (${shards} shards, ${elapsedMin} min) =====\n`);

  const totals = { suites: 0, tests: 0, failed: 0, skipped: 0 };
  for (const r of results) {
    const status = r.code === 0 ? 'pass' : `FAIL (exit ${r.code}${r.signal ? `, ${r.signal}` : ''})`;
    if (r.counts) {
      for (const k of Object.keys(totals)) totals[k] += r.counts[k];
      console.log(
        `  shard ${r.shard}/${shards}: ${status} - `
        + `${r.counts.suites} suites, ${r.counts.tests} tests, `
        + `${r.counts.failed} failed, ${r.counts.skipped} skipped`,
      );
    } else {
      console.log(`  shard ${r.shard}/${shards}: ${status} - no report written (see output above)`);
    }
  }

  const missing = results.filter((r) => !r.counts).length;
  console.log('');
  console.log(
    `  TOTAL: ${totals.suites} suites, ${totals.tests} tests, `
    + `${totals.failed} failed, ${totals.skipped} skipped`
    + (missing ? `  [${missing} shard(s) wrote no report - totals are INCOMPLETE]` : ''),
  );

  try {
    fs.rmSync(reportDir, { recursive: true, force: true });
  } catch { /* a leftover temp dir is not worth failing the run over */ }

  const failedShards = results.filter((r) => r.code !== 0);
  if (failedShards.length > 0) {
    console.log(`\nFAILED: ${failedShards.map((r) => `${r.shard}/${shards}`).join(', ')}`);
    process.exit(1);
  }
  // A skip is unfinished work, not a pass - say so rather than printing an unqualified green.
  console.log(totals.skipped > 0
    ? `\nAll shards passed, but ${totals.skipped} test(s) were skipped. A skip is not a pass.`
    : '\nAll shards passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
