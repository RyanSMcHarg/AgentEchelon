/**
 * Membership Audit Lambda — SPEC-CONVERSATION-SECURITY Layer 6 (near-real-time backstop).
 *
 * WHY THIS EXISTS. IAM conditions every membership change the platform's own services make on the
 * channel's `classification` tag and pins the bearer: an assistant of a declared classification
 * (`membershipAsAssistantStatements`), or the service admin by its exact ARN for the creators
 * (`membershipAsServiceAdminStatements`), measured by `scripts/deny-test-assistant-membership.mjs`. But
 * WHO is added is the `MemberArn` request parameter, which IAM never sees. A membership added out of band (a direct
 * Amazon Chime SDK call by a moderator, a script, or compromised creds) can therefore place a member on a channel
 * of a classification they are not cleared for. Layer 1 still makes that member INERT (their tag-bound creds
 * cannot read or send on that channel), so this audit closes the residual
 * VISIBILITY gap, not a write-leak.
 *
 * WHAT IT DOES. Consumes the same Chime -> Kinesis stream the archival pipeline uses,
 * filters CREATE/UPDATE_CHANNEL_MEMBERSHIP, resolves the member's clearance through their issuers' sources, compares it
 * to the channel's classification (the immutable tag),
 * and on an over-reaching member:
 *   1. when `MEMBERSHIP_AUDIT_ENFORCE=true`, revokes the membership
 *      (`DeleteChannelMembership` as the app-instance-admin bearer);
 *   2. logs a `[MembershipAudit][SecurityEvent]` plus a structured `_auditEvent` line with the outcome;
 *   3. alerts the admins with what actually happened (`postAdminNotice`: an `ae.alert` event, which the
 *      `AdminServices` stack posts into the admin notification channel when the deployment declares `admin`).
 *
 * Report-only by default (enforce is opt-in) so a false positive alerts rather than
 * removing a legitimate member. Two subjects are audited: a HUMAN member whose grants do not reach the
 * channel's classification (they would see content they are not cleared for) and an ASSISTANT (`/bot/`)
 * whose classification the channel's grants do not include (Layer 1 refuses its actions there, and the
 * audit reports the membership). The admin service user is skipped: it is the service moderator.
 * Every person is audited by their AppInstanceUser, whichever issuer they sign in with: their
 * clearance groups come through `Directory.groupsFor`, and a person whose clearance cannot be
 * established (they sign in through no directory whose groups are clearances) is recorded as an
 * unaudited membership, a SecurityEvent, rather than skipped. A `/battle` alt assistant is NOT exempt any more: it carries its own
 * classification tag since ADR-045 decision 7, so it is audited on the same rule as any other
 * assistant. Only a bot this deployment cannot classify at all is left alone.
 */
