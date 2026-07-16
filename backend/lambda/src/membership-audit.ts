/**
 * Membership Audit Lambda — SPEC-CONVERSATION-SECURITY Layer 6 (near-real-time backstop).
 *
 * WHY THIS EXISTS. The IAM classification tag gate (Layer 1) cannot gate
 * `CreateChannelMembership`: that action authorizes against the bearer/user resource,
 * which carries no `classification` tag, so a tag condition would fail closed and break
 * legitimate membership. A membership added out of band (a direct Chime API call by a
 * moderator, a script, or compromised creds) can therefore place an under-tier member on
 * a higher-tier channel. Layer 1 still makes that member INERT (their tag-capped creds
 * cannot read or send on the higher-tier channel), so this audit closes the residual
 * VISIBILITY gap, not a write-leak.
 *
 * WHAT IT DOES. Consumes the same Chime -> Kinesis stream the archival pipeline uses,
 * filters CREATE/UPDATE_CHANNEL_MEMBERSHIP, resolves the member's authoritative
 * Cognito-group tier, compares it to the channel's `modelTier`, and on an over-tier
 * member:
 *   1. logs a `[MembershipAudit][SecurityEvent]` plus a structured `_auditEvent` line;
 *   2. alerts the admin conversation (an in-app message + an email fan-out through the
 *      notification bridge, `lib/channel-notify.fanOutChannelNotification`);
 *   3. when `MEMBERSHIP_AUDIT_ENFORCE=true`, revokes the membership
 *      (`DeleteChannelMembership` as the app-instance-admin bearer).
 *
 * Report-only by default (enforce is opt-in) so a false positive alerts rather than
 * removing a legitimate member. Two subjects are audited: a HUMAN member below the channel
 * tier (they would see content above their clearance) and an ASSISTANT (`/bot/`) above the
 * channel tier (it answers with its own tier's model + context to lower-clearance users,
 * which Layer 1 does not stop). The admin service user and federated (`fed_`) members are
 * skipped: the admin is the service moderator, and federated subs are not resolvable via
 * `AdminListGroupsForUser`. A `/battle` alt-slot bot (not a tier assistant) is left alone.
 */
import { KinesisStreamEvent, KinesisStreamRecord, Context } from 'aws-lambda';
import {
  ChimeSDKMessagingClient,
  ListTagsForResourceCommand,
  DeleteChannelMembershipCommand,
  SendChannelMessageCommand,
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

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'agent-echelon-admin';
const ALERT_CHANNEL_ARN = process.env.MEMBERSHIP_AUDIT_ALERT_CHANNEL_ARN || '';
const ENFORCE_DEFAULT = process.env.MEMBERSHIP_AUDIT_ENFORCE === 'true';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const AUDIT_TABLE = process.env.AUDIT_TABLE || '';

export const TIER_RANK: Record<string, number> = { basic: 1, standard: 2, premium: 3 };
const TIER_GROUPS = ['basic', 'standard', 'premium'] as const;
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

/** Pure: classify a channel-member ARN. Only `user` members are tier-audited. `bot` (not a
 *  tier-capped identity), `admin` (the service moderator), and `federated` (derived sub, not
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

/** Pure: is the member's tier below the channel's classification? Unknown tiers fail safe
 *  (member defaults to the lowest rank, channel to `basic`). */
export function isTierViolation(memberTier: string, channelTier: string): boolean {
  const m = TIER_RANK[memberTier] ?? 0;
  const c = TIER_RANK[channelTier] ?? TIER_RANK.basic;
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
  kind: string; channelArn: string; memberArn: string; subjectTier: string; channelTier: string; action: string;
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

let cachedAdminArn: string | null = null;
async function getAdminArn(): Promise<string> {
  if (cachedAdminArn) return cachedAdminArn;
  const resp = await ssm.send(new GetParameterCommand({ Name: ADMIN_ARN_PARAM }));
  cachedAdminArn = resp.Parameter?.Value || '';
  return cachedAdminArn;
}

/** Resolve a member's authoritative tier from their Cognito groups. Returns null when the
 *  identity cannot be resolved (e.g. UserNotFound) so the caller skips rather than risking a
 *  false-positive revocation of an unresolvable identity. */
async function resolveMemberTier(sub: string): Promise<string | null> {
  if (!USER_POOL_ID) return null;
  try {
    const resp = await cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: sub }),
    );
    const groups = (resp.Groups || []).map((g) => g.GroupName || '');
    let tier = 'basic';
    for (const candidate of TIER_GROUPS) if (groups.includes(candidate)) tier = candidate;
    return tier;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === 'UserNotFoundException') return null; // unresolvable — skip, do not act
    console.warn('[MembershipAudit] failed to resolve member tier; skipping:', err);
    return null;
  }
}

