#!/usr/bin/env node
/**
 * A VERSION'S RETIRED `welcome` BECOMES ITS WELCOME WORKFLOWS (W1).
 *
 *   npm run migrate-legacy-welcome                       every assistant with an active version
 *   npm run migrate-legacy-welcome -- --assistant <name> one assistant
 *   npm run migrate-legacy-welcome -- --dry-run          say what would be written, write nothing
 *
 * For each assistant this reads the ACTIVE version's definition (`<ssmRoot>/assistant/<name>/definition:active`), and
 * when it carries `welcome`, plans the welcome workflows that greet exactly as that welcome did (`legacyWelcomePlan`,
 * `lambda/src/lib/legacy-welcome-migration.ts`): a structured opening becomes a workflow with one opening step, a
 * prompt welcome that opening followed by a prompt step, a workflow welcome the workflow it named, each per-type
 * variant a workflow whose `types` name its type. What the welcome said that a workflow cannot say is reported.
 *
 * A version is immutable, so the welcome is carried into a NEW version, written through the profile API exactly as an
 * operator would: a draft cloned from the active version (`/version`), `welcome: null` and the planned `eventWorkflows`
 * patched onto it (`/draft`), validated (`/validate`) and activated (`/activate`). An assistant that already has a draft
 * is skipped and named, so a draft somebody is working on is never replaced; migrate it once that draft is activated or
 * discarded. An assistant whose active version carries no `welcome` is left alone, so a second run writes nothing.
 *
 * Reads run as the operator's own AWS credentials; every write is a SigV4-signed call to the profile API
 * (`scripts/lib/assistant-cli.cjs`), the only sanctioned write path to the profile namespace. The API is `--api <url>`,
 * else AE_MANAGE_PROFILES_API_URL, else this instance's AdminApi output.
 *
 * Imports the COMPILED modules: `npm run migrate-legacy-welcome` builds first.
 */
import { createRequire } from 'node:module';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { legacyWelcomePlan } from '../lambda/src/lib/legacy-welcome-migration.js';

const require = createRequire(import.meta.url);
const { resolveInstanceName, resolveStackPrefix } = require('./lib/stack-lookup.cjs');
const { signedPost, regionOfApiUrl } = require('./lib/assistant-cli.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY_RUN = argv.includes('--dry-run');
const ONLY = option('--assistant');

/** The profile routes' base on this instance's AdminApi. */
async function resolveApi() {
  const explicit = option('--api') || process.env.AE_MANAGE_PROFILES_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const stack = `${resolveStackPrefix(process.env)}AdminApi`;
  const r = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: stack }));
  const base = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'AdminApiUrl')?.OutputValue || '';
  if (!base) throw new Error(`${stack} publishes no AdminApiUrl; the profile API is part of the admin capability. Pass --api <url>.`);
  return `${base.replace(/\/$/, '')}/admin/profiles`;
}

/** Every assistant that has a definition parameter, by name. */
async function assistantNames(ssm, ssmRoot) {
  const names = new Set();
  let NextToken;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({ Path: `${ssmRoot}/assistant`, Recursive: true, NextToken }));
    for (const p of res.Parameters ?? []) {
      const m = p.Name.match(/\/assistant\/([^/]+)\/definition$/);
      if (m) names.add(m[1]);
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return [...names].sort();
}

async function readParam(ssm, name) {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name }));
    return res.Parameter?.Value ?? null;
  } catch (err) {
    if (err?.name === 'ParameterNotFound' || err?.name === 'ParameterVersionLabelNotFound' || err?.name === 'ParameterVersionNotFound') return null;
    throw err;
  }
}

/** One signed call to the profile API. Throws with the API's answer when it is not a success. */
async function call(api, route, body, credentials) {
  const region = REGION || regionOfApiUrl(api);
  const req = await signedPost({ url: `${api}/${route}`, body, credentials, region, SignatureV4, Sha256 });
  const res = await fetch(req.url, req.init);
  const text = await res.text();
  let answer;
  try { answer = text ? JSON.parse(text) : {}; } catch { answer = { raw: text.slice(0, 500) }; }
  if (!res.ok) throw new Error(`${route} answered ${res.status}: ${JSON.stringify(answer)}`);
  return answer;
}

async function main() {
  const ssmRoot = `/${resolveInstanceName(process.env)}`;
  const ssm = new SSMClient({ region: REGION });
  const names = ONLY ? [ONLY] : await assistantNames(ssm, ssmRoot);
  const api = DRY_RUN ? '' : await resolveApi();
  const credentials = DRY_RUN ? undefined : await defaultProvider()();
  let migrated = 0;
  let skipped = 0;
  let refusedLines = 0;
  for (const name of names) {
    const raw = await readParam(ssm, `${ssmRoot}/assistant/${name}/definition:active`);
    if (!raw) { console.log(`${name}: no active version`); continue; }
    const def = JSON.parse(raw);
    if (def.welcome === undefined || def.welcome === null) { console.log(`${name}: no retired welcome`); continue; }
    const plan = legacyWelcomePlan(def.welcome, def.eventWorkflows);
    for (const w of plan.workflows) {
      console.log(`${name}: ${DRY_RUN ? 'would carry' : 'carries'} ${w.from} into eventWorkflows.${w.name}${w.types ? ` (types: ${w.types.join(', ')})` : ' (every other room)'}`);
    }
    if (!plan.workflows.length) console.log(`${name}: its welcome says what the platform's welcome says; the new version declares no welcome of its own`);
    for (const r of plan.refused) {
      refusedLines++;
      console.log(`${name}: not carried: ${r.at}: ${r.reason}`);
    }
    if (plan.refused.some((r) => r.at === 'eventWorkflows')) { skipped++; continue; }
    if (DRY_RUN) continue;
    if (await readParam(ssm, `${ssmRoot}/assistant/${name}/draft`)) {
      skipped++;
      console.log(`${name}: has a draft somebody is working on; skipped. Migrate it once that draft is activated or discarded.`);
      continue;
    }
    try {
      await call(api, 'version', { profileName: name }, credentials);
      await call(api, 'draft', { profileName: name, patch: { welcome: null, eventWorkflows: plan.eventWorkflows } }, credentials);
      const validation = await call(api, 'validate', { profileName: name }, credentials);
      if (validation.valid === false) throw new Error(`the migrated draft is not valid: ${(validation.errors || []).join('; ')}`);
      const activated = await call(api, 'activate', { profileName: name }, credentials);
      migrated++;
      console.log(`${name}: activated version ${activated.version} (${activated.configId})`);
    } catch (err) {
      skipped++;
      console.log(`${name}: not migrated: ${err?.message ?? err}. The draft is left for review.`);
    }
  }
  console.log(`\n${DRY_RUN ? 'dry run: nothing written.' : `migrated ${migrated} assistant(s); ${skipped} skipped.`} ${refusedLines} part(s) of a welcome not carried.`);
  if (skipped || refusedLines) process.exitCode = 2;
}

main().catch((err) => {
  console.error(`[migrate-legacy-welcome] ${err?.message ?? err}`);
  process.exit(1);
});
