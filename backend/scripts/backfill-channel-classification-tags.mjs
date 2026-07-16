#!/usr/bin/env node
/**
 * Backfill: stamp the SPEC-CONVERSATION-SECURITY Layer 1 `classification` tag on
 * every EXISTING channel, derived from its `Metadata.modelTier`.
 *
 * Why: the per-tier IAM channel-join boundary is FAIL-CLOSED — a tier identity
 * may act ONLY on channels tagged `classification ∈ {its tier and below}`. New
 * channels are tagged at creation (create-conversation / channel-creation /
 * proactive-briefing); channels created BEFORE tagging shipped are untagged and
 * would therefore be unreachable. Run this once after deploying the allow-based
 * Layer 1 so existing conversations keep working.
 *
 * Usage:
 *   AWS_PROFILE=<your-profile> node backend/scripts/backfill-channel-classification-tags.mjs
 *   AWS_PROFILE=<your-profile> node backend/scripts/backfill-channel-classification-tags.mjs --dry-run
 *
 * Idempotent: skips channels already carrying a `classification` tag. Reads the
 * app-instance-admin ARN from SSM (/agent-echelon/app-instance-admin-arn) and
 * uses it as ChimeBearer to enumerate + describe + tag every channel.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelsCommand,
  DescribeChannelCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const REGION = process.env.AWS_REGION || 'us-east-1';
const DRY_RUN = process.argv.includes('--dry-run');
const VALID_TIERS = ['basic', 'standard', 'premium'];

const messaging = new ChimeSDKMessagingClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

async function getParam(name) {
  const resp = await ssm.send(new GetParameterCommand({ Name: name }));
  return resp.Parameter?.Value;
}

async function main() {
  const adminArn = await getParam('/agent-echelon/app-instance-admin-arn');
  if (!adminArn) throw new Error('App-instance admin ARN not found in SSM (/agent-echelon/app-instance-admin-arn)');
  const appInstanceArn = adminArn.split('/user/')[0];
  console.log('App instance:', appInstanceArn);
  console.log('Admin bearer:', adminArn);
  console.log(DRY_RUN ? '(dry run — no tags written)\n' : '');

  let nextToken;
  const tagged = [];
  const skipped = [];
  const failed = [];

  do {
    const resp = await messaging.send(
      new ListChannelsCommand({ AppInstanceArn: appInstanceArn, ChimeBearer: adminArn, MaxResults: 50, NextToken: nextToken }),
    );
    for (const ch of resp.Channels || []) {
      const channelArn = ch.ChannelArn;
      const name = ch.Name || '(unnamed)';
      if (!channelArn) continue;
      try {
        // Already tagged? skip.
        const tags = await messaging.send(new ListTagsForResourceCommand({ ResourceARN: channelArn }));
        if ((tags.Tags || []).some((t) => t.Key === 'classification')) {
          skipped.push(name);
          continue;
        }
        // Derive tier from metadata.
        const desc = await messaging.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: adminArn }));
        let tier = 'basic';
        try {
          const meta = JSON.parse(desc.Channel?.Metadata || '{}');
          if (VALID_TIERS.includes(meta.modelTier)) tier = meta.modelTier;
        } catch { /* default basic */ }

        if (DRY_RUN) {
          console.log(`  would tag ${name} → classification=${tier}`);
          tagged.push(name);
          continue;
        }
        await messaging.send(
          new TagResourceCommand({ ResourceARN: channelArn, Tags: [{ Key: 'classification', Value: tier }] }),
        );
        console.log(`  ✓ ${name} → classification=${tier}`);
        tagged.push(name);
      } catch (err) {
        console.log(`  ✗ ${name}: ${err.name} ${err.message}`);
        failed.push({ name, error: err.message });
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  console.log(`\nTagged: ${tagged.length} | Already-tagged (skipped): ${skipped.length} | Failed: ${failed.length}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
