#!/usr/bin/env npx ts-node
/**
 * Backfill: recover a pre-move conversation's host grounding into the server-only Channel Context store.
 *
 * WHY THIS EXISTS. Six fields - `participantProfile`, `domainContext`, `otherContexts`, `userName`,
 * `userLanguage`, `segment` - used to be stamped into member-readable channel Metadata. The P1 split
 * moved them to the server-only store (`ChannelContextTable`) and `host-grounding.ts` now reads them
 * ONLY from there. Every writer of the store is on a CREATE path, so a conversation that already existed
 * when that shipped has its grounding in Metadata and no stored copy. Nothing errors. The assistant
 * simply answers ungrounded, and - because `userLanguage` and `segment` choose the model - a
 * Chinese-segment conversation quietly starts answering in English on the default model.
 *
 * WHY A SCRIPT AND NOT A READ-TIME FALLBACK. Channel Metadata is member WRITABLE: a channel's creator is
 * a moderator of their own channel and holds `chime:UpdateChannel`, which writes Name and Metadata in
 * ONE call, and IAM cannot separate them. A fallback in the router would put attacker-controlled text
 * into the system prompt on every turn forever, and would let a member choose the model that answers
 * their own conversation. `host-grounding.ts` refuses that on purpose. Promoting once, here, is a
 * bounded decision an operator makes with knowledge this code does not have: whether THIS deployment's
 * channel Metadata was ever writable by someone untrusted.
 *
 * WHICH CHANNELS RECOVER, AND WHICH DO NOT. Stated plainly, because a backfill that implies completeness
 * is worse than none:
 *   - RECOVERED: a channel whose Metadata still carries the legacy fields and whose store row carries
 *     neither any of the six nor an `updatedAt` stamp.
 *   - NOT RECOVERED, and unrecoverable: a channel whose Metadata has since been re-stamped without the
 *     legacy fields. The post-move create/edit path rewrites Metadata AND writes the store in the same
 *     call, so those channels have already healed themselves. `federated-add-member` also rewrites
 *     Metadata on its conflict path but only writes the store fields its own event carried, so a legacy
 *     channel whose only post-deploy touch was an add-member call carrying no grounding has lost the
 *     Metadata copy for good. That window closes for the whole population the moment this runs, which is
 *     the argument for running it early rather than eventually.
 *   - LEFT ALONE by default: a channel the store already grounds (never overwritten), and a channel
 *     whose row carries `updatedAt`, meaning some store writer has touched it. The second is a
 *     judgement call the dry run puts a number on and `--include-store-owned` acts on: a host clearing
 *     a field by sending `null` leaves that shape, but so does the native create path recording a
 *     participant shape and `recordMemberIdentity` appending an issuer hint. See rule 2 in
 *     `lib/legacy-channel-context.ts`.
 *
 * The values are re-bounded and marker-stripped on the way in; see `lib/legacy-channel-context.ts` for
 * the rules and the reasoning behind each.
 *
 * USAGE
 *   AWS_PROFILE=<your-profile> npx ts-node backend/scripts/backfill-channel-context.ts --dry-run
 *   AWS_PROFILE=<your-profile> npx ts-node backend/scripts/backfill-channel-context.ts
 *   AWS_PROFILE=<your-profile> npx ts-node backend/scripts/backfill-channel-context.ts --channel=<arn>
 *
 *   --dry-run               enumerate, decide and report; write nothing
 *   --channel=<arn>         one channel only, for a targeted recovery
 *   --include-store-owned   also promote into rows a store writer has touched (rule 2). Run the dry run
 *                           first: it reports how many channels this covers
 *
 * Idempotent: a second run finds the fields present and reports every channel as already grounded. Reads
 * the app-instance-admin bearer and the table name from SSM, the same way the other backfills do, so it
 * needs no config file.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelsCommand,
  DescribeChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  planLegacyPromotion,
  type PromotionSkipReason,
} from '../lambda/src/lib/legacy-channel-context.js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_CHANNEL = (process.argv.find((a) => a.startsWith('--channel=')) || '').split('=')[1] || '';
const INCLUDE_STORE_OWNED = process.argv.includes('--include-store-owned');

/**
 * SSM root for this instance. Mirrors `SSM_ROOT` in `lib/stacks/agent-classification-common.ts` rather
 * than importing it: that module is evaluated inside the CDK app and pulls the whole CDK library in with
 * it, which an operator script has no reason to load.
 */
