/**
 * Membership Audit Lambda — SPEC-CONVERSATION-SECURITY Layer 6 (near-real-time backstop).
 *
 * WHY THIS EXISTS. The IAM classification tag gate (Layer 1) cannot gate
 * `CreateChannelMembership`: that action authorizes against the bearer/user resource,
 * which carries no `classification` tag, so a tag condition would fail closed and break
 * legitimate membership. A membership added out of band (a direct Chime API call by a
 * moderator, a script, or compromised creds) can therefore place an under-cleared member on
 * a higher-classification channel. Layer 1 still makes that member INERT (their tag-capped creds
 * cannot read or send on the higher-classification channel), so this audit closes the residual
 * VISIBILITY gap, not a write-leak.
 *
 * WHAT IT DOES. Consumes the same Chime -> Kinesis stream the archival pipeline uses,
 * filters CREATE/UPDATE_CHANNEL_MEMBERSHIP, resolves the member's authoritative
 * Cognito-group clearance, compares it to the channel's classification (the immutable tag),
 * and on an over-reaching member:
 *   1. logs a `[MembershipAudit][SecurityEvent]` plus a structured `_auditEvent` line;
 *   2. alerts the admin conversation (an in-app message + an email fan-out through the
 *      notification bridge, `lib/channel-notify.fanOutChannelNotification`);
 *   3. when `MEMBERSHIP_AUDIT_ENFORCE=true`, revokes the membership
 *      (`DeleteChannelMembership` as the app-instance-admin bearer).
 *
 * Report-only by default (enforce is opt-in) so a false positive alerts rather than
 * removing a legitimate member. Two subjects are audited: a HUMAN member below the channel
 * classification (they would see content above their clearance) and an ASSISTANT (`/bot/`) above the
 * channel classification (it answers with its own classification's model + context to lower-clearance
 * users, which Layer 1 does not stop). The admin service user and federated (`fed_`) members are
 * skipped: the admin is the service moderator, and federated subs are not resolvable via
 * `AdminListGroupsForUser`. A `/battle` alt-slot bot (not a classification assistant) is left alone.
 */
import { KinesisStreamEvent, KinesisStreamRecord, Context } from 'aws-lambda';
import {
  ChimeSDKMessagingClient,
  ListTagsForResourceCommand,
  DeleteChannelMembershipCommand,
  SendChannelMessageCommand,
  ListChannelsCommand,
  ListChannelMembershipsCommand,
  ListChannelMembershipsForAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { fanOutChannelNotification } from './lib/channel-notify.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry.js';
import { resolveChannelClassificationTag as resolveChannelClassificationTagShared } from './lib/channel-classification.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
// Trigger #2 (sweep) bound: cap channels scanned per scheduled run so a large app instance can't run
// the sweep unbounded. 0/unset ⇒ the default. A truncated sweep logs what it dropped (no silent cap).
const MAX_SWEEP_CHANNELS = parseInt(process.env.MAX_SWEEP_CHANNELS || '500', 10);
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'agent-echelon-admin';
const ALERT_CHANNEL_ARN = process.env.MEMBERSHIP_AUDIT_ALERT_CHANNEL_ARN || '';
const ENFORCE_DEFAULT = process.env.MEMBERSHIP_AUDIT_ENFORCE === 'true';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const AUDIT_TABLE = process.env.AUDIT_TABLE || '';

export const AUDITED_EVENT_TYPES = new Set(['CREATE_CHANNEL_MEMBERSHIP', 'UPDATE_CHANNEL_MEMBERSHIP']);

interface ChimeKinesisEvent {
  EventType: string;
  Payload: {
    ChannelArn?: string;
    Member?: { Arn: string };
    InvitedBy?: { Arn: string };
    Channel?: { ChannelArn: string; Metadata?: string };
  };
}

export type MemberKind = 'user' | 'bot' | 'admin' | 'federated' | 'unknown';

/** Pure: classify a channel-member ARN. Only `user` members are clearance-audited. `bot` (not a
 *  Cognito-group identity), `admin` (the service moderator), and `federated` (derived sub, not
 *  resolvable via Cognito) are skipped. */
export function classifyMember(
  memberArn: string | undefined,
  adminUserId: string = ADMIN_USER_ID,
): { kind: MemberKind; sub: string | null } {
  if (!memberArn) return { kind: 'unknown', sub: null };
  const marker = '/user/';
  const idx = memberArn.indexOf(marker);
  if (idx === -1) return { kind: 'bot', sub: null }; // `/bot/...` or any non-user principal
  const sub = memberArn.slice(idx + marker.length);
  if (!sub) return { kind: 'unknown', sub: null };
  if (sub === adminUserId) return { kind: 'admin', sub };
  if (sub.startsWith('fed_')) return { kind: 'federated', sub };
  return { kind: 'user', sub };
}

/** Pure: is the member's clearance below the channel's classification? Unknown values fail safe
 *  (member defaults to the lowest rank, channel to `basic`). */
export function isClassificationViolation(memberClearance: string, channelClassification: string): boolean {
  // Unknown member clearance ranks BELOW everything (0) so it always over-reports (fail-safe);
  // unknown channel classification defaults to the fail-closed floor. Ranks come from the registry.
  const m = profiles.isKnownClassification(memberClearance) ? profiles.rank(memberClearance) : 0;
  const c = profiles.isKnownClassification(channelClassification) ? profiles.rank(channelClassification) : profiles.rank(profiles.failClosedValue);
  return m < c;
}

const chime = new ChimeSDKMessagingClient({ region: AWS_REGION });
const cognito = new CognitoIdentityProviderClient({ region: AWS_REGION });
const ssm = new SSMClient({ region: AWS_REGION });
const ddb = AUDIT_TABLE ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION })) : null;

