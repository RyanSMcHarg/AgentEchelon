/**
 * Battle Outcome API (SPEC-BATTLE.md §"Battle Scoring & Per-Step
 * Telemetry", Scope Revision decision 3 — the pick-the-winner path).
 *
 *   POST /channels/battle/outcome  { battleId, winner }   -> records pick
 *   GET  /channels/battle/outcome?battleId=...             -> reads pick
 *
 * Authorization / scope decision (v0.2.0):
 *   - Cognito-authenticated. `chosenByPersonId` is the caller's person id,
 *     resolved from the verified token by `callerPersonId`, NEVER from the
 *     request body — a client cannot attribute a pick to someone else.
 *   - Channel membership IS verified on POST. The caller passes the
 *     `channelArn` the duel happened in and `handlePost` checks their
 *     membership of it before recording.
 *     This was once left out on the reasoning that battleId is
 *     sha256(channelArn + ':' + userMessageId)[:16], not reversible to a
 *     channel without extra state, and that a pick is descriptive only
 *     (never read back into model/variant selection, per the amended
 *     "Algorithmic judging" Non-Goal). That reasoning made a spurious pick
 *     cheap rather than impossible, and a pick is now a per-user vote that
 *     a tally reads, so the identity casting it has to be entitled to.
 *   - The battleId is BOUND to that channel, which membership alone does
 *     not do. Both values arrive from the client and describe different
 *     things, so checking one said nothing about the other: a member of
 *     any channel could pick in a duel that ran somewhere they cannot see.
 *     `readBattleChannel` is the join, recorded at fan-out on the one row
 *     per battle that is written once and never replaced. It is checked
 *     only when recorded - see the call site for why unknown is allowed.
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
  readUserBattleOutcome,
} from './lib/battle-outcome.js';
import {
  loadChannelBattleConfig,
  readBattleRows,
  battleChannelFrom,
  duelWasAbandoned,
} from './lib/battle-state.js';
import type { BattleStateRow } from './lib/battle-state.js';
import type { BattleOutcome } from './lib/analytics-metadata.js';
import { parseJsonBody, callerPersonId } from './lib/auth.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { userArnFor } from './lib/person-arn.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const experimentsDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * THE TWO VERSIONS A PICK JUDGES, by configId: the control's and the treatment's pins on the experiment
 * row (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5), written when it was armed. A promoted version keeps
 * the treatment's configId, so a pick recorded with it stays attributable after promotion. Empty when the
 * row or its pins cannot be read (a battle armed before pins carried configIds): the pick records without
 * them, as before.
 */
export async function pinnedConfigIds(experimentId: string): Promise<{ controlConfigId?: string; treatmentConfigId?: string }> {
  const table = process.env.EXPERIMENTS_TABLE || '';
  if (!table || !experimentId) return {};
  try {
    const res = await experimentsDdb.send(new GetCommand({ TableName: table, Key: { experimentId } }));
    const variants = (res.Item?.variants ?? []) as Array<{ controlPin?: { configId?: string }; altPin?: { configId?: string } }>;
    const control = variants[0]?.controlPin?.configId;
    const treatment = variants[1]?.altPin?.configId;
    return {
      ...(typeof control === 'string' && control ? { controlConfigId: control } : {}),
      ...(typeof treatment === 'string' && treatment ? { treatmentConfigId: treatment } : {}),
    };
  } catch (err) {
    console.warn("[battle-outcome] could not read the experiment's pins; the pick records without its configIds",{ experimentId, err: (err as Error)?.name });
    return {};
  }
}

const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN);
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const messagingClient = chimeMessagingClient({});

const VALID_WINNERS: ReadonlySet<string> = new Set(['A', 'B', 'tie']);

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,POST,OPTIONS' });