import { KinesisStreamEvent, KinesisStreamRecord, Context } from 'aws-lambda';
import {
  ChimeSDKMessagingClient,
  ListTagsForResourceCommand,
  DeleteChannelMembershipCommand,
  ListChannelsCommand,
  ListChannelsCommandOutput,
  ListChannelMembershipsCommand,
  ListChannelMembershipsForAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
// AN AppInstanceBot IS AN IDENTITY RESOURCE, NOT A MESSAGING ONE. Its tags are written by
// the provisioner (`assistant-provisioner.ts`) through the Identity client, and only the Identity client can read them back -
// the Messaging client rejects the ARN. Both SDKs export a command of the same name, so the Identity
// one is aliased to keep the two reads visibly different at their call sites.
import {
  ChimeSDKIdentityClient,
  ListTagsForResourceCommand as ListIdentityTagsCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
// The sweep hands its remainder to a fresh invocation of THIS function when it runs out of time.
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { adminNotice, postAdminNotice, type AdminNotice } from './lib/admin-notice.js';
import { defaultDirectory, type ClearanceEvidence } from './lib/membership-source.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { classifyPrincipal, type PrincipalRole } from './lib/principal-role.js';
import { readChannelClassificationTag } from './lib/channel-classification.js';
import { emitEmfMetric } from './lib/emf-metrics.js';
import { chimeMessagingClient, chimeIdentityClient, appInstanceAdminBearer } from './lib/chime/clients.js';
import { invitationStatusOf, invitationsNaming, type InvitationRecord } from './lib/invitations.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
// Trigger #2 (sweep) bound: cap channels scanned per scheduled run so a large app instance can't run
// the sweep unbounded. 0/unset ⇒ the default. A truncated sweep logs what it dropped (no silent cap).
// Matches the construct's default. A handler default BELOW the construct's would quietly shorten
// every sweep on any path that invokes it without the env set.
const MAX_SWEEP_CHANNELS = parseInt(process.env.MAX_SWEEP_CHANNELS || '2000', 10);
/**
 * How long one sweep invocation spends walking channels before handing the rest to a continuation.
 *
 * Deliberately well under the function's timeout: the margin has to cover the channel being walked
 * when the deadline is checked (a ListChannelMemberships page plus its per-member reads), the final
 * log line, and the continuation invoke. A budget that ran to the timeout would be killed doing the
 * one thing that makes a partial sweep legible.
 */
const SWEEP_BUDGET_MS = parseInt(process.env.SWEEP_BUDGET_MS || '', 10) || 12 * 60_000;
const ADMIN_ARN_PARAM = process.env.ADMIN_ARN_PARAM || '/agent-echelon/app-instance-admin-arn';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'agent-echelon-admin';
const ENFORCE_DEFAULT = process.env.MEMBERSHIP_AUDIT_ENFORCE === 'true';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const AUDIT_TABLE = process.env.AUDIT_TABLE || '';
/** The token store, for the invitation that names a member who has no `Identities` row yet. */
const TOKENS_TABLE = process.env.TOKENS_TABLE || '';
/**
 * How long the audit lets the invitations index settle before reading it a second time, for a member who resolves to no
 * clearance and whom no invitation names yet. An invitation adds its invitee BEFORE it writes the record that names
 * them, and the index that record reaches is eventually consistent, so the membership event can arrive first. One
 * bounded second read, only on that path, never a schedule.
 */
const INVITATION_SETTLE_MS = Math.max(0, Number.parseInt(process.env.INVITATION_SETTLE_MS ?? '3000', 10) || 0);

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

export type MemberKind = PrincipalRole;

/** Pure: classify a channel-member ARN. `user` members are clearance-audited and `bot` members are
 *  audited on their own classification tag; `admin` (the service moderator) is skipped. */
export function classifyMember(
  memberArn: string | undefined,
  adminUserId: string = ADMIN_USER_ID,
): { kind: MemberKind; sub: string | null } {
  // ONE TAXONOMY. The rules moved to `lib/principal-role` so archival can ask the same question
  // without importing this handler's Amazon Chime SDK, Cognito, SSM, DynamoDB and Lambda clients.
  // This stays as the audit's name for it, and the audit's default admin id.
  return classifyPrincipal(memberArn, adminUserId);
}

// The doc comment that stood here belonged to `isClassificationViolation`, a rank comparison deleted
// with the ladder, and it described unknown values as defaulting to a lowest rank and to `basic`. Both
// defaults are gone and the block below is the reason: an unevaluable membership is RECORDED as
// unevaluable rather than compared against a substituted value.
/**
 * A channel this audit COULD NOT EVALUATE, recorded rather than passed over.
 *
 * The failure mode this exists for is silence: before ADR-045 an unreadable tag was replaced with the
 * floor and the comparison ran anyway, so a channel the auditor was blind to produced the same output
 * as a channel it had cleared. A detective control whose blind spots look like clean results is worse
 * than one that reports its blind spots, because an operator reads "no findings" as "no problem".
 *
 * This does NOT raise a violation: nothing has been shown to be wrong, and a finding that names an
 * innocent membership is how a report stops being read. It raises the fact that a membership went
 * unchecked, which is the honest claim.
 */
export function recordUnauditableChannel(
  channelArn: string,
  memberArn: string,
  memberKind: 'member' | 'assistant',
  // WHICH HALF OF THE COMPARISON WAS MISSING. Both halves make the audit impossible and both must be
  // visible, but they are different failures: an unreadable channel tag is usually a permissions or
  // propagation fault, while an unresolvable member clearance is frequently the very thing this
  // control exists to catch - somebody removed from a clearance group out of band while still sitting
  // in the room. Defaulted so the original call site reads exactly as it did.
  reason: 'channel-classification' | 'member-clearance' | 'clearance-record-stale' = 'channel-classification',
): void {
  console.error('[MembershipAudit][SecurityEvent] membership NOT audited; one side of the comparison is unresolvable', {
    channelArn, memberArn, memberKind, reason,
  });
  emitEmfMetric({
    namespace: 'AgentEchelon/MembershipAudit',
    metrics: [{ name: 'MembershipNotAudited', unit: 'Count' }],
    dimensionSets: [['MemberKind']],
    properties: { MemberKind: memberKind, MembershipNotAudited: 1 },
  });
}

export function isClassificationViolation(memberClearance: string, channelClassification: string): boolean {
  // ── SET MEMBERSHIP, NOT `m < c` ───────────────────────────────────────────────
  //
  // The violation is "this person's clearance does not reach this conversation". That was written as
  // a rank comparison, which answers the question only while the classifications form a ladder. With
  // `legal` and `finance` as peers, a finance-cleared person in a legal room is not "below" it -
  // they simply do not reach it - and `m < c` is false, so the leak went unreported.
  //
  // `grantsFor` is what the deployed IAM condition is generated from, so the detective control and
  // the preventive control now answer from one source. They disagreeing about the same pairing is
  // exactly what `classification-admission.ts` says must not happen: "no consumer may compare ranks
  // ... every consumer bug being fixed here was a rank comparison".
  //
  // AN UNKNOWN VALUE ON EITHER SIDE IS A VIOLATION, which is the fail-safe direction for a detector:
  // an unresolvable clearance reaches nothing, and an unresolvable channel is reached by nothing. It
  // over-reports rather than missing, and a finding a human dismisses costs less than a leak nobody
  // sees. Note this is the opposite of what an ACCESS decision does with the same uncertainty, and
  // deliberately so: refusing access is safe, refusing to LOOK is not.
  if (!profiles.isKnownClassification(memberClearance)) return true;
  if (!profiles.isKnownClassification(channelClassification)) return true;
  return !profiles.reaches(memberClearance, channelClassification);
}

const chime = chimeMessagingClient({ region: AWS_REGION });
// Channels are Messaging resources and assistants are Identity resources, so reading a tag off each
// takes a different client. One client for both is a call that can only ever fail.
const chimeIdentity = chimeIdentityClient({ region: AWS_REGION });
const ssm = new SSMClient({ region: AWS_REGION });
// The sweep re-invokes THIS function to continue past its time budget.
const lambdaClient = new LambdaClient({ region: AWS_REGION });
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
  /** `recorded-sign-in`: read from the exchange's record of the member's last sign-in (C3), not a live clearance. */
  basis?: 'recorded-sign-in';
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
const getAdminArn = appInstanceAdminBearer({
  ssm,
  param: ADMIN_ARN_PARAM,
  onFailure: 'throw',
  errors: {
    read: (err) => new Error(
      `[MembershipAudit] cannot resolve the admin bearer ARN from SSM '${ADMIN_ARN_PARAM}' `
      + `(${err.name}: ${err.message}). The membership audit cannot evaluate any `
      + 'membership without it; failing the invocation so the records are retried rather than silently skipped.',
    ),
    empty: () => new Error(
      `[MembershipAudit] SSM parameter '${ADMIN_ARN_PARAM}' resolved to an empty value. The membership `
      + 'audit cannot run without an admin bearer ARN - check the parameter was populated at deploy time.',
    ),
  },
});

/**
 * What a member who reaches nothing is recorded as: a person of an issuer the registry no longer
 * declares. Not a classification, so `isClassificationViolation` flags them wherever they sit (C3).
 */
export const NO_CLEARANCE = 'none';

/**
 * A member's authoritative clearance, through each issuer they sign in with (`Directory.clearanceOf`):
 * that issuer's Q5 clearance source, within its declared classifications, resolved to the holder token the credential
 * exchange vends. The person's subjects are found through `Identities`, so a member of any issuer is
 * audited the same way; nothing here reads the id's shape or assumes a pool.
 *
 *  - A member whose issuers are all REMOVED from the registry reaches nothing: `NO_CLEARANCE`, which the
 *    caller flags as a violation.
 *  - Null when the clearance cannot be established: an issuer of theirs decides only from a token (a
 *    mapping), they hold no declared combination, or the read failed. The caller RECORDS that as an
 *    unaudited membership rather than acting on it, so an unresolvable identity is flagged and never
 *    revoked on a guess.
 */
export async function resolveMemberClearance(memberArn: string): Promise<string | null> {
  return (await memberClearanceOf(memberArn)).clearance;
}

/**
 * `resolveMemberClearance`, with the evidence an undetermined member carries: for an issuer that decides only
 * from a token, what the exchange recorded it decided at their last sign-in (`lastSignIn`, C3). The evidence
 * is for a finding; `clearance` is never taken from it.
 */
export async function memberClearanceOf(memberArn: string): Promise<{ clearance: string | null; adminPlane?: boolean; lastSignIn?: ClearanceEvidence[] }> {
  try {
    // A PERSON DISABLED AT THEIR ISSUER IS EVALUATED TOO: their row stays active (the platform keeps no copy
    // of the issuer's state), so a clearance narrowed while they are disabled is evaluated now.
    const answer = await defaultDirectory().clearanceOf(memberArn);
    if (answer.state === 'none') return { clearance: NO_CLEARANCE };
    if (answer.state === 'undetermined') return { clearance: null, ...(answer.lastSignIn ? { lastSignIn: answer.lastSignIn } : {}) };
    // `undefined` (no declared token for this combination) is unresolvable, which this function
    // reports as null: skip rather than act on a clearance nobody declared.
    // THE ADMIN PLANE HELD BESIDE THE TOKEN reaches admin conversations (`ProfileRegistry.holderOf`).
    return { clearance: answer.token ?? null, ...(answer.adminPlane ? { adminPlane: true } : {}) };
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === 'UserNotFoundException') return { clearance: null }; // unresolvable — skip, do not act
    console.warn('[MembershipAudit] failed to resolve member clearance; skipping:', err);
    return { clearance: null };
  }
}

/**
 * A MEMBER READ THROUGH THEIR LAST SIGN-IN'S RECORD (C3): their issuer decides only from a token, so the
 * audit reads what the exchange recorded it decided. REPORTED, NEVER REVOKED: a record is evidence, and
 * the audit acts on a clearance alone. Returns true when the evidence settled the membership (fresh and
 * reaching the channel, or flagged); false when there is no evidence and the membership is unaudited.
 */
export async function auditByRecordedDecision(
  channelArn: string,
  memberArn: string,
  channelClassification: string,
  lastSignIn: readonly ClearanceEvidence[] | undefined,
): Promise<boolean> {
  if (!lastSignIn?.length) return false;
  let flagged = false;
  for (const e of lastSignIn) {
    if (e.stale) {
      flagged = true;
      console.warn('[MembershipAudit][SecurityEvent] membership read through a stale clearance record', {
        _auditEvent: 'membership_clearance_record_stale', channelArn, memberArn, issuer: e.issuer, recorded: e.classification, recordedAt: e.at,
      });
      recordUnauditableChannel(channelArn, memberArn, 'member', 'clearance-record-stale');
      continue;
    }
    if (!isClassificationViolation(e.classification, channelClassification)) continue;
    flagged = true;
    console.warn('[MembershipAudit][SecurityEvent] a member\'s last recorded sign-in does not reach the conversation', {
      _auditEvent: 'membership_clearance_record_mismatch', channelArn, memberArn, issuer: e.issuer, recorded: e.classification, recordedAt: e.at, channelClassification,
    });
    await writeFinding({ kind: 'member', channelArn, memberArn, subjectClearance: e.classification, channelClassification, action: 'reported', basis: 'recorded-sign-in' });
    await alertAdmins(adminNotice({
      name: 'recorded-clearance-mismatch',
      values: { recorded: e.classification, classification: channelClassification, channel: channelArn, member: memberArn, issuer: e.issuer, recordedAt: e.at },
    }, 'membership_audit_finding', { channelArn, memberArn, outcome: 'reported' }));
  }
  if (!flagged) console.log('[MembershipAudit] audited by the last sign-in\'s recorded decision', { channelArn, memberArn });
  return true;
}

type Sender = { send(command: unknown): Promise<any> };
let tokensDoc: Sender | null = null;

/**
 * IS THIS MEMBER AN INVITEE THE INVITATION ITSELF ADMITS? (B8, M-10.)
 *
 * An invitation mints its invitee's AppInstanceUser at invite time and adds it to the one conversation it is
 * for, with no `Identities` row until a sign-in redemption binds one, and none ever for a `link` redemption
 * (`lib/invitation-redemption.ts`). Such a member resolves to no clearance, which reads as a violation. It is
 * not one: the invitation record names it. So a member who resolves to nothing is audited when, and only
 * when, an invitation record of THIS conversation names it as its invitee and:
 *
 *  - is not revoked (a revocation removes the membership; a member left behind by one is flagged);
 *  - carries this conversation's classification, as read from the immutable tag at invite time;
 *  - is pending and unexpired, or was redeemed by its `link`, whose session never gains an `Identities` row.
 *
 * An expired, unredeemed invitee is not admitted (its AppInstanceUser lapses with the invitation, and one
 * still in the room is flagged), and a `sign-in` redemption binds a row, so that member is audited by their
 * clearance like anyone else. Nobody else is affected: the record is consulted only for a member who
 * resolves to no clearance at all. An unreadable token store answers false, so the member is flagged.
 */
export async function invitationAdmitsMember(
  channelArn: string,
  memberArn: string,
  channelClassification: string,
  deps: { doc?: Sender; table?: string; now?: number; settleMs?: number } = {},
): Promise<boolean> {
  const table = deps.table ?? TOKENS_TABLE;
  if (!table || !channelArn || !memberArn || !channelClassification) return false;
  const doc = deps.doc ?? (tokensDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION })));
  // EVERY INVITATION OF THIS CONVERSATION NAMING THE MEMBER, to the end of the index. When none does yet, the index is
  // read once more after it settles: the invitee is added before its record is written, and the index lags the record.
  let records: InvitationRecord[];
  try {
    records = await invitationsNaming(doc, table, channelArn, memberArn);
    if (!records.length) {
      const settleMs = deps.settleMs ?? INVITATION_SETTLE_MS;
      if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      records = await invitationsNaming(doc, table, channelArn, memberArn);
    }
  } catch (err) {
    console.warn('[MembershipAudit] the invitations of the conversation could not be read; the member is audited as anyone else', {
      channelArn, err: (err as { name?: string })?.name,
    });
    return false;
  }
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  return records.some((r) => {
    if (r.personArn !== memberArn || r.channelArn !== channelArn) return false;
    if (r.revokedAt !== undefined) return false;
    if (r.classification !== channelClassification) return false;
    const status = invitationStatusOf(r, now);
    return status === 'pending' || (status === 'redeemed' && r.redeemedVia === 'link');
  });
}

