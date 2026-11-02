#!/usr/bin/env node
/**
 * Backfill: stamp the SPEC-CONVERSATION-SECURITY Layer 1 `classification` tag on
 * every EXISTING channel, derived from its `Metadata.modelTier`.
 *
 * Why: the per-classification IAM channel-join boundary is FAIL-CLOSED: an identity
 * may act ONLY on channels tagged with a classification its `grants` set names. New
 * channels are tagged at creation (create-conversation / channel-creation /
 * proactive-briefing); channels created BEFORE tagging shipped are untagged and
 * would therefore be unreachable. Run this once after deploying the allow-based
 * Layer 1 so existing conversations keep working.
 *
 * Usage:
 *   AWS_PROFILE=<your-profile> node backend/scripts/backfill-channel-classification-tags.mjs
 *   AWS_PROFILE=<your-profile> node backend/scripts/backfill-channel-classification-tags.mjs --dry-run
 *
 * The value is the channel's `modelTier` only when it is a classification THIS DEPLOYMENT declares
 * (`lib/deployment-profiles.mjs`, so the registry is the deployment's set); a channel whose metadata names
 * none is left untagged and reported, never stamped with a guessed classification. Run `npm run build` first.
 *
 * Idempotent: skips channels already carrying a `classification` tag. Reads the
 * app-instance-admin ARN from SSM (<SSM root>/app-instance-admin-arn) and
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
import { createRequire } from 'node:module';
// The deployment's set, imported before the registry so the registry is built from it.
import './lib/deployment-profiles.mjs';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry.js';

const { resolveInstanceName } = createRequire(import.meta.url)('./lib/stack-lookup.cjs');
const { appInstanceArnOf } = createRequire(import.meta.url)('./lib/person-arn.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const DRY_RUN = process.argv.includes('--dry-run');

const messaging = new ChimeSDKMessagingClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

async function getParam(name) {
  const resp = await ssm.send(new GetParameterCommand({ Name: name }));
  return resp.Parameter?.Value;
}

async function main() {
  const adminParam = `/${resolveInstanceName(process.env)}/app-instance-admin-arn`;
  const adminArn = await getParam(adminParam);
  if (!adminArn) throw new Error(`App-instance admin ARN not found in SSM (${adminParam})`);
  const appInstanceArn = appInstanceArnOf(adminArn);
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
        let tier;
        try {
          const meta = JSON.parse(desc.Channel?.Metadata || '{}');
          if (profiles.isConversational(meta.modelTier)) tier = profiles.resolveClassification(meta.modelTier);
        } catch { /* unreadable metadata names no classification */ }
        if (!tier) {
          console.log(`  ✗ ${name}: its metadata names no conversational classification this deployment declares; left untagged`);
          failed.push({ name, error: 'no declared classification in metadata' });
          continue;
        }

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
