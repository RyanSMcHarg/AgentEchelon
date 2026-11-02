#!/usr/bin/env node
/**
 * Reconcile: stamp the `classification` tag on every EXISTING assistant identity the deployment can
 * attribute, and report the ones it cannot, which are orphans.
 *
 * Why: the assistant provisioning grants are STRICT on `aws:ResourceTag/classification`
 * (`assistantProvisioningAllow`, `lib/stacks/agent-classification-common.ts`). A strict condition
 * denies every update and delete on an untagged bot - including the Delete that is the only call
 * sent when a resource is removed - so an untagged bot under a strict grant is one a teardown cannot
 * remove. New bots are tagged at creation; bots created before tagging shipped are not. Run this once
 * BEFORE deploying the strict grants, so there is no untagged managed bot for them to refuse.
 *
 * This is the identity-side twin of `backfill-channel-classification-tags.mjs`, and it is deliberately
 * a script rather than an `IfExists` condition: `IfExists` would have made every untagged bot reachable
 * by every provisioner, permanently, to avoid a one-time job.
 *
 * ATTRIBUTION, and only from sources the platform writes:
 *   - a PRIMARY assistant: `${SSM_ROOT}/assistant/{classification}/bot-arn`, where the segment is a
 *     classification value the stacks published under (`botArnKey`);
 *   - a duel's ALT: its assignment record at `${SSM_ROOT}/assistant-assignments/{classification}/{role}/alt`,
 *     which carries `classification` explicitly.
 *   The admin assistant publishes under a PROFILE NAME (`/assistant/admin-agent/bot-arn`) rather than a
 *   classification, so it is never attributed from that key - it is tagged at creation and is
 *   expected to already carry its tag. Anything else untagged is an ORPHAN: a bot no stack references,
 *   which is exactly the accumulation the delete branch of `create-bot.ts` now prevents going forward.
 *
 * Usage:
 *   AWS_PROFILE=<profile> node backend/scripts/reconcile-assistant-identity-tags.mjs            # dry run
 *   AWS_PROFILE=<profile> node backend/scripts/reconcile-assistant-identity-tags.mjs --apply    # write tags
 *   AWS_PROFILE=<profile> node backend/scripts/reconcile-assistant-identity-tags.mjs --apply --delete-orphans
 *
 * Dry run is the default and prints the full plan. `--apply` writes tags. `--delete-orphans` deletes
 * unattributable bots and is separate, because deleting an identity is the one action here that
 * cannot be undone. Idempotent: a bot already carrying `classification` is skipped.
 *
 * Runs as the operator's own credentials (the app-instance owner), not as any provisioner role: the
 * per-classification grants are the thing being made safe, and cannot be what makes them safe.
 */

