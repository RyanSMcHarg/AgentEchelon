#!/usr/bin/env node
/**
 * Regenerate the API contract reference from the CDK app that deploys the HTTP surface.
 *
 *   npm run gen-api-contract
 *
 * Synthesizes `bin/backend.ts` once per deployment variant, reads every `AWS::ApiGatewayV2::Route` out
 * of the resulting templates, and writes `docs/reference/api-contract.md`.
 * `api-contract-reference.test.ts` fails the build when the committed file stops matching a fresh
 * render, so a route added to a stack is a route added to the document.
 *
 * Takes about half a minute: each variant is a full synthesis of the app, in a child process, with
 * Lambda bundling switched off. That is the price of reading the routes from what CloudFormation would
 * actually create rather than from a regex over `addMethod(`.
 *
 * The npm script runs `tsc` first ON PURPOSE, for the same reason `gen-coverage-matrix` does: this
 * module imports the COMPILED `lib/docs/api-contract.js` while the test imports the `.ts`, so without
 * the build step an edit to the renderer would produce a document the test then rejects.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  readApiContract,
  renderApiContract,
  API_CONTRACT_PATH,
  SYNTH_VARIANTS,
} from '../lib/docs/api-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

console.log(`synthesizing ${SYNTH_VARIANTS.length} deployment variant(s) - this takes a moment`);
const contract = readApiContract(REPO_ROOT);
const rendered = renderApiContract(contract);

const out = path.join(REPO_ROOT, API_CONTRACT_PATH);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, rendered, 'utf8');

console.log(
  `wrote ${API_CONTRACT_PATH.split(path.sep).join('/')} - `
  + `${contract.routes.length} routes across ${contract.surfaces.length} HTTP APIs`,
);

// An unauthenticated route is a deliberate decision, never an accident, so say so out loud here as
// well as in the document. Reported, not failed: the generator's job is to make the current state
// visible, and the guard's job is to fail on it.
const open = contract.routes.filter((r) => r.authorizationType === 'NONE');
if (open.length) {
  console.warn(`\n${open.length} route(s) carry no authorizer:`);
  for (const r of open) console.warn(`  ${r.method} ${r.path} (${r.stack})`);
}
