/**
 * Battle Outcome storage (SPEC-BATTLE.md §"Battle Scoring & Per-Step
 * Telemetry", Scope Revision decision 3; DESIGN-EXPERIMENTS-BATTLE §3.4 B3).
 *
 * Backing table `BattleOutcome` — PK battleId, ONE row per battle. The row
 * now holds a PER-USER `votes` map keyed by the chooser's Cognito sub:
 *
 *   { battleId, schemaVersion: 2, votes: { <userSub>: { winner, chosenAt, ... } } }
 *
 * This closes the last-write-wins data loss of the original single-pick row: in
 * a multi-user channel each member's pick is retained (re-picking still
 * overwrites, but only that user's own entry), and the battle winner is a
 * TALLY (majority of decisive A/B picks), not whoever clicked last. A
 * single-user battle is unchanged — one entry, that user's pick.
 *
 * Writes are per-key UpdateExpressions (`SET votes.<sub> = ...`), which are
 * atomic on the nested path and never clobber a sibling user's vote, so two
 * members voting concurrently both persist. The map keeps the SAME PK
 * (battleId), so this is a purely ADDITIVE, item-level change — no table re-key,
 * no migration, and deployed rows keep working (INV-2).
 *
 * Versioned read: `extractPicks` tolerates a LEGACY v1 single-row outcome
 * (top-level `winner`/`chosenByUserSub`, no `votes` map) during cutover — it is
 * read as one pick keyed by its `chosenByUserSub`. A v2 votes map and a v1
 * top-level pick can even coexist on one row (a legacy row later voted into);
 * the votes map wins for a user present in both.
 *
 * Descriptive only — never read back into variant/model selection (see the
 * amended "Algorithmic judging" Non-Goal). It backs the scorecard's "you
 * picked" state, the tally UI, and the admin `battle_wins` aggregation.
 *
 * Read/write fail OPEN like the other battle libs: if the env var is unset
 * (feature not provisioned) or DDB rejects the call, callers get null / an
 * empty tally and the UI degrades to "no recorded pick" rather than erroring.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { BattleOutcome } from './analytics-metadata.js';

const BATTLE_OUTCOME_TABLE = process.env.BATTLE_OUTCOME_TABLE || '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Item-shape version marker for the per-user votes map. Legacy rows have none. */
export const OUTCOME_SCHEMA_VERSION = 2;

export type BattleWinner = BattleOutcome['winner']; // 'A' | 'B' | 'tie'

const VALID_WINNERS: ReadonlySet<BattleWinner> = new Set(['A', 'B', 'tie']);

/** One user's stored pick inside the per-battle `votes` map (no userSub — that's the key). */
export interface BattleVote {
  winner: BattleWinner;
  chosenAt: string; // ISO, server-stamped
  controlConfigId?: string;
  treatmentConfigId?: string;
  experimentId?: string;
  variantId?: 'control' | 'treatment';
  intent?: string;
}

/** A per-user pick with its userSub attached — the read-side shape. */
export interface PerUserPick extends BattleVote {
  userSub: string;
}

/**
 * The tallied result for a battle across all retained per-user picks. `winner`
 * is the MAJORITY of decisive (A/B) picks — 'tie' when they are equal or when
 * there are no decisive picks. `tieCount` is picks that chose 'tie'; those are
 * non-decisive and excluded from `totalDecisive`.
 */
export interface BattleTally {
  battleId: string;
  winner: BattleWinner;
  aCount: number;
  bCount: number;
  tieCount: number;
  totalDecisive: number; // aCount + bCount
  picks: PerUserPick[];
}

export interface RecordBattleOutcomeArgs {
  battleId: string;
  winner: BattleWinner;
  chosenByUserSub: string;
  // P4 config attribution — the config fingerprints of the two sides that fought. Optional: the pick
  // still records without them (fail-open), but supplying them makes the outcome sliceable by config.
  controlConfigId?: string;
  treatmentConfigId?: string;
  // Feedback join — the experiment + intent this
  // battle belongs to, resolved by the caller from the channel's battle config.
  // `variantId` is derived here from `winner` (A→control, B→treatment, tie→none).
  experimentId?: string;
  intent?: string;
}

/**
 * Pure. Tally a set of per-user picks into a battle winner. Majority of the
 * decisive (A/B) picks; ties in the count (or no decisive picks at all) yield
 * an overall 'tie'. Exported for the analytics `battle_wins` aggregation and
 * for unit tests.
 */