const SSM_ROOT = `/${(process.env.AE_INSTANCE_NAME || 'agent-echelon').trim()}`;

const messaging = new ChimeSDKMessagingClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function getParam(name: string): Promise<string | undefined> {
  const resp = await ssm.send(new GetParameterCommand({ Name: name }));
  return resp.Parameter?.Value;
}

async function listAllChannels(appInstanceArn: string, bearer: string): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await messaging.send(new ListChannelsCommand({
      AppInstanceArn: appInstanceArn,
      ChimeBearer: bearer,
      MaxResults: 50,
      NextToken: nextToken,
    }));
    for (const summary of page.Channels || []) if (summary.ChannelArn) arns.push(summary.ChannelArn);
    nextToken = page.NextToken;
  } while (nextToken);
  return arns;
}

/**
 * Write the promoted fields, and only if the row still looks as it did when the plan was made.
 *
 * The condition is not belt-and-braces. This enumerates a live deployment, so a host can create or edit
 * the very conversation being examined between the read and the write - and the host's write is the
 * authority while this one is a recovered copy. Losing that race must mean the copy is DISCARDED, which
 * is what `attribute_not_exists` on each promoted field guarantees. `updatedAt` joins the condition only
 * in the default mode, where its absence is part of what made the channel eligible; under
 * `--include-store-owned` the row is expected to carry it and the six fields are the whole test.
 */
async function promote(
  table: string,
  channelArn: string,
  patch: Record<string, unknown>,
  requireFreshRow: boolean,
): Promise<'written' | 'raced'> {
  const now = new Date().toISOString();
  const names: Record<string, string> = {
    '#updatedAt': 'updatedAt',
    '#backfilledAt': 'groundingBackfilledAt',
  };
  // Provenance, so a later reader can tell recovered grounding from host-supplied grounding. A timestamp
  // of the recovery rather than a "source" flag: a host write afterwards replaces the values without
  // clearing a flag, which would leave the flag asserting something no longer true.
  const values: Record<string, unknown> = { ':updatedAt': now, ':backfilledAt': now };
  const sets = ['#updatedAt = :updatedAt', '#backfilledAt = :backfilledAt'];
  const conditions = requireFreshRow ? ['attribute_not_exists(#updatedAt)'] : [];
  for (const [field, value] of Object.entries(patch)) {
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    sets.push(`#${field} = :${field}`);
    conditions.push(`attribute_not_exists(#${field})`);
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return 'written';
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'raced';
    throw err;
  }
}

