/**
 * Battle Outcome API (SPEC-BATTLE.md §"Battle Scoring & Per-Step
 * Telemetry", Scope Revision decision 3 — the pick-the-winner path).
 *
 *   POST /channels/battle/outcome  { battleId, winner }   -> records pick
 *   GET  /channels/battle/outcome?battleId=...             -> reads pick
 *
 * Authorization / scope decision (v0.2.0):
 *   - Cognito-authenticated. `chosenByUserSub` is taken from the token
 *     claims (event.requestContext.authorizer.claims.sub), NEVER from the
 *     request body — a client cannot attribute a pick to someone else.
 *   - Channel-membership enforcement is intentionally NOT done here.
 *     battleId is sha256(channelArn + ':' + userMessageId)[:16] — not
 *     reversible to a channel without extra state — and the outcome is
 *     descriptive only (never read back into model/variant selection,
 *     per the amended "Algorithmic judging" Non-Goal). A spurious pick
 *     only skews a display statistic, so token-auth + server-derived
 *     sub is the proportionate control for v0.2.0. Revisit if outcomes
 *     ever gain weight.
 *
 * Storage semantics (last-write-wins, server-stamped chosenAt) live in
 * lib/battle-outcome.ts; this file is transport + auth + validation.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  ChimeSDKMessagingClient,
  DescribeChannelMembershipCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  recordBattleOutcome,
  readBattleOutcome,
} from './lib/battle-outcome.js';
import { loadChannelBattleConfig } from './lib/battle-state.js';
import type { BattleOutcome } from './lib/analytics-metadata.js';
import { parseJsonBody } from './lib/auth.js';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',');
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const messagingClient = new ChimeSDKMessagingClient({});

const VALID_WINNERS: ReadonlySet<string> = new Set(['A', 'B', 'tie']);

function corsHeaders(origin?: string): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin',
  };
}

function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

function getCallerSub(event: APIGatewayProxyEvent): string | null {
  const claims = (event.requestContext.authorizer?.claims || {}) as Record<string, string>;
  return claims.sub || null;
}

interface PostBody {
  battleId?: string;
  winner?: string;
  /** Caller must reference the channel the battle happened in; membership is
   *  verified before recording. */
  channelArn?: string;
}

async function handlePost(
  event: APIGatewayProxyEvent,
  origin?: string,
): Promise<APIGatewayProxyResult> {
  const callerSub = getCallerSub(event);
  if (!callerSub) {
    return respond(401, { error: 'Unauthorized — no Cognito sub on the request' }, origin);
  }

  // Standardize on the shared parseJsonBody helper so every endpoint returns
  // the same 400 shape.
  const parsed = parseJsonBody<PostBody>(event, origin);
  if ('statusCode' in parsed) return parsed;
  const body = parsed.body;

  const battleId = (body.battleId || '').trim();
  const winner = body.winner;
  const channelArn = (body.channelArn || '').trim();

  if (!battleId) {
    return respond(400, { error: 'Missing battleId' }, origin);
  }
  if (!winner || !VALID_WINNERS.has(winner)) {
    return respond(400, {
      error: "winner must be 'A', 'B', or 'tie'",
      code: 'INVALID_WINNER',
    }, origin);
  }

  // Caller must be a member of the battle's channel before they can record an
  // outcome. Without this,
  // any signed-in user with a known battleId can override another
  // user's pick (last-write-wins). channelArn is provided by the
  // frontend (it knows the active conversation); we cross-check
  // membership via Chime.
  if (!channelArn) {
    return respond(400, {
      error: 'channelArn (the battle\'s channel) is required',
      code: 'MISSING_CHANNEL_ARN',
    }, origin);
  }
  if (APP_INSTANCE_ARN && !channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) {
    return respond(400, {
      error: 'channelArn does not belong to this app instance',
      code: 'INVALID_CHANNEL_ARN',
    }, origin);
  }
  if (APP_INSTANCE_ARN) {
    const callerUserArn = `${APP_INSTANCE_ARN}/user/${callerSub}`;
    try {
      await messagingClient.send(new DescribeChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: callerUserArn,
        ChimeBearer: callerUserArn,
      }));
    } catch (membershipErr) {
      console.warn('[battle-outcome] caller not a member of channel', {
        callerSub, channelArn, err: (membershipErr as Error).name,
      });
      return respond(403, {
        error: 'Caller is not a member of the battle\'s channel',
        code: 'NOT_A_MEMBER',
      }, origin);
    }
  }

  // Feedback join: resolve the experiment from the channel's battle config
  // server-side (never trust the client to
  // attribute a pick to an experiment). variantId is derived in the lib from
  // `winner`. Fail-open: if the config can't be read, the pick still records
  // without the join rather than erroring.
  let experimentId: string | undefined;
  try {
    const cfg = await loadChannelBattleConfig(channelArn);
    experimentId = cfg?.experimentId;
  } catch (cfgErr) {
    console.warn('[battle-outcome] could not resolve experiment for channel', {
      channelArn, err: (cfgErr as Error).name,
    });
  }

  const outcome = await recordBattleOutcome({
    battleId,
    winner: winner as BattleOutcome['winner'],
    chosenByUserSub: callerSub,
    ...(experimentId && { experimentId }),
  });

  if (!outcome) {
    // Input was already validated above, so a null here means the store
    // is unavailable / not provisioned — fail-open at the lib, surfaced
    // as a soft error so the UI can degrade rather than hard-fail.
    return respond(503, {
      error: 'Outcome store unavailable; pick not recorded',
      code: 'OUTCOME_STORE_UNAVAILABLE',
    }, origin);
  }

  return respond(200, { outcome }, origin);
}

async function handleGet(
  event: APIGatewayProxyEvent,
  origin?: string,
): Promise<APIGatewayProxyResult> {
  if (!getCallerSub(event)) {
    return respond(401, { error: 'Unauthorized — no Cognito sub on the request' }, origin);
  }
  const battleId = (event.queryStringParameters?.battleId || '').trim();
  if (!battleId) {
    return respond(400, { error: 'Missing battleId' }, origin);
  }
  const outcome = await readBattleOutcome(battleId);
  return respond(200, { outcome }, origin); // outcome may be null — "no pick yet"
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;
  const method = event.httpMethod;
  const path = event.path || '';

  if (method === 'OPTIONS') {
    return respond(200, {}, origin);
  }

  try {
    if (method === 'POST' && path.endsWith('/battle/outcome')) {
      return await handlePost(event, origin);
    }
    if (method === 'GET' && path.endsWith('/battle/outcome')) {
      return await handleGet(event, origin);
    }
    return respond(404, { error: `No route for ${method} ${path}` }, origin);
  } catch (err) {
    console.error('[battle-outcome-api] Unhandled error:', err);
    return respond(500, { error: 'Internal server error' }, origin);
  }
}
