#!/usr/bin/env node
/**
 * Backfill `channel_classification` from Amazon Chime SDK Messaging (ADR-028).
 *
 * WHY THIS RUNS OUT HERE AND NOT IN THE VPC. The authority for a channel's classification is its
 * immutable Chime channel tag. The Aurora VPC is provisioned with `natGateways: 0` and interface
 * endpoints for Kinesis, S3, Secrets Manager, DynamoDB and Bedrock Runtime only - so nothing that can
 * reach the database can reach Chime, and nothing that can reach Chime can reach the database.
 * Rather than punch a hole through that (the platform's standing rule is not to), this script does the
 * authoritative read where Chime is reachable and hands the result to the data-plane as one op.
 *
 * WHY NOT READ IT FROM AURORA'S OWN ARCHIVE, which already lists channels. ADR-012: the archive is a
 * lagging projection filled asynchronously by the Kinesis path, and it is never the authority for a
 * boundary decision. Seeding the boundary from it would bake that lag in permanently - and unlike a
 * stale membership read, a stale classification is not self-correcting, because the value is written
 * once and then trusted by every subsequent read.
 *
 * WHAT IT IS FOR. A live turn refreshes its own channel through the `detectDrift` op, so an active
 * conversation keeps itself current. This exists for the rest: channels that predate ADR-028,
 * channels that have not had a turn since, and the first run on an existing deployment - where every
 * summary embedding is otherwise stamped fail-closed to the most restrictive classification and is
 * invisible to everything below it.
 *
 * USAGE
 *   node backend/scripts/backfill-channel-classifications.mjs [--dry-run] [--verify]
 *
 *   --dry-run  enumerate and report, write nothing
 *   --verify   afterwards, run the ADR's boundary checks against the live database
 *
 * Reads the deployment context the same way the other scripts do (`backend/deploy.config.json`).
 */

import {
  ChimeSDKMessagingClient,
  ListChannelsCommand,
  DescribeChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

function loadConfig() {
  const p = path.join(REPO_ROOT, 'backend', 'deploy.config.json');
  if (!fs.existsSync(p)) {
    console.error(`✗ ${p} not found. This script needs the deployment context (app instance ARN, region).`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const config = loadConfig();
const REGION = config.region || process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = config.appInstanceArn || process.env.APP_INSTANCE_ARN;
const DATA_PLANE_ARN = config.dataPlaneArn || process.env.AURORA_DATA_PLANE_ARN;
const ADMIN_ARN = config.adminUserArn || process.env.CHIME_ADMIN_ARN;

if (!APP_INSTANCE_ARN || !DATA_PLANE_ARN || !ADMIN_ARN) {
  console.error(
    '✗ missing context. Need appInstanceArn, dataPlaneArn and adminUserArn in backend/deploy.config.json\n'
    + '  (or APP_INSTANCE_ARN / AURORA_DATA_PLANE_ARN / CHIME_ADMIN_ARN in the environment).',
  );
  process.exit(1);
}

const chime = new ChimeSDKMessagingClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

/**
 * The classification lives in the channel's Metadata, which is where the rest of the platform reads
 * it from. NOT trusted blindly: `recordChannelClassifications` rejects any value this deployment does
 * not declare, so a malformed or hand-edited Metadata blob cannot seed a label that later reads would
 * have to defend against.
 *
 * Metadata is member-WRITABLE (users hold UpdateChannel), which is exactly why this is a projection
 * that feeds a fail-closed default rather than a live authority: a wrong value here produces a row
 * stamped for the wrong classification, and the ingest-side content guard - not this script - is what
 * stands between that and a mislabelled document. Recorded provenance makes it auditable.
 */
function classificationFromChannel(channel) {
  try {
    const metadata = JSON.parse(channel?.Metadata || '{}');
    const value = metadata.classification;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

async function listAllChannels() {
  const arns = [];
  let nextToken;
  do {
    const page = await chime.send(new ListChannelsCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      ChimeBearer: ADMIN_ARN,
      MaxResults: 50,
      NextToken: nextToken,
    }));
    for (const summary of page.Channels || []) {
      if (summary.ChannelArn) arns.push(summary.ChannelArn);
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return arns;
}

async function invokeDataPlane(op, input) {
  const response = await lambda.send(new InvokeCommand({
    FunctionName: DATA_PLANE_ARN,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({ op, input })),
  }));
  const payload = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
  if (response.FunctionError) {
    throw new Error(`data-plane '${op}' failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  console.log(`Enumerating channels in ${APP_INSTANCE_ARN} (${REGION})...`);
  const arns = await listAllChannels();
  console.log(`  ${arns.length} channel(s)`);

  const records = [];
  const untagged = [];
  for (const arn of arns) {
    const described = await chime.send(new DescribeChannelCommand({ ChannelArn: arn, ChimeBearer: ADMIN_ARN }));
    const classification = classificationFromChannel(described.Channel);
    if (classification) {
      records.push({ channelArn: arn, classification, source: 'backfill' });
    } else {
      untagged.push(arn);
    }
  }

  console.log(`  ${records.length} carry a classification, ${untagged.length} do not`);
  if (untagged.length) {
    // NOT an error, and deliberately not defaulted here. A channel with no classification tag stays
    // absent from the projection, which makes the writer stamp its summary fail-closed to the most
    // restrictive value. Inventing a value in this script would be the one place a guess could
    // silently become the boundary.
    console.log('  (untagged channels are left absent; their summaries stay at the most restrictive classification)');
    for (const arn of untagged.slice(0, 5)) console.log(`    - ${arn}`);
    if (untagged.length > 5) console.log(`    ... and ${untagged.length - 5} more`);
  }

  const byClassification = records.reduce((acc, r) => {
    acc[r.classification] = (acc[r.classification] || 0) + 1;
    return acc;
  }, {});
  console.log('  by classification:', byClassification);

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing written.');
  } else {
    const result = await invokeDataPlane('setChannelClassifications', { records });
    console.log(`\n✓ recorded ${result.recorded} channel classification(s)`);
    if (result.rejected?.length) {
      console.log(`  ✗ ${result.rejected.length} rejected (classification not declared by this deployment):`);
      for (const r of result.rejected.slice(0, 5)) console.log(`    - ${r.channelArn}: ${r.classification}`);
    }
  }

  if (VERIFY) {
    console.log('\nVerifying the classification boundary against the live database...');
    const verification = await invokeDataPlane('verifyClassificationBoundary', {});
    for (const check of verification.checks) {
      console.log(`  ${check.passed ? '✓' : '✗'} ${check.name}\n      ${check.detail}`);
    }
    if (!verification.ok) {
      console.error('\n✗ THE CLASSIFICATION BOUNDARY IS NOT HOLDING. See the failing checks above.');
      process.exit(1);
    }
    console.log(`\n✓ boundary verified over [${verification.classifications.join(', ')}]`);
  }
}

main().catch((err) => {
  console.error('✗ backfill failed:', err);
  process.exit(1);
});
