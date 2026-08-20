/**
 * ENDING A DUEL - the one door, so no caller can end one halfway.
 *
 * A duel ends in three ways and only one of them was ever implemented: it finishes, it closes loud
 * because a side never produced an answer, or **somebody leaves it** (DESIGN-BATTLE 2a-i). That third
 * way had no code and no state, so the only thing that ever ended an unfinished duel was a clock -
 * `DUEL_MAX_LIFETIME_MS` expiring - and every reader that consulted the pointer went on believing a
 * battle was running until it did.
 *
 * Ending is not one write. It is five, and doing four of them is a worse outcome than doing none:
 *
 *   1. the round-2 fire is poisoned, so no rebuttal is produced for a comparison nobody finished;
 *   2. the end is recorded as a marker of its own, which no race can take away;
 *   3. every non-terminal side moves to `ABANDONED`, so each side's end is recorded too;
 *   4. every waiting affordance comes down, so an ended duel stops inviting an answer;
 *   5. the channel's active-battle pointer is released, so the next `/battle` is not refused.
 *
 * Skip (2) and a duel ended in the instant its last side completed carries no record of having been
 * ended, so a pick on it is accepted. Skip (4) and the transcript keeps a live "Replying to:" control on
 * a question nothing is listening for. Skip (5) and the channel is locked until the backstop clock
 * fires. So they live together behind one function rather than at each call site, where the fifth one
 * added would have got it wrong.
 *
 * WHY THE TASK NEEDS NO SEPARATE STEP HERE. A task-shaped side is suspended at `WAITING_FOR_USER`
 * between legs and only advances when the duel hands it the next input. Ending the duel therefore ends
 * the chain by removing what drove it, which is the containment DESIGN-BATTLE 2a-i describes: the task
 * sits inside the battle, and there is no path that advances it once the battle is gone.
 */

import {
  readBattleRows,
  botRowsOnly,
  clearActiveBattle,
  tryClaimOrchestratorFire,
  transitionBotState,
  markBattleAbandoned,
  type BattleStateRow,
} from './battle-state.js';
import { clearBattleWaitingMarker } from './battle-waiting-marker.js';

/** Why a duel was ended. Recorded on the pointer's release and carried into the logs. */
export type BattleEndReason =
  | 'abandoned:drift'          // the person changed the subject and chose to leave
  | 'abandoned:new-battle'     // the person started another duel in the same channel
  | 'abandoned:battle-mode-off' // a moderator turned Battle Mode off
  | 'abandoned:requested';     // an explicit `/battle end`

export interface BattleEndResult {
  /** Sides moved to `ABANDONED` by this call. Empty when the duel had already stopped. */
  abandoned: string[];
  /** Waiting affordances actually taken down. */
  markersCleared: number;
  /**
   * Did this call take the orchestrator's exactly-once claim?
   *
   * `false` means a round-2 fan-out had ALREADY claimed it and is dispatched. The rebuttal cannot be
   * recalled - the claim is the only interlock there is - so the duel is still recorded abandoned and
   * its pick still refused, and the comparison contributes nothing even though a message was produced.
   * Surfaced rather than swallowed so a caller can say something true about it.
   */
  round2Suppressed: boolean;
}

/**
 * End the duel `battleId` in channel `channelArn`.
 *
 * IDEMPOTENT. Every step is conditional or best-effort: a second call finds the rows already
 * `ABANDONED` (no transition claimed), the claim already taken, the markers already gone and the
 * pointer already released. A retry is therefore safe and reports an honest empty result.
 *
 * NEVER THROWS. This runs on paths whose real job is something else - answering a person, starting the
 * next duel, flipping a toggle - and a failure to clean up must not take those down. Each step logs.
 */
export async function endBattle(args: {
  channelArn: string;
  battleId: string;
  reason: BattleEndReason;
  /** The person who ended it. Retained on the release for the audit. */
  endedBy?: string;
}): Promise<BattleEndResult> {
  const { channelArn, battleId, reason, endedBy } = args;
  const result: BattleEndResult = { abandoned: [], markersCleared: 0, round2Suppressed: false };

  let rows: BattleStateRow[] = [];
  try {
    rows = botRowsOnly(await readBattleRows(battleId));
  } catch (err) {
    console.warn('[battle-end] could not read the duel rows; releasing the pointer anyway:', err);
  }

  // 1. POISON THE ROUND-2 FIRE FIRST, and the order is deliberate.
  //
  //    The claim is what stops a rebuttal being generated, and the window it is racing is the moment
  //    the last side reaches COMPLETED. Taking it before the rows change means an in-flight fan-out
  //    cannot slip between the transition and the claim. Losing it is not an error - see the field's
  //    documentation - it means round 2 is already gone.
  try {
    result.round2Suppressed = await tryClaimOrchestratorFire(battleId);
  } catch (err) {
    console.warn('[battle-end] orchestrator claim attempt failed:', err);
  }

  // 2. RECORD THE END AS A FACT OF ITS OWN, before touching the sides.
  //
  //    The per-side rows are not a reliable record of "a person ended this". The claim above is taken
  //    first so no rebuttal is generated, and a side that reaches COMPLETED in that instant then fails
  //    its abandon transition below - leaving a duel that WAS ended by a person carrying no ABANDONED
  //    row at all. A reader keying on the rows would call that duel a completed comparison and accept a
  //    pick on it, which is the fabricated round the exclusion rule exists to prevent.
  //
  //    So the end gets a marker of its own, mirroring the orchestrator's `__complete__`. It cannot be
  //    raced away, because nothing else writes it.
  await markBattleAbandoned(battleId, reason);

  // 3. Record the end on every side that had not already stopped.
  //
  //    COMPLETED and FAILED are left ALONE. A side that genuinely produced its answer did produce it,
  //    and rewriting that as abandoned would erase real work to make the row set tidy.
  for (const row of rows) {
    if (row.state !== 'INVOKED' && row.state !== 'WAITING_FOR_USER') continue;
    try {
      const moved = await transitionBotState({
        battleId,
        botArn: row.botArn,
        state: 'ABANDONED',
        correlationId: row.correlationId,
      });
      if (moved) result.abandoned.push(row.botArn);
    } catch (err) {
      console.warn('[battle-end] could not abandon side', row.botArn, err);
    }
  }

  // 4. Take down every affordance that invited the next input.
  //
  //    Only a side that was WAITING has one. The question text stays in the transcript - it was a real
  //    part of the duel - and only the control that made it answerable goes.
  for (const row of rows) {
    if (row.state !== 'WAITING_FOR_USER' || !row.waitingMessageId) continue;
    const cleared = await clearBattleWaitingMarker(channelArn, row.waitingMessageId, row.botArn);
    if (cleared) result.markersCleared += 1;
  }

  // 5. Release the channel. Conditional on this battleId, so a late call cannot clear a newer duel.
  await clearActiveBattle({ channelArn, battleId, reason, endedBy });

  console.log('[battle-end] duel ended', {
    channelArn,
    battleId,
    reason,
    abandoned: result.abandoned.length,
    markersCleared: result.markersCleared,
    round2Suppressed: result.round2Suppressed,
  });
  return result;
}
