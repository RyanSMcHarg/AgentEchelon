// Federated create-conversation — create-or-get a context-bound conversation for
// a user authenticated against a host app's OWN Cognito pool (a foreign IdP).
// Additive to the native create-conversation/index.js: identity comes ONLY from the
// validated authorizer claims; the foreign `sub` maps to the same disjoint `fed_`
// AppInstanceUser id the federated credential exchange vends (deriveFederatedSub), so
// the member this adds is exactly the bearer the embedded widget operates as.
//
// The channel is created by the classification bot (its ChimeBearer), classification-tagged, and
// bound to {contextType, contextId} in metadata. The ChannelId is DETERMINISTIC from
// the context, so a repeat call is idempotent — Chime returns ConflictException and we
// reconstruct the (deterministic) ARN. No modelId / classification-gate: federated users get a
// fixed classification (the configured assistant), so there is no Cognito group lookup.

import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
  AssociateChannelFlowCommand,
  UpdateChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { deriveFederatedSub } from './lib/federated-identity';
import { putChannelContext } from './lib/channel-context-client';
import { boundedDomainContext, boundedOtherContexts } from './lib/host-grounding';
import { getConversationTypeConfig } from '../../lib/config/conversation-types.js';

const messaging = new ChimeSDKMessagingClient({});
const ssm = new SSMClient({});

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';
// Classification this federated assistant is provisioned at (SPEC-CAPABILITY-PROFILES).
// Authoritative for federated users — the channel is created at it.
const CLASSIFICATION = (process.env.ASSISTANT_CLASSIFICATION || 'basic').trim();
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || `${SSM_ROOT}/assistant/${CLASSIFICATION}/bot-arn`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function cors(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Content-Type': 'application/json' };
}
function res(statusCode: number, body: unknown): { statusCode: number; headers: Record<string, string>; body: string } {
  return { statusCode, headers: cors(), body: JSON.stringify(body) };
}

let cachedBotArn: string | null = null;
let cachedFlowArn: string | null = null;
async function ssmGet(name: string): Promise<string> {
  const r = await ssm.send(new GetParameterCommand({ Name: name }));
  return r.Parameter?.Value || '';
}
async function getBotArn(): Promise<string> {
  if (cachedBotArn !== null) return cachedBotArn;
  cachedBotArn = await ssmGet(BOT_ARN_PARAM);
  if (!cachedBotArn) throw new Error(`per-classification bot ARN ${BOT_ARN_PARAM} is empty`);
  return cachedBotArn;
}
async function getFlowArn(): Promise<string> {
  if (cachedFlowArn !== null) return cachedFlowArn;
  if (!CHANNEL_FLOW_ARN_PARAM) { cachedFlowArn = ''; return ''; }
  try { cachedFlowArn = await ssmGet(CHANNEL_FLOW_ARN_PARAM); }
  catch { cachedFlowArn = ''; }
  return cachedFlowArn;
}