const respond = http.respond;

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
  const personId = await callerPersonId(event);
  if (!personId) {
    return respond(401, { error: 'Unauthorized: this sign-in names no person' }, origin);
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
    const callerUserArn = userArnFor(APP_INSTANCE_ARN, personId);
    try {
      await messagingClient.send(new DescribeChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: callerUserArn,
        ChimeBearer: callerUserArn,
      }));
    } catch (membershipErr) {
      console.warn('[battle-outcome] caller not a member of channel', {
        personId, channelArn, err: (membershipErr as Error).name,
      });
      return respond(403, {
        error: 'Caller is not a member of the battle\'s channel',
        code: 'NOT_A_MEMBER',
      }, origin);
    }
  }

  // THE DUEL'S OWN ROWS, read once and used for both checks below. Two reads of the same rows would
  // cost a second round-trip to say the same thing.
  let rows: BattleStateRow[] = [];
  try {
    rows = await readBattleRows(battleId);
  } catch (stateErr) {
    console.warn('[battle-outcome] could not read battle state', {
      battleId, err: (stateErr as Error).name,
    });
  }

  // THE BATTLE MUST BE THE ONE THAT RAN IN THAT CHANNEL, and until this check the two halves of the
  // request were never joined.
  //
  // The membership gate above proves the caller belongs in `channelArn`. It proves nothing about
  // `battleId`, which arrives separately and was recorded as given. So a member of any channel could
  // cast a pick into a duel that ran somewhere they cannot see, given its id: last-write-wins per
  // user, and the experiment attribution below is resolved from the channel THEY named, so the vote
  // also lands under the wrong experiment.
  //
  // UNKNOWN IS NOT MISMATCH. `battleChannelFrom` yields null for a duel that predates the binding,
  // one whose rows have aged out, and a deployment with no state table. Refusing on null would
  // discard real judgements from people who did see the comparison, and would make the endpoint's
  // behavior depend on a TTL. Only a recorded channel that DIFFERS is refused.
  const battleChannel = battleChannelFrom(rows);
  if (battleChannel && battleChannel !== channelArn) {
    console.warn('[battle-outcome] refusing a pick for a battle from another channel', {
      personId, battleId, claimedChannel: channelArn,
    });
    // The same 403 the membership gate returns, and deliberately not a more specific one: a distinct
    // code would confirm that the battleId exists and belongs elsewhere, to a caller who has just
    // demonstrated they are not entitled to know that.
    return respond(403, {
      error: 'Caller is not a member of the battle\'s channel',
      code: 'NOT_A_MEMBER',
    }, origin);
  }

  // AN ABANDONED DUEL IS NOT COMPARABLE, so it takes no pick (DESIGN-BATTLE 2a-i).
  //
  // A duel somebody walked out of never produced the comparison a pick is a judgement of: one side may
  // have been mid-sentence, or still collecting the details it needed. Recording a winner would put a
  // fabricated round into the human-pick axis, where it points a recommendation with the authority of
  // real data. Refusing here is what keeps it out - `battlePickAxis` reads recorded picks, so a pick
  // that never lands never counts.
  //
  // ORDERED AFTER THE MEMBERSHIP CHECK, deliberately. This response distinguishes battle ids that exist
  // from ones that do not, so it must sit behind the gate that establishes the caller belongs here;
  // in front of it, it would answer that question for anyone who asked.
  //
  // THE FAIL-OPEN IS `rows.length > 0` - an empty result means either "this duel has no rows" or "the
  // read did not work", the two are indistinguishable from here, and neither is evidence that a duel
  // was abandoned. Refusing on silence would discard a real judgement from someone who did see the
  // comparison, which is the worse error of the two.
  {
    if (rows.length > 0 && duelWasAbandoned(rows)) {
      console.log('[battle-outcome] refusing a pick for an abandoned battle', { battleId });
      return respond(409, {
        error: 'That battle was ended before it finished, so there is no result to judge',
        code: 'BATTLE_ABANDONED',
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
  if (!experimentId) {
    // Not necessarily wrong - an unbound (legacy) battle has no experiment. But it is also what a
    // missing CHANNEL_BATTLE_CONFIG_TABLE grant looks like, and an unattributed pick is invisible
    // downstream: the analytics scan filters picks by experimentId, so this one silently never
    // counts toward battle wins. Say so here rather than letting the tally read as a flat zero.
    console.warn('[battle-outcome] recording pick with NO experiment attribution', {
      channelArn,
      configTableSet: Boolean(process.env.CHANNEL_BATTLE_CONFIG_TABLE),
    });
  }

  const outcome = await recordBattleOutcome({
    battleId,
    winner: winner as BattleOutcome['winner'],
    chosenByPersonId: personId,
    ...(experimentId && { experimentId }),
    // The two versions that fought, from the experiment's pins, so the pick names what it judged.
    ...(experimentId ? await pinnedConfigIds(experimentId) : {}),
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
  const personId = await callerPersonId(event);
  if (!personId) {
    return respond(401, { error: 'Unauthorized: this sign-in names no person' }, origin);
  }
  const battleId = (event.queryStringParameters?.battleId || '').trim();
  if (!battleId) {
    return respond(400, { error: 'Missing battleId' }, origin);
  }
  // Return the CALLER'S OWN pick (the scorecard "you picked" state) - never another user's pick or person id.
  // readUserBattleOutcome scopes to personId, so a caller who didn't vote (or isn't in the battle) gets
  // null, and no other member's person id is ever disclosed. This also realizes the per-user votes-map read
  // (the legacy read returned "whoever voted last", which both leaked a person id and was wrong in a group).
  const pick = await readUserBattleOutcome(battleId, personId);
  const outcome: BattleOutcome | null = pick
    ? {
        battleId,
        winner: pick.winner,
        chosenByPersonId: pick.personId, // the caller's own
        chosenAt: pick.chosenAt,
        ...(pick.controlConfigId && { controlConfigId: pick.controlConfigId }),
        ...(pick.treatmentConfigId && { treatmentConfigId: pick.treatmentConfigId }),
        ...(pick.experimentId && { experimentId: pick.experimentId }),
        ...(pick.variantId && { variantId: pick.variantId }),
        ...(pick.intent && { intent: pick.intent }),
      }
    : null;
  return respond(200, { outcome }, origin); // outcome may be null — "no pick yet"
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
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