/** Runtime enforce toggle, so an admin can switch report-only <-> auto-revoke without a redeploy.
 *  Read from the audit table's `config/enforce` item; falls back to the deploy-time env default.
 *  Cached ~30s. */
let enforceCache: { value: boolean; expires: number } | null = null;
async function isEnforcing(): Promise<boolean> {
  if (!ddb) return ENFORCE_DEFAULT;
  if (enforceCache && enforceCache.expires > Date.now()) return enforceCache.value;
  let value = ENFORCE_DEFAULT;
  try {
    const r = await ddb.send(new GetCommand({ TableName: AUDIT_TABLE, Key: { pk: 'config', sk: 'enforce' } }));
    if (r.Item && typeof r.Item.value === 'string') value = r.Item.value === 'true';
  } catch (err) {
    console.warn('[MembershipAudit] failed to read enforce toggle; using default:', err);
  }
  enforceCache = { value, expires: Date.now() + 30_000 };
  return value;
}

/** Persist each finding so the admin dashboard can review it and take manual action. Best-effort. */
async function writeFinding(f: {
  kind: string; channelArn: string; memberArn: string; subjectClearance: string; channelClassification: string; action: string;
}): Promise<void> {
  if (!ddb) return;
  const ts = new Date().toISOString();
  try {
    await ddb.send(new PutCommand({
      TableName: AUDIT_TABLE,
      Item: { pk: 'finding', sk: `${ts}#${f.channelArn}#${f.memberArn}`, ...f, ts, status: 'open' },
    }));
  } catch (err) {
    console.warn('[MembershipAudit] failed to persist finding:', err);
  }
}

/**
 * The admin AppInstanceUser ARN every Chime call in this Lambda uses as its ChimeBearer. Cached per
 * container after the first successful read.
 *
 * THROWS rather than returning '' when it cannot be resolved, and the handler lets that propagate.
 * That is deliberate: without a bearer ARN no membership can be evaluated, and an empty string would
 * make every downstream Chime call fail one-by-one while the batch checkpointed successfully - a
 * security audit that reports nothing and looks healthy. Failing the invocation instead hands the
 * records back to the event source, which retries (retryAttempts: 3, bisectBatchOnError) and then
 * surfaces the failure. A transient SSM throttle is absorbed by those retries; a PERSISTENT
 * misconfiguration (parameter deleted, wrong name, no read grant) is what the explicit message below
 * is for, because a bare SSM error here is indistinguishable from any other failure in the batch.
 */
let cachedAdminArn: string | null = null;
async function getAdminArn(): Promise<string> {
  if (cachedAdminArn) return cachedAdminArn;
  let value: string | undefined;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: ADMIN_ARN_PARAM }));
    value = resp.Parameter?.Value;
  } catch (err) {
    throw new Error(
      `[MembershipAudit] cannot resolve the admin bearer ARN from SSM '${ADMIN_ARN_PARAM}' `
      + `(${(err as Error).name}: ${(err as Error).message}). The membership audit cannot evaluate any `
      + 'membership without it; failing the invocation so the records are retried rather than silently skipped.',
    );
  }
  if (!value) {
    throw new Error(
      `[MembershipAudit] SSM parameter '${ADMIN_ARN_PARAM}' resolved to an empty value. The membership `
      + 'audit cannot run without an admin bearer ARN - check the parameter was populated at deploy time.',
    );
  }
  cachedAdminArn = value;
  return cachedAdminArn;
}

