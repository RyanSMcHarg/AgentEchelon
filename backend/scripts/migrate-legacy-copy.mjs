#!/usr/bin/env node
/**
 * A VERSION'S RETIRED `copy` LINES BECOME ITS ASSISTANT'S OWN MESSAGE TEMPLATES (ADR-062).
 *
 *   npm run migrate-legacy-copy                       every assistant with an active version
 *   npm run migrate-legacy-copy -- --assistant <name> one assistant
 *   npm run migrate-legacy-copy -- --dry-run          say what would be written, write nothing
 *
 * For each assistant this reads the ACTIVE version's definition (`<ssmRoot>/assistant/<name>/definition:active`), and
 * when it carries `copy`, writes each line that maps to a message as that assistant's own template, active at once,
 * through the template store (`migrateLegacyCopy`, `lambda/src/lib/legacy-copy-migration.ts`): `{var}` becomes
 * `{{field}}`, each line is checked against the shipped template it words, and a line that does not fit is refused
 * and reported. A template the assistant already holds as its own is kept, so a second run writes nothing.
 *
 * Writes run as the operator's own AWS credentials, as `npm run template` does. The bucket is `--bucket <name>`, else
 * TEMPLATE_BUCKET, else the `AttachmentsBucketName` output of this instance's Conversations stack. The deployment's
 * classifications are read from `backend/deploy.config.json` (`profiles`); a console-created assistant's from the
 * assistant directory.
 *
 * Imports the COMPILED modules: `npm run migrate-legacy-copy` builds first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { migrateLegacyCopy } from '../lambda/src/lib/legacy-copy-migration.js';
import { readRuntimeAssistant } from '../lambda/src/lib/runtime-directory.js';
import { useDeploymentProfiles } from '../lib/profile-registry.js';
import { resolveDeploymentProfiles } from '../lib/config/profiles.js';

const require = createRequire(import.meta.url);
const { resolveInstanceName, resolveStackPrefix } = require('./lib/stack-lookup.cjs');

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGION = process.env.AWS_REGION || 'us-east-1';
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY_RUN = argv.includes('--dry-run');
const ONLY = option('--assistant');

async function resolveBucket() {
  const explicit = option('--bucket') || process.env.TEMPLATE_BUCKET;
  if (explicit) return explicit;
  const stack = `${resolveStackPrefix(process.env)}Conversations`;
  const cfn = new CloudFormationClient({ region: REGION });
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  const out = resp.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'AttachmentsBucketName')?.OutputValue;
  if (!out) throw new Error(`${stack} has no AttachmentsBucketName output; pass --bucket <name>.`);
  return out;
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

/** The active version's definition, or null when the assistant has none. */
async function activeDefinition(ssm, ssmRoot, name) {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${ssmRoot}/assistant/${name}/definition:active` }));
    return JSON.parse(res.Parameter?.Value ?? 'null');
  } catch (err) {
    if (err?.name === 'ParameterNotFound' || err?.name === 'ParameterVersionLabelNotFound' || err?.name === 'ParameterVersionNotFound') return null;
    throw err;
  }
}

async function classificationOf(registry, ssm, ssmRoot, name) {
  const declared = registry.classificationOfAssistant(name) ?? registry.roleOfAlt(name)?.classification;
  if (declared) return declared;
  return (await readRuntimeAssistant(ssm, ssmRoot, name))?.entry.classification;
}

async function main() {
  const configPath = path.join(BACKEND_DIR, 'deploy.config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const registry = useDeploymentProfiles(resolveDeploymentProfiles(config.profiles));
  const ssmRoot = `/${resolveInstanceName(process.env)}`;
  const ssm = new SSMClient({ region: REGION });
  const deps = { s3: new S3Client({ region: REGION }), ssm, bucket: await resolveBucket(), ssmRoot };
  const names = ONLY ? [ONLY] : await assistantNames(ssm, ssmRoot);
  let wrote = 0;
  let refused = 0;
  for (const name of names) {
    const def = await activeDefinition(ssm, ssmRoot, name);
    if (!def) { console.log(`${name}: no active version`); continue; }
    const keys = def.copy && typeof def.copy === 'object' ? Object.keys(def.copy) : [];
    if (!keys.length) { console.log(`${name}: no legacy copy lines`); continue; }
    const classification = await classificationOf(registry, ssm, ssmRoot, name);
    if (!classification) { console.log(`${name}: serves no classification this deployment declares; skipped (${keys.join(', ')})`); continue; }
    const report = await migrateLegacyCopy({ assistant: name, classification, copy: def.copy, messages: def.messages }, deps, { dryRun: DRY_RUN });
    for (const t of report.templates) {
      if (t.outcome !== 'kept') wrote++;
      console.log(`${name}: ${t.outcome === 'kept' ? 'kept its own' : t.outcome === 'would-write' ? 'would write' : 'wrote'} ${t.name}`
        + `${t.contentHash ? ` ${t.contentHash}` : ''} from ${t.keys.join(', ')}`);
    }
    for (const r of report.refused) {
      refused++;
      console.log(`${name}: refused ${r.key}${r.template ? ` (${r.template})` : ''}: ${r.reason}`);
    }
  }
  console.log(`\n${DRY_RUN ? 'would write' : 'wrote'} ${wrote} template(s); ${refused} line(s) refused.${DRY_RUN ? ' (dry run: nothing written)' : ''}`);
  if (refused) process.exitCode = 2;
}

main().catch((err) => {
  console.error(`[migrate-legacy-copy] ${err?.message ?? err}`);
  process.exit(1);
});
