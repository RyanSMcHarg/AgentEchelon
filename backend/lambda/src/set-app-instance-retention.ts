/**
 * Custom-resource Lambda: set the app-instance message-retention limit.
 *
 * THE LIMIT NOTHING CAN EXCEED, which is the point. A conversation's own
 * `ExpirationSettings` is per channel and every creation path sets it independently, so a
 * limit enforced in a handler binds only the paths that perform the check. Amazon Chime SDK
 * evaluates `AppInstanceRetentionSettings` above every channel in the app instance, whoever
 * created it and whether or not that creator validated anything - which is what tenet P4 asks
 * for: enforced before the request runs rather than checked in code afterwards.
 *
 * ── IT DELETES MESSAGES AND LEAVES THE CONVERSATION STANDING ─────────────────────────────────
 *
 * This is NOT the same operation as a channel expiring. `ExpirationSettings` deletes the whole
 * channel; this deletes the MESSAGES in every channel past the retention period and leaves the
 * channel, its membership and its name in place. So the two are complements rather than
 * alternatives, and a request for a longer channel expiry than this limit does not fail - it
 * produces a conversation that outlives its own contents.
 *
 * That is the reason the handler-side comparison is still worth having: a caller asking for more
 * than the deployment permits should be told so, not handed a conversation whose messages
 * disappear later.
 *
 * ── SETTING IT DELETES HISTORY THAT ALREADY EXISTS ───────────────────────────────────────────
 *
 * Amazon Chime SDK applies a new retention period to messages ALREADY STORED: anything older
 * than the period is deleted, within roughly a day, across every channel in the app instance.
 * There is no undo and the archive is the only copy afterwards. On a deployment carrying real
 * history this is a one-way door, so the value is deliberately a single declared constant rather
 * than a context knob somebody can lower casually.
 *
 * ── WHY THE VALUE IS DERIVED AND NOT TYPED HERE ─────────────────────────────────────────────
 *
 * The limit and the conversation types' own retention are the same policy stated once. It is
 * passed in from `MESSAGE_RETENTION_DAYS`, which lives beside the type declarations it
 * bounds, and `no-type-exceeds-the-retention-limit.test.ts` refuses a type declaring more. Two
 * copies of "90 days" in two files is precisely the drift this codebase keeps paying for.
 *
 * Idempotent: Chime treats the put as a set rather than an append, so re-running is a no-op when
 * the value is unchanged.
 *
 * DELIBERATELY A NO-OP ON DELETE. Removing the limit on a stack teardown would silently relax a
 * retention commitment at the moment nobody is watching, and a destroyed app instance takes its
 * messages with it anyway.
 */
import {
  ChimeSDKIdentityClient,
  GetAppInstanceRetentionSettingsCommand,
  PutAppInstanceRetentionSettingsCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { chimeIdentityClient } from './lib/chime/clients';

const region = process.env.AWS_REGION || 'us-east-1';
const identityClient = chimeIdentityClient({ region });

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || '');

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  if (event.RequestType === 'Delete') {
    console.log('[retention] Delete is a no-op: the limit stays until something deliberately changes it');
    return { PhysicalResourceId: 'app-instance-retention', Data: {} };
  }

  if (!APP_INSTANCE_ARN) throw new Error('APP_INSTANCE_ARN is required');
  // A limit of zero or a non-integer would be read by Chime as "no retention", which is the
  // opposite of this resource's purpose, so it fails the deploy rather than silently unsetting it.
  if (!Number.isInteger(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    throw new Error(`RETENTION_DAYS must be a positive integer, got "${process.env.RETENTION_DAYS}"`);
  }

  // Read first, so the log says what changed rather than only what was requested. A deploy that
  // LOWERS the limit is the destructive case, and it is worth being able to find afterwards.
  let previous: number | undefined;
  try {
    const current = await identityClient.send(
      new GetAppInstanceRetentionSettingsCommand({ AppInstanceArn: APP_INSTANCE_ARN }),
    );
    previous = current.AppInstanceRetentionSettings?.ChannelRetentionSettings?.RetentionDays;
  } catch (err) {
    // Not fatal: the read is for the record, and a deployment that cannot read it can still set it.
    console.warn('[retention] could not read the current setting:', (err as Error).message);
  }

  if (previous === RETENTION_DAYS) {
    console.log(`[retention] already ${RETENTION_DAYS} days; nothing to do`);
    return { PhysicalResourceId: 'app-instance-retention', Data: { RetentionDays: RETENTION_DAYS } };
  }

  if (previous !== undefined && RETENTION_DAYS < previous) {
    console.warn(
      `[retention] LOWERING the limit from ${previous} to ${RETENTION_DAYS} days. `
      + 'Messages already older than the new period are deleted by Amazon Chime SDK across every '
      + 'channel in this app instance, and the archive is the only remaining copy.',
    );
  }

  await identityClient.send(new PutAppInstanceRetentionSettingsCommand({
    AppInstanceArn: APP_INSTANCE_ARN,
    AppInstanceRetentionSettings: { ChannelRetentionSettings: { RetentionDays: RETENTION_DAYS } },
  }));

  console.log(`[retention] set to ${RETENTION_DAYS} days (was ${previous ?? 'unset'})`);
  return { PhysicalResourceId: 'app-instance-retention', Data: { RetentionDays: RETENTION_DAYS } };
};