import {
  ChimeSDKIdentityClient,
  ListAppInstanceBotsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  DeleteAppInstanceBotCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { createRequire } from 'node:module';

const { resolveInstanceName } = createRequire(import.meta.url)('./lib/stack-lookup.cjs');
const { appInstanceArnOf } = createRequire(import.meta.url)('./lib/person-arn.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const INSTANCE = resolveInstanceName(process.env);
const SSM_ROOT = `/${INSTANCE}`;
const APPLY = process.argv.includes('--apply');
const DELETE_ORPHANS = process.argv.includes('--delete-orphans');

const identity = new ChimeSDKIdentityClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

async function getParam(name) {
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: name }));
    return resp.Parameter?.Value;
  } catch (err) {
    if (err?.name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

// Every `${SSM_ROOT}/assistant/<segment>/bot-arn` the stacks published, keyed by ARN -> the segment.
// (A line comment, not a block one: a literal `/*/` path glob inside `/** */` closes the comment early.)
async function primaryBotSegments() {
  const out = new Map();
  let nextToken;
  do {
    const resp = await ssm.send(new GetParametersByPathCommand({
      Path: `${SSM_ROOT}/assistant/`, Recursive: true, NextToken: nextToken,
    }));
    for (const p of resp.Parameters || []) {
      const m = p.Name.match(/\/assistant\/([^/]+)\/bot-arn$/);
      if (m && p.Value) out.set(p.Value, m[1]);
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return out;
}

// Every alt's record, ARN -> classification: `${SSM_ROOT}/assistant-assignments/<classification>/<role>/alt`.
// Empty when battle is not deployed. (A line comment, for the same reason as above.)
async function altClassifications() {
  const out = new Map();
  let nextToken;
  do {
    const resp = await ssm.send(new GetParametersByPathCommand({
      Path: `${SSM_ROOT}/assistant-assignments/`, Recursive: true, NextToken: nextToken,
    }));
    for (const p of resp.Parameters || []) {
      if (!p.Name.endsWith('/alt')) continue;
      try {
        const e = JSON.parse(p.Value || '{}');
        if (e?.botArn && e?.classification) out.set(e.botArn, e.classification);
      } catch { /* an unparseable record attributes nothing */ }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return out;
}

async function listBots(appInstanceArn) {
  const bots = [];
  let nextToken;
  do {
    const resp = await identity.send(new ListAppInstanceBotsCommand({ AppInstanceArn: appInstanceArn, MaxResults: 50, NextToken: nextToken }));
    bots.push(...(resp.AppInstanceBots || []));
    nextToken = resp.NextToken;
  } while (nextToken);
  return bots;
}

async function classificationTagOf(arn) {
  const resp = await identity.send(new ListTagsForResourceCommand({ ResourceARN: arn }));
  return (resp.Tags || []).find((t) => t.Key === 'classification')?.Value;
}

async function main() {
  const adminArn = await getParam(`${SSM_ROOT}/app-instance-admin-arn`);
  if (!adminArn) throw new Error(`App-instance admin ARN not found in SSM (${SSM_ROOT}/app-instance-admin-arn)`);
  const appInstanceArn = appInstanceArnOf(adminArn);
  const adminAgentArn = await getParam(`${SSM_ROOT}/assistant/admin-agent/bot-arn`);

  console.log('App instance:', appInstanceArn);
  console.log(APPLY ? 'APPLY: tags will be written' : 'DRY RUN: nothing written');
  console.log(DELETE_ORPHANS ? 'DELETE-ORPHANS: unattributable bots will be deleted' : 'orphans are reported only');
  console.log('');

  const primaries = await primaryBotSegments();
  const alts = await altClassifications();
  // The set of classification values the platform actually published under. Attribution only
  // trusts a primary's path segment when it is in this set, so a profile-name segment (the admin
  // assistant's) or a stray parameter cannot tag a bot with a value that is not a classification.
  const knownClassifications = new Set(alts.values());
  for (const [arn, seg] of primaries) if (arn !== adminAgentArn) knownClassifications.add(seg);

  const bots = await listBots(appInstanceArn);
  const plan = { skipped: [], tag: [], orphan: [] };

  for (const bot of bots) {
    const arn = bot.AppInstanceBotArn;
    const existing = await classificationTagOf(arn);
    if (existing) { plan.skipped.push({ arn, name: bot.Name, classification: existing }); continue; }

    const fromAlt = alts.get(arn);
    const seg = primaries.get(arn);
    const fromPrimary = seg && knownClassifications.has(seg) && arn !== adminAgentArn ? seg : undefined;
    const classification = fromAlt ?? fromPrimary;

    if (classification) plan.tag.push({ arn, name: bot.Name, classification, via: fromAlt ? 'roster' : 'ssm' });
    else plan.orphan.push({ arn, name: bot.Name, note: arn === adminAgentArn ? 'admin assistant, expected to be tagged at creation' : 'no stack references this bot' });
  }

  console.log(`Already tagged (${plan.skipped.length}):`);
  for (const s of plan.skipped) console.log(`  ${s.classification.padEnd(10)} ${s.name}  ${s.arn}`);
  console.log(`\nTo tag (${plan.tag.length}):`);
  for (const t of plan.tag) console.log(`  ${t.classification.padEnd(10)} ${t.name}  ${t.arn}  (${t.via})`);
  console.log(`\nOrphans, unattributable (${plan.orphan.length}):`);
  for (const o of plan.orphan) console.log(`  ${o.name}  ${o.arn}  - ${o.note}`);
  console.log('');

  if (!APPLY) { console.log('Dry run complete. Re-run with --apply to write.'); return; }

  let tagged = 0; let deleted = 0; const failed = [];
  for (const t of plan.tag) {
    try {
      await identity.send(new TagResourceCommand({ ResourceARN: t.arn, Tags: [{ Key: 'classification', Value: t.classification }] }));
      tagged++;
    } catch (err) { failed.push({ arn: t.arn, op: 'tag', error: err?.message || String(err) }); }
  }
  if (DELETE_ORPHANS) {
    for (const o of plan.orphan) {
      if (o.arn === adminAgentArn) { console.log('  refusing to delete the admin assistant; tag it instead if it is untagged'); continue; }
      try {
        await identity.send(new DeleteAppInstanceBotCommand({ AppInstanceBotArn: o.arn }));
        deleted++;
      } catch (err) { failed.push({ arn: o.arn, op: 'delete', error: err?.message || String(err) }); }
    }
  }
  console.log(`Tagged ${tagged}, deleted ${deleted}, failed ${failed.length}.`);
  for (const f of failed) console.log(`  FAILED ${f.op} ${f.arn}: ${f.error}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
