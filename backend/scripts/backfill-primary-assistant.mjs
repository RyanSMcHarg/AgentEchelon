#!/usr/bin/env node
/**
 * Backfill: stamp every EXISTING conversation with its `primaryAssistant` tag
 * (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8).
 *
 * Why: a room's primary assistant takes every turn nobody addressed and speaks for the room. New rooms are
 * tagged in the same `CreateChannel` call that writes `classification`; rooms created before that are
 * not. Until they are, `primaryAssistantOf` falls back to the classification's primary assignment and logs
 * `[PrimaryAssistantFault]`. Run this once after deploying, and again if that fault appears.
 *
 * Usage:
 *   AWS_PROFILE=<your-profile> node backend/scripts/backfill-primary-assistant.mjs --dry-run
 *   AWS_PROFILE=<your-profile> node backend/scripts/backfill-primary-assistant.mjs
 *
 * ALSO LABELS EACH ROOM WITH ITS TYPE KEY (`conversationType`): the type the context store records for it
 * (`CHANNEL_CONTEXT_TABLE`, keyed by `channelArn`), else `general`. This replaces the `private` and
 * `briefing` values older creators wrote, which were the channel's privacy and a type the registry does not
 * have. A label only: the context store stays the authority.
 *
 * Idempotent: writes only the tags a room is missing or carries wrongly. The primary is the assistant in the room's
 * classification's `(primary, live)` assignment record. A room with no readable
 * classification is reported and left alone: it is a different fault, and guessing its classification
 * would decide who speaks in it.
 *
 * Enumerates PRIVATE and PUBLIC channels: `ListChannels` returns only PUBLIC ones unless asked, and every
 * conversation is PRIVATE. Uses the app-instance-admin ARN from SSM as the ChimeBearer.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { createRequire } from 'node:module';

const { resolveInstanceName } = createRequire(import.meta.url)('./lib/stack-lookup.cjs');
const { appInstanceArnOf } = createRequire(import.meta.url)('./lib/person-arn.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const SSM_ROOT = `/${resolveInstanceName(process.env)}`;
const DRY_RUN = process.argv.includes('--dry-run');
const PRIMARY_TAG = 'primaryAssistant';
const TYPE_TAG = 'conversationType';
const CONTEXT_TABLE = process.env.CHANNEL_CONTEXT_TABLE || '';
const ddb = new DynamoDBClient({ region: REGION });

async function typeKeyOf(channelArn) {
  const res = await ddb.send(new GetItemCommand({
    TableName: CONTEXT_TABLE, Key: { channelArn: { S: channelArn } }, ProjectionExpression: '#t', ExpressionAttributeNames: { '#t': 'conversationType' },
  }));
  return res.Item?.conversationType?.S || 'general';
}

const messagingRaw = new ChimeSDKMessagingClient({ region: REGION });
// The Amazon Chime SDK throttles a walk over thousands of channels; a throttled call waits and retries.
const messaging = {
  send: async (cmd) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await messagingRaw.send(cmd);
      } catch (err) {
        if (err.name !== 'ThrottledClientException' || attempt >= 6) throw err;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  },
};
const ssm = new SSMClient({ region: REGION });

async function getParam(name) {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
  } catch (err) {
    if (err.name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

const primaries = new Map();
async function primaryOf(classification) {
  if (!primaries.has(classification)) {
    // THE DECLARED PRIMARY: the primary-role record that is not a console-created one (ADR-048, amended 2026-10-23).
    let assistant;
    let token;
    do {
      const res = await ssm.send(new GetParametersByPathCommand({ Path: `${SSM_ROOT}/assistant-assignments/${classification}/primary/assistants`, NextToken: token }));
      for (const p of res.Parameters ?? []) {
        try {
          const r = JSON.parse(p.Value || '{}');
          if (r.source !== 'runtime' && r.assistant) assistant = r.assistant;
        } catch { /* an unreadable record names nobody */ }
      }
      token = res.NextToken;
    } while (token && !assistant);
    primaries.set(classification, assistant);
  }
  return primaries.get(classification);
}

async function main() {
  const adminArn = await getParam(`${SSM_ROOT}/app-instance-admin-arn`);
  if (!adminArn) throw new Error(`App-instance admin ARN not found in SSM (${SSM_ROOT}/app-instance-admin-arn)`);
  const appInstanceArn = appInstanceArnOf(adminArn);
  console.log('App instance:', appInstanceArn);
  console.log(DRY_RUN ? '(dry run: no tags written)\n' : '');

  if (!CONTEXT_TABLE) throw new Error('Set CHANNEL_CONTEXT_TABLE (the Conversations stack output ChannelContextTableName)');
  const counts = { tagged: 0, alreadyTagged: 0, typeRelabeled: 0, noClassification: 0, noPrimaryAssistant: 0, failed: 0 };
  for (const Privacy of ['PRIVATE', 'PUBLIC']) {
    let NextToken;
    do {
      const resp = await messaging.send(new ListChannelsCommand({
        AppInstanceArn: appInstanceArn, ChimeBearer: adminArn, Privacy, MaxResults: 50, NextToken,
      }));
      for (const ch of resp.Channels || []) {
        const channelArn = ch.ChannelArn;
        if (!channelArn) continue;
        const name = ch.Name || '(unnamed)';
        try {
          const tags = (await messaging.send(new ListTagsForResourceCommand({ ResourceARN: channelArn }))).Tags || [];
          const writes = [];
          const wantedType = await typeKeyOf(channelArn);
          if (tags.find((t) => t.Key === TYPE_TAG)?.Value !== wantedType) {
            writes.push({ Key: TYPE_TAG, Value: wantedType });
            counts.typeRelabeled += 1;
          }
          const classification = tags.find((t) => t.Key === 'classification')?.Value;
          if (tags.some((t) => t.Key === PRIMARY_TAG)) {
            counts.alreadyTagged += 1;
            if (writes.length && !DRY_RUN) await messaging.send(new TagResourceCommand({ ResourceARN: channelArn, Tags: writes }));
            continue;
          }
          if (!classification) {
            console.log(`  ! ${name}: no classification tag; left alone`);
            counts.noClassification += 1;
            continue;
          }
          const assistant = await primaryOf(classification);
          if (!assistant) {
            console.log(`  ! ${name}: ${classification} has no (primary, live) assignment record; left alone`);
            counts.noPrimaryAssistant += 1;
            continue;
          }
          writes.push({ Key: PRIMARY_TAG, Value: assistant });
          if (!DRY_RUN) {
            await messaging.send(new TagResourceCommand({ ResourceARN: channelArn, Tags: writes }));
          }
          console.log(`  ${DRY_RUN ? 'would tag' : 'tagged'} ${name} (${classification}) -> ${PRIMARY_TAG}=${assistant}`);
          counts.tagged += 1;
        } catch (err) {
          console.log(`  x ${name}: ${err.name} ${err.message}`);
          counts.failed += 1;
        }
      }
      NextToken = resp.NextToken;
    } while (NextToken);
  }
  console.log('\n' + JSON.stringify(counts));
  if (counts.failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
