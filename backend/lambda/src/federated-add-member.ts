// Federated add-member (ADR-0014 — federated context sharing). Enrols a THIRD-PARTY federated
// user into a context-bound conversation and posts a context-aware targeted greeting.
//
// Invoked DIRECTLY (lambda:InvokeFunction) by the host backend as a system reconcile
// AFTER the host has run its own resource-ACL check — never by an end user. IAM (the caller's
// invoke permission) is the authorization boundary, so conversation membership is always a
// projection of the host's ACL and bare channel membership is never trusted. There is no
// public API route and no end-user token in play.
//
// Unlike federated-create-conversation (which adds the authenticated caller as a moderator),
// this adds the target as a DEFAULT member — an enrolled member is never handed a moderator
// seat. Identity: the target's host-pool {iss, sub} map (via deriveFederatedSub) to the same
// disjoint fed_ AppInstanceUser the credential exchange vends. Channel is create-or-get
// (idempotent on the deterministic, tier-scoped ChannelId) so a share works even before the
// owner has opened the assistant.

import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  AssociateChannelFlowCommand,
  UpdateChannelCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { deriveFederatedSub } from './lib/federated-identity';

const messaging = new ChimeSDKMessagingClient({});
const ssm = new SSMClient({});

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';
// The classification this federated assistant is provisioned at (env renamed from ASSISTANT_TIER
// per SPEC-CAPABILITY-PROFILES; the channel is created at this classification and membership is
// confined to it, so it is authoritative for federated users).
const TIER = (process.env.ASSISTANT_CLASSIFICATION || 'basic').trim();
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || `${SSM_ROOT}/assistant/${TIER}/bot-arn`;
const META_CAP = 1000;

let cachedBotArn: string | null = null;
let cachedFlowArn: string | null = null;
async function ssmGet(name: string): Promise<string> {
  const r = await ssm.send(new GetParameterCommand({ Name: name }));
  return r.Parameter?.Value || '';
}
async function getBotArn(): Promise<string> {
  if (cachedBotArn !== null) return cachedBotArn;
  cachedBotArn = await ssmGet(BOT_ARN_PARAM);
  if (!cachedBotArn) throw new Error(`per-tier bot ARN ${BOT_ARN_PARAM} is empty`);
  return cachedBotArn;
}
async function getFlowArn(): Promise<string> {
  if (cachedFlowArn !== null) return cachedFlowArn;
  if (!CHANNEL_FLOW_ARN_PARAM) { cachedFlowArn = ''; return ''; }
  try { cachedFlowArn = await ssmGet(CHANNEL_FLOW_ARN_PARAM); }
  catch { cachedFlowArn = ''; }
  return cachedFlowArn;
}

