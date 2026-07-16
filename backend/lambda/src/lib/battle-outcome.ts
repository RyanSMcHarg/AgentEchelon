/**
 * Battle Outcome storage (SPEC-BATTLE.md §"Battle Scoring & Per-Step
 * Telemetry", Scope Revision decision 3).
 *
 * Backing table `BattleOutcome` — PK battleId. One row per battle: the
 * user's explicit head-to-head pick (A = control variant, B = treatment,
 * or tie). Per the spec: "one pick per battle per user; re-picking
 * overwrites (last write wins, chosenAt updated)" — so the write is an
 * UNCONDITIONAL Put (no ConditionExpression); the latest pick wins and
 * `chosenAt` is server-stamped at write time.
 *
 * This is descriptive only — it is never read back into variant/model
 * selection (see the amended "Algorithmic judging" Non-Goal). It exists
 * for the scorecard's "you picked" state and the admin breakdown.
 *
 * Read/write fail OPEN like the other battle libs: if the env var is
 * unset (feature not provisioned in this deployment) or DDB rejects the
 * call, callers get null and the UI degrades to "no recorded pick"
 * rather than erroring.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import type { BattleOutcome } from './analytics-metadata.js';

const BATTLE_OUTCOME_TABLE = process.env.BATTLE_OUTCOME_TABLE || '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const VALID_WINNERS: ReadonlySet<BattleOutcome['winner']> = new Set(['A', 'B', 'tie']);

export interface RecordBattleOutcomeArgs {
  battleId: string;
  winner: BattleOutcome['winner'];
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
 * Record (or overwrite) the user's pick for a battle. `chosenAt` is
 * server-stamped here, not client-supplied. Returns the written record,
 * or null when the pick is invalid (bad winner / missing ids — logged,
 * not thrown, so a malformed client request can't 500 the path) or the
 * store is unavailable (fail-open).
 *
 * Last-write-wins: an unconditional Put. A re-pick by the same or a
 * different user simply overwrites with a fresh chosenAt.
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

  const outcome: BattleOutcome = {
    battleId,
    winner: args.winner,
    chosenByUserSub,
    chosenAt: new Date().toISOString(),
    // P4 — stamp the two configs that fought when the caller resolved them.
    ...(args.controlConfigId?.trim() && { controlConfigId: args.controlConfigId.trim() }),
    ...(args.treatmentConfigId?.trim() && { treatmentConfigId: args.treatmentConfigId.trim() }),
    // Feedback join — experiment/variant/intent.
    ...(args.experimentId?.trim() && { experimentId: args.experimentId.trim() }),
    ...(variantId && { variantId }),
    ...(args.intent?.trim() && { intent: args.intent.trim() }),
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: BATTLE_OUTCOME_TABLE,
        Item: outcome,
        // Intentionally no ConditionExpression — last-write-wins per spec.
      }),
    );
    return outcome;
  } catch (err) {
    console.warn('[battle-outcome] recordBattleOutcome failed (failing open):', err);
    return null;
  }
}

/** Read the recorded pick for a battle, or null if none / unavailable. */
export async function readBattleOutcome(battleId: string): Promise<BattleOutcome | null> {
  const id = (battleId || '').trim();
  if (!id || !BATTLE_OUTCOME_TABLE) return null;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: BATTLE_OUTCOME_TABLE, Key: { battleId: id } }),
    );
    return (result.Item as BattleOutcome | undefined) ?? null;
  } catch (err) {
    console.warn('[battle-outcome] readBattleOutcome failed (failing open):', err);
    return null;
  }
}