// Chime ChannelId allows [A-Za-z0-9_-], length 1-64. Make a stable, charset-safe id
// from the context so the same plan always maps to the same channel (idempotency).
// Classification-scoped so a classification change (e.g. basic→standard) creates a FRESH channel
// owned by the current classification's bot, instead of colliding with a channel created+moderated
// by a different bot (which the current bot can't add members to → ForbiddenException).
// Pre-classification-scope channels (`fed-<ctx>-<id>`) are orphaned by design; the host re-creates
// under the new id.
function channelIdFor(contextType: string, contextId: string): string {
  const raw = `fed-${CLASSIFICATION}-${contextType}-${contextId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return raw.slice(0, 64);
}


interface Evt {
  httpMethod?: string;
  body?: string | null;
  requestContext?: { authorizer?: { claims?: Record<string, string> } };
}

export const handler = async (event: Evt): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
  if (event?.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const claims = event?.requestContext?.authorizer?.claims || {};
  const rawSub = claims.sub;
  const iss = claims.iss;
  if (!rawSub || !iss) return res(401, { error: 'Unauthenticated' });

  const body = (typeof event.body === 'string' ? JSON.parse(event.body || '{}') : event.body) || {};
  const contextType = String(body.contextType || '').trim();
  const contextId = String(body.contextId || '').trim();
  if (!contextType || !contextId) return res(400, { error: 'contextType and contextId are required' });
  const title = String(body.title || contextId).slice(0, 80);

  // Grounding context: the host app passes the
  // user's name, a compact current-plan summary, and a title-only list of their other plans/contexts.
  // We stamp these into channel Metadata so the per-classification handler can render them into the
  // assistant's system prompt (current plan = primary grounding; other contexts = disambiguation).
  const userName = String(body.userName || '').slice(0, 80);
  // The host's i18n: the user's chosen site language (e.g. "en"/"zh"). Stamped so the assistant can
  // reply in the same language as the rest of the site.
  const userLanguage = String(body.userLanguage || '').slice(0, 8);
  // Free-text participant profile (preferences/working style) — personalizes the assistant's replies.
  const participantProfile = String(body.participantProfile || '').slice(0, 600);
  // BOUNDED, like every other field on this path. These two were the only host-supplied inputs accepted
  // with no cap at all, and they are the LARGEST: a plan's `items` array and a list of side contexts.
  //
  // Where an unbounded value actually breaks: the private store is DynamoDB (400KB per item, so it
  // accepts far more than the rest of the system can carry), and the router spreads the whole grounding
  // into the async processor's payload on an `Event` invoke - capped at 256KB. Past that the invoke
  // throws `RequestEntityTooLargeException`, and `invokeAsync` logs it and returns, so the worker never
  // runs, the placeholder is never resolved, and the user sits on "One moment..." forever. Not one turn
  // either: EVERY turn in that conversation, because the grounding is re-read and re-sent each time.
  //
  // Rejecting at the write is what the rest of this handler already does, and it turns a silently lost
  // conversation into a 400 the host can see and fix.
  const domainContext = boundedDomainContext(body.domainContext, '[FederatedCreateConversation]');
  const otherContexts = boundedOtherContexts(body.otherContexts);
  // Participant roster — owner + shared members, so the assistant is
  // multi-participant aware and can assign work items. Compact (sub + short name + role); host sends it
  // only for shared plans. Validated + capped; shed last under the metadata budget below.
  // Roster is membership + role + home-IDP pointer ONLY ({sub, iss?, role}); identity (name/email) is
  // resolved from the IDP by (iss, sub) at the point of need (single source of truth), never persisted
  // in channel metadata. `iss` is the issuer that makes `sub` unambiguous across MULTIPLE IDPs; the
  // host omits it while single-pool (⇒ resolved against the primary pool), so this is additive.
  const participants = Array.isArray(body.participants)
    ? (body.participants as Array<{ sub?: unknown; iss?: unknown; role?: unknown }>)
        .map((p) => ({
          sub: String(p.sub || '').slice(0, 64),
          ...(typeof p.iss === 'string' && p.iss ? { iss: p.iss.slice(0, 256) } : {}),
          role: String(p.role || '').slice(0, 16),
        }))
        .filter((p) => p.sub)
        .slice(0, 8)
    : undefined;
  // Geography routing signal (SPEC-CONTEXT-AWARE-MODEL-ROUTING). Tiny ({country:"CN"}) — always
  // survives the metadata budget below, so a CN-segment turn routes correctly even when work items
  // are shed for size. Country is a 2-letter ISO code; reject anything larger as malformed.
  const segmentCountry =
    body.segment && typeof body.segment === 'object'
      ? String((body.segment as { country?: unknown }).country || '').slice(0, 3).toUpperCase()
      : '';
  const segment = /^[A-Z]{2}$/.test(segmentCountry) ? { country: segmentCountry } : undefined;

  const fedSub = deriveFederatedSub(iss, rawSub);
  const userArn = `${APP_INSTANCE_ARN}/user/${fedSub}`;
  const channelId = channelIdFor(contextType, contextId);
  const deterministicArn = `${APP_INSTANCE_ARN}/channel/${channelId}`;

  // Chime channel Metadata is capped at ~1 KB and is MEMBER-READABLE (DescribeChannel). It carries only
  // the conversation's identity bits (topic/contextType/contextId) plus the participant ROSTER (member
  // subs, already visible to members via ListChannelMemberships). The PRIVATE grounding —
  // participantProfile, domainContext, otherContexts, userName — does NOT go here, and neither do the
  // ROUTING signals userLanguage and segment: Metadata is member-WRITABLE (a channel's creator is a
  // moderator of their own channel and holds `chime:UpdateChannel`, which writes Name and Metadata in
  // one call), so a member could otherwise redirect their own conversation's model selection by
  // rewriting them. All six are written server-side to the Channel Context store below
  // (channel-context-client.ts), which no member can read or write. UTF-8 byte length (CJK names are
  // multi-byte) is what Chime measures, so budget on bytes.
  const META_CAP = 1000; // headroom under Chime's 1024-byte cap
  const buildMetadata = (includeParticipants: boolean): string => JSON.stringify({
    modelTier: CLASSIFICATION,
    // No `createdBy`: the owner is the sole human member (read from Chime membership),
    // not copied into member-readable metadata (Tenet 6).
    contextType: contextType.slice(0, 64),
    contextId: contextId.slice(0, 128),
    topic: title,
    // NO `participants` ROSTER. It carried `{sub, iss, role}` — identity, which METADATA-AND-TAGS §1
    // puts on the never-in-Metadata list: Metadata is readable by every member and writable by any
    // moderator, so a roster there disclosed who else was in the conversation and which IdP they came
    // from, and let a member edit it. It now goes to the server-only store as `memberIdentities`.
  });
  // `buildMetadata` no longer varies: the roster was the only shed-able part, and it is gone. The cap
  // check stays because the remaining fields are host-supplied and still bounded by Chime's ~1KB.
  const metadata = buildMetadata(true);
  if (Buffer.byteLength(metadata, 'utf8') > META_CAP) {
    console.warn('[FederatedCreateConversation] metadata exceeds the cap even without the roster', {
      bytes: Buffer.byteLength(metadata, 'utf8'),
    });
  }

  try {
    const botArn = await getBotArn();

    // 1. Create the channel (bot is creator/moderator). Idempotent on ChannelId.
    let conversationArn = deterministicArn;
    try {
      const fedExp = getConversationTypeConfig(CLASSIFICATION).expiration;
      const created = await messaging.send(new CreateChannelCommand({
        AppInstanceArn: APP_INSTANCE_ARN,
        ChannelId: channelId,
        Name: title,
        Mode: 'RESTRICTED',
        Privacy: 'PRIVATE',
        ChimeBearer: botArn,
        Tags: [
          { Key: 'classification', Value: CLASSIFICATION },
          { Key: 'conversationType', Value: 'private' },
          { Key: 'contextType', Value: contextType.slice(0, 128) },
        ],
        Metadata: metadata,
        // Platform-wide retention default (90-day LAST_MESSAGE_TIMESTAMP), same
        // source of truth as the primary/drift paths.
        ...(fedExp
          ? { ExpirationSettings: { ExpirationDays: fedExp.days, ExpirationCriterion: fedExp.criterion } }
          : {}),
      }));
      conversationArn = created.ChannelArn || deterministicArn;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException') throw err;
      // Channel already exists — deterministic ARN holds; ensure membership below.
      // Refresh Name + Metadata so an EDITED plan's context (and userName/otherContexts)
      // reaches the assistant. Without this, metadata is frozen at first-creation and the
      // prompt grounding goes stale — the host re-stamps on every session for this reason.
      try {
        await messaging.send(new UpdateChannelCommand({
          ChannelArn: conversationArn,
          Name: title,
          Mode: 'RESTRICTED',
          Metadata: metadata,
          ChimeBearer: botArn,
        }));
      } catch (uerr) {
        console.warn('[FederatedCreateConversation] metadata refresh failed (non-fatal):', uerr);
      }
    }

    // Persist the PRIVATE host grounding to the server-only Channel Context store (never
    // member-readable channel Metadata). Re-stamped on the edit path too, so an edited plan's context
    // reaches the assistant. Best-effort: a lost write degrades grounding, it never leaks.
    //
    // `null` where the host OMITTED a field, so removing it from a plan actually clears the stored
    // value. The store distinguishes absent (leave alone) from null (clear), but both callers used to
    // coerce a missing field to `''`/`undefined` - which the store reads as "not part of this patch".
    // On the edit path that meant grounding deleted from a plan kept being injected into the system
    // prompt forever, which is the bug the re-stamp exists to prevent.
    await putChannelContext(conversationArn, {
      participantProfile: body.participantProfile === undefined ? null : participantProfile,
      domainContext: body.domainContext === undefined ? null : domainContext,
      otherContexts: body.otherContexts === undefined ? null : otherContexts,
      userName: body.userName === undefined ? null : userName,
      // Routing signals live here rather than in Metadata: they decide which model answers, and
      // Metadata is member-writable.
      userLanguage: body.userLanguage === undefined ? null : userLanguage,
      segment: body.segment === undefined ? null : segment,
      // The roster, moved out of member-readable Metadata. Server-only: it is identity (`sub`, the
      // federated `iss`, role). Kept because a federated member's AppInstanceUser id is
      // `deriveFederatedSub(iss, sub)` — a one-way hash — so nothing else can map them back to an IdP
      // to resolve contact details. NOT the membership list; see `memberIdentities` docs.
      memberIdentities: participants === undefined ? null : (participants ?? null),
    });

    // 2. Associate the channel flow BEFORE any membership (best-effort).
    //
    //    ORDERING IS THE POINT. The assistant becomes a member below and Lex can fire WelcomeIntent
    //    from that moment; every message created before this association bypasses the flow, the
    //    welcome included. `CreateChannel` takes no channel-flow field, so immediately after creation
    //    is the earliest possible point. Same defect and same fix as `create-conversation/index.js`
    //    and `lib/channel-creation.ts`.
    const flowArn = await getFlowArn();
    if (flowArn) {
      try {
        await messaging.send(new AssociateChannelFlowCommand({
          ChannelArn: conversationArn, ChannelFlowArn: flowArn, ChimeBearer: botArn,
        }));
      } catch (err) {
        console.warn('[FederatedCreateConversation] associate flow failed (non-fatal):', err);
      }
    }

    // 3. Add the bot then the federated user as member + moderator (idempotent).
    for (const arn of [botArn, userArn]) {
      try {
        await messaging.send(new CreateChannelMembershipCommand({
          ChannelArn: conversationArn, MemberArn: arn, Type: 'DEFAULT', ChimeBearer: botArn,
        }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConflictException') throw err;
      }
    }
    try {
      await messaging.send(new CreateChannelModeratorCommand({
        ChannelArn: conversationArn, ChannelModeratorArn: userArn, ChimeBearer: botArn,
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException') throw err;
    }

    return res(200, { conversationArn, userArn, contextType, contextId });
  } catch (err) {
    console.error('[FederatedCreateConversation] failed:', err);
    return res(500, { error: 'Federated create-conversation failed' });
  }
};
