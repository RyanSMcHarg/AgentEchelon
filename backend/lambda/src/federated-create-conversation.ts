// Federated create-conversation — create-or-get a context-bound conversation for
// a user authenticated against a host app's OWN Cognito pool (a foreign IdP).
// Additive to the native create-conversation/index.js: identity comes ONLY from the
// validated authorizer claims; the foreign `sub` maps to the same disjoint `fed_`
// AppInstanceUser id the federated credential exchange vends (deriveFederatedSub), so
// the member this adds is exactly the bearer the embedded widget operates as.
//
// The channel is created by the tier bot (its ChimeBearer), classification-tagged, and
// bound to {contextType, contextId} in metadata. The ChannelId is DETERMINISTIC from
// the context, so a repeat call is idempotent — Chime returns ConflictException and we
// reconstruct the (deterministic) ARN. No modelId / tier-gate: federated users get a
// fixed tier (the configured assistant), so there is no Cognito group lookup.

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
import { getConversationTypeConfig } from '../../lib/config/conversation-types.js';

const messaging = new ChimeSDKMessagingClient({});
const ssm = new SSMClient({});

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';
const TIER = (process.env.ASSISTANT_TIER || 'basic').trim();
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || `${SSM_ROOT}/tier/${TIER}/bot-arn`;
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

// Chime ChannelId allows [A-Za-z0-9_-], length 1-64. Make a stable, charset-safe id
// from the context so the same plan always maps to the same channel (idempotency).
// TIER-scoped so a tier change (e.g. basic→standard) creates a FRESH channel owned by the
// current tier's bot, instead of colliding with a channel created+moderated by a different bot
// (which the current bot can't add members to → ForbiddenException). Pre-tier-scope channels
// (`fed-<ctx>-<id>`) are orphaned by design; the host re-creates under the new id.
function channelIdFor(contextType: string, contextId: string): string {
  const raw = `fed-${TIER}-${contextType}-${contextId}`.replace(/[^A-Za-z0-9_-]/g, '-');
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
  // We stamp these into channel Metadata so the per-tier handler can render them into the
  // assistant's system prompt (current plan = primary grounding; other contexts = disambiguation).
  const userName = String(body.userName || '').slice(0, 80);
  // The host's i18n: the user's chosen site language (e.g. "en"/"zh"). Stamped so the assistant can
  // reply in the same language as the rest of the site.
  const userLanguage = String(body.userLanguage || '').slice(0, 8);
  // Free-text participant profile (preferences/working style) — personalizes the assistant's replies.
  const participantProfile = String(body.participantProfile || '').slice(0, 600);
  const domainContext = body.domainContext && typeof body.domainContext === 'object'
    ? (body.domainContext as { items?: unknown[]; [k: string]: unknown })
    : undefined;
  const otherContexts = Array.isArray(body.otherContexts) ? body.otherContexts : undefined;
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

  // Chime channel Metadata is capped at ~1 KB. Build the richest metadata that fits, shedding
  // work items first, then otherContexts, until under budget. userName + topic always survive —
  // they are what the greeting + grounding most need. UTF-8 byte length (CJK names are multi-byte)
  // is what Chime measures, so budget on bytes, not string length.
  const META_CAP = 1000; // headroom under Chime's 1024-byte cap
  const buildMetadata = (itemBudget: number, includeOtherContexts: boolean, includeParticipants: boolean): string => {
    const dc = domainContext
      ? { ...domainContext, items: Array.isArray(domainContext.items) ? domainContext.items.slice(0, itemBudget) : [] }
      : undefined;
    return JSON.stringify({
      modelTier: TIER,
      // No `createdBy`: the owner is the sole human member (read from Chime membership),
      // not copied into member-readable metadata (Tenet 10).
      contextType: contextType.slice(0, 64),
      contextId: contextId.slice(0, 128),
      topic: title,
      ...(userName ? { userName } : {}),
      ...(userLanguage ? { userLanguage } : {}),
      ...(segment ? { segment } : {}),
      ...(participantProfile ? { participantProfile } : {}),
      ...(includeParticipants && participants && participants.length ? { participants } : {}),
      ...(dc ? { domainContext: dc } : {}),
      ...(includeOtherContexts && otherContexts ? { otherContexts } : {}),
    });
  };
  let metadata = buildMetadata(20, true, true);
  if (Buffer.byteLength(metadata, 'utf8') > META_CAP) metadata = buildMetadata(20, false, true);
  for (let n = 15; Buffer.byteLength(metadata, 'utf8') > META_CAP && n >= 0; n -= 5) {
    metadata = buildMetadata(n, false, true);
  }
  // Last resort: the roster is shed only if even an items-less, otherContexts-less metadata is over budget.
  if (Buffer.byteLength(metadata, 'utf8') > META_CAP) metadata = buildMetadata(0, false, false);

  try {
    const botArn = await getBotArn();

    // 1. Create the channel (bot is creator/moderator). Idempotent on ChannelId.
    let conversationArn = deterministicArn;
    try {
      const fedExp = getConversationTypeConfig(TIER).expiration;
      const created = await messaging.send(new CreateChannelCommand({
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

    // 2. Add the bot then the federated user as member + moderator (idempotent).
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

    // 3. Associate the channel flow so @assistant routing runs (best-effort).
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

    return res(200, { conversationArn, userArn, contextType, contextId });
  } catch (err) {
    console.error('[FederatedCreateConversation] failed:', err);
    return res(500, { error: 'Federated create-conversation failed' });
  }
};
