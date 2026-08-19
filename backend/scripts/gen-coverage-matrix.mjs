#!/usr/bin/env node
/**
 * Regenerate the end-to-end coverage matrix from the spec corpus and the e2e suite.
 *
 *   npm run gen-coverage-matrix
 *
 * The `**Coverage:**` line in each spec document is the source; this document is rendered from it, so
 * the two cannot disagree. `e2e-coverage-matrix.test.ts` fails the build when the committed file stops
 * matching a fresh render, when a document declares nothing, or when a declaration names a spec file
 * that is not there.
 *
 * Prints the validation problems it finds rather than refusing to write: the generator's job is to
 * make the current state visible, and the test's job is to fail on it. A generator that exits early
 * would leave the matrix stale exactly when it is most worth reading.
 *
 * The npm script runs `tsc` first ON PURPOSE. This module imports the COMPILED `lib/docs/spec-coverage.js`
 * while the test imports the `.ts`, so without the build step an edit to the renderer would produce a
 * document the test then rejects - the generator and the guard disagreeing about their shared source.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  readSpecCoverage,
  listE2eSpecs,
  countTests,
  renderCoverageMatrix,
  validateCoverage,
  MATRIX_PATH,
} from '../lib/docs/spec-coverage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const specs = readSpecCoverage(REPO_ROOT);
const e2eSpecs = listE2eSpecs(REPO_ROOT);
const rendered = renderCoverageMatrix(specs, e2eSpecs, (f) => countTests(REPO_ROOT, f));

const out = path.join(REPO_ROOT, MATRIX_PATH);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, rendered, 'utf8');

const declared = specs.filter((s) => s.coverage.length > 0).length;
console.log(
  `wrote ${MATRIX_PATH.split(path.sep).join('/')} — `
  + `${specs.length} spec documents (${declared} naming an e2e spec), ${e2eSpecs.length} e2e spec files`,
);

const problems = validateCoverage(specs, e2eSpecs);
if (problems.length) {
  console.warn(`\n${problems.length} coverage problem(s) — the build will fail on these:`);
  for (const p of problems) console.warn(`  [${p.kind}] ${p.spec}\n      ${p.detail}`);
  process.exitCode = 1;
}