// The channel's tier for the violation comparison comes from the IMMUTABLE
// `classification` tag, NOT `metadata.modelTier`. Reading mutable metadata here would let a
// moderator who adds an over-tier assistant also tamper `modelTier` up to match it, blinding
// this detector (botTier > channelTier would go false). The tag cannot be changed by
// UpdateChannel. Fail-closed to basic so an unreadable tag over-reports rather than misses.
async function resolveChannelTier(channelArn: string, _bearerArn: string): Promise<string> {
  try {
    const resp = await chime.send(new ListTagsForResourceCommand({ ResourceARN: channelArn }));
    const tag = (resp.Tags || []).find((t) => t.Key === 'classification')?.Value;
    if (tag && TIER_RANK[tag]) return tag;
    console.warn('[MembershipAudit] channel missing/invalid classification tag; defaulting basic', { channelArn, tag });
    return 'basic';
  } catch (err) {
    console.warn('[MembershipAudit] failed to read channel classification tag; defaulting basic:', err);
    return 'basic';
  }
}

let botTierMap: Map<string, string> | null = null;
/** Map each per-tier assistant's bot ARN (`${SSM_ROOT}/tier/{tier}/bot-arn`) to its tier.
 *  Cached for the Lambda's warm life. A bot ARN not in this map is not one of the default
 *  tier assistants (e.g. a `/battle` alt-slot bot), so it is left alone. */
async function loadBotTierMap(): Promise<Map<string, string>> {
  if (botTierMap) return botTierMap;
  const map = new Map<string, string>();
  for (const tier of TIER_GROUPS) {
    try {
      const resp = await ssm.send(new GetParameterCommand({ Name: `${SSM_ROOT}/tier/${tier}/bot-arn` }));
      if (resp.Parameter?.Value) map.set(resp.Parameter.Value, tier);
    } catch {
      /* a tier without a published bot ARN is simply not mapped */
    }
  }
  botTierMap = map;
  return map;
}
async function resolveBotTier(botArn: string): Promise<string | null> {
  return (await loadBotTierMap()).get(botArn) ?? null;
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
  subjectTier: string,
  channelTier: string,
): Promise<void> {
  const adminArn = await getAdminArn();
  const enforcing = await isEnforcing();
  const noun = kind === 'assistant' ? 'assistant' : 'member';
  console.warn(`[MembershipAudit][SecurityEvent] over-tier ${noun}`, {
    _auditEvent: kind === 'assistant' ? 'assistant_tier_violation' : 'membership_tier_violation',
    channelArn,
    memberArn,
    subject: subjectId,
    subjectTier,
    channelTier,
    action: enforcing ? 'revoked' : 'reported',
  });
  await writeFinding({ kind, channelArn, memberArn, subjectTier, channelTier, action: enforcing ? 'revoked' : 'reported' });

  const verb = enforcing ? 'was removed from' : 'was found on';
  const tail = enforcing
    ? 'The membership has been revoked.'
    : 'Enforcement is off; the membership was left in place. Flip the enforce toggle in the admin dashboard (or set MEMBERSHIP_AUDIT_ENFORCE) to auto-revoke.';
  const text =
    `Security audit: a ${subjectTier}-tier ${noun} ${verb} a ${channelTier}-tier conversation.\n` +
    `Channel: ${channelArn}\n${kind === 'assistant' ? 'Assistant' : 'Member'}: ${memberArn}\n${tail}`;
  await alertAdmins(adminArn, text, `[Security] Over-tier ${noun} on a ${channelTier} conversation`);

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

export async function handler(event: KinesisStreamEvent, _context?: Context): Promise<void> {
  for (const record of event.Records) {
    const evt = parseRecord(record);
    if (!evt || !AUDITED_EVENT_TYPES.has(evt.EventType)) continue;

    const channelArn = evt.Payload.ChannelArn || evt.Payload.Channel?.ChannelArn;
    const memberArn = evt.Payload.Member?.Arn;
    if (!channelArn || !memberArn) continue;

    const { kind, sub } = classifyMember(memberArn);
    if (kind !== 'user' && kind !== 'bot') continue; // admin service user, federated, unknown

    try {
      const adminArn = await getAdminArn();
      if (kind === 'user' && sub) {
        // A human BELOW the channel's tier is the leak (they would see content above their clearance).
        const memberTier = await resolveMemberTier(sub);
        if (!memberTier) continue; // unresolvable identity — skip
        const channelTier = await resolveChannelTier(channelArn, adminArn);
        if (isTierViolation(memberTier, channelTier)) {
          await handleViolation('member', channelArn, memberArn, sub, memberTier, channelTier);
        }
      } else if (kind === 'bot') {
        // An assistant ABOVE the channel's tier is the leak: it answers with its own tier's model
        // and context to users below that clearance. Layer 1 does NOT stop this, because the bot's
        // own creds already cover its tier and below. A bot not matching any tier assistant (a
        // `/battle` alt-slot) is left alone.
        const botTier = await resolveBotTier(memberArn);
        if (!botTier) continue;
        const channelTier = await resolveChannelTier(channelArn, adminArn);
        if ((TIER_RANK[botTier] ?? 0) > (TIER_RANK[channelTier] ?? TIER_RANK.basic)) {
          await handleViolation('assistant', channelArn, memberArn, botTier, botTier, channelTier);
        }
      }
    } catch (err) {
      // Never fail the batch for one record; the next stream poll re-delivers if needed.
      console.error('[MembershipAudit] error auditing membership record:', err);
    }
  }
}
