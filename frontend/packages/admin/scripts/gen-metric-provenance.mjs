#!/usr/bin/env node
/**
 * Resolve `MetricProvenance.publicLine` for every metric, AGAINST THE PUBLIC TREE.
 *
 * The console's code links point at the public repo, which is not this working tree. A line number
 * read from a local editor is therefore wrong by however far the two have diverged - measured
 * 2026-10-01, `analytics-query.ts` was 3889 lines public and 7411 local, and three of four
 * metric-computing symbols checked did not exist publicly at all. A link built from the local number
 * lands on unrelated code and misleads an operator more than no link would.
 *
 * So this script is the only writer of `publicLine`:
 *
 *   1. read each `provenance` entry's `file` AS THE PUBLIC REMOTE HAS IT (`git show <ref>:<file>`)
 *   2. find `symbol` in that content
 *   3. write the 1-based line back into the registry, or REMOVE the field when the symbol is not
 *      public - which makes the console render the path as text instead of a link that would 404
 *      or point somewhere false
 *
 * It never invents a line and never keeps a stale one: a symbol it cannot find has its `publicLine`
 * deleted rather than left behind.
 *
 *   node scripts/gen-metric-provenance.mjs            # write
 *   node scripts/gen-metric-provenance.mjs --check    # exit 1 if the file would change (CI)
 *
 * The companion test asserts the same thing from the other side, so a registry edited by hand and
 * never regenerated fails the suite rather than shipping.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(HERE, '..', 'src', 'components', 'admin', 'metricTargets.ts');
/** The ref the console's links actually resolve against. Overridable for a fork with another remote. */
const PUBLIC_REF = process.env.AE_PUBLIC_REF || 'origin/main';
const CHECK = process.argv.includes('--check');

/** Public file content, or null when the remote does not have the file at all. */
const publicFile = (repoPath) => {
  try {
    return execFileSync('git', ['show', `${PUBLIC_REF}:${repoPath}`], {
      encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

/**
 * The 1-based line of `symbol`, or null.
 *
 * A DECLARATION is preferred over a mention, because the first textual hit is often an import or a
 * call site and the point of the link is to land on the computation. Failing that the first hit is
 * used, which is still in the right file.
 */
const lineOf = (content, symbol) => {
  const lines = content.split('\n');
  const declared = lines.findIndex((l) => new RegExp(
    `(export\\s+)?(async\\s+)?(function|const|let|var|class|interface|type)\\s+${symbol}\\b`,
  ).test(l));
  if (declared >= 0) return declared + 1;
  const mentioned = lines.findIndex((l) => l.includes(symbol));
  return mentioned >= 0 ? mentioned + 1 : null;
};

const source = fs.readFileSync(REGISTRY, 'utf8');

// Each provenance block, captured whole so the rewrite is a local splice rather than a parse of TS.
const BLOCK = /provenance:\s*\{([\s\S]*?)\}/g;
const FIELD = (name) => new RegExp(`${name}:\\s*'([^']*)'`);

let out = '';
let last = 0;
let resolved = 0;
let unresolved = 0;
const report = [];

for (const m of source.matchAll(BLOCK)) {
  const [whole, body] = m;
  const file = body.match(FIELD('file'))?.[1];
  const symbol = body.match(FIELD('symbol'))?.[1];
  if (!file || !symbol) continue;

  const content = publicFile(file);
  const line = content ? lineOf(content, symbol) : null;

  // Strip any existing publicLine (and its trailing comma/space) before writing the current answer.
  let nextBody = body.replace(/,?\s*publicLine:\s*\d+/g, '');
  if (line) {
    nextBody = `${nextBody.replace(/,\s*$/, '')}, publicLine: ${line}`;
    resolved += 1;
    report.push(`  ok       ${symbol}  ->  ${path.posix.basename(file)}:${line}`);
  } else {
    unresolved += 1;
    report.push(`  TEXT     ${symbol}  ->  ${content ? 'symbol not in' : 'file absent from'} ${PUBLIC_REF}`);
  }

  out += source.slice(last, m.index) + `provenance: {${nextBody}}`;
  last = m.index + whole.length;
}
out += source.slice(last);

if (CHECK) {
  if (out !== source) {
    console.error('metricTargets.ts provenance is STALE. Run: node scripts/gen-metric-provenance.mjs');
    process.exit(1);
  }
  console.log(`provenance up to date against ${PUBLIC_REF} (${resolved} linked, ${unresolved} shown as text)`);
  process.exit(0);
}

fs.writeFileSync(REGISTRY, out);
console.log(report.join('\n'));
console.log(`\nresolved against ${PUBLIC_REF}: ${resolved} linked, ${unresolved} rendered as text`);
