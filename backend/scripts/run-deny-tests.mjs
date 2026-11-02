#!/usr/bin/env node
/**
 * Run named deny-tests one after another and report each one's verdict, a crash included.
 *
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node scripts/run-deny-tests.mjs invitations bearer-pin
 *
 * A name is the part after `deny-test-` (`invitations` runs `scripts/deny-test-invitations.mjs`). Each runs
 * as its own process with this one's environment and output, in order, never in parallel: they create and
 * remove live resources against one deployment.
 *
 * Each exit is read by `lib/deny-test-verdict.cjs`: 0 held, 1 a gap, 2 a setup error, and anything else
 * CRASHED with the raw code, because a script that dies at exit has not said whether its refusals held.
 * This runner exits 1 if any gap was found, else 3 if any script crashed, else 2 for a setup error, else 0.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verdictOf, runExitCode } = require('./lib/deny-test-verdict.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const names = process.argv.slice(2);
if (!names.length) {
  const available = fs.readdirSync(HERE).filter((f) => /^deny-test-.+\.mjs$/.test(f)).map((f) => f.slice('deny-test-'.length, -'.mjs'.length));
  console.error(`usage: node scripts/run-deny-tests.mjs <name> [<name> ...]\navailable: ${available.join(' ')}`);
  process.exit(2);
}
const files = names.map((n) => path.join(HERE, `deny-test-${n.replace(/^deny-test-/, '').replace(/\.mjs$/, '')}.mjs`));
const missing = files.filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error(`no such deny-test: ${missing.map((f) => path.basename(f)).join(', ')}`);
  process.exit(2);
}

const verdicts = [];
for (const file of files) {
  const name = path.basename(file);
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit', env: process.env });
  const v = { name, ...verdictOf(r.error ? null : r.status, r.signal) };
  if (r.error) v.error = String(r.error.message || r.error);
  verdicts.push(v);
}

console.log('\n=== verdicts ===');
for (const v of verdicts) {
  const detail = v.kind === 'crashed'
    ? `CRASHED (${v.error ? v.error : v.signal ? `signal ${v.signal}` : `exit ${v.code}`}): it did not report whether its refusals held`
    : v.kind === 'held' ? 'every refusal and control held'
      : v.kind === 'gap' ? 'GAP: a refusal or control did not hold'
        : 'SETUP ERROR: it could not run its checks';
  console.log(`  ${v.name.padEnd(44)} ${detail}`);
}
process.exitCode = runExitCode(verdicts);
