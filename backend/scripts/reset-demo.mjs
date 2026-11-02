/**
 * Return a deployment to the state a demo started from.
 *
 *   - Retires every assistant created in the console since the demo began, through the same signed route
 *     the console's Retire uses. Declared assistants are never touched (scripts/lib/reset-demo.cjs).
 *   - Deletes the demo cast's conversations created in the same window, with their tasks, through
 *     delete-conversations.mjs. Rooms a person outside the cast is in are kept. The archive keeps every
 *     event, so history and analytics are unaffected.
 *
 * A dry run is the default and changes nothing. `--apply` makes the changes.
 *
 * Usage:
 *   AWS_PROFILE=<profile> npm run reset-demo -- --since=2026-10-27T09:00:00Z
 *   AWS_PROFILE=<profile> npm run reset-demo -- --since=2026-10-27T09:00:00Z --apply
 *
 * Options:
 *   --since=<ISO time>       required: the start of the demo
 *   --apply                  make the changes (default: list what would change)
 *   --skip-assistants        leave assistants as they are
 *   --skip-conversations     leave conversations as they are
 *   --secret=<name>          the people whose conversations go (default agent-interface/demo-credentials)
 *   --reason=<text>          the reason recorded on each retire
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

const require = createRequire(import.meta.url);
const { assistantsToRetire, parseResetArgs } = require('./lib/reset-demo.cjs');
const { signedPost } = require('./lib/assistant-cli.cjs');
const { resolveInstanceName, resolveStackPrefix } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let opts;
try {
  opts = parseResetArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const INSTANCE = resolveInstanceName(process.env);
const PREFIX = resolveStackPrefix(process.env);
const cfn = new CloudFormationClient({ region: REGION });

async function stackOutput(stack, key) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: `${PREFIX}${stack}` }));
  const value = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
  if (!value) throw new Error(`${PREFIX}${stack} has no ${key} output`);
  return value;
}

async function readDirectory() {
  const ssm = new SSMClient({ region: REGION });
  const prefix = `/${INSTANCE}/assistant-directory/`;
  const entries = [];
  let token;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({ Path: `/${INSTANCE}/assistant-directory`, MaxResults: 10, NextToken: token }));
    for (const p of res.Parameters || []) {
      if (!p.Name?.startsWith(prefix) || !p.Value) continue;
      try { entries.push([p.Name.slice(prefix.length), JSON.parse(p.Value)]); } catch { /* an unreadable entry selects nothing */ }
    }
    token = res.NextToken;
  } while (token);
  return entries;
}

async function resetAssistants() {
  const picked = assistantsToRetire(await readDirectory(), opts.since);
  console.log(`\nAssistants created in the console since ${opts.since.toISOString()}: ${picked.length}`);
  for (const a of picked) console.log(`  ${a.name} (${a.classification}, ${a.status}, created ${a.createdAt})`);
  if (!picked.length || !opts.apply) return 0;

  const base = (await stackOutput('AdminApi', 'AdminApiUrl')).replace(/\/$/, '');
  const credentials = defaultProvider();
  let failed = 0;
  for (const a of picked) {
    const { url, init } = await signedPost({
      url: `${base}/admin/roster/${encodeURIComponent(a.name)}/retire`,
      body: { reason: opts.reason },
      credentials: await credentials(),
      region: REGION,
      SignatureV4,
      Sha256,
    });
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`  retired ${a.name}: ${body.status ?? 'done'}`);
    } else {
      failed += 1;
      console.log(`  could not retire ${a.name}: ${res.status} ${body.error ?? ''}`);
    }
  }
  return failed;
}

function resetConversations(poolId) {
  console.log(`\nConversations the demo cast (${opts.secret}) created since ${opts.since.toISOString()}:`);
  const args = [path.join(HERE, 'delete-conversations.mjs'), `--created-since=${opts.since.toISOString()}`, '--only-test-people'];
  if (opts.apply) args.push('--apply');
  const r = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, TEST_SECRET_NAME: opts.secret, VITE_USER_POOL_ID: poolId },
  });
  return r.status === 0 ? 0 : 1;
}

console.log(`Demo reset on instance "${INSTANCE}"${opts.apply ? '' : ' (dry run: nothing changes; add --apply)'}`);
let failures = 0;
if (opts.assistants) failures += await resetAssistants();
if (opts.conversations) failures += resetConversations(process.env.VITE_USER_POOL_ID || await stackOutput('Identity', 'UserPoolId'));
process.exit(failures ? 1 : 0);