export function tallyPicks(battleId: string, picks: PerUserPick[]): BattleTally {
  let aCount = 0;
  let bCount = 0;
  let tieCount = 0;
  for (const p of picks) {
    if (p.winner === 'A') aCount++;
    else if (p.winner === 'B') bCount++;
    else tieCount++;
  }
  const winner: BattleWinner = aCount > bCount ? 'A' : bCount > aCount ? 'B' : 'tie';
  return { battleId, winner, aCount, bCount, tieCount, totalDecisive: aCount + bCount, picks };
}

/** Pull the optional attribution fields off a stored vote/legacy row (undefined-safe). */
function pickExtras(v: Record<string, unknown>): Omit<BattleVote, 'winner' | 'chosenAt'> {
  return {
    ...(typeof v.controlConfigId === 'string' && { controlConfigId: v.controlConfigId }),
    ...(typeof v.treatmentConfigId === 'string' && { treatmentConfigId: v.treatmentConfigId }),
    ...(typeof v.experimentId === 'string' && { experimentId: v.experimentId }),
    ...((v.variantId === 'control' || v.variantId === 'treatment') && { variantId: v.variantId }),
    ...(typeof v.intent === 'string' && { intent: v.intent }),
  };
}

/**
 * Versioned normalize: read every retained pick off a raw outcome item,
 * tolerating both the v2 `votes` map and a legacy v1 top-level single pick. The
 * votes map wins for a user present in both. Invalid entries are skipped.
 */
function extractPicks(item: Record<string, unknown> | null | undefined): PerUserPick[] {
  if (!item) return [];
  const picks: PerUserPick[] = [];
  const seen = new Set<string>();

  const votes = item.votes as Record<string, Record<string, unknown>> | undefined;
  if (votes && typeof votes === 'object') {
    for (const [userSub, raw] of Object.entries(votes)) {
      const winner = raw?.winner as BattleWinner | undefined;
      if (!userSub || !winner || !VALID_WINNERS.has(winner)) continue;
      picks.push({
        userSub,
        winner,
        chosenAt: typeof raw.chosenAt === 'string' ? raw.chosenAt : '',
        ...pickExtras(raw),
      });
      seen.add(userSub);
    }
  }

  // Legacy v1 single-row pick, tolerated during cutover. Keyed by its
  // chosenByUserSub; skipped if that user already has an entry in the votes map.
  const legacyWinner = item.winner as BattleWinner | undefined;
  const legacySub = typeof item.chosenByUserSub === 'string' ? item.chosenByUserSub : undefined;
  if (legacyWinner && VALID_WINNERS.has(legacyWinner) && legacySub && !seen.has(legacySub)) {
    picks.push({
      userSub: legacySub,
      winner: legacyWinner,
      chosenAt: typeof item.chosenAt === 'string' ? item.chosenAt : '',
      ...pickExtras(item),
    });
  }

  return picks;
}

/**
 * Record (or overwrite) ONE user's pick for a battle. `chosenAt` is
 * server-stamped here, not client-supplied. Returns the written pick as a
 * `BattleOutcome` (this user's own entry), or null when the pick is invalid
 * (bad winner / missing ids — logged, not thrown) or the store is unavailable
 * (fail-open).
 *
 * Per-user: the write sets `votes.<userSub>`, so a re-pick overwrites only that
 * user's entry and a different user's pick is retained (no cross-user
 * last-write-wins). Two round-trips — one idempotent init that ensures the
 * `votes` map exists (concurrency-safe via `if_not_exists`), then the per-user
 * SET — because a nested path can't be created and written in one expression.
 */