/** Resolve a member's authoritative clearance from their Cognito groups. Returns null when the
 *  identity cannot be resolved (e.g. UserNotFound) so the caller skips rather than risking a
 *  false-positive revocation of an unresolvable identity. */
async function resolveMemberClearance(sub: string): Promise<string | null> {
  if (!USER_POOL_ID) return null;
  try {
    const resp = await cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: sub }),
    );
    const groups = (resp.Groups || []).map((g) => g.GroupName || '');
    return profiles.clearanceForGroups(groups);
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === 'UserNotFoundException') return null; // unresolvable — skip, do not act
    console.warn('[MembershipAudit] failed to resolve member clearance; skipping:', err);
    return null;
  }
}

// The channel's classification for the violation comparison comes from the IMMUTABLE
// `classification` tag, NOT `metadata.modelTier`. Reading mutable metadata here would let a
// moderator who adds an over-tier assistant also tamper `modelTier` up to match it, blinding
// this detector (botClassification > channelClassification would go false). The tag cannot be changed by
// UpdateChannel. Fail-closed to basic so an unreadable tag over-reports rather than misses.
async function resolveChannelClassification(channelArn: string, _bearerArn: string): Promise<string> {
  return resolveChannelClassificationTagShared(chime, channelArn, '[MembershipAudit]');
}

let botClassificationMap: Map<string, string> | null = null;
/** Map each per-classification assistant's bot ARN (`${SSM_ROOT}/assistant/{classification}/bot-arn`)
 *  to its classification. Cached for the Lambda's warm life. A bot ARN not in this map is not one of
 *  the default classification assistants (e.g. a `/battle` alt-slot bot), so it is left alone. */
async function loadBotClassificationMap(): Promise<Map<string, string>> {
  if (botClassificationMap) return botClassificationMap;
  const map = new Map<string, string>();
  for (const classification of profiles.classificationValues()) {
    try {
      const resp = await ssm.send(new GetParameterCommand({ Name: `${SSM_ROOT}/assistant/${classification}/bot-arn` }));
      if (resp.Parameter?.Value) map.set(resp.Parameter.Value, classification);
    } catch {
      /* a classification without a published bot ARN is simply not mapped */
    }
  }
  botClassificationMap = map;
  return map;
}
async function resolveBotClassification(botArn: string): Promise<string | null> {
  return (await loadBotClassificationMap()).get(botArn) ?? null;
}

/** Post the alert into the admin conversation (in-app surface) and fan it out to the admin
 *  roster over email through the notification bridge. Best-effort; never throws. Degrades to
 *  log-only when no admin conversation is configured. */
async function alertAdmins(adminArn: string, text: string, subject: string): Promise<void> {
  if (!ALERT_CHANNEL_ARN) return;
  try {
    await chime.send(
      new SendChannelMessageCommand({
        ChannelArn: ALERT_CHANNEL_ARN,
        ChimeBearer: adminArn,
        Content: text,
        Type: 'STANDARD',
        Persistence: 'PERSISTENT',
        ClientRequestToken: randomUUID(),
      }),
    );
  } catch (err) {
    console.warn('[MembershipAudit] failed to post admin-conversation alert:', err);
  }
  try {
    await fanOutChannelNotification({
      channelArn: ALERT_CHANNEL_ARN,
      bearerArn: adminArn,
      userPoolId: USER_POOL_ID,
      messageText: text,
      directive: { notify: { email: true }, subject },
    });
  } catch (err) {
    console.warn('[MembershipAudit] failed to fan out admin email:', err);
  }
}