async function main(): Promise<void> {
  const bearer = await getParam(`${SSM_ROOT}/app-instance-admin-arn`);
  if (!bearer) throw new Error(`app-instance admin ARN not found in SSM (${SSM_ROOT}/app-instance-admin-arn)`);
  const table = await getParam(`${SSM_ROOT}/shared/tables/channel-context-name`);
  if (!table) throw new Error(`channel-context table name not found in SSM (${SSM_ROOT}/shared/tables/channel-context-name)`);
  const appInstanceArn = bearer.split('/user/')[0];

  console.log('App instance:', appInstanceArn);
  console.log('Context table:', table);
  if (DRY_RUN) console.log('(dry run - nothing is written)');
  if (INCLUDE_STORE_OWNED) {
    console.log('(--include-store-owned: rows a store writer has touched are eligible too; a field the'
      + ' host cleared on purpose can come back if its Metadata copy survived)');
  }

  const arns = ONLY_CHANNEL ? [ONLY_CHANNEL] : await listAllChannels(appInstanceArn, bearer);
  console.log(`${arns.length} channel(s) to examine\n`);

  const skips: Record<PromotionSkipReason, string[]> = {
    'already-grounded': [],
    'store-owns-the-row': [],
    'nothing-to-promote': [],
  };
  const promoted: Array<{ channelArn: string; fields: string[] }> = [];
  const raced: string[] = [];
  const failed: Array<{ channelArn: string; error: string }> = [];

  for (const channelArn of arns) {
    try {
      const described = await messaging.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: bearer }));
      // Strongly consistent: the decision turns on whether a live writer has already owned this row, and
      // an eventually-consistent read of that is a decision made on a row that may no longer exist.
      const current = await ddb.send(new GetCommand({ TableName: table, Key: { channelArn }, ConsistentRead: true }));
      const plan = planLegacyPromotion(described.Channel?.Metadata, current.Item ?? null, {
        includeStoreOwned: INCLUDE_STORE_OWNED,
      });

      if (plan.skipped) {
        skips[plan.skipped].push(channelArn);
        continue;
      }
      if (DRY_RUN) {
        promoted.push({ channelArn, fields: plan.fields });
        continue;
      }
      const outcome = await promote(
        table, channelArn, plan.patch as Record<string, unknown>, !INCLUDE_STORE_OWNED,
      );
      if (outcome === 'raced') raced.push(channelArn);
      else promoted.push({ channelArn, fields: plan.fields });
    } catch (err) {
      failed.push({ channelArn, error: (err as Error).name || String(err) });
    }
  }

  // The report names the fields recovered, never their values: this is member-writable text and the log
  // is a less guarded place than the store it came from.
  console.log(`${DRY_RUN ? 'WOULD RECOVER' : 'RECOVERED'}: ${promoted.length} channel(s)`);
  for (const p of promoted.slice(0, 20)) console.log(`  + ${p.channelArn}  [${p.fields.join(', ')}]`);
  if (promoted.length > 20) console.log(`  ... and ${promoted.length - 20} more`);

  console.log('\nleft alone:');
  console.log(`  ${skips['already-grounded'].length} already grounded by the store (nothing to recover)`);
  console.log(`  ${skips['store-owns-the-row'].length} have a row a store writer has touched`);
  console.log(`  ${skips['nothing-to-promote'].length} carry no legacy grounding in Metadata`);
  if (raced.length) {
    console.log(`  ${raced.length} lost a race to a live write and were DISCARDED (the live write wins;`
      + ' re-run to re-examine them)');
  }

  // A backfill that examines a whole deployment, recovers nothing and exits 0 is indistinguishable from
  // one that is broken. Say which of the two this was.
  if (promoted.length === 0) {
    console.log('\nNo channel was recovered.');
    if (skips['store-owns-the-row'].length > 0 && !INCLUDE_STORE_OWNED) {
      console.log(`  ${skips['store-owns-the-row'].length} channel(s) were held back by rule 2 alone.`
        + ' Their rows carry `updatedAt`, which a grounding write and a bare participant-shape or'
        + ' issuer-hint write both leave behind, so this bucket is a mix. Re-run with'
        + ' --include-store-owned once you have decided that is the right call for this deployment.');
    } else {
      console.log('  Nothing eligible was found: either the store already grounds these conversations,'
        + ' or their Metadata no longer carries the legacy fields, in which case the grounding no longer'
        + ' exists anywhere and the host must re-send it.');
    }
  }

  if (failed.length) {
    console.error(`\n${failed.length} channel(s) could not be examined:`);
    for (const f of failed.slice(0, 10)) console.error(`  - ${f.channelArn}: ${f.error}`);
    process.exit(1);
  }

  if (DRY_RUN && promoted.length) {
    console.log('\nRe-run without --dry-run to write these. Channels not listed above stay ungrounded;'
      + ' for them the grounding no longer exists anywhere and the host must re-send it.');
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
