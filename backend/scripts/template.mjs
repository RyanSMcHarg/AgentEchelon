#!/usr/bin/env node
/**
 * DOCUMENT, MESSAGE AND PROMPT TEMPLATES, PER CLASSIFICATION (SPEC-DOCUMENT-TEMPLATES FR2, FR4, FR7; ADR-062).
 *
 * Puts a template body, activates or rolls back the version a name points at, lists what a classification
 * holds, and checks that every template a classification's workflows declare resolves. Writes run as the
 * operator's own AWS credentials: no turn role writes a template, and the turn roles read only their own
 * classification's `templates/<classification>/` prefix and pointers. The platform's shipped templates are
 * written at deploy, create-only, and replacing one is a `put` of the same name with `--activate`.
 *
 *   npm run template -- put <classification> <file.md> [--activate] [--assistant <name>] [--dry-run]
 *   npm run template -- activate <classification> <name> <sha256> [--assistant <name>] [--dry-run]
 *   npm run template -- rollback <classification> <name> [--assistant <name>] [--dry-run]
 *   npm run template -- list <classification> [--assistant <name>]
 *   npm run template -- check <classification> [--pack <pack.json>]
 *
 * `--assistant <name>` works on that assistant's own family (`templates/<classification>/_assistants/<name>/`),
 * the template its messages are said from before the classification's (ADR-062 decision 3). Without it, the
 * classification's own family.
 *
 * A body is stored at `templates/<classification>/<name>/<sha256>.md` in the attachments bucket, created
 * once and never overwritten. The active version is the SSM parameter
 * `<ssmRoot>/assistant/<classification>/templates/<name>`; activation and rollback rewrite only it, so
 * the next delivery uses the new version with no deploy.
 *
 * The bucket is `--bucket <name>`, else TEMPLATE_BUCKET, else the `AttachmentsBucketName` output of this
 * instance's Conversations stack. `check` reads the classification's deployed intent pack unless
 * `--pack` names a local one.
 *
 * Imports the COMPILED modules: `npm run template` builds first.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  putTemplate, activateTemplate, rollbackTemplate, listTemplates, templateReferenceErrors,
} from '../lambda/src/lib/template-store.js';
import { parseIntentPack, taskStateMachines, resolvePackParameterValue } from '../lambda/src/lib/intent-pack.js';

const { resolveInstanceName, resolveStackPrefix } = createRequire(import.meta.url)('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--bucket', '--pack', '--assistant'].includes(argv[i - 1])));
const [command, classification, ...rest] = positional;
const DRY_RUN = flag('--dry-run');
const ASSISTANT = option('--assistant');
/** The family a command works on: the named assistant's own, else the classification's. */
const OWNER = ASSISTANT ? { family: 'assistant', assistant: ASSISTANT } : undefined;

function usage(message) {
  if (message) console.error(`[template] ${message}`);
  console.error('Usage: npm run template -- <put|activate|rollback|list|check> <classification> ... (see the header of scripts/template.mjs)');
  process.exit(1);
}

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

async function main() {
  if (!command || !classification) usage();
  const ssmRoot = `/${resolveInstanceName(process.env)}`;
  const bucket = await resolveBucket();
  const deps = { s3: new S3Client({ region: REGION }), ssm: new SSMClient({ region: REGION }), bucket, ssmRoot };
  const note = DRY_RUN ? ' (dry run: nothing written)' : '';

  switch (command) {
    case 'put': {
      const [file] = rest;
      if (!file) usage('put needs a file');
      const source = readFileSync(file, 'utf8');
      const put = await putTemplate(classification, source, deps, { dryRun: DRY_RUN, owner: OWNER });
      console.log(`${put.written ? 'stored' : DRY_RUN ? 'would store' : 'already stored'} ${put.name} ${put.contentHash}`
        + ` at s3://${bucket}/${put.key}${note}`);
      if (flag('--activate')) {
        if (DRY_RUN) {
          console.log(`would activate ${put.name} ${put.contentHash}${note}`);
        } else {
          const a = await activateTemplate(classification, put.name, put.contentHash, deps, { owner: OWNER });
          console.log(a.changed ? `activated ${put.name} ${a.active}${a.previous ? ` (was ${a.previous})` : ''}` : `${put.name} ${a.active} was already active`);
        }
      }
      return;
    }
    case 'activate': {
      const [name, hash] = rest;
      if (!name || !hash) usage('activate needs a name and a content hash');
      const a = await activateTemplate(classification, name, hash, deps, { dryRun: DRY_RUN, owner: OWNER });
      console.log(a.changed
        ? `${DRY_RUN ? 'would activate' : 'activated'} ${name} ${a.active}${a.previous ? ` (was ${a.previous})` : ''}${note}`
        : `${name} ${a.active} is already active`);
      return;
    }
    case 'rollback': {
      const [name] = rest;
      if (!name) usage('rollback needs a name');
      const r = await rollbackTemplate(classification, name, deps, { dryRun: DRY_RUN, owner: OWNER });
      console.log(`${DRY_RUN ? 'would roll back' : 'rolled back'} ${name} from ${r.from} to ${r.to}${note}`);
      return;
    }
    case 'list': {
      const all = await listTemplates(classification, deps, OWNER);
      if (!all.length) console.log(`no templates stored for ${classification}`);
      for (const t of all) {
        console.log(`${t.name}  active: ${t.active ?? 'none'}  versions: ${t.versions.length}  rollback to: ${t.history.at(-1) ?? 'none'}`);
      }
      return;
    }
    case 'check': {
      let raw;
      const packFile = option('--pack');
      if (packFile) {
        raw = readFileSync(packFile, 'utf8');
      } else {
        const name = `${ssmRoot}/assistant/${classification}/assistant-intent-pack`;
        try {
          const resp = await deps.ssm.send(new GetParameterCommand({ Name: name }));
          raw = await resolvePackParameterValue(resp.Parameter?.Value, classification, { s3: deps.s3, bucket });
        } catch (err) {
          if (err?.name !== 'ParameterNotFound') throw err;
        }
      }
      const machines = taskStateMachines(parseIntentPack(raw));
      const errors = await templateReferenceErrors(machines, classification, deps);
      if (errors.length) {
        for (const e of errors) console.error(`[template] ${e}`);
        process.exit(2);
      }
      console.log(`every template ${classification}'s workflows declare resolves`);
      return;
    }
    default:
      usage(`unknown command "${command}"`);
  }
}

main().catch((err) => {
  console.error(`[template] ${err?.message ?? err}`);
  process.exit(1);
});