/**
 * IS THE MEMBER STILL IN THE ROOM? Read from Amazon Chime SDK, the authority for current membership (D7), as the service
 * admin, through the channel's own membership listing (its visible and its hidden members), before a finding is
 * reported. A membership event describes the room as it was when the event was written: a member added and removed
 * again (an invitation revoked a moment after it was made) still arrives as an add, and judged against the records as
 * they are now it reads as somebody who should not be there. A listing that cannot be read answers true, so the finding
 * is reported rather than dropped.
 */
export async function isStillMember(channelArn: string, memberArn: string, adminArn: string): Promise<boolean> {
  try {
    for (const Type of ['DEFAULT', 'HIDDEN'] as const) {
      let NextToken: string | undefined;
      do {
        const resp = await chime.send(new ListChannelMembershipsCommand({
          ChannelArn: channelArn, ChimeBearer: adminArn, Type, MaxResults: 50, NextToken,
        }));
        if ((resp?.ChannelMemberships ?? []).some((m) => m.Member?.Arn === memberArn)) return true;
        NextToken = resp?.NextToken;
      } while (NextToken);
    }
    return false;
  } catch (err) {
    console.warn('[MembershipAudit] whether the member is still in the conversation could not be read; the finding stands', {
      channelArn, memberArn, err: (err as { name?: string })?.name,
    });
    return true;
  }
}