export async function recordBattleOutcome(
  args: RecordBattleOutcomeArgs,
): Promise<BattleOutcome | null> {
  const battleId = (args.battleId || '').trim();
  const chosenByUserSub = (args.chosenByUserSub || '').trim();

  if (!battleId || !chosenByUserSub || !VALID_WINNERS.has(args.winner)) {
    console.warn('[battle-outcome] recordBattleOutcome rejected invalid input', {
      hasBattleId: !!battleId,
      hasUserSub: !!chosenByUserSub,
      winner: args.winner,
    });
    return null;
  }

  if (!BATTLE_OUTCOME_TABLE) return null; // feature not provisioned — fail open

  // Feedback join: derive the credited variant from the pick. A tie credits
  // neither side, so variantId stays undefined (the tie is still recorded).
  const variantId =
    args.winner === 'A' ? 'control' : args.winner === 'B' ? 'treatment' : undefined;

  const chosenAt = new Date().toISOString();
  const vote: BattleVote = {
    winner: args.winner,
    chosenAt,
    // P4 — stamp the two configs that fought when the caller resolved them.
    ...(args.controlConfigId?.trim() && { controlConfigId: args.controlConfigId.trim() }),
    ...(args.treatmentConfigId?.trim() && { treatmentConfigId: args.treatmentConfigId.trim() }),
    // Feedback join — experiment/variant/intent.
    ...(args.experimentId?.trim() && { experimentId: args.experimentId.trim() }),
    ...(variantId && { variantId }),
    ...(args.intent?.trim() && { intent: args.intent.trim() }),
  };

  try {
    // Phase 1: ensure the row + votes map exist. `if_not_exists` makes this an
    // idempotent no-op when they already do, and concurrency-safe if two users'
    // first picks race (the second sees the existing map and keeps it).
    await ddb.send(
      new UpdateCommand({
        TableName: BATTLE_OUTCOME_TABLE,
        Key: { battleId },
        UpdateExpression:
          'SET votes = if_not_exists(votes, :empty), ' +
          'schemaVersion = if_not_exists(schemaVersion, :ver)',
        ExpressionAttributeValues: { ':empty': {}, ':ver': OUTCOME_SCHEMA_VERSION },
      }),
    );

    // Phase 2: set THIS user's pick. Atomic on the nested path — never clobbers
    // another user's entry. `lastChosenAt` tracks the most recent write for the
    // back-compat single-pick read.
    await ddb.send(
      new UpdateCommand({
        TableName: BATTLE_OUTCOME_TABLE,
        Key: { battleId },
        UpdateExpression: 'SET votes.#u = :vote, lastChosenAt = :now',
        ExpressionAttributeNames: { '#u': chosenByUserSub },
        ExpressionAttributeValues: { ':vote': vote, ':now': chosenAt },
      }),
    );
  } catch (err) {
    console.warn('[battle-outcome] recordBattleOutcome failed (failing open):', err);
    return null;
  }

  // Return this user's own pick in the legacy `BattleOutcome` shape so the API
  // response and existing callers are unchanged.
  return {
    battleId,
    winner: vote.winner,
    chosenByUserSub,
    chosenAt,
    ...(vote.controlConfigId && { controlConfigId: vote.controlConfigId }),
    ...(vote.treatmentConfigId && { treatmentConfigId: vote.treatmentConfigId }),
    ...(vote.experimentId && { experimentId: vote.experimentId }),
    ...(vote.variantId && { variantId: vote.variantId }),
    ...(vote.intent && { intent: vote.intent }),
  };
}

/** Raw single-item read of the outcome row (PK battleId). Fails open (null). */
async function readOutcomeItem(battleId: string): Promise<Record<string, unknown> | null> {
  const id = (battleId || '').trim();
  if (!id || !BATTLE_OUTCOME_TABLE) return null;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: BATTLE_OUTCOME_TABLE, Key: { battleId: id } }),
    );
    return (result.Item as Record<string, unknown> | undefined) ?? null;
  } catch (err) {
    console.warn('[battle-outcome] read failed (failing open):', err);
    return null;
  }
}

/**
 * Read every retained per-user pick for a battle, tallied. Null when the store
 * is unavailable or there is no row / no valid pick. This is the authoritative
 * read for the honest multi-user winner (a majority TALLY, not last-write) and
 * for the `battle_wins` aggregation.
 */
export async function readBattleOutcomes(battleId: string): Promise<BattleTally | null> {
  const item = await readOutcomeItem(battleId);
  const picks = extractPicks(item);
  if (picks.length === 0) return null;
  return tallyPicks((battleId || '').trim(), picks);
}

/** Read a single user's own pick for a battle (the scorecard "you picked" state), or null. */
export async function readUserBattleOutcome(
  battleId: string,
  userSub: string,
): Promise<PerUserPick | null> {
  const sub = (userSub || '').trim();
  if (!sub) return null;
  const item = await readOutcomeItem(battleId);
  return extractPicks(item).find((p) => p.userSub === sub) ?? null;
}

/**
 * REMOVED: the back-compat single-pick read, which returned the most recent pick ACROSS ALL USERS.
 *
 * It was retired when picks became per-user but kept for compatibility, and by then nothing called
 * it - the API's GET reads `readUserBattleOutcome` (the caller's own pick) and the tally reads
 * `readBattleOutcomes`. Its own tests kept it green, so it read as covered behavior rather than as
 * dead code, and it was convincing enough to be mistaken for the live read path during triage.
 *
 * Reusing it would be a bug: in a group battle "whoever voted last" is not any given user's pick, so
 * a scorecard driven by it would show one member another member's choice. Anything needing a single
 * winner wants `readBattleOutcomes` (a majority tally); anything showing "you picked" wants
 * `readUserBattleOutcome`.
 */