// Deterministic, charset-safe, TIER-scoped ChannelId (parity with create-conversation).
function channelIdFor(contextType: string, contextId: string): string {
  return `fed-${TIER}-${contextType}-${contextId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

interface WorkItem { title?: string; status?: string; assignee?: string; start?: string; end?: string }
interface DomainContext { title?: string; items?: WorkItem[]; [k: string]: unknown }

/** A short, member-visible recap composed from the domain context the host passes through. */
function buildRecap(title: string, dc?: DomainContext): string {
  const bits: string[] = [];
  if (title) bits.push(`**${title}**`);
  const n = Array.isArray(dc?.items) ? dc!.items!.length : 0;
  if (n) bits.push(`${n} item${n === 1 ? '' : 's'}`);
  return bits.length ? bits.join(' · ') : 'a shared context';
}

// Direct-invoke event (NOT an API Gateway proxy event): the host sends the args directly.
interface AddMemberEvent {
  contextType?: string;
  contextId?: string;
  iss?: string; // target user's host-pool issuer
  sub?: string; // target user's host-pool subject
  role?: string; // granted role — informational only
  title?: string;
  userName?: string;
  userLanguage?: string;
  participantProfile?: string;
  domainContext?: DomainContext;
  otherContexts?: unknown[];
  segment?: { country?: unknown };
}

export const handler = async (event: AddMemberEvent) => {
  const contextType = String(event.contextType || '').trim();
  const contextId = String(event.contextId || '').trim();
  const iss = String(event.iss || '').trim();
  const sub = String(event.sub || '').trim();
  if (!contextType || !contextId || !iss || !sub) {
    return { ok: false, error: 'contextType, contextId, iss and sub are required' };
  }

  // Display context (drives metadata + greeting only; not authoritative).
  const title = String(event.title || contextId).slice(0, 80);
  const userName = String(event.userName || '').slice(0, 80);
  const userLanguage = String(event.userLanguage || '').slice(0, 8);
  const participantProfile = String(event.participantProfile || '').slice(0, 600);
  const domainContext = event.domainContext && typeof event.domainContext === 'object' ? event.domainContext : undefined;
  const otherContexts = Array.isArray(event.otherContexts) ? event.otherContexts : undefined;
  const segCountry =
    event.segment && typeof event.segment === 'object'
      ? String(event.segment.country || '').slice(0, 3).toUpperCase()
      : '';
  const segment = /^[A-Z]{2}$/.test(segCountry) ? { country: segCountry } : undefined;

  const userArn = `${APP_INSTANCE_ARN}/user/${deriveFederatedSub(iss, sub)}`;
  const channelId = channelIdFor(contextType, contextId);
  const conversationArn = `${APP_INSTANCE_ARN}/channel/${channelId}`;

  const buildMetadata = (itemBudget: number, includeOtherContexts: boolean): string => {
    const dc = domainContext
      ? { ...domainContext, items: Array.isArray(domainContext.items) ? domainContext.items.slice(0, itemBudget) : [] }
      : undefined;
    return JSON.stringify({
      modelTier: TIER,
      contextType: contextType.slice(0, 64),
      contextId: contextId.slice(0, 128),
      topic: title,
      ...(userLanguage ? { userLanguage } : {}),
      ...(segment ? { segment } : {}),
      ...(participantProfile ? { participantProfile } : {}),
      ...(dc ? { domainContext: dc } : {}),
      ...(includeOtherContexts && otherContexts ? { otherContexts } : {}),
    });
  };
  let metadata = buildMetadata(20, true);
  if (Buffer.byteLength(metadata, 'utf8') > META_CAP) metadata = buildMetadata(20, false);
  for (let n = 15; Buffer.byteLength(metadata, 'utf8') > META_CAP && n >= 0; n -= 5) {
    metadata = buildMetadata(n, false);
  }

  try {
    const botArn = await getBotArn();

    // 1. Create-or-get the channel (bot is creator). Idempotent on the deterministic id;
    //    refresh Name+Metadata on conflict so the greeting reflects the current plan.
    try {
      await messaging.send(new CreateChannelCommand({
        AppInstanceArn: APP_INSTANCE_ARN,
        ChannelId: channelId,
        Name: title,
        Mode: 'RESTRICTED',
        Privacy: 'PRIVATE',
        ChimeBearer: botArn,
        Tags: [
          { Key: 'classification', Value: TIER },
          { Key: 'conversationType', Value: 'private' },
          { Key: 'contextType', Value: contextType.slice(0, 128) },
        ],
        Metadata: metadata,
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException') throw err;
      try {
        await messaging.send(new UpdateChannelCommand({
          ChannelArn: conversationArn, Name: title, Mode: 'RESTRICTED', Metadata: metadata, ChimeBearer: botArn,
        }));
      } catch (uerr) {
        console.warn('[FederatedAddMember] metadata refresh failed (non-fatal):', uerr);
      }
    }

    // 2. Ensure the bot is a member, then add the TARGET as a DEFAULT member (NOT a moderator).
    for (const arn of [botArn, userArn]) {
      try {
        await messaging.send(new CreateChannelMembershipCommand({
          ChannelArn: conversationArn, MemberArn: arn, Type: 'DEFAULT', ChimeBearer: botArn,
        }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConflictException') throw err;
      }
    }

    // 3. Associate the channel flow so @assistant routing runs (best-effort).
    const flowArn = await getFlowArn();
    if (flowArn) {
      try {
        await messaging.send(new AssociateChannelFlowCommand({
          ChannelArn: conversationArn, ChannelFlowArn: flowArn, ChimeBearer: botArn,
        }));
      } catch (err) {
        console.warn('[FederatedAddMember] associate flow failed (non-fatal):', err);
      }
    }

    // 4. Greet: a room-wide join notice + a member-targeted recap teaching the @assistant/@all
    //    grammar (parity with share-conversation's announce + targeted summary).
    const who = userName || 'Someone';
    try {
      await messaging.send(new SendChannelMessageCommand({
        ChannelArn: conversationArn,
        Content: `**${who}** joined this conversation. Mention **@assistant** or **@all** to bring in the assistant.`,
        Type: 'STANDARD',
        Persistence: 'PERSISTENT',
        ChimeBearer: botArn,
        Metadata: JSON.stringify({ botResponse: true, systemAnnouncement: 'member_joined' }),
      }));
      await messaging.send(new SendChannelMessageCommand({
        ChannelArn: conversationArn,
        Content:
          `Welcome${userName ? `, ${userName}` : ''} — you've been added to ${buildRecap(title, domainContext)}.\n\n` +
          `_Only you can see this message. Mention **@assistant** or **@all** to bring in the assistant; ` +
          `other messages are visible to everyone here, but I won't reply unless I'm mentioned._`,
        Type: 'STANDARD',
        Persistence: 'PERSISTENT',
        ChimeBearer: botArn,
        Target: [{ MemberArn: userArn }],
        // Notification bridge (SPEC-NOTIFICATION-BRIDGE P1, outbound): mirror this in-app welcome
        // out to the new member's email. The channel flow resolves their address from the IDP by
        // (iss, sub) at send time (never stored). The target carries the member's issuer so the
        // lookup hits the right pool even when members span multiple IDPs; the member may not be in
        // the channel roster yet, so it's resolved directly without a roster read.
        Metadata: JSON.stringify({
          botResponse: true,
          systemAnnouncement: 'join_summary',
          notify: { email: true },
          notifyTargets: [{ sub, iss }],
          notifySubject: `You've been added to ${title}`,
        }),
      }));
    } catch (gerr) {
      console.warn('[FederatedAddMember] greeting failed (non-fatal):', gerr);
    }

    return { ok: true, conversationArn, userArn, contextType, contextId };
  } catch (err) {
    console.error('[FederatedAddMember] failed:', err);
    return { ok: false, error: 'Federated add-member failed' };
  }
};