// The channel's classification for the violation comparison comes from the IMMUTABLE
// `classification` tag, NOT `metadata.modelTier`. Reading mutable metadata here would let a
// moderator who adds an uncleared assistant also tamper `modelTier` up to match it, blinding
// this detector (botClassification > channelClassification would go false). The tag cannot be changed
// by UpdateChannel.
//
// IT RETURNS `undefined` RATHER THAN THE FLOOR, AND THE OLD COMMENT HERE WAS HALF WRONG (ADR-045
// decision 2). "Fail-closed to basic so an unreadable tag over-reports rather than misses" is true of
// exactly one of this file's two comparisons:
//
//  - the BOT check (`botRank > chRank`) with the channel forced to the lowest rank fires for every
//    assistant above the floor, so it over-reports. Noisy, and safe for a detector.
//  - the MEMBER check (`m < c`, `isClassificationViolation`) with the channel forced to the LOWEST
//    rank can almost never be true, so it reports nothing. That is a MISS, not an over-report: on a
//    channel whose tag could not be read, every under-clearance member leak went undetected.
//
// A detective control that guesses is worse than one that says it could not look. So an unreadable
// tag is now `undefined` and the caller records the channel as UNAUDITED rather than comparing
// against a value nobody read.
async function resolveChannelClassification(channelArn: string, _bearerArn: string): Promise<string | undefined> {
  return readChannelClassificationTag(chime, channelArn, '[MembershipAudit]');
}

