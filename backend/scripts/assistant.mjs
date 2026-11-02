/**
 * The assistant profile CLI's entry point: `npm run assistant -- <command> <profile> [options]`.
 *
 * What each command does, and why every call is a signed call to the profile API, is in
 * `scripts/lib/assistant-cli.cjs`. This file only supplies the real dependencies: the operator's IAM
 * credentials from the default AWS credential chain, `fetch`, and the profile routes on this instance's
 * `AdminApi` (its `AdminApiUrl` output, then `/admin/profiles`).
 *
 *   AWS_PROFILE=<your-profile> npm run assistant -- validate analyst
 *
 * `<profile>` is an assistant profile name (`analyst` serves `standard` in the shipped catalog), never a
 * classification: the profile API answers `400 unknown or missing profileName` for a classification name.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const require = createRequire(import.meta.url);
const { run } = require('./lib/assistant-cli.cjs');
const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';

/** The profile routes' base on this instance's `AdminApi`, or '' when the stack or the output is absent. */
async function resolveApi() {
  const stack = `${resolveStackPrefix(process.env)}AdminApi`;
  try {
    const r = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: stack }));
    const base = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'AdminApiUrl')?.OutputValue || '';
    return base ? `${base.replace(/\/$/, '')}/admin/profiles` : '';
  } catch (e) {
    if (/does not exist/.test(String(e?.message || e))) return '';
    throw new Error(`could not read ${stack}'s outputs (${e?.name || 'error'}): ${e?.message || e}`);
  }
}

const { exitCode, output } = await run({
  argv: process.argv.slice(2),
  env: process.env,
  credentials: defaultProvider(),
  fetchImpl: fetch,
  resolveApi,
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  SignatureV4,
  Sha256,
});
(exitCode === 0 ? console.log : console.error)(output);
process.exit(exitCode);