async function handleViolation(
  kind: 'member' | 'assistant',
  channelArn: string,
  memberArn: string,
  subjectId: string,
  subjectClearance: string,
  channelClassification: string,
): Promise<void> {
  const adminArn = await getAdminArn();
  const enforcing = await isEnforcing();
  const noun = kind === 'assistant' ? 'assistant' : 'member';
  console.warn(`[MembershipAudit][SecurityEvent] over-tier ${noun}`, {
    _auditEvent: kind === 'assistant' ? 'assistant_tier_violation' : 'membership_tier_violation',
    channelArn,
    memberArn,
    subject: subjectId,
    subjectClearance,
    channelClassification,
    action: enforcing ? 'revoked' : 'reported',
  });
  await writeFinding({ kind, channelArn, memberArn, subjectClearance, channelClassification, action: enforcing ? 'revoked' : 'reported' });

  const verb = enforcing ? 'was removed from' : 'was found on';
  const tail = enforcing
    ? 'The membership has been revoked.'
    : 'Enforcement is off; the membership was left in place. Flip the enforce toggle in the admin dashboard (or set MEMBERSHIP_AUDIT_ENFORCE) to auto-revoke.';
  const text =
    `Security audit: a ${subjectClearance}-tier ${noun} ${verb} a ${channelClassification}-tier conversation.\n` +
    `Channel: ${channelArn}\n${kind === 'assistant' ? 'Assistant' : 'Member'}: ${memberArn}\n${tail}`;
  await alertAdmins(adminArn, text, `[Security] Over-tier ${noun} on a ${channelClassification} conversation`);

  if (!enforcing) return;
  try {
    await chime.send(
      new DeleteChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: memberArn,
        ChimeBearer: adminArn,
      }),
    );
    console.warn(`[MembershipAudit] revoked over-tier ${noun}`, { channelArn, memberArn });
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === 'NotFoundException' || name === 'ConflictException') return; // idempotent
    console.error('[MembershipAudit] failed to revoke membership:', err);
  }
}

function parseRecord(record: KinesisStreamRecord): ChimeKinesisEvent | null {
  try {
    return JSON.parse(Buffer.from(record.kinesis.data, 'base64').toString('utf-8')) as ChimeKinesisEvent;
  } catch {
    return null;
  }
}

/**
 * Evaluate ONE (channel, member) pair for an over-tier violation and flag/revoke it. The single shared
 * check behind all three detection triggers (SPEC-CONVERSATION-SECURITY §11): the Kinesis event stream
 * (#1), the scheduled sweep (#2), and the on-downgrade re-eval (#3) all funnel here, so the violation
 * rule lives in exactly one place. Best-effort per pair - a resolution error for one member never aborts
 * the batch/sweep.
 */
async function evaluateMembership(channelArn: string, memberArn: string, adminArn: string): Promise<void> {
  const { kind, sub } = classifyMember(memberArn);
  if (kind !== 'user' && kind !== 'bot') return; // admin service user, federated, unknown

  try {
    if (kind === 'user' && sub) {
      // A human BELOW the channel's classification is the leak (they would see content above their clearance).
      const memberClearance = await resolveMemberClearance(sub);
      if (!memberClearance) return; // unresolvable identity — skip
      const channelClassification = await resolveChannelClassification(channelArn, adminArn);
      if (isClassificationViolation(memberClearance, channelClassification)) {
        await handleViolation('member', channelArn, memberArn, sub, memberClearance, channelClassification);
      }
    } else if (kind === 'bot') {
      // An assistant ABOVE the channel's classification is the leak: it answers with its own
      // classification's model and context to users below that clearance. Layer 1 does NOT stop this,
      // because the bot's own creds already cover its classification and below. A bot not matching any
      // classification assistant (a `/battle` alt-slot) is left alone.
      const botClassification = await resolveBotClassification(memberArn);
      if (!botClassification) return;
      const channelClassification = await resolveChannelClassification(channelArn, adminArn);
      // Over-tier assistant: its classification ranks ABOVE the channel's. Unknown bot ranks 0,
      // unknown channel the fail-closed floor — same fail-safe direction as isClassificationViolation.
      const botRank = profiles.isKnownClassification(botClassification) ? profiles.rank(botClassification) : 0;
      const chRank = profiles.isKnownClassification(channelClassification) ? profiles.rank(channelClassification) : profiles.rank(profiles.failClosedValue);
      if (botRank > chRank) {
        await handleViolation('assistant', channelArn, memberArn, botClassification, botClassification, channelClassification);
      }
    }
  } catch (err) {
    console.error('[MembershipAudit] error evaluating membership:', { channelArn, memberArn, err });
  }
}

/**
 * Trigger #2 (SPEC-CONVERSATION-SECURITY §11): scheduled sweep of EVERY channel's memberships against
 * the CURRENT channel classification. Catches a violation the event stream can't - a member who became
 * over-tier AFTER joining (their clearance was downgraded, or the channel was re-tagged down), which
 * emits no membership event. Bounded by MAX_SWEEP_CHANNELS; a truncated run logs what it dropped.
 */