let botClassificationMap: Map<string, string> | null = null;
/** Map each per-classification assistant's bot ARN (`${SSM_ROOT}/assistant/{classification}/bot-arn`)
 *  to its classification. Cached for the Lambda's warm life. A bot ARN not in this map is not one of
 *  the default classification assistants (e.g. a role's alt), so it is left alone. */
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
/**
 * An assistant's classification, from the TAG ON ITS IDENTITY first.
 *
 * THE TAG IS THE DESIGN. `aws:ResourceTag/classification` is the same immutable,
 * IAM-evaluable signal the channel side is judged on, so reading it here means the auditor compares
 * two values of the same kind instead of one tag against a derived one. It also means an assistant
 * provisioned by any path - not only one whose ARN was published to the expected SSM parameter - is
 * classified correctly.
 *
 * THE SSM MAP REMAINS AS A FALLBACK, and only that. Bots created before the tag existed are tagged by
 * the provisioner's Update branch, but that runs on deploy; until a deployment has redeployed, its
 * assistants are untagged and the map is the only answer available. Falling through keeps the audit
 * working across that window instead of silently reclassifying every assistant as unknown - which
 * would switch off the clearance check precisely when it is least verified.
 *
 * Null means neither source knows, which for this auditor means "not a classification assistant" and
 * is the right answer for a bot no source classifies.
 */
async function resolveBotClassification(botArn: string): Promise<string | null> {
  try {
    const resp = await chimeIdentity.send(new ListIdentityTagsCommand({ ResourceARN: botArn }));
    const tag = (resp.Tags || []).find((t) => t.Key === 'classification')?.Value;
    if (profiles.isKnownClassification(tag)) return profiles.resolveClassification(tag) ?? null;
  } catch (err) {
    // Not fatal: fall through to the map. Logged so an unreadable identity tag is visible rather than
    // being indistinguishable from an untagged one.
    console.warn('[MembershipAudit] could not read the assistant identity tag; falling back to the published map', {
      botArn,
      error: (err as Error).name,
    });
  }
  return (await loadBotClassificationMap()).get(botArn) ?? null;
}

/**
 * Tell the admins, through the one alert path (`lib/admin-notice.ts`): an `ae.alert` event on the default
 * bus, which the `AdminServices` stack posts into the admin notification channel. This role holds no
 * message send at all: the grant is `alertEmitterWiring`, `events:PutEvents` for the `ae.alert` source
 * only. `postAdminNotice` never throws.
 */
async function alertAdmins(notice: AdminNotice): Promise<void> {
  const posted = await postAdminNotice(notice);
  if (!posted) console.warn(`[MembershipAudit] the finding was not posted; logging it instead: ${notice.subject} - ${notice.content}`);
}

/** What the revoke actually did, so the alert reports an outcome rather than an intention. */
type RevokeOutcome = 'revoked' | 'already_gone' | 'failed' | 'reported';

