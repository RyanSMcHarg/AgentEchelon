#!/usr/bin/env node
/**
 * Backfill: associate the AgentEchelon channel flow with all existing channels.
 *
 * Usage:
 *   AWS_PROFILE=<your-profile> node backend/scripts/backfill-channel-flow.mjs
 *
 * Reads the channel flow ARN from SSM (/agent-echelon/channel-flow-arn) and each
 * per-tier bot ARN (/agent-echelon/tier/{tier}/bot-arn), then iterates every
 * channel each bot is a member of and calls AssociateChannelFlow.
 *
 * Safe to re-run: AssociateChannelFlow is idempotent.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelMembershipsForAppInstanceUserCommand,
  AssociateChannelFlowCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const REGION = process.env.AWS_REGION || 'us-east-1';

const messaging = new ChimeSDKMessagingClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

async function getParam(name) {
  const resp = await ssm.send(new GetParameterCommand({ Name: name }));
  return resp.Parameter?.Value;
}

async function associateForBot(botArn, channelFlowArn, processed, failed) {
  let nextToken;
  do {
    const resp = await messaging.send(
      new ListChannelMembershipsForAppInstanceUserCommand({
        AppInstanceUserArn: botArn,
        ChimeBearer: botArn,
        MaxResults: 50,
        NextToken: nextToken,
      }),
    );
    for (const m of resp.ChannelMemberships || []) {
      const channelArn = m.ChannelSummary?.ChannelArn;
      const name = m.ChannelSummary?.Name || '(unnamed)';
      if (!channelArn) continue;
      try {
        await messaging.send(
          new AssociateChannelFlowCommand({
            ChannelArn: channelArn,
            ChannelFlowArn: channelFlowArn,
            ChimeBearer: botArn,
          }),
        );
        processed.push({ channelArn, name });
        console.log(`  ✓ ${name}`);
      } catch (err) {
        failed.push({ channelArn, name, error: err.message });
        console.log(`  ✗ ${name}: ${err.message}`);
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
}

async function main() {
  const channelFlowArn = await getParam('/agent-echelon/channel-flow-arn');
  if (!channelFlowArn) throw new Error('Channel flow ARN not found in SSM (/agent-echelon/channel-flow-arn)');
  console.log('Channel flow ARN:', channelFlowArn);

  // Each tier owns its bot (no shared bot). Iterate every per-tier bot's channel
  // memberships. A tier whose bot isn't deployed is skipped (not an error).
  const processed = [];
  const failed = [];
  for (const tier of ['basic', 'standard', 'premium']) {
    let botArn;
    try {
      botArn = await getParam(`/agent-echelon/tier/${tier}/bot-arn`);
    } catch {
      botArn = undefined;
    }
    if (!botArn) {
      console.log(`(skip ${tier}: /agent-echelon/tier/${tier}/bot-arn not found)`);
      continue;
    }
    console.log(`\n[${tier}] bot ${botArn}`);
    await associateForBot(botArn, channelFlowArn, processed, failed);
  }

  console.log();
  console.log(`Associated: ${processed.length}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