async function sweepAllChannels(adminArn: string): Promise<void> {
  if (!APP_INSTANCE_ARN) {
    console.warn('[MembershipAudit][sweep] APP_INSTANCE_ARN unset; cannot enumerate channels');
    return;
  }
  let scanned = 0;
  let nextToken: string | undefined;
  let truncated = false;
  do {
    const resp = await chime.send(new ListChannelsCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      ChimeBearer: adminArn,
      MaxResults: 50,
      NextToken: nextToken,
    }));
    for (const ch of resp.Channels || []) {
      if (scanned >= MAX_SWEEP_CHANNELS) { truncated = true; break; }
      if (ch.ChannelArn) {
        await sweepChannelMemberships(ch.ChannelArn, adminArn);
        scanned += 1;
      }
    }
    nextToken = truncated ? undefined : resp.NextToken;
  } while (nextToken);
  console.log('[MembershipAudit][sweep] complete', { scanned, truncated, cap: MAX_SWEEP_CHANNELS });
  if (truncated) {
    console.warn('[MembershipAudit][sweep] hit MAX_SWEEP_CHANNELS; remaining channels NOT scanned this run', { cap: MAX_SWEEP_CHANNELS });
  }
}

/** Evaluate every member of one channel (paginated). Used by the sweep. */
async function sweepChannelMemberships(channelArn: string, adminArn: string): Promise<void> {
  let nextToken: string | undefined;
  do {
    const resp = await chime.send(new ListChannelMembershipsCommand({
      ChannelArn: channelArn,
      ChimeBearer: adminArn,
      MaxResults: 50,
      NextToken: nextToken,
    }));
    for (const m of resp.ChannelMemberships || []) {
      if (m.Member?.Arn) await evaluateMembership(channelArn, m.Member.Arn, adminArn);
    }
    nextToken = resp.NextToken;
  } while (nextToken);
}

/**
 * Trigger #3 (SPEC-CONVERSATION-SECURITY §11): re-evaluate ONE user's existing memberships immediately
 * after their clearance changes (a Cognito-group downgrade emits no Chime membership event, so the
 * event stream never re-checks them). Invoked async by user-management on downgrade. Lists the user's
 * channels and evaluates each against the user's new clearance.
 */
async function reevalUser(userArn: string, adminArn: string): Promise<void> {
  let nextToken: string | undefined;
  let scanned = 0;
  do {
    const resp = await chime.send(new ListChannelMembershipsForAppInstanceUserCommand({
      AppInstanceUserArn: userArn,
      ChimeBearer: adminArn,
      MaxResults: 50,
      NextToken: nextToken,
    }));
    for (const m of resp.ChannelMemberships || []) {
      const channelArn = m.ChannelSummary?.ChannelArn;
      if (channelArn) { await evaluateMembership(channelArn, userArn, adminArn); scanned += 1; }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  console.log('[MembershipAudit][reeval-user] complete', { userArn, scanned });
}

/** A non-Kinesis invocation: the scheduled sweep (#2) or a targeted user re-eval (#3). */
interface AuditControlEvent {
  type: 'sweep' | 'reeval-user';
  /** Required for 'reeval-user': the AppInstanceUser ARN whose memberships to re-check. */
  userArn?: string;
}

export async function handler(
  event: KinesisStreamEvent | AuditControlEvent,
  _context?: Context,
): Promise<void> {
  const adminArn = await getAdminArn();

  // Dispatch by event shape. Kinesis event source → membership events (#1); a scheduled/async invoke
  // carries { type } → the sweep (#2) or a targeted user re-eval (#3).
  if ('type' in event) {
    if (event.type === 'sweep') {
      await sweepAllChannels(adminArn);
    } else if (event.type === 'reeval-user' && event.userArn) {
      await reevalUser(event.userArn, adminArn);
    } else {
      console.warn('[MembershipAudit] unrecognized control event', { event });
    }
    return;
  }

  for (const record of event.Records) {
    const evt = parseRecord(record);
    if (!evt || !AUDITED_EVENT_TYPES.has(evt.EventType)) continue;
    const channelArn = evt.Payload.ChannelArn || evt.Payload.Channel?.ChannelArn;
    const memberArn = evt.Payload.Member?.Arn;
    if (!channelArn || !memberArn) continue;
    await evaluateMembership(channelArn, memberArn, adminArn);
  }
}