async function handleViolation(
  kind: 'member' | 'assistant',
  channelArn: string,
  memberArn: string,
  subjectId: string,
  subjectClearance: string,
  channelClassification: string,
): Promise<void> {
  const adminArn = await getAdminArn();
  // A FINDING IS ABOUT THE ROOM AS IT IS NOW: a member who has already left it is no finding, whatever the event said.
  if (!await isStillMember(channelArn, memberArn, adminArn)) {
    console.log('[MembershipAudit] the membership is no longer in the conversation; the event was stale and nothing is reported', {
      channelArn, memberArn, kind,
    });
    return;
  }
  const enforcing = await isEnforcing();
  const noun = kind === 'assistant' ? 'assistant' : 'member';

  // REVOKE FIRST, THEN SAY WHAT HAPPENED. The alert used to go out before the revoke and say
  // "The membership has been revoked", so a revoke that failed was reported as done.
  let outcome: RevokeOutcome = 'reported';
  if (enforcing) {
    try {
      await chime.send(
        new DeleteChannelMembershipCommand({
          ChannelArn: channelArn,
          MemberArn: memberArn,
          ChimeBearer: adminArn,
        }),
      );
      outcome = 'revoked';
      console.warn(`[MembershipAudit] revoked uncleared ${noun}`, { channelArn, memberArn });
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotFoundException' || name === 'ConflictException') {
        outcome = 'already_gone'; // idempotent
      } else {
        outcome = 'failed';
        console.error('[MembershipAudit] failed to revoke membership:', err);
      }
    }
  }

  console.warn(`[MembershipAudit][SecurityEvent] uncleared ${noun}`, {
    _auditEvent: kind === 'assistant' ? 'assistant_tier_violation' : 'membership_tier_violation',
    channelArn,
    memberArn,
    subject: subjectId,
    subjectClearance,
    channelClassification,
    action: outcome,
  });
  // A failed revoke is recorded as reported, not revoked, so the finding stays actionable in the console.
  const recorded = outcome === 'revoked' || outcome === 'already_gone' ? 'revoked' : 'reported';
  await writeFinding({ kind, channelArn, memberArn, subjectClearance, channelClassification, action: recorded });

  // WHAT HAPPENED, BY CASE: each case names a label of the `uncleared-membership` template (ADR-062 decision 6), so the
  // words are the template's and a rewording of them reaches the notice.
  const tail = { revoked: 'revoked', already_gone: 'alreadyGone', failed: 'failed', reported: 'reported' }[outcome];
  await alertAdmins(adminNotice({
    name: 'uncleared-membership',
    values: { clearance: subjectClearance, classification: channelClassification, channel: channelArn, member: memberArn },
    labels: {
      noun: kind,
      verb: outcome === 'failed' ? 'stillOn' : enforcing ? 'removed' : 'found',
      heading: kind === 'assistant' ? 'assistantHeading' : 'memberHeading',
      tail,
    },
  }, 'membership_audit_finding', { channelArn, memberArn, outcome }));
}

function parseRecord(record: KinesisStreamRecord): ChimeKinesisEvent | null {
  try {
    return JSON.parse(Buffer.from(record.kinesis.data, 'base64').toString('utf-8')) as ChimeKinesisEvent;
  } catch {
    return null;
  }
}

/**
 * Evaluate ONE (channel, member) pair for an uncleared violation and flag/revoke it. The single shared
 * check behind all three detection triggers (SPEC-CONVERSATION-SECURITY §11): the Kinesis event stream
 * (#1), the scheduled sweep (#2), and the on-downgrade re-eval (#3) all funnel here, so the violation
 * rule lives in exactly one place. Best-effort per pair - a resolution error for one member never aborts
 * the batch/sweep.
 */
async function evaluateMembership(channelArn: string, memberArn: string, adminArn: string): Promise<void> {
  const { kind, sub } = classifyMember(memberArn);
  if (kind !== 'user' && kind !== 'bot') return; // admin service user, unknown

  try {
    if (kind === 'user' && sub) {
      // A human BELOW the channel's classification is the leak (they would see content above their clearance).
      const { clearance: memberClearance, adminPlane, lastSignIn } = await memberClearanceOf(memberArn);
      // RECORDED, NOT SILENTLY SKIPPED. This returned with no log and no metric, which made the
      // control blind in exactly its own scenario: a person removed from their clearance group in the
      // console while still a member of a room resolves to no declared clearance, and the sweep and
      // the Kinesis trigger both went quiet. Substituting a floor is not the answer either - ADR-046
      // removed the floor - so the honest outcome is to say loudly that this membership could not be
      // audited, which is what the channel side one line below already does.
      if (!memberClearance) {
        // AN ISSUER THAT DECIDES ONLY FROM A TOKEN: read the record of the last sign-in, as evidence (C3).
        if (lastSignIn?.length) {
          const channelClassification = await resolveChannelClassification(channelArn, adminArn);
          if (!channelClassification) return recordUnauditableChannel(channelArn, memberArn, 'member');
          if (await auditByRecordedDecision(channelArn, memberArn, channelClassification, lastSignIn)) return;
        }
        return recordUnauditableChannel(channelArn, memberArn, 'member', 'member-clearance');
      }
      const channelClassification = await resolveChannelClassification(channelArn, adminArn);
      if (!channelClassification) return recordUnauditableChannel(channelArn, memberArn, 'member');
      // AN INVITEE THE INVITATION ADMITS (B8): no `Identities` row yet, so no clearance, and the record of
      // this conversation's invitation names them. Consulted only for a member who resolves to nothing.
      if (memberClearance === NO_CLEARANCE && await invitationAdmitsMember(channelArn, memberArn, channelClassification)) {
        console.log('[MembershipAudit] an invitee named by an invitation of this conversation; audited by the invitation', { channelArn, memberArn });
        return;
      }
      // A member holding the admin plane beside their token reaches an admin conversation.
      const reachesAdminPlane = adminPlane === true && profiles.adminPlaneValues().includes(channelClassification);
      if (!reachesAdminPlane && isClassificationViolation(memberClearance, channelClassification)) {
        await handleViolation('member', channelArn, memberArn, sub, memberClearance, channelClassification);
      }
    } else if (kind === 'bot') {
      // An assistant the room's classification does not reach is the leak: it answers with its own
      // classification's model and context to members who are not cleared for it.
      //
      // LAYER 1 NOW DOES STOP THE ACTIONS, AND THIS STILL MATTERS (corrected: ADR-042 is built). The
      // old rationale here was "Layer 1 does NOT stop this, because the bot's own creds already cover
      // its classification and below" - true while an assistant role was scoped to its grant set, and
      // false since every assistant role is generated with `actor: 'assistant'`, i.e.
      // `channelsAnAssistantMayActIn`: its own classification alone.
      //
      // What IAM prevents is the assistant ACTING in such a channel. What nothing prevents is it being
      // MADE A MEMBER of one - membership is created by a moderator or an admin, not by the assistant,
      // so no grant of the assistant's is consulted. That is the gap this detector exists for, and it
      // is why the control is worth keeping even though the actions are now denied.
      const botClassification = await resolveBotClassification(memberArn);
      // AN ALT ASSISTANT IS NO LONGER EXEMPT, and nothing here had to change for that (ADR-045
      // decision 7). This early return was the exemption: a `/battle` alt carried no
      // classification tag and resolved to null, so it was skipped. Alts are now tagged at creation
      // like every other assistant, so they resolve and are audited on the same rule. What remains
      // skipped is a bot this deployment genuinely cannot classify, which is the honest case.
      if (!botClassification) return;
      const channelClassification = await resolveChannelClassification(channelArn, adminArn);
      if (!channelClassification) return recordUnauditableChannel(channelArn, memberArn, 'assistant');
      // THE LEAK DIRECTION, STATED AS A SET. This was `botRank > chRank` - "the
      // assistant outranks the room" - and the set form of that same question is whether the ROOM's
      // classification reaches the assistant's. On a ladder the two agree exactly: a premium
      // assistant in a basic room is flagged because `basic` does not reach `premium`, and a basic
      // assistant in a premium room is not, because `premium` does reach `basic`. On a peer taxonomy
      // it says the thing rank could not: a `finance` assistant in a `legal` room is flagged, because
      // `legal` does not reach `finance`.
      //
      // DELIBERATELY NOT `channelsActableBy`, which would flag BOTH directions. A lower assistant in
      // a higher room under-serves; it does not leak, and this detector's stated subject is the
      // visibility gap. Flagging it here would be ADR-045 decision 3's narrowing, which the owner has
      // held, arriving through a detector rather than through the decision.
      const leaks = !profiles.grantsFor(channelClassification).includes(botClassification);
      if (leaks) {
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
 * uncleared AFTER joining (their clearance was downgraded, or the channel was re-tagged down), which
 * emits no membership event. Bounded by MAX_SWEEP_CHANNELS; a truncated run logs what it dropped.
 */
/**
 * THE SCHEDULED SWEEP (trigger #2), WHICH HAS TO SURVIVE NOT FINISHING IN ONE INVOCATION.
 *
 * ── WHAT WAS WRONG, MEASURED LIVE 2026-09-14 ────────────────────────────────────────────────────
 *
 * This ran to completion or died trying, and on this deployment it died: 698 channels, each needing
 * a ListChannelMemberships plus per-member tag and clearance reads, inside a 30-second timeout. The
 * invocation was killed by the runtime every time.
 *
 * AND IT WAS KILLED IN SILENCE. The only `console.log` was the one after the loop, so a sweep that
 * covered forty channels and was then terminated logged NOTHING - indistinguishable in CloudWatch
 * from a sweep that ran clean and found nothing wrong. The backstop for the membership boundary
 * reported success by saying nothing, which is the worst available failure mode for a control whose
 * whole job is to notice what the event stream missed.
 *
 * ── WHAT IT DOES NOW ────────────────────────────────────────────────────────────────────────────
 *
 * Three changes, and the third is the one that makes the other two honest:
 *
 *  1. A DEADLINE. The sweep stops itself with time to spare rather than being killed mid-channel, so
 *     the work it did is always followed by a record of what it was.
 *  2. A CONTINUATION. It re-invokes itself with the pagination token it stopped on, so a sweep too
 *     big for one invocation completes across several instead of truncating at whatever the timeout
 *     happened to allow. `MAX_SWEEP_CHANNELS` still bounds the TOTAL, across the whole chain, so the
 *     cost limit the schedule was sized against is unchanged.
 *  3. A LINE EVERY TIME, in every exit path. Complete, deadline-stopped, or capped - a person reading
 *     CloudWatch can tell which, and a sweep that covers nothing now says so out loud.
 *
 * The continuation is best-effort: if the self-invoke fails the sweep still reports where it stopped,
 * and the next scheduled run starts from the beginning. A sweep that restarts is a cost problem; a
 * sweep that stops silently is a security one.
 */
async function sweepAllChannels(adminArn: string, startToken?: string, alreadyScanned = 0): Promise<void> {
  if (!APP_INSTANCE_ARN) {
    console.warn('[MembershipAudit][sweep] APP_INSTANCE_ARN unset; cannot enumerate channels');
    return;
  }
  // Stop with a margin, so the final log line and the continuation invoke both fit inside the
  // remaining time. Measured against the function's own timeout rather than a constant, so raising
  // the timeout raises the budget without a second edit.
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  let scanned = alreadyScanned;
  let nextToken: string | undefined = startToken;
  let truncated = false;
  let outOfTime = false;
  do {
    const resp: ListChannelsCommandOutput = await chime.send(new ListChannelsCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      ChimeBearer: adminArn,
      MaxResults: 50,
      NextToken: nextToken,
    }));
    // The token for the page AFTER this one, captured before the page is walked so a deadline hit
    // mid-page resumes at this page rather than skipping the channels it did not reach.
    const pageToken: string | undefined = nextToken;
    for (const ch of resp.Channels || []) {
      if (scanned >= MAX_SWEEP_CHANNELS) { truncated = true; break; }
      if (Date.now() >= deadline) { outOfTime = true; break; }
      if (ch.ChannelArn) {
        await sweepChannelMemberships(ch.ChannelArn, adminArn);
        scanned += 1;
        if (scanned % 25 === 0) console.log('[MembershipAudit][sweep] progress', { scanned });
      }
    }
    if (outOfTime) {
      console.warn('[MembershipAudit][sweep] out of time; continuing in a follow-up invocation', {
        scanned, resumeFrom: pageToken ? 'page-token' : 'start', cap: MAX_SWEEP_CHANNELS,
      });
      await continueSweep(pageToken, scanned);
      return;
    }
    nextToken = truncated ? undefined : resp.NextToken;
  } while (nextToken);

  if (truncated) {
    // NAMES THE CONSEQUENCE, not just the number. "hit the cap" reads as housekeeping; "these
    // channels are outside the membership backstop until the cap is raised" is the actual state, and
    // it is the same every run - the channels past the cap are never reached by any of them.
    console.warn('[MembershipAudit][sweep] hit MAX_SWEEP_CHANNELS; the channels past it are NOT covered by this control until the cap is raised', {
      scanned, cap: MAX_SWEEP_CHANNELS,
    });
    return;
  }
  console.log('[MembershipAudit][sweep] complete', { scanned, cap: MAX_SWEEP_CHANNELS });
}

/**
 * Hand the rest of the sweep to a fresh invocation, carrying the page it stopped on and the running
 * count so `MAX_SWEEP_CHANNELS` bounds the CHAIN rather than each link.
 *
 * Best-effort by design: a failure here is reported and the sweep ends where it stopped. The next
 * scheduled run starts over, which costs list calls and finds the same things - acceptable, where
 * continuing silently past a boundary violation would not be.
 */
async function continueSweep(nextToken: string | undefined, scanned: number): Promise<void> {
  const self = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!self) {
    console.warn('[MembershipAudit][sweep] no function name in the environment; cannot continue', { scanned });
    return;
  }
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: self,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ type: 'sweep', nextToken, scanned })),
    }));
    console.log('[MembershipAudit][sweep] continuation dispatched', { scanned });
  } catch (err) {
    console.error('[MembershipAudit][sweep] continuation failed; the sweep ends here and the next scheduled run restarts it', {
      scanned, error: (err as Error).message,
    });
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
  /** 'sweep' continuation: the ListChannels page to resume from, and the count already covered. */
  nextToken?: string;
  scanned?: number;
}

export async function handler(
  event: KinesisStreamEvent | AuditControlEvent,
  _context?: Context,
): Promise<void> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const adminArn = await getAdminArn();

  // Dispatch by event shape. Kinesis event source → membership events (#1); a scheduled/async invoke
  // carries { type } → the sweep (#2) or a targeted user re-eval (#3).
  if ('type' in event) {
    if (event.type === 'sweep') {
      // A scheduled start carries neither field; a continuation carries both.
      await sweepAllChannels(adminArn, event.nextToken, event.scanned ?? 0);
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
